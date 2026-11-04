export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * /litellm/* — LiteLLM proxy stub (JSON 404, FastAPI parity).
 *
 * The TS port serves chat models exclusively through OpenAI-compatible
 * connections; the LiteLLM management surface does not exist. Without this
 * stub, unknown /litellm/... paths fell through to the SPA fallback
 * (index.html, content-type text/html) — and the ORIGINAL frontend's
 * `res.json()` turned that into
 * `Unexpected token '<', "<html> <h"... is not valid JSON` toasts.
 * Every method answers with the FastAPI-style JSON 404 the Python backend
 * returned for absent routers, so the frontend degrades gracefully.
 */
function notFound(): Response {
  return Response.json({ detail: 'Not Found' }, { status: 404 });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
export const HEAD = notFound;
