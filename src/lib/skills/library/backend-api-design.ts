import type { Skill } from '../types'

export const backendApiDesign: Skill = {
  name: 'backend-api-design',
  description:
    'REST API design and hardening: resource naming and verbs, the correct status codes, cursor vs offset pagination, versioning, request validation, auth mechanism selection (session, JWT, API keys), rate limiting, idempotency for payment POSTs, consistent error payloads, OWASP mitigations and webhook signing. Use when the user designs, builds, reviews or debugs an API, or asks about endpoints, status codes, authentication or webhooks.',
  keywords: [
    'api', 'api rest', 'rest', 'endpoint', 'endpoints', 'status code',
    'code http', 'http', 'pagination', 'versioning', "version d'api", 'webhook',
    'webhooks', 'idempotence', 'rate limiting', 'limite de requetes',
    'authentification', 'jwt', 'cle api', 'api key', "format d'erreur", 'owasp',
    'securite api', 'validation', 'payload', 'crud', 'routes', 'controller',
    'middleware', '429'
  ],
  body: `# REST API Design

## Resource naming and verbs
- Nouns, plural, kebab-case: /api/v1/invoices, /api/v1/subscription-items.
- Nest only for ownership: /users/42/orders; never deeper than two levels.
- Standard verbs: GET list/read, POST create, PUT/PATCH replace/update, DELETE remove.
- Non-CRUD actions: POST /invoices/42/cancel — document these explicitly.

## Status codes (use exactly these)
- 200 read/update success; 201 Created + Location header; 204 No Content for deletes.
- 400 malformed payload; 401 unauthenticated; 403 forbidden; 404 not found; 409 conflict (duplicate, email taken); 422 semantic validation error; 429 rate limited.
- 5xx only for genuine server faults; every 5xx triggers a log + alert.

## Pagination
- Offset (?page=2&limit=50): acceptable for admin lists under ~10k rows; simple, but shifts under concurrent writes.
- Cursor (?after=eyJpZCI6...): default for public feeds and growing data; stable and index-friendly (WHERE id > cursor ORDER BY id).
- Always return metadata: total (offset mode) or nextCursor + hasMore (cursor mode).

## Versioning
- /api/v1 path prefix from day one when external consumers exist.
- Deprecate with Sunset + Deprecation headers and a minimum 6-month migration window; document the change.

## Validation and error format
- Validate at the boundary with a schema per endpoint (zod/valibot); reject unknown fields; coerce and normalize types once.
- One error body everywhere: { error: { code, message, details: [{ field, issue }] }, requestId } for 400/401/403/404/409/422/429/500 — clients write a single parser.

## Auth mechanism selection
- Session cookies: browser frontends; revocable; CSRF token protected.
- JWT: stateless multi-service or mobile clients; short access TTL (15 min) + refresh rotation.
- API keys: server-to-server; hashed at rest, prefix for identification, scoped per key.
- 401 means "who are you?", 403 means "you may not do this".

## Rate limiting
- Token bucket per identity, in this order: user id > API key > IP.
- Defaults: 100 req/min authenticated, 10 req/min on auth endpoints; answer 429 with a Retry-After header.

## Idempotency
- Any POST that pays or creates an external side effect (payment, email, order): accept an Idempotency-Key header, store key + response for 24h, return the stored response on replay instead of executing twice.

## OWASP top mitigations
- Injection: parameterized queries only; never build SQL by string concatenation.
- Broken auth: argon2id or bcrypt cost >= 12; lock accounts after 10 failed attempts.
- Mass assignment: whitelist fields per endpoint, never bind request bodies wholesale.
- SSRF: block private IP ranges on user-supplied URLs; open redirects: validate target domains.
- CORS: explicit origin allowlist; never wildcard origins together with credentials.

## Webhooks
- Sign payloads (HMAC-SHA256 with a timestamp); verify on the receiver with constant-time comparison; reject events older than 5 minutes (replay protection).
- Respond 2xx fast, process asynchronously; retry failures with exponential backoff over 24h; document the retry policy so receivers can make handlers idempotent.`
}

export default backendApiDesign
