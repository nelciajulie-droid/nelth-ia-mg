/**
 * Text chunking — port of the splitter stack used by
 * open_webui/routers/retrieval.py::save_docs_to_vector_db
 * (langchain RecursiveCharacterTextSplitter with add_start_index=True).
 *
 * Behaviour (character splitter, rag.text_splitter in {'', 'character'}):
 *   - separators: ["\n\n", "\n", ".", " ", ""]
 *   - recursive: pick the first separator present in the text; split with the
 *     separator kept at the START of the following piece (keep_separator=True);
 *     any piece longer than chunk_size is re-split with the remaining
 *     separators; short pieces are merged back with overlap.
 *   - 'token' / 'token_transformers' splitters fall back to this character
 *     splitter (no tiktoken/transformers in the serverless runtime —
 *     documented deviation).
 */

export type ChunkDocument = {
  page_content: string;
  metadata: Record<string, any>;
};

export const DEFAULT_SEPARATORS: string[] = ['\n\n', '\n', '.', ' ', ''];

export type SplitOptions = {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: string[];
  /** set false to skip the `start_index` metadata (add_start_index parity) */
  trackStartIndex?: boolean;
};

/** Split `text` keeping `separator` at the start of subsequent pieces. */
function splitWithSeparator(text: string, separator: string): string[] {
  if (separator === '') {
    return Array.from(text);
  }
  // Equivalent of python re.split(f'(?={re.escape(separator)})', text):
  // every occurrence of `separator` becomes the start of a new piece.
  const out: string[] = [];
  let pieceStart = 0;
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf(separator, searchFrom);
    if (idx === -1) {
      out.push(text.slice(pieceStart));
      break;
    }
    out.push(text.slice(pieceStart, idx));
    pieceStart = idx;
    searchFrom = idx + separator.length;
  }
  return out.filter((s) => s !== '');
}

/** Port of _merge_splits: join pieces (separator already embedded) honoring size + overlap. */
function mergeSplits(splits: string[], chunkSize: number, chunkOverlap: number): string[] {
  // keep_separator=True → the separator used for re-joining is '' (it is
  // already embedded in the pieces).
  const separatorLen = 0;
  const docs: string[] = [];
  let currentDoc: string[] = [];
  let total = 0;

  const pushDoc = () => {
    if (currentDoc.length === 0) return;
    const doc = currentDoc.join('');
    if (doc.trim().length > 0) docs.push(doc);
  };

  for (const d of splits) {
    const len = d.length;
    if (len === 0) continue;
    if (total + len + (currentDoc.length ? separatorLen : 0) > chunkSize) {
      if (total > chunkSize) {
        // python warns here; single oversized piece handled by recursion
      }
      if (currentDoc.length > 0) {
        pushDoc();
        // pop from the front while overlap is exceeded
        while (
          total > chunkOverlap ||
          (total + len + (currentDoc.length ? separatorLen : 0) > chunkSize && total > 0)
        ) {
          total -= currentDoc[0].length + (currentDoc.length > 1 ? separatorLen : 0);
          currentDoc = currentDoc.slice(1);
        }
      }
    }
    currentDoc.push(d);
    total += len + (currentDoc.length > 1 ? separatorLen : 0);
  }
  pushDoc();
  return docs;
}

/** Port of RecursiveCharacterTextSplitter._split_text. */
export function recursiveSplit(
  text: string,
  opts: SplitOptions = {}
): string[] {
  const chunkSize = opts.chunkSize ?? 1000;
  const chunkOverlap = opts.chunkOverlap ?? 100;
  const separators = opts.separators ?? DEFAULT_SEPARATORS;

  const finalChunks: string[] = [];
  // pick the first separator that occurs in the text (empty string matches all)
  let separator = separators.length > 0 ? separators[separators.length - 1] : '';
  let newSeparators: string[] = [];
  for (let i = 0; i < separators.length; i++) {
    const s = separators[i];
    if (s === '') {
      separator = s;
      break;
    }
    if (text.includes(s)) {
      separator = s;
      newSeparators = separators.slice(i + 1);
      break;
    }
  }

  const splits = splitWithSeparator(text, separator);
  const goodSplits: string[] = [];

  for (const s of splits) {
    if (s.length < chunkSize) {
      goodSplits.push(s);
    } else {
      if (goodSplits.length > 0) {
        finalChunks.push(...mergeSplits(goodSplits, chunkSize, chunkOverlap));
        goodSplits.length = 0;
      }
      if (newSeparators.length === 0) {
        finalChunks.push(s);
      } else {
        finalChunks.push(...recursiveSplit(s, { ...opts, separators: newSeparators }));
      }
    }
  }
  if (goodSplits.length > 0) {
    finalChunks.push(...mergeSplits(goodSplits, chunkSize, chunkOverlap));
  }
  return finalChunks;
}

