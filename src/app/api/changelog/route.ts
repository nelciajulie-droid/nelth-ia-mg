export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Port of main.py GET /api/changelog → env.py CHANGELOG parsing.
 *
 * Nelth-AI branding decision: release notes and version entries
 * ("v0.12.5", …) are intentionally not surfaced anywhere in the UI
 * (the "What's New" modal renders one `v<version>` heading per entry).
 * The response is therefore intentionally empty.
 */
export async function GET() {
  return Response.json({});
}
