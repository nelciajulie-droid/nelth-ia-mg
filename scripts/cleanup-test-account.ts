import { db } from '../src/lib/db';
import { Auths } from '../src/lib/models/auths';

async function main() {
  const user = await db.user.findFirst({ where: { email: 'nelth-parity-e2e@ethan-nairah.fr' } });
  if (!user) { console.log('déjà supprimé'); return; }
  const ok = await Auths.deleteAuthById(user.id);
  console.log('compte de test supprimé:', ok);
  const remaining = await db.user.findMany({ select: { email: true, role: true } });
  console.log('comptes restants:', remaining.map((u) => `${u.email} (${u.role})`).join(', '));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await (db as any).$disconnect?.(); });
