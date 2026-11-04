export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * /health — JSON health probe.
 *
 * Next.js would render an HTML 404 here; the ORIGINAL frontend's startup
 * probes (and any monitoring) parse the response as JSON and surface
 * `Unexpected token '<', "<html> <h"...` on HTML bodies. FastAPI's parity
 * answer is a tiny JSON document.
 */
export async function GET(): Promise<Response> {
  return Response.json({ status: true, online: true });
}
