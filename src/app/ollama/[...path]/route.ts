export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * /ollama/* — Ollama proxy REMOVED (user request, 2026-11).
 *
 * Nelth-AI serves chat models exclusively through OpenAI-compatible
 * connections (Kilo gateway), so the 1800-line port of
 * open_webui/routers/ollama.py was dead weight — and its 500/400/422
 * responses made the original frontend surface
 * "Unexpected token '<', "<html> <h…" is not valid JSON" toasts
 * (Next.js dev serves an HTML error page when the route module fails
 * to compile/evaluate, and the frontend calls res.json() without
 * checking res.ok on these endpoints).
 *
 * Every method now answers with the FastAPI-style JSON 404 the Python
 * backend returned when Ollama was absent — valid JSON, so the frontend
 * degrades gracefully ("connection offline") and never parses HTML.
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
