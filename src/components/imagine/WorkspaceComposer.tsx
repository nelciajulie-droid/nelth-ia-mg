'use client';

/**
 * Nelth-IA Images — creation workspace (prompt composer).
 *
 * Visual system: the ORIGINAL Open WebUI chat composer — a rounded-3xl
 * card (border-gray-100/50 / dark:border-gray-850/50, bg-white/5,
 * backdrop-blur, shadow-lg), round 30px icon buttons, Workspace-style
 * segmented chips for the selectors and the black/white primary accent
 * (bg-black dark:bg-white) for Generate.
 *
 * Large centered composer: auto-growing multiline prompt, reference image
 * attachments (downscaled to data URLs client-side), aspect-ratio / style /
 * count selectors and the Generate button with its loading state.
 */

import * as React from 'react';
import { ImagePlus, Loader2, Paperclip, Sparkles, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { IMAGINE_RATIOS, imagineStyleById, ratioValue } from '@/lib/images/styles';
import type { ImagineCapabilities } from '@/lib/images/types';
import { StudioImg } from './ImagineShared';

export interface ComposerAttachment {
  name: string;
  dataUrl: string;
}

export interface ComposerSettings {
  aspectRatio: string;
  style: string;
  n: number;
}

interface WorkspaceComposerProps {
  capabilities: ImagineCapabilities | null;
  settings: ComposerSettings;
  onSettingsChange: (settings: ComposerSettings) => void;
  disabled?: boolean;
  busy?: boolean;
  onGenerate: (prompt: string, attachments: ComposerAttachment[]) => void | Promise<void>;
}

const MAX_ATTACHMENTS = 4;

/** Downscale an image file to a JPEG data URL (≤1280px) for prompt refs. */
async function fileToAttachment(file: File): Promise<ComposerAttachment> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Unreadable image'));
      el.src = objectUrl;
    });
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      name: file.name,
      dataUrl: canvas.toDataURL('image/jpeg', 0.86),
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Workspace-style segmented chip (the SPA "Create" control classes). */
function ComposerChip({
  children,
  label,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button
      type="button"
      size="sm"
      aria-label={label}
      className="flex h-7 items-center gap-1.5 overflow-hidden rounded-lg bg-gray-50 px-2.5 text-xs text-gray-900 ring-1 ring-gray-200 transition hover:bg-gray-100 dark:bg-gray-850 dark:text-gray-100 dark:ring-gray-850 dark:hover:bg-gray-800"
      {...props}
    >
      {children}
    </Button>
  );
}

