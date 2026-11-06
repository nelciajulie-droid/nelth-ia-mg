import jwt from 'jsonwebtoken';
import fs from 'node:fs';
const envTxt = await Bun.file('.env').text();
const url = envTxt.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const secret = envTxt.match(/^WEBUI_SECRET_KEY=(.+)$/m)?.[1]?.trim()
  || fs.readFileSync('./data/.webui_secret_key', 'utf8').trim();
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url } } });
const authRows = await db.auth.findMany({ select: { id: true, email: true, session_stamp: true } });
console.log('AUTH ROWS:', JSON.stringify(authRows, null, 1));
const target = authRows[0];
if (!target) { console.log('NO AUTH ROWS'); process.exit(1); }
const user = await db.user.findFirst({ where: { id: target.id } });
const token = jwt.sign({ id: target.id, role: user?.role ?? 'user', email: target.email ?? '', name: user?.name ?? '' , session_stamp: target.session_stamp ?? undefined, typ: 'session' }, secret, { algorithm: 'HS256', expiresIn: '2h' });
console.log('USER:', target.email, user?.role);
console.log('TOKEN:' + token);
await db.$disconnect();
