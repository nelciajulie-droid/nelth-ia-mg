"use client";

/**
 * Open WebUI (TS port) — single-page chat client.
 *
 * Wires the app shell (header + sidebar + messages + composer) around the
 * ported backend:
 *   GET  /api/v1/auths/            session bootstrap
 *   GET  /api/models               model list
 *   GET  /api/v1/chats/list        chat summaries
 *   POST /api/v1/chats/new         create chat (first message)
 *   POST /api/chat/completions     streaming completion (SSE)
 *   POST /api/v1/tasks/title/completions  auto title
 *   POST /api/v1/chats/{id}        persist generated title
 *   GET  /api/v1/chats/{id}        load chat history
 *   DELETE /api/v1/chats/{id}      delete chat
 */

import * as React from "react";
import { Loader2, Sparkles } from "lucide-react";

import { AppHeader } from "@/components/app/AppHeader";
import { AuthView } from "@/components/app/AuthView";
import { ChatInput } from "@/components/app/ChatInput";
import { ChatMessages } from "@/components/app/ChatMessages";
import { ChatSidebar } from "@/components/app/ChatSidebar";
import { KnowledgePanel } from "@/components/app/KnowledgePanel";
import { SettingsDialog } from "@/components/app/SettingsDialog";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import {
  api,
  ApiError,
  getToken,
  outputSnapshotText,
  setToken,
  streamChatCompletion,
} from "@/lib/api-client";
import type {
  AttachedFile,
  ChatDetail,
  ChatSummary,
  MessageFile,
  ModelItem,
  SessionUser,
  UiMessage,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Bootstrap: restore session from the stored bearer token
// ---------------------------------------------------------------------------

type BootstrapState =
  | { phase: "loading" }
  | { phase: "signed-out" }
  | { phase: "ready"; user: SessionUser };

function useBootstrap(): BootstrapState {
  const [state, setState] = React.useState<BootstrapState>({ phase: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) {
        // Fall back to the HttpOnly cookie (if any) before declaring signed-out.
        try {
          const user = await api<SessionUser>("/api/v1/auths/", { auth: false });
          if (!cancelled && user?.id) {
            setState({ phase: "ready", user });
            return;
          }
        } catch {
          /* not signed in */
        }
        if (!cancelled) setState({ phase: "signed-out" });
        return;
      }
      try {
        const user = await api<SessionUser>("/api/v1/auths/");
        if (!cancelled) {
          if (user?.id) setState({ phase: "ready", user });
          else {
            setToken(null);
            setState({ phase: "signed-out" });
          }
        }
      } catch {
        if (!cancelled) setState({ phase: "signed-out" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

// ---------------------------------------------------------------------------
// Chat list helpers
// ---------------------------------------------------------------------------

function normalizeChatList(data: unknown): ChatSummary[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { chats?: unknown }).chats)
      ? (data as { chats: unknown[] }).chats
      : [];
  return list
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map((entry) => ({
      id: String(entry.id ?? ""),
      title: String(entry.title ?? "New Chat"),
      updated_at: Number(entry.updated_at ?? Math.floor(Date.now() / 1000)),
      created_at: Number(entry.created_at ?? entry.updated_at ?? Math.floor(Date.now() / 1000)),
    }))
    .filter((chat) => chat.id.length > 0);
}

type HistoryMessage = {
  id?: string;
  parentId?: string | null;
  role?: string;
  content?: unknown;
  files?: MessageFile[];
  timestamp?: number;
};

/** Walk the current branch of chat.history (currentId → up to the root). */
function threadFromHistory(history: unknown): HistoryMessage[] {
  if (!history || typeof history !== "object") return [];
  const map = (history as { messages?: Record<string, HistoryMessage> }).messages;
  if (!map || typeof map !== "object") return [];
  let currentId = (history as { currentId?: string | null }).currentId ?? null;
  if (!currentId || !map[currentId]) {
    // No current pointer — fall back to the newest message by timestamp.
    const entries = Object.values(map).filter((m) => !!m);
    if (entries.length === 0) return [];
    currentId =
      entries.reduce((newest, m) => ((m.timestamp ?? 0) > (newest?.timestamp ?? 0) ? m : newest), entries[0])
        ?.id ?? null;
    if (!currentId) return [];
  }
  const chain: HistoryMessage[] = [];
  let cursor: HistoryMessage | undefined = map[currentId];
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor.id ?? "")) {
    guard.add(cursor.id ?? "");
    chain.push(cursor);
    cursor = cursor.parentId ? map[cursor.parentId] : undefined;
  }
  return chain.reverse();
}

function messagesFromChatDetail(detail: ChatDetail): UiMessage[] {
  // The canonical thread lives in chat.history (map + currentId) — follow-up
  // turns upsert there. The flat chat.messages array only ever holds the
  // first user message of an API-created chat, so it is the fallback.
  const threaded = threadFromHistory((detail.chat as { history?: unknown })?.history);
  const raw: HistoryMessage[] =
    threaded.length > 0
      ? threaded
      : (Array.isArray(detail.chat?.messages) ? (detail.chat.messages as HistoryMessage[]) : []);
  return raw
    .filter((message) => !!message && typeof message.content === "string")
    .map((message, index) => ({
      id: message.id ?? `${detail.id}-${index}`,
      role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
      content: message.content as string,
      // Knowledge attachments carry an id; image-generation results carry
      // a served `url` instead — both must survive the round-trip.
      files: Array.isArray(message.files)
        ? (message.files as MessageFile[]).filter(
            (file) => !!file && (typeof file.id === "string" || typeof file.url === "string")
          )
        : undefined,
    }))
    .filter((message) => message.content.length > 0 || (message.files?.length ?? 0) > 0);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Home() {
  const { toast } = useToast();
  const boot = useBootstrap();

  // ---- auth ----
  const [user, setUser] = React.useState<SessionUser | null>(null);
  React.useEffect(() => {
    if (boot.phase === "ready") setUser(boot.user);
  }, [boot]);

  // ---- models ----
  const [models, setModels] = React.useState<ModelItem[]>([]);
  const [model, setModel] = React.useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = React.useState(false);

  const refreshModels = React.useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await api<{ data?: ModelItem[] }>("/api/models");
      const list = Array.isArray(res?.data) ? res.data : [];
      setModels(list);
      setModel((current) => (current && list.some((entry) => entry.id === current) ? current : list[0]?.id ?? null));
    } catch (err) {
      toast({
        title: "Could not load models",
        description: err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setModelsLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    if (boot.phase === "ready") void refreshModels();
  }, [boot.phase, refreshModels]);

  // ---- chats ----
  const [chats, setChats] = React.useState<ChatSummary[]>([]);
  const [chatsLoading, setChatsLoading] = React.useState(false);
  const [activeChatId, setActiveChatId] = React.useState<string | null>(null);
  const [chatTitle, setChatTitle] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<UiMessage[]>([]);

  const refreshChats = React.useCallback(async () => {
    setChatsLoading(true);
    try {
      const data = await api<unknown>("/api/v1/chats/list");
      setChats(normalizeChatList(data));
    } catch {
      /* list unavailable — keep current */
    } finally {
      setChatsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (boot.phase === "ready") void refreshChats();
  }, [boot.phase, refreshChats]);

  // ---- panels ----
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  // ---- streaming ----
  const [streaming, setStreaming] = React.useState(false);
  const streamingRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);

  // ---- imagine tool ----
  // Image generation is a TOOL toggled per message (features.image_generation
  // on the request) — deliberately NOT a model in the picker.
  const [imageTool, setImageTool] = React.useState(false);

  // -------------------------------------------------------------------------
  // Chat lifecycle
  // -------------------------------------------------------------------------

  function startNewChat() {
    abortRef.current?.abort();
    setActiveChatId(null);
    setChatTitle(null);
    setMessages([]);
    setSidebarOpen(false);
  }

  async function selectChat(chatId: string) {
    abortRef.current?.abort();
    setSidebarOpen(false);
    setStreaming(false);
    streamingRef.current = false;
    try {
      const detail = await api<ChatDetail>(`/api/v1/chats/${chatId}`);
      setActiveChatId(detail.id);
      setChatTitle(detail.title);
      setMessages(messagesFromChatDetail(detail));
    } catch (err) {
      toast({
        title: "Could not open chat",
        description: err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function deleteChat(chatId: string) {
    try {
      await api(`/api/v1/chats/${chatId}`, { method: "DELETE" });
      setChats((prev) => prev.filter((chat) => chat.id !== chatId));
      if (activeChatId === chatId) startNewChat();
      toast({ title: "Chat deleted" });
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  function signOut() {
    abortRef.current?.abort();
    setToken(null);
    setUser(null);
    setModels([]);
    setChats([]);
    setMessages([]);
    setActiveChatId(null);
    void api("/api/v1/auths/signout", { method: "POST" }).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Send message → (create chat if needed) → stream → title
  // -------------------------------------------------------------------------

  async function sendMessage(text: string, files: AttachedFile[]) {
    if (!model || streamingRef.current) return;
    streamingRef.current = true;
    setStreaming(true);

    const userMessage: UiMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: text,
      files: files.map((file) => ({
        id: file.id,
        type: "file" as const,
        name: file.name,
      })),
    };
    const assistantId = `assistant-${Date.now()}`;
    setMessages((prev) => [...prev, userMessage, { id: assistantId, role: "assistant", content: "" }]);

    // Ensure a chat row exists so the pipeline can persist the exchange.
    let chatId = activeChatId;
    const isNewChat = chatId === null;
    try {
      if (isNewChat) {
        const created = await api<ChatDetail>("/api/v1/chats/new", {
          method: "POST",
          body: { chat: { title: "New Chat" } },
        });
        chatId = created.id;
        setActiveChatId(created.id);
        setChatTitle(created.title);
      }

      let accumulated = "";
      const controller = new AbortController();
      abortRef.current = controller;

      // Open WebUI wire ids: the assistant message id (`id`) + the user
      // message (`user_message`) — the flow persists the exchange against
      // them (history map + files), and reloads walk that history.
      const assistantWireId = crypto.randomUUID();
      const userWireId = crypto.randomUUID();

      /** Patch the streaming assistant message (immutably, by local id). */
      const patchAssistant = (patch: Partial<UiMessage> | ((message: UiMessage) => Partial<UiMessage>)) => {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, ...(typeof patch === "function" ? patch(message) : patch) }
              : message
          )
        );
      };

      await streamChatCompletion(
        {
          model,
          messages: [
            ...messages
              .filter((message) => message.role !== "system")
              .map((message) => ({
                role: message.role,
                content: message.content,
                files: message.files,
              })),
            {
              role: "user",
              content: text,
              files: userMessage.files,
            },
          ],
          chat_id: chatId ?? undefined,
          signal: controller.signal,
          // Open WebUI UI payload: wire ids for persistence + server-side
          // background title generation (prompt-based for image chats).
          id: assistantWireId,
          user_message: {
            id: userWireId,
            role: "user",
            content: text,
            files: userMessage.files,
          },
          background_tasks: { title_generation: true },
          // Imagine tool toggle — routes this turn through the Nelthai image
          // engine (text→image, or image→image with image attachments).
          ...(imageTool ? { features: { image_generation: true } } : {}),
        },
        {
          onDelta: (delta) => {
            accumulated += delta;
            patchAssistant({ content: accumulated });
          },
          // Structured output snapshots (thinking models) replace the
          // accumulated text wholesale — the visible answer is the `message`
          // blocks' concatenation.
          onOutputSnapshot: (output) => {
            const text = outputSnapshotText(output);
            if (text) {
              accumulated = text;
              patchAssistant({ content: accumulated });
            }
          },
          // Live image-generation phases: "Generating image · sending|generating|image".
          onStatus: (status) => {
            if (status.action !== "image_generation") return;
            const phase = status.description?.includes("·")
              ? status.description.split("·").pop()?.trim() ?? null
              : status.description ?? null;
            patchAssistant((message) => ({
              imageGeneration: {
                active: !status.done && (message.files?.length ?? 0) === 0,
                phase,
                error: message.imageGeneration?.error,
                completedAt: message.imageGeneration?.completedAt,
              },
            }));
          },
          // Generated images landing — flips the generation card to its reveal.
          onFiles: (files) => {
            patchAssistant((message) => ({
              files: [
                ...(message.files ?? []).filter((file) => file.type !== "image"),
                ...files.map((file) => ({
                  type: "image" as const,
                  url: file.url,
                  name: file.name,
                })),
              ],
              imageGeneration: message.imageGeneration
                ? { ...message.imageGeneration, active: false, completedAt: Date.now() }
                : undefined,
            }));
            void refreshChats();
          },
          onTitle: (title) => {
            setChatTitle(title);
            setChats((prev) => prev.map((chat) => (chat.id === chatId ? { ...chat, title } : chat)));
          },
          onError: (message) => {
            toast({ title: "Generation error", description: message, variant: "destructive" });
            patchAssistant((current) =>
              current.imageGeneration?.active
                ? { imageGeneration: { ...current.imageGeneration, active: false, error: message } }
                : {}
            );
          },
        }
      );

      // Refresh the sidebar ordering (updated_at changed). The title itself
      // arrives through the chat:title event — the server generates it from
      // the prompt (image chats) or the exchange (text chats).
      void refreshChats();
    } catch (err) {
      const message = err instanceof ApiError || err instanceof Error ? err.message : "Unknown error";
      if ((err as Error)?.name !== "AbortError") {
        toast({ title: "Chat failed", description: message, variant: "destructive" });
      }
      // Drop the placeholder unless something landed (text, images, error state).
      setMessages((prev) =>
        prev.filter(
          (entry) =>
            entry.id !== assistantId ||
            entry.content.length > 0 ||
            (entry.files?.length ?? 0) > 0 ||
            !!entry.imageGeneration?.error
        )
      );
    } finally {
      streamingRef.current = false;
      setStreaming(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (boot.phase === "loading") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-zinc-50">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-600/20">
          <Sparkles className="size-7 text-white" aria-hidden />
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading Open WebUI…
        </div>
      </div>
    );
  }

  if (boot.phase === "signed-out" || !user) {
    return (
      <div className="flex min-h-dvh flex-col bg-zinc-50">
        <main className="flex flex-1 items-center justify-center px-4 py-10">
          <AuthView
            onAuthenticated={(session) => {
              setToken(session.token);
              setUser(session);
              // Reload the app state for the fresh session.
              window.location.reload();
            }}
          />
        </main>
      </div>
    );
  }

  const sidebar = (
    <ChatSidebar
      chats={chats}
      activeChatId={activeChatId}
      loading={chatsLoading}
      onSelect={(chatId) => void selectChat(chatId)}
      onNewChat={startNewChat}
      onDeleteChat={(chatId) => void deleteChat(chatId)}
    />
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-zinc-50">
      <AppHeader
        user={user}
        onToggleSidebar={() => setSidebarOpen(true)}
        onOpenKnowledge={() => setKnowledgeOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onSignOut={signOut}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <aside className="hidden w-72 shrink-0 border-r border-zinc-200 bg-white md:block" aria-label="Chat list">
          {sidebar}
        </aside>

        {/* Conversation */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-zinc-800">
                {chatTitle ?? "New chat"}
              </h2>
              <p className="text-[11px] text-zinc-400">
                {modelsLoading ? "Loading models…" : model ? `Model: ${model}` : "No model selected"}
              </p>
            </div>
            <button
              type="button"
              onClick={startNewChat}
              className="shrink-0 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:border-emerald-300 hover:text-emerald-700"
            >
              New chat
            </button>
          </div>

          <div className="min-h-0 flex-1">
            <ChatMessages
              messages={messages}
              streaming={streaming}
              userName={user.name}
              userAvatar={user.profile_image_url}
              chatTitle={chatTitle}
              onSuggest={(prompt) => void sendMessage(prompt, [])}
            />
          </div>

          <div className="shrink-0 border-t border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur">
            <div className="mx-auto w-full max-w-3xl">
              <ChatInput
                models={models}
                model={model}
                onModelChange={setModel}
                onRefreshModels={() => void refreshModels()}
                streaming={streaming}
                imageTool={imageTool}
                onImageToolChange={setImageTool}
                onSend={(text, files) => void sendMessage(text, files)}
              />
            </div>
          </div>
        </main>
      </div>

      {/* Mobile chat list */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-80 p-0 sm:w-80">
          <SheetHeader className="sr-only">
            <SheetTitle>Chat list</SheetTitle>
          </SheetHeader>
          <div className="h-full">{sidebar}</div>
        </SheetContent>
      </Sheet>

      <KnowledgePanel open={knowledgeOpen} onOpenChange={setKnowledgeOpen} />

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        user={user}
        onSignOut={signOut}
        onModelsRefresh={refreshModels}
      />
    </div>
  );
}
