import { db } from '../src/lib/db';

async function main() {
  const users = await db.user.findMany({ select: { id: true, email: true, name: true, role: true, created_at: true } });
  console.log('=== USERS ===');
  for (const u of users) console.log(`${u.role.padEnd(8)} ${u.email} (${u.name}) id=${u.id.slice(0, 14)}…`);
  console.log('\n=== CONFIG (keys) ===');
  const configs = await db.config.findMany({ select: { key: true, value: true } });
  for (const c of configs) console.log(`${c.key} = ${String(c.value).slice(0, 150)}`);
  console.log('\n=== MODELS ===');
  const models = await db.model.findMany({ select: { id: true, name: true, user_id: true, is_active: true } });
  for (const m of models) console.log(`${m.id} owner=${m.user_id?.slice(0, 12)}… active=${m.is_active}`);
  console.log('\n=== ACCESS GRANTS (count) ===');
  const grants = await db.accessGrant.findMany();
  console.log('count:', grants.length);
  console.log('\n=== GROUPS ===');
  const groups = await db.group.findMany({ select: { id: true, name: true } });
  for (const g of groups) console.log(g.id, g.name);
  await (db as any).$disconnect?.();
}
main().catch(e => { console.error(e); process.exit(1); });
