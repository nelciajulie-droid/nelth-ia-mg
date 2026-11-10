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
  private readonly dropReasoning: boolean;
  private droppedSomething = false;

  /**
   * Strict no-thinking tier (e.g. the TokenHarbor flash model, where thinking
   * is disabled at the model level): with `dropReasoning: true`, reasoning
   * segments are DISCARDED instead of structured — a chain-of-thought the
   * model leaks into the content stream never reaches the UI, and the clean
   * text keeps flowing as plain `choices` deltas (the mode never switches
   * to structured). This enforces the no-thinking contract on OUR side:
   * the wire-level `thinking: {type:'disabled'}` switch is only a request
   * hint, and hybrid models occasionally disobey it.
   */
  constructor(opts: { dropReasoning?: boolean } = {}) {
    this.dropReasoning = !!opts.dropReasoning;
  }

  /** True when reasoning segments were dropped (finish() content ≠ raw). */
  get dropped(): boolean {
    return this.dropReasoning && this.droppedSomething;
  }

  push(delta: string, now = Date.now()): PushResult {
    this.text += delta;
    if (this.dropReasoning) {
      const { segments, tagSeen } = segmentReasoning(this.text);
      if (tagSeen) this.droppedSomething = true;
      const clean = cleanContentOf(segments);
      // Hold back a trailing partial tag start — the same guarantee as plain
      // mode: the literal tag text never flashes while it may still
      // complete on a later chunk (and once completed, it is dropped).
      const hold = partialTagSuffixLen(clean);
      const safeLen = clean.length - hold;
      if (safeLen > this.emittedPlain) {
        const plainDelta = clean.slice(this.emittedPlain, safeLen);
        this.emittedPlain = safeLen;
        return { mode: 'plain', switched: false, plainDelta };
      }
      return { mode: 'plain', switched: false, plainDelta: '' };
    }
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
    if (this.dropReasoning) {
      // Drop mode: single message item built from the CLEAN text (used by
      // the incremental checkpoints — the leaked reasoning never lands in
      // the DB either).
      const clean = cleanContentOf(segmentReasoning(this.text).segments);
      return clean
        ? [
            {
              type: 'message',
              id: hexId('m', 0),
              status: allDone ? 'completed' : 'in_progress',
              role: 'assistant',
              content: [{ type: 'output_text', text: clean }],
            },
          ]
        : [];
    }
    const { segments } = segmentReasoning(this.text);
    this.markTimings(now, segments);
    return buildOutputItems(segments, this.segFirstSeen, this.segClosedAt, now, allDone);
  }

  finish(now = Date.now()): FinishResult {
    if (this.dropReasoning) {
      const clean = cleanContentOf(segmentReasoning(this.text).segments);
      return { usedStructured: false, output: null, content: clean };
    }
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
 *
 * Incremental providers stream the chain-of-thought LIVE: each delta grows
 * the reasoning item and the user watches the model think in real time. A
 * provider that buffers the reasoning server-side and delivers it as one
 * late burst gets the paced-reveal typing instead (advanceReveal). The
 * request-start anchor keeps the measured thinking duration honest in both
 * modes (the phase starts when the request is sent, not when chunks land).
 */
export class NativeReasoningAccumulator {
  private reasoningText = '';
  /** Chars of the buffered chain-of-thought currently visible in snapshots
   *  (paced reveal — decouples emission from ingestion for burst-style
   *  providers; see advanceReveal()). */
  private revealedChars = 0;
  private contentText = '';
  /** Request-send timestamp — anchors the reasoning phase (see announceThinking). */
  private requestStartedAt: number | null = null;
  /** Synthetic "Thinking…" placeholder is live (nothing real received yet). */
  private thinkingAnnounced = false;
  private reasoningFirstAt: number | null = null;
  private reasoningEndedAt: number | null = null;
  private contentFirstAt: number | null = null;
  /** Item-id suffix (continuation rounds): the frontend replaces the whole
   *  `output` array on every snapshot, so a continuation round's items must
   *  not collide with the interrupted round's persisted ids — a distinct
   *  suffix renders the second thinking phase as its own block while the
   *  (seeded) message item carries base+new content under one id. */
  private readonly itemSuffix: string;

  constructor(itemSuffix = '') {
    this.itemSuffix = itemSuffix;
  }

  /** True once any reasoning text has been received (structured mode). */
  get active(): boolean {
    return this.reasoningText.length > 0;
  }

  /** True while buffered reasoning text is still hidden by the paced reveal. */
  get revealPending(): boolean {
    return this.revealedChars < this.reasoningText.length;
  }

  /** True when the reasoning channel opened BEFORE any content flowed (the
   *  burst pattern) — the message item is then held back until the paced
   *  reveal completes so the "Thinking…" header (shimmer) lives for the
   *  whole replay instead of flipping to "Thought for 0 seconds" the
   *  instant the concurrent content stream adds a second output item. */
  private reasoningLedContent = false;

  /** True while the synthetic "Thinking…" placeholder is the only reasoning
   *  item on screen (announced, nothing real received yet). */
  get announced(): boolean {
    return this.thinkingAnnounced && !this.active && !this.contentText;
  }

  /**
   * Announce the thinking phase at the moment the upstream request starts.
   *   1. the live placeholder lets snapshot() render an in-progress
   *      "Thinking…" item during the silent phase (the gateway is quiet the
   *      whole time the model is thinking server-side);
   *   2. `requestStartedAt` anchors the duration: the first reasoning chunk
   *      is backdated to the request start, so the final "Thought for N
   *      seconds" reflects the REAL thinking time instead of the ~0s burst
   *      arrival span.
   * Idempotent; call clearAnnouncement() to retract (reasoning never came).
   */
  announceThinking(now = Date.now()): void {
    this.thinkingAnnounced = true;
    if (this.requestStartedAt === null) this.requestStartedAt = now;
  }

  /** Retract the placeholder — the caller emits an empty-output event so the
   *  frontend drops the block instead of keeping a stuck "Thinking…". */
  clearAnnouncement(): void {
    this.thinkingAnnounced = false;
  }

  /**
   * Paced reveal step — only relevant for burst-style providers that land
   * the whole chain-of-thought at once. Emitting a large burst as-is
   * produces an empty "Thinking…" block that fills within a single frame —
   * the user never sees the reasoning live. Instead the burst is re-emitted
   * progressively (~24 ticks ≈ 1-1.5s at the 90ms tick), giving the
   * o1-style "watch it think" experience. Incremental providers are
   * unaffected: their deltas are small, the reveal catches up with the
   * buffer within a tick or two and the text is effectively live.
   * Returns true while text remains hidden.
   */
  advanceReveal(): boolean {
    const total = this.reasoningText.length;
    if (this.revealedChars >= total) return false;
    // ~24 steps of the buffer: with the ticker (90ms) plus content-push
    // advancement both driving it, the replay spans roughly 1-1.5s — long
    // enough to read as live typing, short enough to never feel like a delay.
    const step = Math.max(8, Math.ceil(total / 24));
    this.revealedChars = Math.min(total, this.revealedChars + step);
    return this.revealedChars < total;
  }

  /** Reveal everything at once (final done event, persistence, non-streaming). */
  flushReveal(): void {
    this.revealedChars = this.reasoningText.length;
  }

  pushReasoning(delta: string, now = Date.now()): void {
    if (!delta) return;
    // Backdate the phase start to the request send — the gateway was silent
    // because the model was thinking server-side all along.
    if (this.reasoningFirstAt === null) this.reasoningFirstAt = this.requestStartedAt ?? now;
    if (!this.contentText) this.reasoningLedContent = true;
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

  /** Structured snapshot (full output array — reasoning text is the REVEALED
   *  slice; the item stays in_progress (shimmer, "Thinking…" header) until
   * the paced reveal completes, then flips to completed with its duration). */
  snapshot(now = Date.now(), allDone = false): OutputItem[] {
    if (!this.active && !this.contentText && !this.thinkingAnnounced) return [];
    const items: OutputItem[] = [];
    const startedMs = this.reasoningFirstAt ?? this.requestStartedAt ?? now;
    const revealDone = this.revealedChars >= this.reasoningText.length;
    let endedMs: number | undefined;
    if (revealDone && this.reasoningEndedAt !== null) {
      endedMs = this.reasoningEndedAt;
    } else if (allDone && this.reasoningFirstAt !== null) {
      endedMs = this.reasoningEndedAt ?? now;
    }
    if (this.reasoningText) {
      items.push({
        type: 'reasoning',
        id: 'rs_native' + this.itemSuffix,
        status: endedMs !== undefined ? 'completed' : 'in_progress',
        start_tag: '<thinking>',
        end_tag: '</thinking>',
        attributes: { type: 'reasoning_content' },
        content: [{ type: 'output_text', text: this.reasoningText.slice(0, this.revealedChars) }],
        summary: null,
        started_at: startedMs / 1000,
        ...(endedMs !== undefined
          ? { ended_at: endedMs / 1000, duration: Math.max(0, Math.round((endedMs - startedMs) / 1000)) }
          : {}),
      });
    } else if (this.thinkingAnnounced && !this.contentText && !allDone) {
      // Synthetic live placeholder — in_progress, no duration, empty text.
      // Replaced wholesale by the real snapshots once chunks arrive (the
      // emission contract is full-snapshot: D.output = output).
      items.push({
        type: 'reasoning',
        id: 'rs_native' + this.itemSuffix,
        status: 'in_progress',
        start_tag: '<thinking>',
        end_tag: '</thinking>',
        attributes: { type: 'reasoning_content' },
        content: [{ type: 'output_text', text: '' }],
        summary: null,
        started_at: startedMs / 1000,
      });
    }
    if (this.contentText && (revealDone || allDone || !this.reasoningLedContent)) {
      items.push({
        type: 'message',
        id: 'msg_native' + this.itemSuffix,
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
    // The final done event (and persistence) always carries the FULL text.
    this.flushReveal();
    return { usedStructured: true, output: this.snapshot(now, true), content: this.contentText };
  }
}

/** Parse a complete (non-streaming) native reasoning + content pair.
 * `at` = when the request was sent (reasoning phase anchor — backdated so
 * the duration reflects the real thinking time, not the ~0s arrival span),
 * `contentAt` = when the complete response arrived. */
export function nativeReasoningOutputItems(
  reasoning: string,
  content: string,
  at = Date.now(),
  contentAt = at
): OutputItem[] {
  if (!reasoning) return [];
  const acc = new NativeReasoningAccumulator();
  acc.pushReasoning(reasoning, at);
  acc.pushContent(content, contentAt);
  acc.flushReveal(); // non-streaming: the whole text is visible immediately
  return acc.snapshot(contentAt, true);
}
