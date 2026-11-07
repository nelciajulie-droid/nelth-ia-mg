"use client";

/**
 * Markdown-lite renderer for chat messages.
 *
 * Supports: fenced code blocks (```lang ... ```), **bold**, *italic*,
 * `inline code`, [links](https://...) and line breaks. Everything is rendered
 * as React elements (no HTML injection), which keeps the stream safe.
 *
 * `streamingCursor` appends the ANIMATED NELTH N LOGO INLINE — right after
 * the LAST streamed character (or at the end of the last code block while it
 * is still being written). Because every delta re-renders this component,
 * the logo visibly follows the text as it streams, and it disappears
 * entirely once the stream ends (the prop is only true while tokens are
 * arriving).
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

const INLINE_TOKEN_RE =
  /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]+\))/g;

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
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

/**
 * Render a text run as paragraphs. When `caret` is true the blinking caret is
 * appended AFTER THE LAST CHARACTER of the last line of the last paragraph —
 * including when that line is still empty (the caret then marks the exact spot
 * where the next token will land).
 */
function renderTextBlock(text: string, keyPrefix: string, caret = false): React.ReactNode[] {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((paragraph, pIndex) => {
    const key = `${keyPrefix}-p${pIndex}`;
    const isLastParagraph = pIndex === paragraphs.length - 1;
    const lines = paragraph.split("\n");
    return (
      <p key={key} className="whitespace-pre-wrap break-words leading-relaxed">
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

// ---------------------------------------------------------------------------
// Code block
// ---------------------------------------------------------------------------

function CodeBlock({
  language,
  code,
  caret = false,
}: {
  language: string;
  code: string;
  caret?: boolean;
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
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-950 shadow-sm">
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
// Public component
// ---------------------------------------------------------------------------

type Block =
  | { kind: "text"; text: string }
  | { kind: "code"; language: string; code: string };

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const fenceRe = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ kind: "text", text: content.slice(lastIndex, match.index) });
    }
    const [, language, code] = match;
    if (code && code.trim().length > 0) {
      blocks.push({ kind: "code", language: language ?? "", code: code.replace(/\n$/, "") });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    blocks.push({ kind: "text", text: content.slice(lastIndex) });
  }
  return blocks;
}

export function Markdown({
  content,
  className,
  streamingCursor = false,
}: {
  content: string;
  className?: string;
  /** While true: blinking caret right after the last streamed character. */
  streamingCursor?: boolean;
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
    return blocks.map((block, index) => {
      const caret = streamingCursor && index === blocks.length - 1;
      if (block.kind === "code") {
        return <CodeBlock key={`c${index}`} language={block.language} code={block.code} caret={caret} />;
      }
      return renderTextBlock(block.text, `t${index}`, caret);
    });
  }, [content, streamingCursor]);

  return <div className={cn("text-[0.925rem] text-zinc-800", className)}>{nodes}</div>;
}
