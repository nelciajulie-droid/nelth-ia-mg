"use client";

/**
 * Chat composer: auto-resizing textarea (Enter sends, Shift+Enter newline),
 * file attachments (uploaded to /api/v1/files/ and attached by id), the
 * model picker and the @ app mention picker (AppMentionPicker).
 *
 * @ mentions: typing "@" at word start (or the toolbar @ button) opens the
 * application picker above the composer. Selecting an app removes the
 * "@query" text, pins the app as a chip (up to MAX_APP_MENTIONS) and rides
 * the outgoing message as structured metadata (connector_ids) — the text
 * itself stays clean.
 */

import * as React from "react";
import { AtSign, FileText, Image as ImageIcon, Loader2, Paperclip, Send, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { uploadFile, api, ApiError } from "@/lib/api-client";
import type { AttachedFile, ModelItem } from "@/lib/types";
import type { ConnectorListItem, ConnectFlowResponse } from "@/lib/apps/app-types";

import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/app/ModelPicker";
import {
  AppMentionPicker,
  MAX_APP_MENTIONS,
  filterApps,
  mentionQueryAt,
  useConnectorApps,
} from "@/components/app/AppMentionPicker";

const MAX_TEXTAREA_HEIGHT = 200;

const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";
const DOC_ACCEPT = ".txt,.md,.csv,.json,.pdf,.docx,.pptx,.xlsx,.html,.xml,.epub,.rst";

/** Chat attachments: documents feed the RAG pipeline, images join the
 * image-to-image generation when the imagine tool is on. */
const ACCEPT_LIST = `${DOC_ACCEPT},${IMAGE_ACCEPT}`;

function isImageName(name: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(name);
}

export function ChatInput({
  models,
  model,
  onModelChange,
  onRefreshModels,
  streaming,
  imageTool,
  onImageToolChange,
  onSend,
}: {
  models: ModelItem[];
  model: string | null;
  onModelChange: (modelId: string) => void;
  onRefreshModels?: () => void;
  streaming: boolean;
  /** Imagine tool toggle — generates an image from this message (tool, not a model). */
  imageTool: boolean;
  onImageToolChange: (enabled: boolean) => void;
  onSend: (text: string, files: AttachedFile[], apps: ConnectorListItem[]) => void;
}) {
  const { toast } = useToast();
  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState<AttachedFile[]>([]);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // ---- @ app mention picker state -----------------------------------------
  const { apps, loading: appsLoading, error: appsError, refresh: refreshApps } = useConnectorApps();
  /** Active trigger ("@" position + typed query) — null while closed. */
  const [mention, setMention] = React.useState<ReturnType<typeof mentionQueryAt>>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  /** Apps pinned for the next message (chips + connector_ids). */
  const [selectedApps, setSelectedApps] = React.useState<ConnectorListItem[]>([]);
  const [connectingId, setConnectingId] = React.useState<string | null>(null);

  const mentionOpen = mention !== null && !streaming;
  const filteredApps = React.useMemo(
    () => filterApps(apps, mention?.query ?? ""),
    [apps, mention?.query]
  );
  const safeIndex = Math.min(activeIndex, Math.max(0, filteredApps.length - 1));

  React.useEffect(() => {
    setActiveIndex(0);
  }, [mention?.query]);

  const autoResize = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, []);

  React.useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  const canSend = !streaming && text.trim().length > 0 && files.every((file) => !file.uploading);

  function send() {
    if (!canSend) return;
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;
    onSend(trimmed, files.filter((file) => !file.uploading), selectedApps);
    setText("");
    setFiles([]);
    setSelectedApps([]);
    setMention(null);
    // Reset the textarea height after clearing.
    window.requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  }

  // ---- @ picker: text/selection sync + keyboard ---------------------------

  /** Recompute the trigger from the live textarea (text + caret). */
  function syncMention(value: string, cursor: number | null) {
    setMention(mentionQueryAt(value, cursor ?? value.length));
  }

  function handleChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(event.target.value);
    syncMention(event.target.value, event.target.selectionStart);
  }

  function handleKeyUp(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      syncMention(event.currentTarget.value, event.currentTarget.selectionStart);
    }
  }

  /** Insert an "@" trigger from the toolbar button (opens the picker). */
  function openPickerManually() {
    if (streaming) return;
    const el = textareaRef.current;
    const separator = text.length === 0 || /\s$/.test(text) ? "" : " ";
    const insertAt = text.length;
    const next = text + separator + "@";
    setText(next);
    setMention({ start: insertAt + separator.length, query: "" });
    window.requestAnimationFrame(() => {
      el?.focus();
      try {
        el?.setSelectionRange(next.length, next.length);
      } catch {
        /* textarea not ready — harmless */
      }
    });
  }

  /** Pick an app: drop the "@query" text, pin the chip, keep the caret. */
  function selectApp(app: ConnectorListItem) {
    if (!selectedApps.some((entry) => entry.id === app.id)) {
      if (selectedApps.length >= MAX_APP_MENTIONS) {
        toast({
          title: "Trop d'applications",
          description: `Maximum ${MAX_APP_MENTIONS} applications par message.`,
        });
        setMention(null);
        return;
      }
      setSelectedApps((prev) => [...prev, app]);
    }
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const trigger = mentionQueryAt(text, cursor);
    if (trigger) {
      const next = text.slice(0, trigger.start) + text.slice(cursor);
      setText(next);
      setMention(null);
      window.requestAnimationFrame(() => {
        el?.focus();
        try {
          el?.setSelectionRange(trigger.start, trigger.start);
        } catch {
          /* ignore */
        }
      });
    } else {
      setMention(null);
      el?.focus();
    }
  }

  function removeApp(appId: string) {
    setSelectedApps((prev) => prev.filter((app) => app.id !== appId));
  }

  /** Start the OAuth connection flow for a disconnected app. */
  async function connectApp(app: ConnectorListItem) {
    if (connectingId) return;
    setConnectingId(app.id);
    try {
      const res = await api<ConnectFlowResponse>(`/api/v1/connectors/${app.id}/connect`, {
        method: "POST",
      });
      if (res.status === "redirect") {
        window.location.assign(res.url);
        return;
      }
      // not_configured / unavailable_here — the server explains what to do.
      toast({ title: `Connexion ${app.name}`, description: res.detail });
    } catch (err) {
      toast({
        title: "Connexion impossible",
        description:
          err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setConnectingId(null);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, filteredApps.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && filteredApps.length > 0) {
        event.preventDefault();
        selectApp(filteredApps[safeIndex]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
      return;
    }
    // Slack-like: Backspace on an empty composer unpins the last app chip.
    if (event.key === "Backspace" && text.length === 0 && selectedApps.length > 0) {
      event.preventDefault();
      setSelectedApps((prev) => prev.slice(0, -1));
    }
  }

  async function attachFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    for (const file of Array.from(fileList)) {
      const localId = `pending-${Math.random().toString(36).slice(2, 10)}`;
      setFiles((prev) => [...prev, { id: localId, name: file.name, uploading: true }]);
      try {
        const uploaded = await uploadFile(file);
        setFiles((prev) =>
          prev.map((entry) =>
            entry.id === localId
              ? { id: uploaded.id, name: uploaded.name, uploading: false }
              : entry
          )
        );
        toast({ title: "File attached", description: uploaded.name });
      } catch (err) {
        setFiles((prev) => prev.filter((entry) => entry.id !== localId));
        toast({
          title: "Upload failed",
          description:
            err instanceof ApiError || err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(fileId: string) {
    setFiles((prev) => prev.filter((entry) => entry.id !== fileId));
  }

  const activeOptionId =
    mentionOpen && filteredApps[safeIndex] ? `app-option-${filteredApps[safeIndex]!.id}` : undefined;

  return (
    <div className="w-full">
      {(files.length > 0 || selectedApps.length > 0) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {selectedApps.map((app) => (
            <span
              key={app.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-zinc-200 bg-white py-1 pl-1 pr-1.5 text-xs text-zinc-800 shadow-sm"
            >
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 [&>svg]:size-3.5"
                aria-hidden
                dangerouslySetInnerHTML={{ __html: app.icon }}
              />
              <span className="max-w-[160px] truncate font-medium">{app.name}</span>
              <button
                type="button"
                onClick={() => removeApp(app.id)}
                aria-label={`Retirer ${app.name}`}
                className="flex size-4 shrink-0 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-600"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          {files.map((file) => (
            <span
              key={file.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 py-1 pl-2.5 pr-1.5 text-xs text-emerald-900"
            >
              {isImageName(file.name) ? (
                <ImageIcon className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <FileText className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
              )}
              <span className="max-w-[160px] truncate font-medium">{file.name}</span>
              {file.uploading ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-emerald-500" aria-hidden />
              ) : (
                <button
                  type="button"
                  onClick={() => removeFile(file.id)}
                  aria-label={`Remove ${file.name}`}
                  className="flex size-4 shrink-0 items-center justify-center rounded-full text-emerald-600 transition-colors hover:bg-emerald-100"
                >
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        {/* @ app mention picker — opens on "@" at word start or the toolbar
            button; the panel rides above the composer box. */}
        {mentionOpen ? (
          <AppMentionPicker
            items={filteredApps}
            query={mention?.query ?? ""}
            loading={appsLoading}
            error={appsError}
            activeIndex={safeIndex}
            selectedIds={selectedApps.map((app) => app.id)}
            connectingId={connectingId}
            onActiveIndexChange={setActiveIndex}
            onSelect={selectApp}
            onConnect={(app) => void connectApp(app)}
            onRefresh={() => void refreshApps()}
          />
        ) : null}

        <div className="flex items-end gap-2 rounded-2xl border border-zinc-200 bg-white p-2 shadow-sm transition-colors focus-within:border-emerald-400">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={streaming}
            aria-label="Attach files"
            title="Attach files (they become RAG context for this message)"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-emerald-600 disabled:pointer-events-none disabled:opacity-40"
          >
            <Paperclip className="size-4.5" aria-hidden />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => void attachFiles(event.target.files)}
            accept={ACCEPT_LIST}
          />

          {/* @ app mention picker trigger (same affordance as ChatGPT's "+"). */}
          <button
            type="button"
            onClick={openPickerManually}
            disabled={streaming}
            aria-label="Mentionner une application"
            title="Mentionner une application — Gmail, Calendar, Drive, recherche web… (ou tapez @ dans le message)"
            className={
              "flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors disabled:pointer-events-none disabled:opacity-40 " +
              (mentionOpen
                ? "bg-emerald-100 text-emerald-600 hover:bg-emerald-200"
                : "text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600")
            }
          >
            <AtSign className="size-4.5" aria-hidden />
          </button>

          {/* Imagine tool — image generation toggle (a TOOL, deliberately NOT a
              model in the picker). With image attachments it runs image→image. */}
          <button
            type="button"
            onClick={() => onImageToolChange(!imageTool)}
            disabled={streaming}
            aria-pressed={imageTool}
            aria-label={imageTool ? "Disable image generation" : "Enable image generation"}
            title={
              imageTool
                ? "Image generation ON — this message generates an image"
                : "Generate an image from this message (image generation tool)"
            }
            className={
              "flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors disabled:pointer-events-none disabled:opacity-40 " +
              (imageTool
                ? "bg-emerald-100 text-emerald-600 hover:bg-emerald-200"
                : "text-zinc-400 hover:bg-zinc-100 hover:text-emerald-600")
            }
          >
            <ImageIcon className="size-4.5" aria-hidden />
          </button>

          <label htmlFor="chat-textarea" className="sr-only">
            Message
          </label>
          <textarea
            ref={textareaRef}
            id="chat-textarea"
            rows={1}
            value={text}
            placeholder={
              streaming
                ? "Generating response…"
                : imageTool
                  ? "Describe the image to generate… (Enter to send)"
                  : selectedApps.length > 0
                    ? `Message pour ${selectedApps.map((app) => app.name).join(", ")}…`
                    : "Send a message… (@ pour les applications)"
            }
            disabled={streaming}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onChange={handleChange}
            onClick={(event) => syncMention(event.currentTarget.value, event.currentTarget.selectionStart)}
            aria-expanded={mentionOpen}
            aria-controls="app-mention-picker"
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            className="scrollbar-thin min-h-[36px] flex-1 resize-none bg-transparent px-1 py-2 text-[0.95rem] leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus-visible:outline-none disabled:opacity-60"
          />

          <Button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="Send message"
            className="size-9 shrink-0 rounded-xl bg-emerald-600 p-0 text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {streaming ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Send className="size-4" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <ModelPicker
          models={models}
          value={model}
          onChange={onModelChange}
          onRefresh={onRefreshModels}
          disabled={streaming}
        />
        {imageTool ? (
          <p className="hidden text-[11px] text-emerald-600 sm:block">
            Imagine tool active — the message generates an image
          </p>
        ) : selectedApps.length > 0 ? (
          <p className="hidden truncate text-[11px] text-emerald-600 sm:block">
            {selectedApps.length === 1
              ? `${selectedApps[0]!.name} recevra ce message (connecteur @)`
              : `${selectedApps.length} applications recevront ce message (connecteurs @)`}
          </p>
        ) : (
          <p className="hidden text-[11px] text-zinc-400 sm:block">
            Tapez @ pour utiliser une application — fichiers joints = contexte RAG
          </p>
        )}
      </div>
    </div>
  );
}