export function WorkspaceComposer({
  capabilities,
  settings,
  onSettingsChange,
  disabled,
  busy,
  onGenerate,
}: WorkspaceComposerProps) {
  const [prompt, setPrompt] = React.useState('');
  const [attachments, setAttachments] = React.useState<ComposerAttachment[]>([]);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // "Use this prompt" from the inspiration gallery fills the composer.
  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === 'string' && detail.trim()) setPrompt(detail);
      textareaRef.current?.focus();
      textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window.addEventListener('nelth:imagine:use-prompt', handler);
    return () => window.removeEventListener('nelth:imagine:use-prompt', handler);
  }, []);

  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(280, Math.max(120, el.scrollHeight))}px`;
  }, [prompt]);

  const style = imagineStyleById(settings.style);
  const hasRefs = attachments.length > 0;
  const ratioMode = capabilities?.aspectRatioMode ?? 'creative-hint';

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) return;
    const picked = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .slice(0, room);
    try {
      const next = await Promise.all(picked.map(fileToAttachment));
      setAttachments((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
    } catch {
      /* unreadable image — ignored */
    }
  }

  function submit() {
    if (disabled || busy) return;
    const trimmed = prompt.trim();
    if (!trimmed) {
      textareaRef.current?.focus();
      return;
    }
    void onGenerate(trimmed, attachments);
  }

  const activeCount = Math.min(settings.n, capabilities?.maxCount ?? 4);

  return (
    <section
      aria-label="Creation workspace"
      className="relative mx-auto w-full max-w-3xl rounded-3xl border border-gray-100/50 bg-white/5 shadow-lg backdrop-blur-sm transition hover:border-gray-200 focus-within:border-gray-200 dark:border-gray-850/50 dark:bg-gray-500/5 dark:hover:border-gray-800 dark:focus-within:border-gray-800"
    >
      {/* Attachments */}
      {hasRefs ? (
        <div className="flex flex-wrap gap-2 border-b border-gray-100/60 p-3 dark:border-gray-850/60">
          {attachments.map((attachment, index) => (
            <div
              key={`${attachment.name}-${index}`}
              className="group relative size-16 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700"
            >
              <StudioImg
                src={attachment.dataUrl}
                alt={`Reference image ${index + 1}: ${attachment.name}`}
                className="size-full object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-3" aria-hidden />
              </button>
            </div>
          ))}
          <div className="flex items-center px-1 text-[11px] text-gray-500 dark:text-gray-400">
            {capabilities?.features.imageToImage
              ? 'References sent to the engine (image → image)'
              : 'References ignored (editing not supported by the engine)'}
          </div>
        </div>
      ) : null}

      {/* Prompt */}
      <div className="p-3 sm:p-4">
        <Textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="Describe the image to create…"
          aria-label="Image prompt"
          className="min-h-[120px] resize-none border-0 bg-transparent p-0 text-[0.9375rem] leading-relaxed shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>

      {/* Settings row — the SPA composer bottom bar: round icon buttons +
          segmented chips + primary pill */}
      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100/60 px-3 py-2 dark:border-gray-850/60">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void handleFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
          aria-label="Attach a reference image"
          title="Attach a reference image"
          className="flex size-[1.875rem] shrink-0 items-center justify-center rounded-full bg-transparent text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-white dark:hover:bg-gray-800"
        >
          <Paperclip className="size-4" aria-hidden />
        </button>

        {/* Aspect ratio */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ComposerChip label="Aspect ratio">
              <span
                aria-hidden
                className="inline-block rounded-[2px] border border-current opacity-70"
                style={{
                  width: Math.min(14, Math.max(6, 12 * Math.min(1, ratioValue(settings.aspectRatio)))),
                  height: Math.min(14, Math.max(6, 12 * Math.min(1, 1 / ratioValue(settings.aspectRatio)))),
                }}
              />
              <span className="tabular-nums">{settings.aspectRatio}</span>
            </ComposerChip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuLabel>Aspect ratio</DropdownMenuLabel>
            {IMAGINE_RATIOS.map((ratio) => (
              <DropdownMenuCheckboxItem
                key={ratio}
                checked={settings.aspectRatio === ratio}
                onCheckedChange={() => onSettingsChange({ ...settings, aspectRatio: ratio })}
                onSelect={() => onSettingsChange({ ...settings, aspectRatio: ratio })}
              >
                <span className="tabular-nums">{ratio}</span>
              </DropdownMenuCheckboxItem>
            ))}
            {ratioMode === 'creative-hint' ? (
              <>
                <DropdownMenuSeparator />
                <p className="px-2 py-1.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
                  The built-in engine adjusts composition through the prompt (final size chosen by the
                  provider).
                </p>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Style */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ComposerChip label="Artistic style" className="max-w-[190px]">
              <Sparkles className="size-3.5 shrink-0 opacity-60" aria-hidden />
              <span className="truncate">{style ? style.label : 'Style'}</span>
            </ComposerChip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>Artistic style</DropdownMenuLabel>
            {['none', 'photorealistic', 'anime', '3d', 'illustration', 'architecture', 'nature', 'fashion', 'product', 'wallpaper', 'art'].map(
              (id) => {
                const entry = imagineStyleById(id);
                if (!entry) return null;
                return (
                  <DropdownMenuCheckboxItem
                    key={id}
                    checked={settings.style === id}
                    onCheckedChange={() => onSettingsChange({ ...settings, style: id })}
                    onSelect={() => onSettingsChange({ ...settings, style: id })}
                  >
                    <span className="truncate">{entry.label}</span>
                  </DropdownMenuCheckboxItem>
                );
              }
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Count */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ComposerChip label="Image count">
              <ImagePlus className="size-3.5 shrink-0 opacity-60" aria-hidden />
              <span className="tabular-nums">×{activeCount}</span>
            </ComposerChip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            <DropdownMenuLabel>Image count</DropdownMenuLabel>
            {Array.from({ length: capabilities?.maxCount ?? 4 }, (_, i) => i + 1).map((count) => (
              <DropdownMenuCheckboxItem
                key={count}
                checked={settings.n === count}
                onCheckedChange={() => onSettingsChange({ ...settings, n: count })}
                onSelect={() => onSettingsChange({ ...settings, n: count })}
              >
                <span className="tabular-nums">{count}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-gray-400 dark:text-gray-500 sm:inline" aria-hidden>
            Ctrl + ⏎
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={disabled || busy || !prompt.trim()}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-white transition',
              'bg-black hover:bg-gray-900 dark:bg-white dark:text-black dark:hover:bg-gray-100',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            {busy ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                <span className="hidden sm:inline">Queueing…</span>
              </>
            ) : (
              <>
                <Sparkles className="size-3.5" aria-hidden />
                Generate
              </>
            )}
          </button>
        </div>
      </div>
    </section>
  );
}
