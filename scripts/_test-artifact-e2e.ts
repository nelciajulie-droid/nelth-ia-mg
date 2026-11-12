/**
 * LOCAL E2E (sandbox): one chat turn → document file + ```html artifact in
 * the persisted message (the native code-preview artifact), llm_content
 * intact, documents API + exports alive.
 */
const BASE = 'http://localhost:3000';

async function api(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function assert(cond: boolean, label: string, extra = '') {
  if (!cond) {
    console.error('✗ FAIL:', label, extra);
    process.exit(1);
  }
  console.log('✓', label, extra);
}

// 1. session
const email = `artifact-e2e-${Date.now()}@nelth-ia-test.local`;
const signup = await api('/api/v1/auths/signup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Artifact E2E', email, password: 'test-password-123' }),
});
assert(signup.status === 200 && signup.body?.token, 'signup + token');
const auth = { authorization: `Bearer ${signup.body.token}` };

// 2. chat
const chat = await api('/api/v1/chats/new', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ chat: { title: 'E2E artefact' } }),
});
assert(chat.status === 200 && chat.body?.id, 'chat created');
const chatId = chat.body.id;

// 3. models → prefer a model that reliably emits ```document blocks
const models = await api('/api/models', { headers: auth });
const all: string[] = (models.body?.data ?? []).map((m: any) => m.id);
const modelId =
  all.find((id) => /nemotron/i.test(id)) ?? all.find((id) => !/dots-studio/i.test(id)) ?? all[0];
assert(!!modelId, 'model resolved', String(modelId));

// 4. one document turn (non-streaming keeps the assertion surface simple)
const assistantId = crypto.randomUUID();
const userWireId = crypto.randomUUID();
const prompt =
  "Crée-moi un document Word professionnel : un mini rapport intitulé « Essai artefact » avec une brève introduction, un tableau de deux lignes et une conclusion courte.";
const turn = await api('/api/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: prompt }],
    chat_id: chatId,
    id: assistantId,
    user_message: { id: userWireId, role: 'user', content: prompt },
  }),
});
assert(turn.status === 200, 'chat turn 200', String(turn.status).slice(0, 40));
const files: any[] = turn.body?.files ?? [];
assert(files.length >= 1, 'document file generated', `${files.length} file(s)`);
assert(files.every((f) => !('artifact_html' in f)), 'files clean of artifact_html');
const docFile = files.find((f) => f.document_id);
assert(!!docFile, 'documents-engine doc present', docFile?.document_type ?? '');

// 5. persisted message — the native ```html artifact rides the content
const detail = await api(`/api/v1/chats/${chatId}`, { headers: auth });
const messages = detail.body?.chat?.history?.messages ?? {};
const asst = messages[assistantId];
assert(!!asst, 'assistant message persisted');
assert(
  typeof asst.content === 'string' && asst.content.includes('```html') && asst.content.includes('<!--nelth-doc-artifact:'),
  'artifact block in message content',
  `${(asst.content.match(/```html/g) || []).length} html block(s)`
);
assert(!String(asst.content).includes('```document'), 'no raw document block left in content');
assert(
  typeof asst.meta?.llm_content === 'string' && asst.meta.llm_content.includes('```document'),
  'llm_context keeps the raw document block (no html bloat)'
);
assert(
  !String(asst.meta?.llm_content ?? '').includes('<!--nelth-doc-artifact:'),
  'llm_context free of artifact html'
);

// 6. documents API + export
const docId = docFile.document_id;
const docDetail = await api(`/api/v1/documents/${docId}`, { headers: auth });
assert(docDetail.status === 200 && docDetail.body?.document?.title, 'document detail', docDetail.body?.document?.title ?? '');
for (const fmt of ['pdf', 'docx', 'pptx']) {
  const res = await fetch(`${BASE}/api/v1/documents/${docId}/export?format=${fmt}`, { headers: auth });
  const buf = await res.arrayBuffer();
  assert(res.status === 200 && buf.byteLength > 800, `export ${fmt} (${buf.byteLength} bytes)`);
}

console.log('\nE2E OK — chat turn → native ```html artifact + clean files + exports');
process.exit(0);
