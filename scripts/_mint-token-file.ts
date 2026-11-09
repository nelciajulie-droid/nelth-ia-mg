import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';

const envTxt = await Bun.file('.env').text();
const url = envTxt.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const secret = fs.readFileSync('./data/.webui_secret_key', 'utf-8').trim();
const db = new PrismaClient({ datasources: { db: { url } } });
const auth = await db.auth.findFirst();
const user = await db.user.findFirst({ where: { id: auth.id } });
const token = jwt.sign(
  { id: auth.id, role: user?.role ?? 'user', email: auth.email ?? '', name: user?.name ?? '', session_stamp: auth.session_stamp ?? undefined, typ: 'session' },
  secret,
  { algorithm: 'HS256', expiresIn: '2h' }
);
console.log('TOKEN:' + token);
await db.$disconnect();
