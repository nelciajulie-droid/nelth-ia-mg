"use client";

/**
 * Message list: user bubbles on the right, assistant bubbles on the left,
 * markdown-lite rendering, streaming cursor, file chips and auto-scroll.
 */

import * as React from "react";
import { Check, Copy, FileText, Loader2, Sparkles } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import type { UiMessage } from "@/lib/types";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const SUGGESTIONS = [
  "Explain what Open WebUI does in 3 sentences",
  "Write a haiku about databases",
  "Summarize the RAG pipeline as a bullet list",
  "Show me a TypeScript debounce snippet",
];

function StreamingCursor() {
  return (
    <span className="ml-0.5 inline-block h-4 w-[7px] animate-pulse rounded-sm bg-emerald-500 align-text-bottom" />
  );
}

function CopyMessageButton({ content }: { content: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      aria-label="Copy message"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(content);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="flex size-7 items-center justify-center rounded-md text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100"
    >
      {copied ? <Check className="size-3.5 text-emerald-600" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </button>
  );
}

function FileChips({ files, light = false }: { files: NonNullable<UiMessage["files"]>; light?: boolean }) {
  if (files.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {files.map((file) => (
        <span
          key={file.id}
          className={
            light
              ? "inline-flex max-w-full items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-medium text-white"
              : "inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700"
          }
        >
          <FileText className="size-3 shrink-0" aria-hidden />
          <span className="max-w-[140px] truncate">{file.name ?? "attachment"}</span>
        </span>
      ))}
    </div>
  );
}

export function ChatMessages({
  messages,
  streaming,
  userName,
  userAvatar,
  chatTitle,
  onSuggest,
}: {
  messages: UiMessage[];
  streaming: boolean;
  userName: string;
  userAvatar: string | null;
  chatTitle: string | null;
  onSuggest: (prompt: string) => void;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickToBottomRef = React.useRef(true);
  const lastCountRef = React.useRef(messages.length);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const messageAdded = messages.length !== lastCountRef.current;
    lastCountRef.current = messages.length;
    if (messageAdded || stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const initials = userName
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 px-6 py-12 text-center">
        <div className="flex size-16 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-600/20">
          <Sparkles className="size-8 text-white" aria-hidden />
        </div>
        <div className="max-w-md space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">
            {chatTitle ?? "Welcome to Open WebUI"}
          </h2>
          <p className="text-sm text-zinc-500">
            Chat with your models, attach files as retrieval context, and manage knowledge
            bases — all running on the TypeScript port of Open WebUI v0.12.5.
          </p>
        </div>
        <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onSuggest(suggestion)}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left text-sm text-zinc-600 shadow-sm transition-all hover:border-emerald-300 hover:text-zinc-900 hover:shadow"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="scrollbar-thin h-full overflow-y-auto"
      role="log"
      aria-live="polite"
      aria-label="Chat messages"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        {messages.map((message, index) => {
          const isLast = index === messages.length - 1;
          const showCursor = streaming && isLast && message.role === "assistant";

          if (message.role === "user") {
            return (
              <div key={message.id} className="flex justify-end gap-2.5">
                <div className="group/message flex max-w-[85%] flex-col items-end gap-1 sm:max-w-[75%]">
                  <div className="rounded-2xl rounded-br-md bg-emerald-600 px-4 py-2.5 text-white shadow-sm">
                    <FileChips files={message.files ?? []} light />
                    <div className="whitespace-pre-wrap break-words text-[0.95rem] leading-relaxed">
                      {message.content}
                    </div>
                  </div>
                </div>
                <Avatar className="mt-0.5 size-8 shrink-0 border border-zinc-200">
                  {userAvatar ? <AvatarImage src={userAvatar} alt={userName} /> : null}
                  <AvatarFallback className="bg-zinc-100 text-[11px] font-semibold text-zinc-600">
                    {initials || "U"}
                  </AvatarFallback>
                </Avatar>
              </div>
            );
          }

          return (
            <div key={message.id} className="flex justify-start gap-2.5">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50">
                <Sparkles className="size-4 text-emerald-600" aria-hidden />
              </div>
              <div className="group/message flex max-w-[85%] flex-col items-start gap-1 sm:max-w-[75%]">
                <div className="rounded-2xl rounded-bl-md border border-zinc-200 bg-white px-4 py-2.5 shadow-sm">
                  <Markdown content={message.content} />
                  {showCursor ? <StreamingCursor /> : null}
                  {message.content.length === 0 && !streaming ? (
                    <span className="text-sm italic text-zinc-400">(empty response)</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-1 pl-1">
                  {message.content.length > 0 && !showCursor ? (
                    <CopyMessageButton content={message.content} />
                  ) : null}
                  {showCursor ? (
                    <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                      <Loader2 className="size-3 animate-spin" aria-hidden /> generating…
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
