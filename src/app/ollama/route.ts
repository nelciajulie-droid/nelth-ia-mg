export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Bare /ollama (no subpath) → FastAPI-style JSON 404. Next.js would render
 *  an HTML 404 page here, which the ORIGINAL frontend's `throw await res.json()`
 *  turns into "Unexpected token '<' … is not valid JSON". The Ollama proxy was
 *  removed entirely — see [...path]/route.ts. */
export async function GET(): Promise<Response> {
  return Response.json({ detail: 'Not Found' }, { status: 404 });
}

export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;
