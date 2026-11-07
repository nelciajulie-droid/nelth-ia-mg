"use client";

/**
 * Markdown-lite renderer for chat messages.
 *
 * Supports: fenced code blocks (```lang ... ```), **bold**, *italic*,
 * `inline code`, [links](https://...) and line breaks. Everything is rendered
 * as React elements (no HTML injection), which keeps the stream safe.
 *
 * `streamingCursor` appends a blinking caret INLINE — right after the LAST
 * streamed character (or at the end of the last code block while it is still
 * being written). Because every delta re-renders this component, the caret
 * visibly follows the text as it streams, and it disappears entirely once
 * the stream ends (the prop is only true while tokens are arriving).
 */

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Streaming caret — hugs the last character, blinks in place
// ---------------------------------------------------------------------------

function StreamCaret({ dark = false }: { dark?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "stream-caret ml-[2px] inline-block h-[1.05em] w-[0.5em] translate-y-[0.2em] rounded-[2px]",
        dark ? "bg-emerald-400" : "bg-emerald-500"
      )}
    />
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
            {caret && isLastParagraph && lIndex === lines.length - 1 ? <StreamCaret /> : null}
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
          {caret ? <StreamCaret dark /> : null}
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
              <StreamCaret />
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
