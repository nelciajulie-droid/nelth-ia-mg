import { db } from '@/lib/db';
import { env } from '@/lib/constants';

/**
 * Embeddings — port of open_webui/utils/embeddings.py.
 *
 * Engine resolution (same as Python):
 *   RAG_EMBEDDING_ENGINE in {'', 'ollama', 'openai', 'openai_compatible'}
 *   ''  → local fallback (deviation: deterministic hash embedding, 256-d)
 *   ollama → /api/embeddings on the Ollama server
 *   openai / openai_compatible → OpenAI-compatible /embeddings endpoint
 */

const LOCAL_DIM = 256;

export function embeddingEngine(): string {
  return env.RAG_EMBEDDING_ENGINE;
}

export function embeddingModel(): string {
  return env.RAG_EMBEDDING_MODEL;
}

/** Deterministic local embedding fallback (small hosts: no GPU / no model download). */
function localEmbed(text: string): number[] {
  const vec = new Float64Array(LOCAL_DIM);
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % LOCAL_DIM;
    vec[idx] += 1;
    // second hash → spreads energy
    let h2 = 5381;
    for (let i = 0; i < tok.length; i++) h2 = (h2 * 33 + tok.charCodeAt(i)) >>> 0;
    vec[Math.abs(h2) % LOCAL_DIM] += 0.5;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < LOCAL_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => v / norm);
}

async function openAiEmbed(texts: string[], model: string): Promise<number[][]> {
  const baseUrl = env.RAG_OPENAI_API_BASE_URL || env.OPENAI_API_BASE_URL;
  const apiKey = process.env.RAG_OPENAI_API_KEY || env.OPENAI_API_KEY;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ input: texts, model }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Embedding API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.data as Array<{ embedding: number[] }>).map((d) => d.embedding).sort((a, b) => a[0] - b[0]) as number[][];
}

async function ollamaEmbed(texts: string[], model: string): Promise<number[][]> {
  const out: number[][] = [];
  for (const text of texts) {
    const res = await fetch(`${env.OLLAMA_API_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Ollama embedding error ${res.status}`);
    const data = await res.json();
    out.push(data.embedding as number[]);
  }
  return out;
}

/** Generate embeddings for a batch of texts. */
export async function generateEmbeddings(
  model: string,
  texts: string[],
  baseUrl?: string
): Promise<number[][]> {
  const engine = embeddingEngine();
  if (engine === 'openai' || engine === 'openai_compatible') {
    return openAiEmbed(texts, model);
  }
  if (engine === 'ollama') {
    return ollamaEmbed(texts, model);
  }
  // local fallback (documented deviation for serverless)
  return texts.map(localEmbed);
}

export async function generateEmbedding(model: string, text: string): Promise<number[]> {
  const [vec] = await generateEmbeddings(model, [text]);
  return vec;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------------------------------------------------------------------------
// Vector store — DB-backed chunks (serverless-friendly replacement for Chroma)
// ---------------------------------------------------------------------------

export type Chunk = {
  id: string;
  knowledge_id: string | null;
  file_id: string | null;
  collection_name: string;
  content: string;
  embedding: number[];
  metadata: Record<string, any>;
};

/** Store chunks + embeddings for a collection (replaces Chroma collection.add). */
export async function storeChunks(
  collectionName: string,
  items: Array<{ id: string; text: string; embedding: number[]; metadata: Record<string, any> }>,
  opts: { knowledgeId?: string | null; fileId?: string | null } = {}
): Promise<void> {
  await db.chunk.createMany({
    data: items.map((it) => ({
      id: it.id,
      collection_name: collectionName,
      knowledge_id: opts.knowledgeId ?? null,
      file_id: opts.fileId ?? null,
      content: it.text,
      embedding: JSON.stringify(it.embedding),
      metadata: JSON.stringify(it.metadata ?? {}),
    })),
  });
}

/** Query a collection by embedding similarity (replaces Chroma collection.query). */
export async function queryChunks(
  collectionName: string | string[],
  queryEmbedding: number[],
  k = 4
): Promise<Array<{ id: string; text: string; metadata: Record<string, any>; distance: number }>> {
  const names = Array.isArray(collectionName) ? collectionName : [collectionName];
  const rows = await db.chunk.findMany({ where: { collection_name: { in: names } } });
  const scored = rows.map((row) => {
    let embedding: number[];
    try {
      embedding = JSON.parse(row.embedding);
    } catch {
      embedding = [];
    }
    let metadata: Record<string, any> = {};
    try {
      metadata = JSON.parse(row.metadata ?? '{}');
    } catch {
      /* ignore */
    }
    return {
      id: row.id,
      text: row.content,
      metadata,
      distance: 1 - cosineSimilarity(queryEmbedding, embedding),
    };
  });
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, k);
}

export async function deleteChunksForFile(fileId: string): Promise<void> {
  await db.chunk.deleteMany({ where: { file_id: fileId } });
}

export async function deleteChunksForCollection(collectionName: string): Promise<void> {
  await db.chunk.deleteMany({ where: { collection_name: collectionName } });
}

export async function countChunksForCollection(collectionName: string): Promise<number> {
  return db.chunk.count({ where: { collection_name: collectionName } });
}
