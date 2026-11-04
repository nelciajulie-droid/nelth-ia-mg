import type { ApiUser } from '@/lib/auth';
import type { ChatForm, ChatPayloadMetadata } from '@/lib/chat/pipeline';

/**
 * RAG injection — port of the chat context part of
 * open_webui/utils/middleware.py (files/knowledge → retrieved context added to
 * the last user message before generation).
 */

export async function ragInjectContext(
  user: ApiUser,
  form: ChatForm,
  metadata: ChatPayloadMetadata
): Promise<void> {
  const lastIdx = form.messages.length - 1;
  if (lastIdx < 0) return;
  const last = form.messages[lastIdx];
  if (last.role !== 'user') return;

  const fileIds: string[] = [
    ...(Array.isArray(metadata.files) ? metadata.files : []),
    ...(Array.isArray(last.files) ? last.files.map((f: any) => f?.id ?? f).filter(Boolean) : []),
  ];
  if (!fileIds.length) return;

  try {
    const { queryChunks, generateEmbedding } = await import('@/lib/retrieval/embeddings');
    const { db } = await import('@/lib/db');

    const files = await db.file.findMany({ where: { id: { in: fileIds } } });
    if (!files.length) return;

    const collectionNames = files.map((f) => `file-${f.id}`);
    const query = typeof last.content === 'string' ? last.content : '';
    const embedding = await generateEmbedding('default', query);
    const results = await queryChunks(collectionNames, embedding, 6);

    if (!results.length) return;

    const context = results.map((r) => r.text).join('\n\n');
    const citations = files.map((f) => ({
      source: { name: f.filename ?? f.id, type: 'file' },
      file: { id: f.id, name: f.filename ?? '' },
      content: results.find((r) => r.metadata?.file_id === f.id)?.text ?? '',
    }));

    const content = `<context>\n${context}\n</context>\n\n${query}`;
    form.messages[lastIdx] = { ...last, content } as typeof last;
    metadata.citations = citations;
  } catch (e) {
    console.error('[rag] injection failed', e);
  }
}
