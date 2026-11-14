# nelth-ia-mg

**Nelth-AI** — portage 100 % TypeScript d'[Open WebUI](https://github.com/open-webui/open-webui) v0.12.5 (**zéro Python**), prêt à déployer sur **Vercel**, Docker ou VPS.

- **Frontend** : le build original Open WebUI (SvelteKit, `adapter-static`) est servi tel quel depuis `public/` — Next.js fait le SPA fallback (`next.config.ts` rewrites).
- **Backend** : API complète en TypeScript (`/api/v1/**`, `/ollama/**`, `/openai/**`, `/oauth/**`) avec streaming **SSE** des complétions de chat.
- **LLM intégré** : passerelle [Kilo AI](https://kilo.ai) compatible OpenAI (`Nelth-3.5` + `Nelth-3.5_Thinking`), aucune clé OpenAI requise.
- **Base de données** : Postgres managé (Supabase/Neon/RDS…) via Prisma — 45 tables, parité exacte avec le schéma Python.
- **Auth** : Firebase Auth (email/mot de passe) + Google OAuth (optionnel).
- **Recherche web + citations** style ChatGPT (chips inline, panneau Sources), TTS/STT intégrés sans clé, génération d'images sans clé (Pollinations), RAG fichiers.

## Déploiement Vercel (recommandé)

Le repo est déjà configuré (`vercel.json` : build `prisma generate && next build`, install `bun install`) :

1. Importer ce repo sur [vercel.com/new](https://vercel.com/new) (framework détecté : Next.js) — ou en CLI :
   ```bash
   bunx vercel link --project nelth-ia-mg
   bunx vercel deploy --prod
   ```
2. Renseigner les variables d'environnement (dashboard → Settings → Environment Variables) — voir `.env.example` :

   | Variable | Obligatoire | Rôle |
   |---|---|---|
   | `DATABASE_URL` | ✅ | URL Postgres (Supabase…), `sslmode=require` |
   | `KILO_GATEWAY_API_KEY` | ✅ | Clé de la passerelle LLM (kilo.ai → Settings → API Keys) |
   | `WEBUI_SECRET_KEY` | ✅ | Secret stable de signature des JWT (sinon les sessions ne survivent pas aux cold starts serverless) |
   | `FIREBASE_API_KEY` / `FIREBASE_PROJECT_ID` | ✅ | Firebase Auth (email/mot de passe) |
   | `KILO_GATEWAY_BASE_URL` | ⬜ | Défaut `https://ai-gateway.kilo.ai/api/v1` |
   | `DEFAULT_MODELS` | ⬜ | Modèle par défaut des nouveaux comptes |
   | `ENABLE_SIGNUP`, `DEFAULT_USER_ROLE`, `ENABLE_OAUTH`, `ENABLE_OAUTH_SIGNUP`, `OAUTH_MERGE_ACCOUNTS_BY_EMAIL` | ⬜ | Inscription / OAuth |
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ⬜ | Connexion Google (redirect `<domaine>/oauth/google/callback`) |

3. Vérifier :
   ```bash
   curl https://<votre-app>.vercel.app/api/version   # → {"version":"0.12.5"}
   ```

> Sur Vercel, le service temps réel socket.io (`mini-services/socket-service`) n'est pas hébergeable — l'app le contourne par design : le chat stream en **SSE HTTP** et les événements socket sont *best-effort* (voir `src/lib/chat/socket-events.ts`). Pour le temps réel complet, utilisez le déploiement Docker/VPS.

## Développement local / auto-hébergement

```bash
bun install                       # dépendances + client Prisma Postgres
vim .env                          # DATABASE_URL = URL Supabase (cf. .env.example)
bun run db:push                   # (re)crée les 45 tables dans Supabase
bun run dev                       # app (3000) + socket-service (3001) supervisés
```

> **Une seule base : Supabase Postgres.** Le schéma Prisma unique
> (`prisma/schema.prisma`, provider postgresql) est partagé par le local ET
> la production — même base, mêmes données. Le client généré est toujours
> le client Postgres (`@prisma/client`) ; au démarrage, `scripts/serve.mjs`
> vérifie sa fraîcheur (sous-commande `ensure`) et le régénère si besoin.

Docker : `docker compose up -d --build` (Caddy TLS inclus). Guide complet : [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Structure

```
src/app/          API Next.js (routes /api/v1, /ws proxy, /ollama, /openai, /oauth)
src/lib/          pipeline chat v12 (SSE), Kilo LLM, retrieval/RAG, auth Firebase, TTS/STT
src/server/       routeurs portés de open_webui (chats, files, models, knowledge…)
public/           build Open WebUI original (SvelteKit statique) + couche loader.js/custom.css
prisma/           schéma 45 tables — Supabase Postgres (unique, local + prod)
mini-services/    socket-service (temps réel, optionnel) + stt-service (STT sherpa-onnx :3032, mode vocal)
scripts/          superviseur serve.mjs, sélecteur Prisma prisma.mjs, utilitaires
```

## Deployments

- Live: https://nelth-ia-mg.vercel.app
- Auto-deploy: every push to `main` triggers a Vercel production build.
