import { db } from '../src/lib/db';

/**
 * Nettoyage des comptes INVITÉS expirés (mode invité à la ChatGPT).
 *
 * Les invités sont des comptes anonymes jetables (guest-*@guests.nelth-ia.local)
 * créés par POST /api/v1/auths/guest. Ce script purge ceux inactifs depuis
 * plus de --days (défaut : 30, aligné sur le TTL du JWT invité) — chats,
 * fichiers et lignes dépendantes compris — pour garder la base saine.
 *
 * Usage : bun run scripts/cleanup-guests.ts [--days 30] [--dry-run]
 */

const GUEST_SUFFIX = '@guests.nelth-ia.local';

function parseArgs() {
  const args = process.argv.slice(2);
  let days = 30;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) days = parseInt(args[i + 1], 10);
    if (args[i] === '--dry-run') dryRun = true;
  }
  return { days, dryRun };
}

async function main() {
  const { days, dryRun } = parseArgs();
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 3600;

  const guests = await db.user.findMany({
    where: { email: { endsWith: GUEST_SUFFIX }, last_active_at: { lt: cutoff } },
    select: { id: true, email: true, last_active_at: true },
  });

  console.log(`guests inactive since < ${new Date(cutoff * 1000).toISOString()}: ${guests.length}`);
  if (!guests.length || dryRun) {
    if (dryRun) guests.forEach((g) => console.log('  (dry-run)', g.email));
    console.log(dryRun ? 'dry-run — nothing deleted.' : 'nothing to clean.');
    return;
  }

  let chatsRemoved = 0;
  let rowsRemoved = 0;

  for (const guest of guests) {
    const chatIds = (await db.chat.findMany({ where: { user_id: guest.id }, select: { id: true } })).map((c) => c.id);
    if (chatIds.length) {
      rowsRemoved += (await db.chatMessage.deleteMany({ where: { chat_id: { in: chatIds } } })).count;
      rowsRemoved += (await db.chatFile.deleteMany({ where: { chat_id: { in: chatIds } } })).count;
      rowsRemoved += (await db.sharedChat.deleteMany({ where: { chat_id: { in: chatIds } } })).count;
      rowsRemoved += (await db.chat.deleteMany({ where: { id: { in: chatIds } } })).count;
      chatsRemoved += chatIds.length;
    }

    const fileIds = (await db.file.findMany({ where: { user_id: guest.id }, select: { id: true } })).map((f) => f.id);
    if (fileIds.length) {
      rowsRemoved += (await db.chatFile.deleteMany({ where: { file_id: { in: fileIds } } })).count;
      await db.knowledgeFile.deleteMany({ where: { file_id: { in: fileIds } } });
      rowsRemoved += (await db.file.deleteMany({ where: { id: { in: fileIds } } })).count;
    }

    for (const model of ['folder', 'note', 'memory', 'apiKey', 'groupMember', 'imageItem'] as const) {
      try {
        rowsRemoved += (await (db as any)[model].deleteMany({ where: { user_id: guest.id } })).count;
      } catch {
        /* model may not carry user_id */
      }
    }
    try {
      rowsRemoved += (await db.auth.deleteMany({ where: { id: guest.id } })).count;
    } catch {
      /* no auth row */
    }
    rowsRemoved += (await db.user.deleteMany({ where: { id: guest.id } })).count;
    console.log('  removed', guest.email);
  }

  console.log(`guests removed: ${guests.length} | chats: ${chatsRemoved} | related rows: ${rowsRemoved}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
