"use client";

/**
 * Rich Markdown renderer for chat messages (ChatGPT parity).
 *
 * Block-level: fenced code blocks, ATX headings (#…######), bullet and
 * ordered lists (nested by indentation, with - [ ] task checkboxes),
 * GFM tables (with a header row, alignment support, mobile scroll wrapper),
 * blockquotes (with nested content), horizontal rules, paragraphs.
 * Inline: **bold**, *italic*, ~~strikethrough~~, `inline code`,
 * [links](url) and [N]/[N,M] citation pills (rendered as small badges).
 * Everything is rendered as React elements (no HTML injection).
 *
 * STREAMING-FIRST: every delta re-renders this component, so a partially
 * received document must render gracefully at any byte offset — an
 * unterminated table renders its rows so far, a list mid-item renders the
 * items already seen, a heading half-received renders its partial text.
 * `streamingCursor` appends the ANIMATED NELTH N LOGO INLINE right after
 * the LAST streamed character of the LAST block (or at the end of the last
 * code block while it is still being written).
 */

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Streaming N logo — hugs the last character, draws itself in a loop
// ---------------------------------------------------------------------------

/** The Nelth "N" glyph path (same as the compiled frontend's indicator). */
const N_PATH =
  "M380 85.5c-.8.7-6.9 5.3-13.5 10-33.7 24.3-107.8 79.8-108.2 81.1-.4 1.1 14.6 9.6 47.7 27.1l18.5 9.8.3 40.5c.1 22.2-.1 40.7-.6 41.2-.4.4-6.6-2.8-13.7-7.1-39.9-24-52.5-31.2-53.5-30.6-.6.4-1 11.8-1 33.4 0 32.7 0 32.8 2.3 34.8 2.5 2.4 6.9 5.1 21.7 13.8 5.8 3.4 17.6 10.5 26.3 15.8 19.9 12.2 23.9 14.3 31.5 15.8 14.7 3.1 33-5.4 40.9-18.8 5.5-9.4 5.3-4.5 5.3-141.6 0-132.7.1-129.4-4-125.2m-225.9 45c-12.4 3.5-20.9 10.6-26.4 22.3l-3.2 6.7-.1 128.8c-.2 113.3 0 128.8 1.3 128.3 1.8-.7 16.9-11.6 33.6-24.1 6.5-5 21.7-16.1 33.6-24.8 40.9-29.8 57.1-41.9 57.1-42.8 0-1.4-5.4-4.5-34.5-19.9-14.8-7.9-28-14.9-29.1-15.6-2-1.2-2.2-2.3-2.9-27.3-.8-29.7.1-56.1 1.9-56.1.7 0 4.5 2.1 8.6 4.7 19.8 12.5 56.6 34.1 57.2 33.7.5-.3.8-15.5.8-33.9v-33.3l-3-2.6c-4.7-3.9-66.6-40.6-72-42.7-6.9-2.6-16.4-3.2-22.9-1.4";

function StreamN({ dark = false }: { dark?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "nelth-stream-n-inline ml-[0.12em] inline-block h-[1.12em] w-[1.06em] align-[-0.22em]",
        dark ? "text-emerald-400" : "text-emerald-600"
      )}
    >
      <svg viewBox="0 0 497 502" focusable="false" className="block h-full w-full">
        <path className="nelth-n-path" d={N_PATH} />
      </svg>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline elements
// ---------------------------------------------------------------------------

