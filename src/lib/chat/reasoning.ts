/**
 * Reasoning (thinking) support — port of the Python middleware's tag handling
 * (open_webui/utils/middleware.py DEFAULT_REASONING_TAGS + tag_output_handler).
 *
 * Two reasoning sources are supported:
 *  1. Tag-based: models that wrap their chain-of-thought in `<thinking>` (and
 *     sibling) tags inside the content stream — detected across chunk
 *     boundaries and converted into structured output items.
 *  2. Native: OpenAI-compatible gateways (the built-in Kilo AI Gateway) that
 *     stream the chain-of-thought in a dedicated `delta.reasoning` /
 *     `delta.reasoning_content` field, separate from `delta.content`.
 * Both are converted into the structured Open WebUI v0.12.5
 * `output` items (`{type:'reasoning', …}` + `{type:'message', …}`) that the
 * compiled frontend renders as the collapsible "Thinking… / Thought for N
 * seconds" block (chunks/C7aR8OSY.js → vASsNUVb.js).
 *
 * Emission contract (frontend chunks/BwPFp-FS.js `yl` handler):
 *   chat:completion {done:false, output:[…]}  → D.output = output,
 *   D.content = mo(output) (message items only). A plain-`choices` delta is
 *   NOT sent once structured mode is active, otherwise content would double.
 */

// Python middleware DEFAULT_REASONING_TAGS (verbatim; kept for parity with
// upstream — some providers still emit raw tags in the content stream).
export const REASONING_TAG_PAIRS: Array<[string, string]> = [
  ['<thinking>', '</thinking>'],
  ['<reason>', '</reason>'],
  ['<reasoning>', '</reasoning>'],
  ['<thought>', '</thought>'],
  ['<Thought>', '</Thought>'],
  ['<|begin_of_thought|>', '<|end_of_thought|>'],
  ['◁think▷', '◁/think▷'],
  ['<think>', '</think>'],
];

// ---------------------------------------------------------------------------
// Tag matching (angle tags allow attributes: <thinking foo="bar">)
// ---------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type TagMatcher = { start: RegExp; end: string; startRaw: string };

const MATCHERS: TagMatcher[] = REASONING_TAG_PAIRS.map(([start, end]) => {
  if (start.startsWith('<') && start.endsWith('>') && !start.includes(' ')) {
    const name = escapeRe(start.slice(1, -1));
    return { start: new RegExp(`<${name}(\\s[^>\\n]*)?>`), end, startRaw: start };
  }
  return { start: new RegExp(escapeRe(start)), end, startRaw: start };
});

