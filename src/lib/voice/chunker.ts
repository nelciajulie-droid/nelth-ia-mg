/**
 * Intelligent streaming sentence chunker — consumes LLM tokens and emits
 * natural TTS segments (mission §8).
 *
 * Guarantees:
 *   - Sentence boundary detection (. ! ? … ;) — segments end cleanly.
 *   - Punctuation-driven fallback: a comma splits an over-long clause.
 *   - Minimum segment size (never send "Ok." alone when more is coming)
 *     and maximum segment size (hard split on word boundary).
 *   - Abbreviations (M., Mme., Dr., etc., e.g., approx.) never close a
 *     segment.
 *   - Decimal numbers (3,14 / 3.14) never split.
 *   - Markdown cleanup (**bold**, `code`, lists, headings) and URL
 *     flattening — TTS reads words, not syntax.
 *   - Final flush() emits the trailing incomplete segment.
 *   - Ordered sequence ids + bounded downstream queue (backpressure is the
 *     manager's duty: it awaits each TTS segment before pulling further).
 */

const MIN_CHARS = 24;
const MAX_CHARS = 220;

/** Abbreviation dots that must NOT close a sentence. */
const ABBREVIATIONS = [
  'M.', 'Mme.', 'Dr.', 'Pr.', 'Sr.', 'Jr.', 'Mr.', 'Mrs.', 'Ms.', 'St.',
  'etc.', 'ex.', 'approx.', 'cf.', 'e.g.', 'i.e.', 'vs.', 'p.', 'pp.',
  'no.', 'n°.', 'art.', 'vol.', 'fig.', 'min.', 'max.', 'sec.', 'lundi.', // day guards
];

export function cleanForTts(raw: string): string {
  let text = raw;
  // Markdown decorations → plain words.
  text = text.replace(/```[\s\S]*?```/g, ' '); // fenced code blocks → drop
  text = text.replace(/`([^`]+)`/g, '$1'); // inline code
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // images
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // links → label
  text = text.replace(/https?:\/\/\S+/g, ' lien '); // bare URLs → spoken word
  text = text.replace(/[*_#~>|]/g, ' '); // emphasis / heading markers
  text = text.replace(/\s*[-•]\s+/g, ', '); // list bullets → small pause
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function isSentenceEnd(text: string, idx: number): boolean {
  const ch = text[idx];
  if ('.!?…'.includes(ch)) {
    // Decimal guard: digit on both sides ("3.14").
    if (ch === '.' && idx > 0 && /\d/.test(text[idx - 1]) && idx + 1 < text.length && /\d/.test(text[idx + 1])) return false;
    // Abbreviation guard: the token ending at idx (ignoring case).
    const before = text.slice(Math.max(0, idx - 8), idx + 1);
    const hit = ABBREVIATIONS.find((a) => before.toLowerCase().endsWith(a.toLowerCase()));
    if (hit) return false;
    return true;
  }
  if (ch === ';' || ch === ':') return true; // natural pause boundaries
  return false;
}

export class SentenceChunker {
  private buffer = '';
  private seq = 0;

  /** Feed a raw LLM token; returns COMPLETE segments ready for TTS. */
  push(token: string): { sequenceId: number; text: string }[] {
    this.buffer += token;
    const out: { sequenceId: number; text: string }[] = [];
    let text = this.buffer;

    for (let i = MIN_CHARS; i < text.length; i++) {
      if (isSentenceEnd(text, i)) {
        const segment = text.slice(0, i + 1);
        text = text.slice(i + 1);
        const clean = cleanForTts(segment);
        this.buffer = text;
        if (clean.length >= 4) out.push({ sequenceId: ++this.seq, text: clean });
        i = MIN_CHARS; // rescan from the new buffer (cheap, buffers ≤ few KB)
        continue;
      }
      // Over-long clause without sentence end → comma split.
      if (i >= MAX_CHARS && /[,)]\s/.test(text.slice(i - 2, i + 1))) {
        const segment = text.slice(0, i + 1);
        text = text.slice(i + 1);
        const clean = cleanForTts(segment);
        this.buffer = text;
        if (clean.length >= 4) out.push({ sequenceId: ++this.seq, text: clean });
        i = MIN_CHARS;
        continue;
      }
    }

    // Hard cap without ANY boundary: split at a word boundary.
    if (this.buffer.length >= MAX_CHARS + 60) {
      const slice = this.buffer.slice(0, MAX_CHARS);
      const cut = Math.max(MIN_CHARS, slice.lastIndexOf(' '));
      const segment = slice.slice(0, cut);
      if (cleanForTts(segment).length >= 4) {
        this.buffer = this.buffer.slice(cut);
        out.push({ sequenceId: ++this.seq, text: cleanForTts(segment) });
      }
    }

    return out;
  }

  /** End of the LLM response — flush the trailing segment. */
  flush(): { sequenceId: number; text: string }[] {
    const clean = cleanForTts(this.buffer);
    this.buffer = '';
    if (clean.length >= 4) return [{ sequenceId: ++this.seq, text: clean }];
    return [];
  }
}