/** Inline token grammar: bold, italic, strikethrough, code, links, [N] citations. */
const INLINE_TOKEN_RE =
  /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]+\)|\[\d+(?:\s*,\s*\d+)*\])/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(INLINE_TOKEN_RE).filter((p) => p !== undefined && p !== "");
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2 && !part.startsWith("**")) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4) {
      return (
        <del key={key} className="text-zinc-500">
          {part.slice(2, -2)}
        </del>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.85em] text-emerald-700"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={key}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-800"
        >
          {linkMatch[1]}
        </a>
      );
    }
    // [N] / [N,M] citation marker → compact badge (the compiled frontend
    // resolves these to favicon+domain pills; the TS port shows the number).
    const citationMatch = part.match(/^\[(\d+(?:\s*,\s*\d+)*)\]$/);
    if (citationMatch) {
      return (
        <sup
          key={key}
          className="ml-[0.15em] rounded border border-zinc-200 bg-zinc-100 px-1 py-[0.05em] text-[0.62em] font-semibold leading-none text-zinc-500"
        >
          {citationMatch[1].replace(/\s+/g, "")}
        </sup>
      );
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

// ---------------------------------------------------------------------------
// Code block
// ---------------------------------------------------------------------------

/** Live fade class for a newly streamed block. React's KEYED
 *  reconciliation keeps already-rendered blocks in the DOM across deltas,
 *  so the CSS animation only ever runs for elements appearing NOW — blocks
 *  that merely grow (text appended inside an existing <p>/<li>) stay put
 *  under the streaming cursor, and history re-renders (fadeIn=false) never
 *  animate. This is the "effet fondu" on the streamed reply. */
function fadeCls(fade: boolean): string | undefined {
  return fade ? "nelth-stream-fade" : undefined;
}

function CodeBlock({
  language,
  code,
  caret = false,
  fade = false,
}: {
  language: string;
  code: string;
  caret?: boolean;
  fade?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className={cn("my-2 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-950 shadow-sm", fadeCls(fade))}>
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-zinc-400">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
        >
          {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="scrollbar-thin overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-zinc-100">
        <code>
          {code}
          {caret ? <StreamN dark /> : null}
        </code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Block model + line-level parser
// ---------------------------------------------------------------------------

type Block =
  | { kind: "code"; language: string; code: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "hr" }
  | { kind: "quote"; content: string }
  | {
      kind: "list";
      ordered: boolean;
      start: number;
      items: { text: string; depth: number; checked?: boolean }[];
    }
  | { kind: "table"; header: string[]; align: ("left" | "center" | "right")[]; rows: string[][]; hasBody: boolean }
  | { kind: "text"; text: string };

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const HR_RE = /^[ \t]{0,3}(?:[-*_])[ \t]*(?:[-*_][ \t]*){2,}$/;
const LIST_ITEM_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE_RE = /^[ \t]*>[ \t]?(.*)$/;
const TABLE_ROW_RE = /^[ \t]*\|(.*)\|[ \t]*$/;
const TABLE_ROW_LOOSE_RE = /^[ \t]*\|.*$/;
const TABLE_SEPARATOR_RE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;

/** Split one table row into cells (leading/trailing pipes stripped). */
function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split(/[ \t]*\|[ \t]*/).map((cell) => cell.trim());
}

/** Column alignment from a GFM separator row (---:, :---:, :---). */
function separatorAlignments(separator: string): ("left" | "center" | "right")[] {
  return splitTableRow(separator).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

/**
 * Parse a text segment (between code fences) into line-level blocks.
 * Streaming-safe: consumed lines render as far as they arrived.
 */
function parseLineBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split(/\n/);

  let paragraph: string[] = [];
  let quote: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      const joined = paragraph.join("\n").trim();
      if (joined) blocks.push({ kind: "text", text: joined });
      paragraph = [];
    }
  };
  const flushQuote = () => {
    if (quote !== null) {
      const joined = quote.join("\n").trim();
      if (joined) blocks.push({ kind: "quote", content: joined });
      quote = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ---- Blockquote run ------------------------------------------------
    const quoteMatch = line.match(QUOTE_RE);
    if (quoteMatch) {
      flushParagraph();
      if (quote === null) quote = [];
      quote.push(quoteMatch[1]);
      continue;
    }
    flushQuote();

    // ---- Blank line ends the current paragraph ---------------------------
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    // ---- Heading ---------------------------------------------------------
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      flushParagraph();
      blocks.push({ kind: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
      continue;
    }

    // ---- Horizontal rule ---------------------------------------------------
    if (HR_RE.test(line)) {
      flushParagraph();
      blocks.push({ kind: "hr" });
      continue;
    }

    // ---- Table (header + separator + rows) --------------------------------
    const rowMatch = line.match(TABLE_ROW_LOOSE_RE);
    if (rowMatch && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      const align = separatorAlignments(lines[i + 1]);
      const rows: string[][] = [];
      let j = i + 2;
      let hasBody = false;
      while (j < lines.length) {
        const rowLine = lines[j];
        if (!rowLine.trim() || !TABLE_ROW_LOOSE_RE.test(rowLine)) break;
        rows.push(splitTableRow(rowLine));
        hasBody = true;
        j++;
      }
      blocks.push({ kind: "table", header, align, rows, hasBody });
      i = j - 1;
      continue;
    }

    // ---- List run (bullet or ordered, nested by indentation) -------------
    const listMatch = line.match(LIST_ITEM_RE);
    if (listMatch) {
      flushParagraph();
      const firstMarker = listMatch[2];
      const ordered = /\d/.test(firstMarker[0]);
      const start = ordered ? parseInt(firstMarker, 10) : 1;
      const items: { text: string; depth: number; checked?: boolean }[] = [];
      let j = i;
      while (j < lines.length) {
        const itemLine = lines[j];
        const itemMatch = itemLine.match(LIST_ITEM_RE);
        if (!itemMatch) {
          // Continuation text indented under the last item — folded in.
          if (
            items.length &&
            itemLine.trim() &&
            /^[ \t]{2,}\S/.test(itemLine) &&
            !HEADING_RE.test(itemLine) &&
            !QUOTE_RE.test(itemLine)
          ) {
            items[items.length - 1].text += ` ${itemLine.trim()}`;
            j++;
            continue;
          }
          break;
        }
        // A different marker family (bullet ↔ ordered) starts a NEW list.
        const marker = itemMatch[2];
        const isOrdered = /\d/.test(marker[0]);
        if (isOrdered !== ordered && items.length) break;
        const indent = itemMatch[1].replace(/\t/g, "  ").length;
        const depth = Math.min(3, Math.floor(indent / 2));
        let itemText = itemMatch[3];
        let checked: boolean | undefined;
        const taskMatch = itemText.match(/^\[([ xX])\][ \t]+(.*)$/);
        if (taskMatch) {
          checked = taskMatch[1].toLowerCase() === "x";
          itemText = taskMatch[2];
        }
        items.push({ text: itemText.trim(), depth, ...(checked !== undefined ? { checked } : {}) });
        j++;
      }
      blocks.push({ kind: "list", ordered, start, items });
      i = j - 1;
      continue;
    }

    // ---- Plain paragraph line ---------------------------------------------
    paragraph.push(line);
  }
  flushParagraph();
  flushQuote();
  return blocks;
}

/** Split fenced code blocks out of the raw content, then line-parse the rest. */
function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const fenceRe = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push(...parseLineBlocks(content.slice(lastIndex, match.index)));
    }
    const [, language, code] = match;
    if (code && code.trim().length > 0) {
      blocks.push({ kind: "code", language: language ?? "", code: code.replace(/\n$/, "") });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    blocks.push(...parseLineBlocks(content.slice(lastIndex)));
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

const HEADING_CLASSES: Record<number, string> = {
  1: "mt-4 mb-2 text-[1.35rem] font-semibold leading-snug text-zinc-900",
  2: "mt-4 mb-2 text-[1.2rem] font-semibold leading-snug text-zinc-900",
  3: "mt-3 mb-1.5 text-[1.07rem] font-semibold leading-snug text-zinc-900",
  4: "mt-3 mb-1.5 text-[0.98rem] font-semibold text-zinc-800",
  5: "mt-2 mb-1 text-[0.93rem] font-semibold text-zinc-800",
  6: "mt-2 mb-1 text-[0.88rem] font-semibold uppercase tracking-wide text-zinc-600",
};

const NESTED_BULLET_STYLES = ["disc", "circle", "square", "disc"];

function renderList(
  block: Extract<Block, { kind: "list" }>,
  key: string,
  caret: boolean,
  fade = false
): React.ReactNode {
  const lastItemIndex = block.items.length - 1;
  return (
    <ul key={key} className="my-1.5 space-y-0.5 pl-1" aria-label={block.ordered ? "Liste ordonnée" : "Liste"}>
      {block.items.map((item, index) => {
        const bullet = item.checked === undefined;
        const orderedMarker = block.ordered ? `${block.start + index}.` : null;
        return (
          <li
            key={`${key}-li${index}`}
            className={cn("flex items-start gap-2 leading-relaxed", fadeCls(fade))}
            style={{ paddingLeft: `${item.depth * 1.15}rem` }}
          >
            {bullet ? (
              <span
                aria-hidden="true"
                className="mt-[0.42em] flex size-[0.68em] shrink-0 items-center justify-center"
                style={
                  orderedMarker
                    ? { minWidth: "1.1em", fontSize: "0.86em" }
                    : undefined
                }
              >
                {orderedMarker ? (
                  <span className="font-medium text-zinc-600">{orderedMarker}</span>
                ) : (
                  <span
                    className="block size-[0.38em] rounded-full"
                    style={{
                      backgroundColor: "currentColor",
                      borderRadius: NESTED_BULLET_STYLES[item.depth % NESTED_BULLET_STYLES.length] === "circle" ? "50%" : undefined,
                      opacity: NESTED_BULLET_STYLES[item.depth % NESTED_BULLET_STYLES.length] === "square" ? 1 : 0.75,
                    }}
                  />
                )}
              </span>
            ) : (
              <span aria-hidden="true" className="mt-[0.28em] flex size-4 shrink-0 items-center justify-center">
                <span
                  className={cn(
                    "flex size-[0.9em] items-center justify-center rounded border text-[0.6em] font-bold leading-none",
                    item.checked
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : "border-zinc-300 text-transparent"
                  )}
                >
                  {item.checked ? "✓" : "·"}
                </span>
              </span>
            )}
            <span className="min-w-0 break-words">
              {renderInline(item.text, `${key}-li${index}`)}
              {caret && index === lastItemIndex ? <StreamN /> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function renderTable(
  block: Extract<Block, { kind: "table" }>,
  key: string,
  caret: boolean,
  fade = false
): React.ReactNode {
  const lastRowIndex = block.rows.length - 1;
  const cellAlign = (col: number): React.CSSProperties =>
    ({ textAlign: block.align[col] ?? "left" });
  return (
    <div key={key} className="scrollbar-thin my-2 overflow-x-auto rounded-lg border border-zinc-200 shadow-sm">
      <table className="w-full border-collapse bg-white text-[0.86rem]">
        <thead>
          <tr className="border-b-2 border-zinc-200 bg-zinc-50">
            {block.header.map((cell, col) => (
              <th
                key={`${key}-th${col}`}
                style={cellAlign(col)}
                className="px-3 py-2 font-semibold text-zinc-700"
              >
                {renderInline(cell, `${key}-th${col}`)}
              </th>
            ))}
          </tr>
        </thead>
        {block.rows.length > 0 && (
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr
                key={`${key}-tr${rowIndex}`}
                className={cn(
                  "border-b border-zinc-100 last:border-b-0 odd:bg-white even:bg-zinc-50/60",
                  fade && "nelth-stream-fade-row"
                )}
              >
                {row.map((cell, col) => (
                  <td
                    key={`${key}-td${rowIndex}-${col}`}
                    style={cellAlign(col)}
                    className="px-3 py-2 align-top text-zinc-700"
                  >
                    {renderInline(cell, `${key}-td${rowIndex}-${col}`)}
                    {caret && rowIndex === lastRowIndex && col === row.length - 1 ? <StreamN /> : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function renderQuote(content: string, key: string, caret: boolean, fade = false): React.ReactNode {
  const inner = parseLineBlocks(content);
  const last = inner.length - 1;
  return (
    <blockquote
      key={key}
      className={cn(
        "my-2 rounded-r-md border-l-[3px] border-emerald-300 bg-emerald-50/60 py-1.5 pl-3.5 pr-2 text-zinc-700 [&>p]:leading-relaxed",
        fadeCls(fade)
      )}
    >
      {inner.map((block, index) => renderBlock(block, `${key}-b${index}`, caret && index === last, false))}
    </blockquote>
  );
}

function renderParagraph(text: string, keyPrefix: string, caret: boolean, fade = false): React.ReactNode {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((paragraph, pIndex) => {
    const key = `${keyPrefix}-p${pIndex}`;
    const isLastParagraph = pIndex === paragraphs.length - 1;
    const lines = paragraph.split("\n");
    return (
      <p key={key} className={cn("my-1.5 whitespace-pre-wrap break-words leading-relaxed", fadeCls(fade))}>
        {lines.flatMap((line, lIndex) => (
          <React.Fragment key={`${key}-l${lIndex}`}>
            {lIndex > 0 ? <br /> : null}
            {renderInline(line, `${key}-l${lIndex}`)}
            {caret && isLastParagraph && lIndex === lines.length - 1 ? <StreamN /> : null}
          </React.Fragment>
        ))}
      </p>
    );
  });
}

function renderBlock(block: Block, key: string, caret: boolean, fade = false): React.ReactNode {
  switch (block.kind) {
    case "code":
      return <CodeBlock key={key} language={block.language} code={block.code} caret={caret} fade={fade} />;
    case "heading": {
      const level = Math.min(6, Math.max(1, block.level));
      const Tag = `h${Math.min(4, level)}` as "h1" | "h2" | "h3" | "h4";
      return (
        <Tag key={key} className={cn(HEADING_CLASSES[level], fadeCls(fade))}>
          {renderInline(block.text, `${key}-inl`)}
          {caret ? <StreamN /> : null}
        </Tag>
      );
    }
    case "hr":
      return <hr key={key} className={cn("my-3 border-zinc-200", fadeCls(fade))} />;
    case "quote":
      return renderQuote(block.content, key, caret, fade);
    case "list":
      return renderList(block, key, caret, fade);
    case "table":
      return renderTable(block, key, caret, fade);
    case "text":
      return renderParagraph(block.text, key, caret, fade);
  }
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function Markdown({
  content,
  className,
  streamingCursor = false,
  fadeIn = false,
}: {
  content: string;
  className?: string;
  /** While true: blinking caret right after the last streamed character. */
  streamingCursor?: boolean;
  /** While true: newly streamed blocks (paragraph, list item, table row,
   *  heading…) mount with a soft fade-in — the "effet fondu" on the
   *  streaming reply. React's keyed reconciliation keeps already-rendered
   *  blocks in the DOM, so only the blocks appearing NOW animate. */
  fadeIn?: boolean;
}) {
  const nodes = React.useMemo(() => {
    const blocks = parseBlocks(content);
    if (blocks.length === 0) {
      // Nothing yet — the caret alone marks where the first token will land.
      return streamingCursor
        ? [
            <p key="t-empty" className="whitespace-pre-wrap break-words leading-relaxed">
              <StreamN />
            </p>,
          ]
        : null;
    }
    return blocks.map((block, index) =>
      renderBlock(block, `b${index}`, streamingCursor && index === blocks.length - 1, fadeIn)
    );
  }, [content, streamingCursor, fadeIn]);

  return <div className={cn("text-[0.925rem] text-zinc-800", className)}>{nodes}</div>;
}
