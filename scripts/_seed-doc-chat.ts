/**
 * SEED (sandbox verification): create a real user + a chat whose assistant
 * message carries a REAL generated document (file row + SDR + artifact html)
 * — exactly like the production pipeline, then print the credentials.
 */
const BASE = 'http://localhost:3000';
const email = `doc-ui-test-${Date.now()}@nelth-ia-test.local`;
const password = 'Test1234!';

const signup = await fetch(BASE + '/api/v1/auths/signup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Doc UI Test', email, password }),
});
const auth = await signup.json();
if (!auth?.token) { console.error('signup failed', auth); process.exit(1); }
console.log('user:', email);

const me = await (await fetch(BASE + '/api/v1/auths/', { headers: { authorization: 'Bearer ' + auth.token } })).json();
console.log('user id:', me.id);

const DOC_MD = `# Rapport d'activité — Studio Gamma

## Introduction

Ce **rapport trimestriel** présente les résultats de l'agence *Studio Gamma* sur le premier semestre. Il couvre les activités commerciales, la production et les perspectives.

## Chiffres clés

| Indicateur | T1 | T2 |
| --- | --- | --- |
| Chiffre d'affaires | 128 500 € | 152 300 € |
| Nouveaux clients | 9 | 14 |
| Marge nette | 21 % | 24 % |

### Analyse

La croissance est portée par le pôle **vidéo** et l'arrivée de deux comptes majeurs.

> Le second semestre s'annonce au-dessus des objectifs initiaux. — Direction

- Renforcer l'équipe production
- Lancer l'offre formation

## Conclusion

Le cap est bon, la trajectoire confirmée sur l'ensemble des indicateurs suivis ce semestre.
`;

const { generateDocumentFile } = await import('@/lib/document-generation');
const file = await generateDocumentFile(me, {
  filename: 'rapport-activite.pdf',
  content: DOC_MD,
  design: 'moderne',
}, { source: 'seed_test' });
if (!file?.document_id) { console.error('generation failed', file); process.exit(1); }
console.log('document id:', file.document_id, '· file:', file.name, '· artifact html:', (file.artifact_html || '').length, 'chars');

const assistantContent =
  "Voici le rapport d'activité trimestriel de Studio Gamma, prêt à consulter et à télécharger." +
  (file.artifact_html ? `\n\n\`\`\`html\n${file.artifact_html}\n\`\`\`` : '');

const chatForm = {
  chat: {
    title: 'Test aperçu document',
    history: {
      messages: {
        'seed-user-1': { role: 'user', content: "Génère le rapport d'activité de Studio Gamma en PDF" },
        'seed-assistant-1': {
          parentId: 'seed-user-1',
          role: 'assistant',
          content: assistantContent,
          done: true,
          files: [
            {
              type: 'file',
              id: file.id,
              url: file.url,
              name: file.name,
              size: file.size,
              content_type: file.content_type,
              document_id: file.document_id,
              doc_type: file.doc_type,
              template: file.template,
              language: file.language,
              title: file.title,
            },
          ],
          meta: { response_ended_at: Math.floor(Date.now() / 1000) },
        },
      },
      currentId: 'seed-assistant-1',
    },
  },
};
const create = await fetch(BASE + '/api/v1/chats/new', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.token },
  body: JSON.stringify(chatForm),
});
const chat = await create.json();
if (!chat?.id) { console.error('chat create failed', chat); process.exit(1); }
console.log('CHAT_ID=' + chat.id);
console.log('EMAIL=' + email);
console.log('PASSWORD=' + password);
console.log('TOKEN=' + auth.token);
