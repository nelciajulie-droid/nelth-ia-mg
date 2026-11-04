export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Bare /oauth (no subpath) → FastAPI-style JSON 404 (see /ollama/route.ts). */
export async function GET(): Promise<Response> {
  return Response.json({ detail: 'Not Found' }, { status: 404 });
}

export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;