/**
 * Split documents into chunks — port of text_splitter.split_documents(docs)
 * with add_start_index=True (chunk offsets recorded via text.indexOf scan).
 */
export function splitDocuments(docs: ChunkDocument[], opts: SplitOptions = {}): ChunkDocument[] {
  const out: ChunkDocument[] = [];
  for (const doc of docs) {
    const chunks = recursiveSplit(doc.page_content, opts);
    if (opts.trackStartIndex !== false) {
      let index = 0;
      for (const chunk of chunks) {
        index = doc.page_content.indexOf(chunk, index);
        out.push({
          page_content: chunk,
          metadata: { ...doc.metadata, start_index: index },
        });
        if (index >= 0) index += chunk.length;
      }
    } else {
      for (const chunk of chunks) {
        out.push({ page_content: chunk, metadata: { ...doc.metadata } });
      }
    }
  }
  return out;
}

/**
 * Merge undersized chunks up to `chunkSize` — port of merge_docs_to_target_size /
 * can_merge_chunks (used when rag.chunk_min_size_target > 0). Chunks are only
 * merged when they share the same source and file_id metadata.
 */
export function mergeDocsToTargetSize(
  chunks: ChunkDocument[],
  opts: { chunkSize: number; minSize: number }
): ChunkDocument[] {
  const { chunkSize, minSize } = opts;
  if (minSize <= 0) return chunks;
  const measure = (s: string) => s.length;

  const mergeBackward = (result: ChunkDocument[], content: string, chunk: ChunkDocument): boolean => {
    if (result.length === 0) return false;
    const prev = result[result.length - 1];
    if (!canMergeChunks(prev, chunk)) return false;
    const merged = `${prev.page_content}\n\n${content}`;
    if (measure(merged) > chunkSize) return false;
    result[result.length - 1] = { page_content: merged, metadata: { ...prev.metadata } };
    return true;
  };

  const emit = (result: ChunkDocument[], content: string, chunk: ChunkDocument) => {
    const undersized = measure(content) < minSize;
    if (undersized && mergeBackward(result, content, chunk)) return;
    result.push({ page_content: content, metadata: { ...chunk.metadata } });
  };

  const result: ChunkDocument[] = [];
  let currentChunk: ChunkDocument | null = null;
  let currentContent = '';

  for (const nextChunk of chunks) {
    if (currentChunk === null) {
      currentChunk = nextChunk;
      currentContent = nextChunk.page_content;
      continue;
    }
    const mergedContent = `${currentContent}\n\n${nextChunk.page_content}`;
    const canMergeForward =
      canMergeChunks(currentChunk, nextChunk) &&
      measure(currentContent) < minSize &&
      measure(mergedContent) <= chunkSize;
    if (canMergeForward) {
      currentContent = mergedContent;
    } else {
      emit(result, currentContent, currentChunk);
      currentChunk = nextChunk;
      currentContent = nextChunk.page_content;
    }
  }
  if (currentChunk !== null) {
    emit(result, currentContent, currentChunk);
  }
  return result;
}

function canMergeChunks(a: ChunkDocument, b: ChunkDocument): boolean {
  if (a.metadata['source'] !== b.metadata['source']) return false;
  const aFile = a.metadata['file_id'];
  const bFile = b.metadata['file_id'];
  if (aFile !== undefined && aFile !== null && bFile !== undefined && bFile !== null) {
    return aFile === bFile;
  }
  return true;
}
