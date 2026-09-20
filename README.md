# linktree-host

Page link-in-bio auto-hébergée, avec stats (vues, clics, CTR par lien,
tendance 30 jours, sources de trafic, mobile/desktop), pas d'interface
d'admin exposée publiquement.

## Architecture retenue

Sur base de ton homelab actuel (`elmzn.be`, srv1 = pve-extranet avec
Docker + Nginx Proxy Manager, VPN WireGuard existant) :

- **Conteneur Docker** unique (`linktree-host`), Node.js + Express,
  déployé sur **srv1 / vm-extranet** aux côtés de NPM. Pas de VM dédiée :
  c'est un service léger, il n'a pas besoin d'isolation forte.
- **Réseau** : le conteneur rejoint le réseau Docker déjà utilisé par NPM
  (`npm_network` dans `docker-compose.yml`), donc **aucun port n'est
  exposé sur le LAN** — NPM proxifie en interne via le nom du conteneur.
  Le SSL (Let's Encrypt) reste géré par NPM comme pour tes autres
  services, pas besoin de certificat dans le conteneur.
- **Édition des liens** : un seul fichier `config/links.json` (titre, bio,
  liens). Pas de base de données pour le contenu, pas de login — donc
  aucune surface d'attaque côté admin. Tu édites le JSON en local, le
  script `deploy.sh` fait tout le reste.
- **Stats** : SQLite local (`data/stats.db`, monté en volume Docker donc
  persistant entre redéploiements). Table d'événements horodatés (`view`
  sur `/`, `click` sur `/l/<slug>`) — aucune IP ni user-agent complet
  stockés, juste des catégories agrégées (référent : direct/instagram/
  google/x/youtube/tiktok/autre, appareil : mobile/desktop). Permet de
  calculer vues, clics, CTR global et par lien, tendance sur 30 jours,
  répartition sources et appareils. Consultable sur `/stats`, protégé par
  Basic Auth (identifiants dans `.env` côté serveur — jamais commités).
- **Image Docker** : `node:20-slim` (Debian/glibc) plutôt qu'Alpine —
  `better-sqlite3` est un module natif compilé, et les binaires
  précompilés publiés pour lui ciblent surtout glibc ; Alpine (musl)
  aurait pu forcer une compilation à la volée qui échoue faute de
  toolchain dans l'image.
- **Sécurité pour l'exposition publique** :
  - `helmet` pour les headers de sécurité (CSP notamment)
  - `express-rate-limit` sur `/` et `/l/:slug` pour limiter l'abus
  - conteneur exécuté en utilisateur non-root
  - `/stats` en Basic Auth (tu peux en plus le restreindre au LAN/VPN via
    une Access List NPM si tu veux du défense-en-profondeur)
  - aucune route d'écriture publique — la config n'est modifiable que
    par toi via le déploiement

## Structure du projet

```
linktree-host/
├── server.js            # serveur Express (page, redirections trackées, /stats)
├── views/                # templates EJS (page + stats)
├── public/style.css      # thème sombre, mobile-first
├── config/links.json     # ← c'est CE fichier que tu édites pour changer tes liens
├── data/                 # SQLite (créé au runtime, jamais commité)
├── Dockerfile
├── docker-compose.yml
├── deploy.sh              # ← une seule commande pour tout déployer
├── .env.example           # variables à copier en .env sur le SERVEUR
└── .env.deploy.example     # variables à copier en .env.deploy en LOCAL (pour deploy.sh)
```

## Mise en place (une seule fois)

