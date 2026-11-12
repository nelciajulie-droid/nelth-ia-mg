/**
 * Mint a session token for the sandbox SQLite user (db/custom.db) — used by
 * local e2e harnesses when signup is gated.
 *
 *   bun scripts/_mint-token-sqlite.ts
 */
import jwt from 'jsonwebtoken';
import fs from 'node:fs';

const secret =
  (await Bun.file('.env').text()).match(/^WEBUI_SECRET_KEY=(.+)$/m)?.[1]?.trim()
  || fs.readFileSync('./data/.webui_secret_key', 'utf8').trim();

const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url: 'file:' + process.cwd() + '/db/custom.db' } } });
const authRow = await db.auth.findFirst({ select: { id: true, email: true, session_stamp: true } });
if (!authRow) { console.log('NO AUTH ROWS'); process.exit(1); }
const user = await db.user.findFirst({ where: { id: authRow.id } });
const token = jwt.sign(
  {
    id: authRow.id,
    role: user?.role ?? 'user',
    email: authRow.email ?? '',
    name: user?.name ?? '',
    session_stamp: authRow.session_stamp ?? undefined,
    typ: 'session',
  },
  secret,
  { algorithm: 'HS256', expiresIn: '2h' }
);
console.log('USER:', authRow.email, user?.role);
console.log('TOKEN:' + token);
await db.$disconnect();
