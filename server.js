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
`);

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

  db.prepare('UPDATE page_views SET count = count + 1 WHERE id = 1').run();
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

  db.prepare(
    `INSERT INTO clicks (slug, count) VALUES (?, 1)
     ON CONFLICT(slug) DO UPDATE SET count = count + 1`
  ).run(link.slug);

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

  const rows = db.prepare('SELECT slug, count FROM clicks').all();
  const clicksBySlug = Object.fromEntries(rows.map((r) => [r.slug, r.count]));
  const pageViews = db.prepare('SELECT count FROM page_views WHERE id = 1').get().count;

  const stats = config.links.map((l) => ({
    label: l.label,
    slug: l.slug,
    clicks: clicksBySlug[l.slug] || 0,
  }));

  res.render('stats', { stats, pageViews });
});

app.listen(PORT, () => {
  console.log(`Linktree host listening on :${PORT}`);
});