/** Longest suffix of `text` that is a strict prefix of any start tag. */
function partialTagSuffixLen(text: string): number {
  let best = 0;
  for (const m of MATCHERS) {
    const s = m.startRaw;
    for (let k = s.length - 1; k >= 1; k--) {
      if (text.endsWith(s.slice(0, k))) {
        if (k > best) best = k;
        break;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

export type Segment = { kind: 'text' | 'reasoning'; text: string; closed: boolean };

export type OutputTextPart = { type: 'output_text'; text: string };

export type OutputItem = {
  type: 'reasoning' | 'message';
  id: string;
  status: 'in_progress' | 'completed';
  role?: string;
  start_tag?: string;
  end_tag?: string;
  attributes?: Record<string, string>;
  content: OutputTextPart[];
  summary?: null;
  started_at?: number;
  ended_at?: number;
  duration?: number;
};

/**
 * Split accumulated text into ordered segments. Tag pairs are matched
 * sequentially; an unclosed reasoning tag consumes the rest of the text.
 */
export function segmentReasoning(text: string): { segments: Segment[]; tagSeen: boolean } {
  const segments: Segment[] = [];
  let tagSeen = false;
  let pos = 0;

  for (;;) {
    // earliest start-tag match at/after pos
    let best: { index: number; end: number; endTag: string } | null = null;
    for (const m of MATCHERS) {
      const re = new RegExp(m.start.source, 'g');
      re.lastIndex = 0;
      const hit = re.exec(text.slice(pos));
      if (hit && (best === null || pos + hit.index < best.index)) {
        best = { index: pos + hit.index, end: pos + hit.index + hit[0].length, endTag: m.end };
      }
    }
    if (!best) {
      const rest = text.slice(pos);
      if (rest) segments.push({ kind: 'text', text: rest, closed: true });
      break;
    }
    const pre = text.slice(pos, best.index);
    if (pre) segments.push({ kind: 'text', text: pre, closed: true });
    tagSeen = true;
    const closeIdx = text.indexOf(best.endTag, best.end);
    if (closeIdx === -1) {
      segments.push({ kind: 'reasoning', text: text.slice(best.end), closed: false });
      break;
    }
    segments.push({ kind: 'reasoning', text: text.slice(best.end, closeIdx), closed: true });
    pos = closeIdx + best.endTag.length;
  }
  return { segments, tagSeen };
}

function hexId(prefix: string, index: number): string {
  const h = (index * 2654435761 >>> 0).toString(16).padStart(8, '0');
  const r = (Math.abs(hashString(prefix + index)) >>> 0).toString(16).padStart(8, '0');
  return `${prefix}_${h}${r}`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Clean content = message segments joined (matches frontend `mo`/F function). */
export function cleanContentOf(segments: Segment[]): string {
  return segments
    .filter((s) => s.kind === 'text' && s.text.trim())
    .map((s) => s.text)
    .join('\n');
}

/** Strip reasoning tags from a complete text (non-streaming convenience). */
export function stripReasoningTags(text: string): string {
  const { segments } = segmentReasoning(text);
  return cleanContentOf(segments);
}

// ---------------------------------------------------------------------------
// Streaming accumulator
// ---------------------------------------------------------------------------

export type PushResult = {
  mode: 'plain' | 'structured';
  switched: boolean;
  /** plain mode: newly-safe text to emit as a choices delta (may be '') */
  plainDelta?: string;
};

export type FinishResult = {
  usedStructured: boolean;
  output: OutputItem[] | null;
  /** clean content (tags stripped) */
  content: string;
};

/**
 * Accumulates streamed content, switching from plain-`choices` emission to
 * structured `output` snapshots the moment a reasoning tag is detected. While
 * in plain mode a trailing partial tag prefix is held back so the literal tag
 * text never flashes in the UI.
 */
export class ReasoningAccumulator {
  private text = '';
  private emittedPlain = 0;
  private mode: 'plain' | 'structured' = 'plain';
  private segFirstSeen: number[] = [];
  private segClosedAt: number[] = [];

  push(delta: string, now = Date.now()): PushResult {
    this.text += delta;
    if (this.mode === 'structured') {
      return { mode: 'structured', switched: false };
    }
    const { tagSeen } = segmentReasoning(this.text);
    if (tagSeen) {
      this.mode = 'structured';
      this.markTimings(now);
      return { mode: 'structured', switched: true };
    }
    // plain mode: hold back a potential partial tag at the end
    const hold = partialTagSuffixLen(this.text);
    const safeLen = this.text.length - hold;
    if (safeLen > this.emittedPlain) {
      const plainDelta = this.text.slice(this.emittedPlain, safeLen);
      this.emittedPlain = safeLen;
      return { mode: 'plain', switched: false, plainDelta };
    }
    return { mode: 'plain', switched: false, plainDelta: '' };
  }

  /** Structured snapshot (full output array) — call only in structured mode. */
  snapshot(now = Date.now(), allDone = false): OutputItem[] {
    const { segments } = segmentReasoning(this.text);
    this.markTimings(now, segments);
    return buildOutputItems(segments, this.segFirstSeen, this.segClosedAt, now, allDone);
  }

  finish(now = Date.now()): FinishResult {
    if (this.mode !== 'structured') {
      return { usedStructured: false, output: null, content: this.text };
    }
    const { segments } = segmentReasoning(this.text);
    this.markTimings(now, segments);
    const output = buildOutputItems(segments, this.segFirstSeen, this.segClosedAt, now, true);
    return { usedStructured: true, output, content: cleanContentOf(segments) };
  }

  private markTimings(now: number, segments?: Segment[]): void {
    const segs = segments ?? segmentReasoning(this.text).segments;
    segs.forEach((seg, i) => {
      if (this.segFirstSeen[i] === undefined) this.segFirstSeen[i] = now;
      if (seg.kind === 'reasoning' && seg.closed && this.segClosedAt[i] === undefined) {
        this.segClosedAt[i] = now;
      }
    });
  }
}

function buildOutputItems(
  segments: Segment[],
  segFirstSeen: number[],
  segClosedAt: number[],
  now: number,
  allDone: boolean
): OutputItem[] {
  const out: OutputItem[] = [];
  segments.forEach((seg, i) => {
    if (!seg.text.trim()) return;
    if (seg.kind === 'reasoning') {
      const startedMs = segFirstSeen[i] ?? now;
      const endedMs = seg.closed ? segClosedAt[i] ?? now : undefined;
      out.push({
        type: 'reasoning',
        id: hexId('r', i),
        status: seg.closed || allDone ? 'completed' : 'in_progress',
        start_tag: '<thinking>',
        end_tag: '</thinking>',
        attributes: { type: 'reasoning_content' },
        content: [{ type: 'output_text', text: seg.text }],
        summary: null,
        started_at: startedMs / 1000,
        ...(endedMs !== undefined
          ? { ended_at: endedMs / 1000, duration: Math.max(0, Math.round((endedMs - startedMs) / 1000)) }
          : {}),
      });
    } else {
      out.push({
        type: 'message',
        id: hexId('m', i),
        status: allDone ? 'completed' : 'in_progress',
        role: 'assistant',
        content: [{ type: 'output_text', text: seg.text }],
      });
    }
  });
  return out;
}

/** Parse a complete (non-streaming) response content into output items. */
export function parseCompleteOutput(content: string, startedAt = Date.now()): OutputItem[] {
  const { segments, tagSeen } = segmentReasoning(content);
  if (!tagSeen) return [];
  const firstSeen = segments.map(() => startedAt);
  const closedAt = segments.map((s, i) => (s.kind === 'reasoning' && s.closed ? startedAt : NaN));
  return buildOutputItems(segments, firstSeen, closedAt, startedAt, true);
}

// ---------------------------------------------------------------------------
// Native reasoning (OpenAI-compatible gateways streaming `delta.reasoning`)
// ---------------------------------------------------------------------------

/**
 * Accumulates a native reasoning channel (`delta.reasoning` /
 * `delta.reasoning_content`) separately from the content channel
 * (`delta.content`), and emits full structured `output` snapshots —
 * one reasoning item followed by one message item — following the exact
 * same emission contract as the tag-based accumulator above.
 */
export class NativeReasoningAccumulator {
  private reasoningText = '';
  private contentText = '';
  private reasoningFirstAt: number | null = null;
  private reasoningEndedAt: number | null = null;
  private contentFirstAt: number | null = null;

  /** True once any reasoning text has been received (structured mode). */
  get active(): boolean {
    return this.reasoningText.length > 0;
  }

  pushReasoning(delta: string, now = Date.now()): void {
    if (!delta) return;
    if (this.reasoningFirstAt === null) this.reasoningFirstAt = now;
    this.reasoningText += delta;
    // content already flowing → reasoning re-opened after the message
    if (this.contentFirstAt !== null && this.reasoningEndedAt === null) {
      this.reasoningEndedAt = now;
    }
  }

  pushContent(delta: string, now = Date.now()): void {
    if (!delta) return;
    if (this.contentFirstAt === null) {
      this.contentFirstAt = now;
      // the reasoning phase closes when the final answer starts
      if (this.reasoningFirstAt !== null && this.reasoningEndedAt === null) {
        this.reasoningEndedAt = now;
      }
    }
    this.contentText += delta;
  }

  /** Structured snapshot (full output array). */
  snapshot(now = Date.now(), allDone = false): OutputItem[] {
    if (!this.active && !this.contentText) return [];
    const items: OutputItem[] = [];
    const startedMs = this.reasoningFirstAt ?? now;
    const endedMs =
      this.reasoningEndedAt ?? (allDone && this.reasoningFirstAt !== null ? now : undefined);
    if (this.reasoningText) {
      items.push({
        type: 'reasoning',
        id: 'rs_native',
        status: endedMs !== undefined ? 'completed' : 'in_progress',
        start_tag: '<thinking>',
        end_tag: '</thinking>',
        attributes: { type: 'reasoning_content' },
        content: [{ type: 'output_text', text: this.reasoningText }],
        summary: null,
        started_at: startedMs / 1000,
        ...(endedMs !== undefined
          ? { ended_at: endedMs / 1000, duration: Math.max(0, Math.round((endedMs - startedMs) / 1000)) }
          : {}),
      });
    }
    if (this.contentText) {
      items.push({
        type: 'message',
        id: 'msg_native',
        status: allDone ? 'completed' : 'in_progress',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.contentText }],
      });
    }
    return items;
  }

  finish(now = Date.now()): FinishResult {
    if (!this.active) {
      return { usedStructured: false, output: null, content: this.contentText };
    }
    return { usedStructured: true, output: this.snapshot(now, true), content: this.contentText };
  }
}

/** Parse a complete (non-streaming) native reasoning + content pair. */
export function nativeReasoningOutputItems(
  reasoning: string,
  content: string,
  at = Date.now()
): OutputItem[] {
  if (!reasoning) return [];
  const acc = new NativeReasoningAccumulator();
  acc.pushReasoning(reasoning, at);
  acc.pushContent(content, at);
  return acc.snapshot(at, true);
}
