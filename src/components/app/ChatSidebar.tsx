"use client";

/**
 * Sidebar chat list: search filter, new chat, per-chat delete.
 * Rendered inside a desktop <aside> and a mobile <Sheet> by the parent.
 */

import * as React from "react";
import { MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import type { ChatSummary } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

function formatRelativeDate(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function ChatSidebar({
  chats,
  activeChatId,
  loading,
  onSelect,
  onNewChat,
  onDeleteChat,
}: {
  chats: ChatSummary[];
  activeChatId: string | null;
  loading: boolean;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (chatId: string) => void;
}) {
  const [search, setSearch] = React.useState("");

  const filtered = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return chats;
    return chats.filter((chat) => chat.title.toLowerCase().includes(query));
  }, [chats, search]);

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <Button
        onClick={onNewChat}
        className="h-10 w-full justify-start gap-2 rounded-xl bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
      >
        <Plus className="size-4" aria-hidden /> New chat
      </Button>

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400"
          aria-hidden
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search chats…"
          aria-label="Search chats"
          className="h-9 rounded-xl border-zinc-200 bg-white pl-8 text-sm"
        />
      </div>

      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex flex-col gap-2 px-1 pt-1">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex items-center gap-2.5">
                <Skeleton className="size-8 rounded-lg" />
                <div className="flex w-full flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <MessageSquare className="size-8 text-zinc-300" aria-hidden />
            <p className="text-sm text-zinc-400">
              {search.trim() ? "No chats match your search." : "No chats yet — start one!"}
            </p>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-0.5 pr-2">
              {filtered.map((chat) => {
                const active = chat.id === activeChatId;
                return (
                  <div
                    key={chat.id}
                    className={`group relative flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors ${
                      active
                        ? "bg-emerald-50 text-emerald-900"
                        : "text-zinc-700 hover:bg-zinc-100"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(chat.id)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      aria-current={active ? "true" : undefined}
                    >
                      <MessageSquare
                        className={`size-4 shrink-0 ${active ? "text-emerald-600" : "text-zinc-400"}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{chat.title}</span>
                        <span className="block text-[11px] text-zinc-400">
                          {formatRelativeDate(chat.updated_at)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteChat(chat.id)}
                      aria-label={`Delete chat ${chat.title}`}
                      title="Delete chat"
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 opacity-0 transition-all hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
