"use client";

/**
 * Markdown-lite renderer for chat messages.
 *
 * Supports: fenced code blocks (```lang ... ```), **bold**, *italic*,
 * `inline code`, [links](https://...) and line breaks. Everything is rendered
 * as React elements (no HTML injection), which keeps the stream safe.
 */

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

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

function renderTextBlock(text: string, keyPrefix: string): React.ReactNode[] {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((paragraph, pIndex) => {
    const key = `${keyPrefix}-p${pIndex}`;
    const lines = paragraph.split("\n");
    return (
      <p key={key} className="whitespace-pre-wrap break-words leading-relaxed">
        {lines.flatMap((line, lIndex) => (
          <React.Fragment key={`${key}-l${lIndex}`}>
            {lIndex > 0 ? <br /> : null}
            {renderInline(line, `${key}-l${lIndex}`)}
          </React.Fragment>
        ))}
      </p>
    );
  });
}

// ---------------------------------------------------------------------------
// Code block
// ---------------------------------------------------------------------------

function CodeBlock({ language, code }: { language: string; code: string }) {
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
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function Markdown({ content, className }: { content: string; className?: string }) {
  const nodes = React.useMemo(() => {
    const result: React.ReactNode[] = [];
    const fenceRe = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let blockIndex = 0;

    while ((match = fenceRe.exec(content)) !== null) {
      if (match.index > lastIndex) {
        result.push(...renderTextBlock(content.slice(lastIndex, match.index), `t${blockIndex}`));
      }
      const [, language, code] = match;
      if (code && code.trim().length > 0) {
        result.push(
          <CodeBlock
            key={`c${blockIndex}`}
            language={language ?? ""}
            code={code.replace(/\n$/, "")}
          />
        );
      }
      lastIndex = match.index + match[0].length;
      blockIndex += 1;
    }
    if (lastIndex < content.length) {
      result.push(...renderTextBlock(content.slice(lastIndex), `t${blockIndex}`));
    }
    return result;
  }, [content]);

  return <div className={cn("text-[0.925rem] text-zinc-800", className)}>{nodes}</div>;
}
