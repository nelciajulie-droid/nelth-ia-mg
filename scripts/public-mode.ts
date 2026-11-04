import { db } from '../src/lib/db';

/**
 * PUBLIC-APP MODE migration (one-shot):
 *   - the admin role is removed: every account becomes an equal 'user'
 *   - pending accounts are activated as 'user'
 * After this, no account can reach the admin panel routes (auth:'admin' → 403).
 */
async function main() {
  const admins = await db.user.findMany({ where: { role: 'admin' }, select: { email: true } });
  const r1 = await db.user.updateMany({ where: { role: 'admin' }, data: { role: 'user' } });
  const r2 = await db.user.updateMany({ where: { role: 'pending' }, data: { role: 'user' } });
  console.log(`Demoted ${r1.count} admin account(s): ${admins.map((a) => a.email).join(', ')}`);
  console.log(`Activated ${r2.count} pending account(s)`);
  const users = await db.user.findMany({ select: { email: true, role: true } });
  console.log('Final roles:', JSON.stringify(users.map((u) => ({ email: u.email, role: u.role })), null, 1));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await (db as any).$disconnect?.(); });
