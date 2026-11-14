# Déploiement de Nelth-AI — guide complet

Ce document explique **comment déployer Nelth-AI indépendamment du sandbox de
développement**, sur votre propre serveur, avec votre propre domaine — et
pourquoi `https://www.nelth-ai.com` ne répond **pas** aujourd'hui.

---

## 1. Pourquoi « www.nelth-ai.com » est inaccessible (DNS_PROBE_FINISHED_NXDOMAIN)

L'erreur `DNS_PROBE_FINISHED_NXDOMAIN` signifie que **le nom de domaine n'existe
pas dans le DNS** : aucune adresse IP ne lui est associée, nulle part dans le
monde. Vérifié le jour même : `www.nelth-ai.com` et `nelth-ai.com` ne
résolvent vers rien (`ENOTFOUND`), alors que `google.com` résout
normalement — ce n'est donc **pas** un problème de votre connexion ni de
Windows.

Deux causes se cumulent :

1. **Le domaine n'est pas déployé.** L'application tourne actuellement dans
   l'environnement de développement (panneau de prévisualisation). Aucun
   serveur public ne répond sur `nelth-ai.com`, et aucun enregistrement DNS
   n'existe pour ce nom. Un domaine doit être **acheté** (registrar : OVH,
   Gandi, Namecheap, Google Domains…), puis **pointé** vers un serveur
   (enregistrement DNS `A`/`AAAA`), et l'application doit y être **déployée**
   (voir §3). Jusque-là, toute URL sur ce domaine donnera la même erreur.

2. **Le lien lui-même avait été inventé par l'IA.** Dans la conversation
   « Creative Uses for Children's Drawings », le modèle avait répondu à une
   demande de fichier Excel par un faux lien de téléchargement
   `https://www.nelth-ai.com/export/excel/organisation-dessins-enfants.xlsx`.
   Ce chemin (`/export/excel/…`) n'existe dans aucune version de
   l'application, et l'application ne publie jamais de fichiers par URL
   externe : les fichiers générés apparaissent en **carte de téléchargement
   dans la conversation** (`/api/v1/files/<id>/content`).
   Ce problème est désormais corrigé à trois niveaux :
   - la **conversation a été réparée** : le vrai fichier Excel
     « Organisation dessins enfants.xlsx » (3 feuilles) est désormais attaché
     au message, téléchargeable depuis la carte ;
   - l'IA reçoit une consigne renforcée : **interdiction absolue d'inventer
     des liens de téléchargement**, le bloc `document` est le seul canal ;
   - un **filet de sécurité** retire automatiquement toute URL inventée
     (`nelth-ai.com`, `/export/…`) des réponses du modèle.

En résumé : l'adresse n'est pas « fausse », elle est simplement **pas encore
réelle**. La suite de ce guide explique la rendre réelle.

---

## 2. Ce dont l'application a besoin

Nelth-AI est un produit **100 % TypeScript** (portage complet d'Open WebUI
v0.12.5, zéro Python). Elle ne dépend du sandbox pour rien : toutes ses
dépendances sont soit dans le dépôt, soit des services cloud standards.

