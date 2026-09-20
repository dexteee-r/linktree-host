// Minimal self-hosted link-in-bio server.
// Renders a page from config/links.json, tracks page views and per-link
// clicks in a local SQLite file, and exposes a basic-auth-protected
// /stats page. No admin UI: links are edited in config/links.json and
// shipped via the deploy script, keeping the public attack surface small.

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config', 'links.json');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'stats.db');

// Make sure the data directory exists before opening the DB (first run / fresh volume).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS clicks (
    slug TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    count INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO page_views (id, count) VALUES (1, 0);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('view', 'click')),
    slug TEXT,
    referrer TEXT,
    device TEXT NOT NULL DEFAULT 'desktop',
    day TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_type_day ON events(type, day);
  CREATE INDEX IF NOT EXISTS idx_events_type_slug ON events(type, slug);
`);

const insertEvent = db.prepare(
  'INSERT INTO events (type, slug, referrer, device, day) VALUES (?, ?, ?, ?, ?)'
);

// Buckets only — never stores raw IP or full user-agent strings.
const REFERRER_RULES = [
  [/instagram\.com/i, 'instagram'],
  [/(^|\.)x\.com$|t\.co$|twitter\.com/i, 'x'],
  [/youtube\.com$|youtu\.be$/i, 'youtube'],
  [/tiktok\.com$/i, 'tiktok'],
  [/google\./i, 'google'],
];

function bucketReferrer(referrerHeader, ownHost) {
  if (!referrerHeader) return 'direct';
  let host;
  try {
    host = new URL(referrerHeader).hostname.replace(/^www\./, '');
  } catch {
    return 'autre';
  }
  if (host === ownHost) return 'direct';
  for (const [pattern, label] of REFERRER_RULES) {
    if (pattern.test(host)) return label;
  }
  return 'autre';
}

function bucketDevice(userAgent) {
  if (userAgent && /mobile|android|iphone|ipad|ipod/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.links)) {
    throw new Error('config/links.json must have a "links" array');
  }
  return parsed;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // behind Nginx Proxy Manager

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        fontSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      },
    },
  })
);

app.use('/public', express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true }));

const pageLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const redirectLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

app.get('/', pageLimiter, (req, res) => {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[config] failed to load:', err.message);
    return res.status(500).send('Configuration invalide.');
  }

  insertEvent.run(
    'view',
    null,
    bucketReferrer(req.get('Referrer'), req.hostname),
    bucketDevice(req.get('User-Agent')),
    today()
  );
  res.render('index', { config });
});

app.get('/l/:slug', redirectLimiter, (req, res) => {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return res.status(500).send('Configuration invalide.');
  }

  const link = config.links.find((l) => l.slug === req.params.slug);
  if (!link) return res.status(404).send('Lien introuvable.');

  insertEvent.run('click', link.slug, null, bucketDevice(req.get('User-Agent')), today());

  res.redirect(302, link.url);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const statsAuth = basicAuth({
  users: { [process.env.STATS_USER || 'admin']: process.env.STATS_PASS || 'change-me' },
  challenge: true,
  realm: 'Linktree Stats',
});

app.get('/stats', statsAuth, (req, res) => {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return res.status(500).send('Configuration invalide.');
  }

  const totalViews = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'view'").get().n;
  const totalClicks = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'click'").get().n;
  const ctr = totalViews > 0 ? (totalClicks / totalViews) * 100 : 0;

  const clicksBySlug = Object.fromEntries(
    db
      .prepare("SELECT slug, COUNT(*) AS n FROM events WHERE type = 'click' GROUP BY slug")
      .all()
      .map((r) => [r.slug, r.n])
  );

  const stats = config.links
    .map((l) => {
      const clicks = clicksBySlug[l.slug] || 0;
      return {
        label: l.label,
        slug: l.slug,
        clicks,
        ctr: totalViews > 0 ? (clicks / totalViews) * 100 : 0,
      };
    })
    .sort((a, b) => b.clicks - a.clicks);

  // 30-day trend, zero-filled so gaps show as empty bars rather than skipped days.
  const since = new Date();
  since.setDate(since.getDate() - 29);
  const sinceStr = since.toISOString().slice(0, 10);

  const viewsByDay = Object.fromEntries(
    db
      .prepare("SELECT day, COUNT(*) AS n FROM events WHERE type = 'view' AND day >= ? GROUP BY day")
      .all(sinceStr)
      .map((r) => [r.day, r.n])
  );
  const clicksByDay = Object.fromEntries(
    db
      .prepare("SELECT day, COUNT(*) AS n FROM events WHERE type = 'click' AND day >= ? GROUP BY day")
      .all(sinceStr)
      .map((r) => [r.day, r.n])
  );

  const trend = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(since);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    trend.push({ day: key, views: viewsByDay[key] || 0, clicks: clicksByDay[key] || 0 });
  }
  const maxViews = Math.max(1, ...trend.map((t) => t.views));

  const sources = db
    .prepare("SELECT referrer, COUNT(*) AS n FROM events WHERE type = 'view' GROUP BY referrer ORDER BY n DESC")
    .all()
    .map((r) => ({
      label: r.referrer || 'direct',
      count: r.n,
      pct: totalViews > 0 ? (r.n / totalViews) * 100 : 0,
    }));

  const deviceCounts = Object.fromEntries(
    db
      .prepare("SELECT device, COUNT(*) AS n FROM events WHERE type = 'view' GROUP BY device")
      .all()
      .map((r) => [r.device, r.n])
  );
  const mobilePct = totalViews > 0 ? ((deviceCounts.mobile || 0) / totalViews) * 100 : 0;
  const desktopPct = totalViews > 0 ? ((deviceCounts.desktop || 0) / totalViews) * 100 : 0;

  res.render('stats', {
    totalViews,
    totalClicks,
    ctr,
    stats,
    trend,
    maxViews,
    sources,
    mobilePct,
    desktopPct,
  });
});

app.listen(PORT, () => {
  console.log(`Linktree host listening on :${PORT}`);
});
