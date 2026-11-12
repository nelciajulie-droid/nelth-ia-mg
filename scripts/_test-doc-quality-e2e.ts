/**
 * E2E sandbox verification: PREMIUM DOCUMENT QUALITY PASS through the REAL
 * chat pipeline (v12-flow → processGeneratedDocuments → enhance → files).
 *
 *   bun scripts/_test-doc-quality-e2e.ts
 *
 * The request deliberately uses the WEAK standard model — the quality pass
 * must lift its thin draft to expert level before the PDF is built.
 */

const BASE = process.env.E2E_BASE || 'http://localhost:3000';
const email = `doc-quality-e2e-${Date.now()}@nelth-ia-test.local`;

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};

// 1. Authenticate — a pre-minted token (sandbox SQLite user) or signup.
let token = process.env.E2E_TOKEN || '';
if (!token) {
  const su = await fetch(`${BASE}/api/v1/auths/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Doc Quality E2E', email, password: 'Passw0rd!e2e' }),
  });
  if (!su.ok) {
    console.error('signup failed:', su.status, (await su.text()).slice(0, 300));
    process.exit(1);
  }
  const auth: any = await su.json();
  token = auth.token;
}
console.log(`[e2e] authenticated${token ? ' (pre-minted token)' : ` as ${email}`}`);

// 2. Chat completion — WEAK model, explicit file request
const t0 = Date.now();
const res = await fetch(`${BASE}/api/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({
    model: 'dots-studio/dots-3-note-preview:free',
    messages: [
      {
        role: 'user',
        content:
          "Génère-moi un CV professionnel en PDF pour le poste de directrice commerciale senior dans une entreprise de distribution à Lubumbashi. Je m'appelle Grace Ilunga, 12 ans d'expérience dans le secteur FMCG.",
      },
    ],
    stream: false,
  }),
});
console.log(`[e2e] completion HTTP ${res.status} in ${Math.round((Date.now() - t0) / 1000)}s`);
if (!res.ok) {
  console.error('completion failed:', (await res.text()).slice(0, 400));
  process.exit(1);
}
const data: any = await res.json();

const content: string = data?.choices?.[0]?.message?.content ?? '';
const files: any[] = data?.files ?? [];
console.log(`[e2e] reply ${content.length} chars · ${files.length} file(s)`);
console.log('----- assistant reply (first 350 chars) -----');
console.log(content.slice(0, 350).replace(/\n{3,}/g, '\n\n'));
console.log('----- reply tail (last 300 chars) -----');
console.log(content.slice(-300).replace(/\n{3,}/g, '\n\n'));
const openFences = [...content.matchAll(/```[a-zA-Z0-9_-]+[^\n]*\n/g)].map((m) => m[0].slice(0, 70));
const closeFences = (content.match(/^```[ \t]*$/gm) || []).length;
console.log(`[e2e] fence diagnostics — openers: ${JSON.stringify(openFences)} · closers: ${closeFences}`);

check('assistant replied', content.trim().length > 20);
check('a downloadable file card exists', files.length >= 1);

const pdf = files.find((f) => String(f.name || '').toLowerCase().endsWith('.pdf'));
check('the file is the requested CV pdf', !!pdf, pdf ? `${pdf.name} · ${(pdf.size / 1024).toFixed(1)} KB` : 'no pdf');
if (pdf) {
  check(
    'pdf is rich (expert pass — > 12 KB)',
    (pdf.size ?? 0) > 12_000,
    `${(pdf.size / 1024).toFixed(1)} KB`
  );
  check('documents-engine envelope present', !!pdf.document_id, pdf.document_id ?? '');
  // Fetch the bytes — %PDF magic proves a real renderable document.
  const fileRes = await fetch(`${BASE}${pdf.url}`, { headers: { authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await fileRes.arrayBuffer());
  check('file bytes are a real PDF', buf.subarray(0, 4).toString() === '%PDF', `${buf.length} bytes · HTTP ${fileRes.status}`);
}
check(
  'no invented download link in the reply',
  !/https?:\/\/[^\s]*\.(pdf|docx|xlsx)/i.test(content),
);

console.log(failures ? `\nFAILURES: ${failures}` : '\nE2E CHECKS PASSED');
process.exit(failures ? 1 : 0);