| Besoin | Détail |
|---|---|
| **Runtime** | [Bun](https://bun.sh) ≥ 1.1 (ou Node 20+ pour l'app seule) |
| **Base de données** | Postgres managé — **déjà externe** (Supabase). Aucune migration nécessaire : il suffit de `DATABASE_URL` |
| **Authentification** | Firebase Auth (Email/Mot de passe + Google) — service cloud, clé API dans `.env` |
| **Modèles LLM** | Kilo Gateway (compatible OpenRouter) — clé API dans `.env` |
| **Processus** | 2 processus, **démarrés par une seule commande** (`bun run start`) : l'app Next.js (port 3000) + le service socket.io de streaming (port 3001, interne) |

Le fichier `scripts/serve.mjs` supervise les deux processus (redémarrage
automatique du service socket, extinction propre). Les navigateurs ne voient
que le port 3000 : l'application proxifie elle-même `/ws/**` vers le service
interne.

---

## 3. Rendre « nelth-ai.com » réel — les étapes

1. **Acheter le domaine** `nelth-ai.com` chez un registrar (≈ 10–15 €/an).
2. **Louer un serveur** (VPS) — 2 vCPU / 4 Go RAM suffisent largement
   (Hetzner, OVH, Scaleway, DigitalOcean…). Noter son adresse IP publique.
3. **Créer les enregistrements DNS** chez le registrar :
   - `A`     `nelth-ai.com`        → `IP_DU_SERVEUR`
   - `A`     `www.nelth-ai.com`    → `IP_DU_SERVEUR`
   - (optionnel) `AAAA` avec l'IPv6 du serveur
   - Attendre la propagation (quelques minutes à quelques heures).
4. **Installer Docker** sur le serveur, copier le dépôt et le `.env`.
5. **Lancer** : `docker compose up -d --build` — Caddy obtient le certificat
   HTTPS automatiquement. Le site répond sur `https://nelth-ai.com`.

---

## 4. Déploiement Docker (recommandé)

Fichiers fournis : `Dockerfile`, `docker-compose.yml`, `deploy/Caddyfile`,
`.env.example`.

```bash
# Sur le serveur :
git clone <votre-depot> nelth-ai && cd nelth-ai
cp .env.example .env
nano .env                      # remplir les valeurs (cf. §6)

docker compose up -d --build   # app + Caddy TLS
docker compose logs -f         # suivre le démarrage
```

- L'application écoute en interne (conteneur `nelth-ai`, port 3000) ;
  Caddy publie 80/443 et fait le HTTPS.
- Le domaine est configuré dans `deploy/Caddyfile` (remplacer
  `nelth-ai.com` si vous utilisez un autre nom).
- Pour tester **sans domaine**, décommenter le bloc `ports: "3000:3000"`
  dans `docker-compose.yml` et ouvrir `http://IP_SERVEUR:3000`.

### Mise à jour

```bash
git pull
docker compose up -d --build
```

---

## 5. Déploiement sans Docker (VPS nu)

Pré-requis : Bun (`curl -fsSL https://bun.sh/install | bash`), Git.

```bash
git clone <votre-depot> nelth-ai && cd nelth-ai
cp .env.example .env && nano .env

bun install                              # dépendances + prisma generate
cd mini-services/socket-service && bun install && cd ../..

bun run db:push                          # crée/pousse les 45 tables Postgres

bun run build                            # build production Next.js
bun run start                            # démarre app + socket-service
```

Pour un service systemd (`/etc/systemd/system/nelth-ai.service`) :

```ini
[Unit]
Description=Nelth-AI (Next.js + socket-service)
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/opt/nelth-ai
ExecStart=/home/deploy/.bun/bin/bun run start
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now nelth-ai
```

Le port 3000 est alors servi en HTTP local ; placez Caddy/Nginx devant pour
le HTTPS public (voir `deploy/Caddyfile` — avec un bare-metal, remplacer
`reverse_proxy nelth-ai:3000` par `reverse_proxy 127.0.0.1:3000`).

---

## 6. Variables d'environnement

Copier `.env.example` → `.env`. Les valeurs marquées **obligatoires** doivent
être remplies ; l'application les lit au démarrage.

| Variable | Obligatoire | Rôle |
|---|---|---|
| `DATABASE_URL` | ✅ | Postgres (Supabase/Neon/RDS…). Les données actuelles suivent : c'est cette URL qui détient les comptes, conversations, fichiers |
| `KILO_GATEWAY_API_KEY` | ✅ | Clé de la passerelle LLM (modèles de chat) |
| `KILO_GATEWAY_BASE_URL` | ⬜ | Défaut : `https://ai-gateway.kilo.ai/api/v1` |
| `FIREBASE_API_KEY` | ✅ | Clé web Firebase Auth |
| `FIREBASE_PROJECT_ID` | ✅ | Projet Firebase |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ⬜ | Connexion Google ; rediriger l'URI autorisée vers `https://VOTRE-DOMAINE/api/auth/google/callback` |
| `ENABLE_OAUTH`, `ENABLE_OAUTH_SIGNUP`, `OAUTH_MERGE_ACCOUNTS_BY_EMAIL` | ⬜ | Réglages Google OAuth |
| `ENABLE_SIGNUP` | ⬜ | Autoriser les inscriptions (défaut : `true`) |
| `DEFAULT_USER_ROLE` | ⬜ | Rôle des nouveaux comptes (`user`) |
| `DEFAULT_MODELS` | ⬜ | Modèle par défaut des nouveaux comptes (défaut : moteur intégré Nelth-3.5) |
| `ENABLE_WEBSOCKET_SUPPORT` | ⬜ | Temps réel — défaut `False` (polling+websocket, comme l'original) ; `True` = WebSocket pur derrière un reverse proxy qui termine l'upgrade |
| `APP_PORT` | ⬜ | Port de l'app (défaut `3000`) |
| `SOCKET_SERVICE_PORT` | ⬜ | Port interne socket.io (défaut `3001`) |

### Moteurs intégrés audio + images (zéro configuration, sans aucun SDK)

La voix et les images fonctionnent à l'installation, comme dans l'original,
en pur HTTPS — **aucun SDK fournisseur** n'est utilisé :

- **Lecture à voix haute (TTS)** — moteur intégré par défaut (`audio.tts.engine`
  = `""`) via l'endpoint vocal public Google Translate **sans clé** : 12 voix
  (= langues), texte long découpé par phrases et fusionné en un seul MP3
  continu (`audio/mpeg`).
- **Saisie vocale (STT)** — transcription via le **modèle omni gratuit** du
  Kilo Gateway (`nvidia/nemotron-3-nano-omni…:free`, réutilise
  `KILO_GATEWAY_API_KEY`, zéro crédit consommé) ; les captures micro
  navigateur (webm/opus) sont transcodées en WAV 16 kHz par **ffmpeg** (inclus
  dans l'image Docker). Les fichiers audio envoyés dans le chat sont
  **transcrits puis indexés** (interrogeables).
- **Génération d'images** — moteur `sd` intégré via l'endpoint public
  **Pollinations sans clé** (JPEG 768×768, tailles jusqu'à 1440×720 acceptées,
  3 tentatives avec backoff). `IMAGE_GENERATION_ENGINE_BASE_URL` permet de
  pointer vers un endpoint SD compatible.
- Un administrateur peut toujours brancher un moteur externe dans Paramètres →
  Audio : `openai`, `elevenlabs`, `azure`, `mistral` (TTS/STT), `deepgram`
  (STT) — et `openai` pour les images — tous proxifiés en TypeScript.

---

## 7. Fonctionnalités activées à la parité originale

Cette session a activé ce qui restait hors service :

| Fonctionnalité | État | Détail |
|---|---|---|
| Lecture à voix haute (TTS) | ✅ autonome | `/api/v1/audio/speech` → MP3 via endpoint vocal public Google Translate **sans clé** (`src/lib/audio-builtin.ts`) ; moteurs externes openai/elevenlabs/azure/mistral conservés |
| Saisie vocale (STT) | ✅ autonome | `/api/v1/audio/transcriptions` via **modèle omni gratuit** du Kilo Gateway + transcodage ffmpeg (webm→wav) ; proxys **deepgram / azure / mistral** portés |
| Fichiers audio → RAG | ✅ activé | Upload audio transcrit puis indexé — interrogeable dans le chat (comportement Python) |
| Génération d'images | ✅ autonome | `/api/v1/images/generations` → JPEG réel via endpoint public **Pollinations sans clé** (`src/lib/image-generation.ts`), persisté dans le pipeline fichiers |
| Bus d'événements socket | ✅ activé | `publishEvent`/`broadcastEvent` (`src/lib/events.ts`) : `models:refresh` broadcasté à chaque CRUD modèle → tous les onglets se rafraîchissent ; `/emit` du socket-service supporte le broadcast sans room |
| Version API | ✅ alignée | `/api/version` → `0.12.5` (identique au package.json / à l'original) |
| Modèle par défaut | ✅ corrigé | `ui.default_models` → moteur intégré Nelth-3.5 (l'ancien id `zai-glm-4-plus` était un reliquat) |
| WebSocket | ✅ aligné | `ENABLE_WEBSOCKET_SUPPORT=False` — défaut de l'original : transports polling+websocket, compatible avec le proxy intégré (True = WebSocket pur, exige un reverse proxy qui termine l'upgrade) ; le temps réel (streaming, bus d'événements) fonctionne en polling |
| Recherche web | ✅ déjà réelle | Chaîne DuckDuckGo Lite/HTML + 4get (`src/lib/retrieval/web-search.ts`) |
| Recherche web **automatique** | ✅ activé | Engagement auto (comme le browsing ChatGPT) : sans toucher au bouton globe, un mini-appel au modèle intégré gratuit décide si la question nécessite du frais (`src/lib/chat/auto-web-search.ts`), puis déclenche la même chaîne de recherche + citations — même libellé de statut « Recherche web en cours » que le mode manuel. Config `web.search.auto` (défaut : true) |
| Panneau de citation (style ChatGPT) | ✅ activé | **Panneau Sources ancré à droite** (`public/static/loader.js`) : clic sur « N Sources » → panneau intégré au layout (400 px desktop / plein écran mobile, `#chat-container` reçoit la marge → conversation et composer restent visibles, zéro chevauchement), liste complète (numéro, favicon, domaine, titre, extrait, URL), clic rangée → ouvre l'URL (`_blank` + `noopener noreferrer nofollow`), Échap/bouton ferment, changement de message = mise à jour, thèmes clair/sombre |
| Badges de citation inline (style ChatGPT Search) | ✅ activé | Le pipeline injecte des sources **numérotées** (`<source number="N">`) + un prompt de citation → le modèle émet des marqueurs `[N]`/`[N,M]` → le **tokenizer natif du frontend** les rend en pastilles inline (favicon + domaine, favicon injecté par loader.js via MutationObserver). Hygiène backend : ids hors plage supprimés, marqueurs sans sources retirés (`sanitizeCitationMarkers`). Clic badge → panneau droit avec la source **surlignée** |
| Bug `Unexpected token '<'` (JSON) | ✅ corrigé | `/ollama/api/version` répondait 500 après chaque complétion (parité Python) ; le frontend fait `if (!res.ok) throw await res.json()` et toute page d'erreur HTML (fenêtre de recompilation dev) donnait `Unexpected token '<', "<html>…`. Retour à `200 {"version":false}` (signal « Ollama absent » natif du frontend) + classifieur de recherche auto renforcé (3 tentatives, retry aussi sur réponse non parsable) |
| Web loader (lecture des pages) | ✅ activé | `loadWebPages` (`web-search.ts`) : récupère le contenu réel des 3 principales pages résultats (dédoublonnées, extraction HTML→texte, échec doux par page) et remplace les extraits maigres par le vrai contenu — `web.search.bypass_web_loader` = false en base |

Restent documentés non portés (choix assumés, pas de mockup) :
`/realtime` (appels vocaux OpenAI — désactivé par défaut dans l'original aussi,
nécessite une clé OpenAI Realtime), connecteurs knowledge externes, moteur
d'exécution des automations (RRULE/APScheduler) — les tables et l'API CRUD
existent, seule l'exécution programmée attend une implémentation fidèle.

## 8. Vérifications post-déploiement

```bash
curl https://nelth-ai.com/api/version      # → {"version":"0.12.5",...}
curl -I https://nelth-ai.com/              # → 200, content-type text/html
```

Dans le navigateur : créer un compte (ou Google), envoyer un message, la
réponse doit arriver **en streaming** (service socket.io opérationnel —
sinon vérifier `docker compose logs nelth-ai` : `[serve] mode=start`).

---

## 9. Notes opérationnelles

- **Les fichiers générés** (PDF/DOCX/XLSX…) sont stockés en base
  (`content_base64`) et servis par `/api/v1/files/<id>/content` — aucun
  disque externe ni CDN n'est requis ; un stockage objet peut être ajouté
  plus tard sans changer le modèle.
- **Sauvegardes** : `pg_dump` de la base `DATABASE_URL` suffit à tout
  sauvegarder (comptes + conversations + fichiers).
- **Montée en charge** : l'app est stateless (hors socket.io). Pour plusieurs
  instances, répliquer le conteneur `nelth-ai` derrière le reverse proxy en
  gardant une seule instance `socket-service` partagée, ou activer le mode
  SSE (sans socket) du pipeline de chat.
- **Le sandbox de développement** ne sert qu'au développement : aucun chemin
  de code ne lui est dédié (la résolution de `DATABASE_URL` dans
  `src/lib/db.ts` fonctionne à l'identique en production : variable
  d'environnement Postgres directe).
