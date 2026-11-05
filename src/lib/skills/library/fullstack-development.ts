import type { Skill } from '../types'

export const fullstackDevelopment: Skill = {
  name: 'fullstack-development',
  description:
    'Fullstack web application architecture: stack selection by project size, folder structure conventions, API-first design, session vs JWT auth selection, secrets and environment handling, layered error handling, and MVP scoping with an explicit cut list. Use when the user wants to build or structure a complete web app, choose a stack, set up authentication, plan a project, or scope an MVP.',
  keywords: [
    'fullstack', 'full stack', 'architecture', 'stack', 'technos', 'backend',
    'frontend', 'api', 'api rest', 'rest', 'mvp', 'application web', 'app web',
    'projet web', 'creer une application', 'creer une app', 'developpement web',
    'authentification', 'authentication', 'jwt', 'session', 'login', 'connexion',
    'base de donnees', 'database', 'structure de projet', 'secrets',
    "variables d'environnement", 'deploiement', 'deployment'
  ],
  body: `# Fullstack Project Architecture

## Architecture decision checklist (answer in order)
1. What is the ONE core user action? Build data model and screens around it; everything else is secondary.
2. Read/write ratio and data shape drive the database choice, not fashion.
3. Who consumes the app: browser only, or also mobile/partners? More than the web app means API-first from day one.
4. Auth complexity: public content, single-tenant users, or multi-tenant with roles?
5. Real-time needs (websockets) or is request/response enough?
6. Ops budget: managed platforms (Vercel, Railway, Supabase, Fly.io) beat self-hosting for MVPs.

## Folder structure conventions
- Separate route/UI wiring from domain logic: features live in src/lib/features/<feature>/ with page component, service, validation schema and types side by side.
- Shared layers: src/lib/components (presentational UI only), src/lib/server (server-only code), src/lib/utils.
- Env loading in a single validated config module; one config file per concern.
- Framework files (routes, pages) contain wiring only, never business logic.

## API-first design
- Write the contract first: method, path, request shape, response shape, error cases — then implement both sides against it.
- Version from day one (/api/v1) as soon as any external consumer exists.
- One consistent JSON envelope and one error shape across every endpoint.

## Auth pattern selection
- Session cookies (httpOnly, SameSite=Lax, Secure): the default for server-rendered apps; revocable, simple, CSRF-protectable.
- JWT: only when a stateless multi-service backend or federation genuinely requires it; 15-minute access tokens + refresh token rotation.
- Never store tokens in localStorage; never hand-roll password reset.
- Add one OAuth provider (Google/GitHub) for consumer MVPs to cut sign-up friction.

## Secrets and environment
- Commit \`.env.example\` only; real \`.env\` stays gitignored; every secret flows through one typed config module validated at boot, so a missing variable crashes startup with a clear message.
- Separate dev/staging/prod scopes; rotate on leak; never log secrets or tokens.

## Layered error handling
- Route handlers never leak raw errors: catch, log with context (request id), map to a typed error response.
- Error taxonomy: validation 400, auth 401/403, not found 404, conflict 409, server 500 with alerting.
- Frontend: error boundary + readable message + retry path; never swallow failures silently.

## MVP scoping — the cut list
Cut from v1: granular roles beyond one admin, settings pages, more than 2 email templates, dark mode, i18n, analytics dashboards, more than one social login, billing beyond a single plan.
Keep in v1: the core action end-to-end, auth, one happy-path admin flow, error and empty states, an automated deploy pipeline.

## Stack recommendations by project size
- Prototype / weekend: SvelteKit or Next.js + SQLite (Drizzle or Prisma) + Vercel or Fly.io.
- MVP / early product: SvelteKit or Next.js + managed Postgres (Supabase, Neon) + session auth + Resend for email.
- Scaling product: split an API service only when a second consumer appears; add a queue (Redis + BullMQ) for emails and imports; Redis cache on hot reads.
- Never choose microservices or Kubernetes for an MVP.`
}

export default fullstackDevelopment
