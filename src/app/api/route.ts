export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// FastAPI parity: /api (root, no sub-path) → {"detail":"Not Found"}.
async function notFound(): Promise<Response> {
  return Response.json({ detail: 'Not Found' }, { status: 404 });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
