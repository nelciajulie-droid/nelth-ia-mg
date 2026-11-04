import { db } from '../src/lib/db';

const TEST_EMAIL = 'verify.browser@nelth-ai.app';

async function main() {
  const user = await db.user.findFirst({ where: { email: TEST_EMAIL } });
  if (!user) {
    console.log('no test user in DB — nothing to clean');
    return;
  }
  console.log('cleaning test user', user.id);

  const chats = await db.chat.findMany({ where: { user_id: user.id }, select: { id: true } });
  const chatIds = chats.map((c) => c.id);
  let rows = 0;
  if (chatIds.length) {
    rows += (await db.chatMessage.deleteMany({ where: { chat_id: { in: chatIds } } })).count;
    rows += (await db.chatFile.deleteMany({ where: { chat_id: { in: chatIds } } })).count;
    rows += (await db.sharedChat.deleteMany({ where: { chat_id: { in: chatIds } } })).count;
    rows += (await db.chat.deleteMany({ where: { id: { in: chatIds } } })).count;
  }
  console.log('chats removed:', chatIds.length, '| related rows:', rows);

  const files = await db.file.findMany({ where: { user_id: user.id }, select: { id: true } });
  const fileIds = files.map((f) => f.id);
  if (fileIds.length) {
    await db.chatFile.deleteMany({ where: { file_id: { in: fileIds } } });
    await db.knowledgeFile.deleteMany({ where: { file_id: { in: fileIds } } });
    await db.file.deleteMany({ where: { id: { in: fileIds } } });
  }
  console.log('files removed:', fileIds.length);

  for (const model of ['folder', 'note', 'memory', 'apiKey'] as const) {
    try {
      await (db as any)[model].deleteMany({ where: { user_id: user.id } });
    } catch {
      /* model may not carry user_id */
    }
  }
  try {
    await db.auth.deleteMany({ where: { user_id: user.id } });
  } catch {
    /* no auth row */
  }
  await db.user.deleteMany({ where: { id: user.id } });
  console.log('user deleted');

  const check = await db.user.findFirst({ where: { email: TEST_EMAIL } });
  console.log('DB clean:', check === null);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
