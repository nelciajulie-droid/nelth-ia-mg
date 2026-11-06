"use client";

/**
 * Chat composer: auto-resizing textarea (Enter sends, Shift+Enter newline),
 * file attachments (uploaded to /api/v1/files/ and attached by id) and the
 * model picker.
 */

import * as React from "react";
import { FileText, Image as ImageIcon, Loader2, Paperclip, Send, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { uploadFile, ApiError } from "@/lib/api-client";
import type { AttachedFile, ModelItem } from "@/lib/types";

import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/app/ModelPicker";

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
  onSend: (text: string, files: AttachedFile[]) => void;
}) {
  const { toast } = useToast();
  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState<AttachedFile[]>([]);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

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
    onSend(trimmed, files.filter((file) => !file.uploading));
    setText("");
    setFiles([]);
    // Reset the textarea height after clearing.
    window.requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
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

  return (
    <div className="w-full">
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
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
                : "Send a message… (Enter to send, Shift+Enter for a new line)"
          }
          disabled={streaming}
          onKeyDown={handleKeyDown}
          onChange={(event) => setText(event.target.value)}
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
        ) : (
          <p className="hidden text-[11px] text-zinc-400 sm:block">
            Attached files are used as retrieval (RAG) context
          </p>
        )}
      </div>
    </div>
  );
}