1. **Sur srv1 (vm-extranet, `192.168.1.111`)** :
   - Vérifie le **vrai** nom du réseau Docker de NPM : `docker network ls`
     (ne te fie pas à un nom deviné — la stack NPM de cette VM peut avoir
     été démarrée avec n'importe quel nom de projet Compose).
   - Crée le dossier cible et le sous-dossier `data` **avec les bons
     droits** (le conteneur tourne en non-root, UID/GID fixe `1000:1000` —
     sans ça, Docker crée `data/` en root et SQLite plante au démarrage
     avec `SQLITE_CANTOPEN`) :
     ```bash
     mkdir -p /opt/linktree-host/data
     chown -R 1000:1000 /opt/linktree-host/data
     ```
   - Copie `.env.example` en `.env` dans ce dossier et remplis
     `STATS_USER`, `STATS_PASS` et `NPM_NETWORK_NAME` (obligatoire —
     `docker compose up` refuse de démarrer si elle est absente, pour
     éviter un déploiement silencieux sur le mauvais réseau).

2. **En local (ta machine)** :
   - Copie `.env.deploy.example` en `.env.deploy` et ajuste
     `REMOTE_USER` / `REMOTE_HOST` / `REMOTE_PATH` si besoin (par défaut
     `root@192.168.1.111:/opt/linktree-host` — accès SSH root confirmé
     sur cette VM ; il n'y a pas de compte `webadmin` connu dessus,
     contrairement à lxc-web/.112).
   - Édite `config/links.json` avec tes vrais liens (remplace les
     `CHANGE_ME`).
   - Lance : `./deploy.sh` (WSL ou Git Bash sous Windows — nécessite
     `tar` et `ssh` — pas de dépendance à `rsync`).

3. **Chez OVH (DNS)** : ajoute un enregistrement `links.elmzn.be` (CNAME
   vers ton DDNS, comme fait pour `mytcg.elmzn.be`) si ce n'est pas déjà
   couvert par un enregistrement existant.

4. **Dans Nginx Proxy Manager** (une seule fois, via son interface web) :
   - Ajoute un Proxy Host, ex. `links.elmzn.be` → forward vers
     `linktree-host:3000` (nom du conteneur, puisqu'il est sur le même
     réseau Docker que NPM).
   - Active SSL / Let's Encrypt comme pour tes autres sous-domaines.
   - ⚠️ **Pas d'Access List LAN-only sur ce proxy host** — contrairement à
     `elmzn.be`/`n8n.elmzn.be`/`files.elmzn.be`, cette page doit être
     publique : c'est un lien de bio destiné à être cliqué depuis
     Instagram par des gens hors de ton LAN.
   - (Optionnel) Ajoute une Access List sur le path `/stats` uniquement
     pour la restreindre à ton LAN/VPN en plus du Basic Auth.

## Utilisation au quotidien

- **Changer un lien / le titre / la bio** : édite `config/links.json` en
  local, puis `./deploy.sh`. Pas besoin de taper les commandes Docker
  toi-même.
- **Voir les stats** : `https://links.elmzn.be/stats` (identifiants
  Basic Auth définis dans `.env` côté serveur).
- **Logs** : `ssh root@192.168.1.111 'docker logs -f linktree-host'`

## Sauvegarde

⚠️ Il n'existe **aucun job de backup automatisé sur le Beelink
(pve-extranet)** actuellement — ni pour ce service, ni pour les autres
services qui y tournent (n8n, MyTCG). `/opt/linktree-host/data/stats.db`
et `config/links.json` sont les deux seuls fichiers d'état qui ne sont
pas dans le dépôt : à sauvegarder manuellement (scp) tant qu'aucune
solution Restic n'est mise en place sur cette machine. Perte acceptable
en pratique (juste des stats de clics + la config des liens, ré-éditable
en 2 minutes), mais à garder en tête.

## Pistes d'évolution (pas faites maintenant, volontairement)

- Automatiser la création du Proxy Host NPM via son API (au lieu du clic
  manuel) si tu montes plusieurs sous-domaines de ce genre.
- Passer `/stats` derrière l'Access List NPM en plus du Basic Auth si le
  site devient une cible (défense en profondeur).
- Si un jour tu veux plusieurs pages de liens (pas juste la tienne), il
  faudra revoir la config pour un format multi-sites — non fait ici
  puisque tu n'en as besoin que pour toi pour l'instant.
