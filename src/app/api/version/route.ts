export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { handleVersion } from '@/server/root-handlers';

export async function GET() {
  return handleVersion();
}
