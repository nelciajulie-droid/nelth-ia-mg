'use client';

/**
 * Nelth-IA Images — immersive detail viewer + editor.
 *
 * Main area: large preview with zoom / fit / fullscreen / prev-next (keyboard
 * ← → Esc, + -). Side panel (bottom sheet on mobile): prompt, metadata,
 * rename, favorite, download, copy link, delete, and the natural-language
 * EDIT composer — every operation sends the ORIGINAL image + instructions to
 * the real image→image engine (remove background, change background, extend,
 * style change… are honest quick-fill prompts, never CSS fakes).
 *
 * Visual system: neutral lightbox (black/90 backdrop, white-on-black primary
 * accent — same accent as the SPA's inverted primary buttons).
 */

import * as React from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  Copy,
  Download,
  ExternalLink,
  Heart,
  Link2,
  Loader2,
  Maximize2,
  Minus,
  Pencil,
  RefreshCw,
  Trash2,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { ImagineItem } from '@/lib/images/types';
import { formatDate, GenerationSkeleton, sourceLabel, StudioImg, useAuthImage } from './ImagineShared';

interface ImageDetailOverlayProps {
  item: ImagineItem | null;
  siblings: ImagineItem[];
  busyReason: string | null;
  onClose: () => void;
  onNavigate: (delta: number) => void;
  onToggleFavorite: (item: ImagineItem) => void;
  onDelete: (item: ImagineItem) => void;
  onRename: (item: ImagineItem, name: string) => void;
  onEdit: (item: ImagineItem, prompt: string) => void;
  onVariation: (item: ImagineItem) => void;
  onRegenerate: (item: ImagineItem) => void;
}

const EDIT_CHIPS = [
  'Remove the background',
  'Change the background to a futuristic night city',
  'Extend the scene around the subject',
  'Reinterpret in anime style',
  'Make the scene nocturnal and more dramatic',
];

export function ImageDetailOverlay({
  item,
  siblings,
  busyReason,
  onClose,
  onNavigate,
  onToggleFavorite,
  onDelete,
  onRename,
  onEdit,
  onVariation,
  onRegenerate,
}: ImageDetailOverlayProps) {
  const [scale, setScale] = React.useState(1);
  const [editPrompt, setEditPrompt] = React.useState('');
  const [renaming, setRenaming] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<HTMLDivElement>(null);

  const url = useAuthImage(item?.status === 'completed' ? item.url : null);
  const active = item?.status === 'generating' || item?.status === 'processing';

  // Reset zoom / drafts when switching items.
  React.useEffect(() => {
    setScale(1);
    setRenaming(false);
    setCopied(false);
    setNameDraft(item?.name ?? '');
    setEditPrompt('');
  }, [item?.id, item?.name, item]);

  // Keyboard navigation.
  React.useEffect(() => {
    if (!item) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
      if (event.key === 'Escape') {
        if (typing) return;
        onClose();
        return;
      }
      if (typing) return;
      if (event.key === 'ArrowLeft') onNavigate(-1);
      if (event.key === 'ArrowRight') onNavigate(1);
      if (event.key === '+' || event.key === '=') setScale((s) => Math.min(4, s + 0.25));
      if (event.key === '-' || event.key === '_') setScale((s) => Math.max(0.5, s - 0.25));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [item, onClose, onNavigate]);

  // Focus the panel on open (screen-reader friendly entry point).
  React.useEffect(() => {
    if (item) panelRef.current?.focus();
  }, [item?.id, item]);

  if (!item) return null;

  const index = siblings.findIndex((entry) => entry.id === item.id);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < siblings.length - 1;

  async function download() {
    if (!url || !item) return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${(item.name ?? item.prompt ?? 'image')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 60)}.png`;
    anchor.click();
  }

  async function copyLink() {
    if (!item?.url) return;
    const absolute = `${window.location.origin}${item.url}`;
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Image detail: ${item.name ?? item.prompt ?? 'untitled'}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
    >
      {/* Top bar */}
      <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-white">
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-white/80 transition hover:bg-white/10 hover:text-white"
        >
          <ChevronLeft className="size-4" aria-hidden />
          <span className="hidden sm:inline">Back</span>
        </button>
        <p className="min-w-0 flex-1 truncate text-xs text-white/70">
          {item.name ?? item.prompt ?? 'Image'}
          {active ? ' — generating…' : ''}
        </p>
        <div className="flex items-center gap-1">
          <DetailIconButton label="Zoom in" disabled={!url} onClick={() => setScale((s) => Math.min(4, s + 0.25))}>
            <ZoomIn className="size-4" aria-hidden />
          </DetailIconButton>
          <DetailIconButton label="Zoom out" disabled={!url} onClick={() => setScale((s) => Math.max(0.5, s - 0.25))}>
            <ZoomOut className="size-4" aria-hidden />
          </DetailIconButton>
          <DetailIconButton label="Actual size" disabled={!url} onClick={() => setScale(1)}>
            <Minus className="size-4" aria-hidden />
          </DetailIconButton>
          <DetailIconButton
            label="Fullscreen"
            disabled={!url}
            onClick={() => {
              const node = viewRef.current;
              if (!node) return;
              if (document.fullscreenElement) void document.exitFullscreen();
              else void node.requestFullscreen?.();
            }}
          >
            <Maximize2 className="size-4" aria-hidden />
          </DetailIconButton>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail view"
          className="flex size-7 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Main viewer */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-6">
          {active || !url ? (
            <div className="flex h-full w-full max-w-xl items-center justify-center">
              <GenerationSkeleton
                item={item}
                className="h-full max-h-[70vh] w-full rounded-2xl border-white/10 bg-gray-900"
              />
            </div>
          ) : (
            <StudioImg
              ref={viewRef}
              src={url}
              alt={item.prompt ?? item.name ?? 'Generated image'}
              className="max-h-full max-w-full rounded-lg object-contain shadow-2xl transition-transform duration-200"
              style={{ transform: `scale(${scale})` }}
              draggable={false}
            />
          )}

          {/* Prev / next */}
          {hasPrev ? <NavArrow side="left" onClick={() => onNavigate(-1)} /> : null}
          {hasNext ? <NavArrow side="right" onClick={() => onNavigate(1)} /> : null}
        </div>

        {/* Side / bottom panel */}
        <div
          ref={panelRef}
          tabIndex={-1}
          className="max-h-[55vh] shrink-0 overflow-y-auto border-t border-white/10 bg-gray-950 p-4 text-gray-200 outline-none [scrollbar-width:thin] lg:max-h-none lg:w-[340px] lg:border-l lg:border-t-0"
        >
          {/* Prompt */}
          {item.prompt ? (
            <section aria-label="Prompt used" className="mb-4">
              <PromptBlock prompt={item.prompt} />
            </section>
          ) : null}

          {/* Metadata */}
          <dl className="mb-4 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px] text-gray-400">
            <Meta label="Created" value={formatDate(item.created_at ?? 0)} />
            <Meta label="Source" value={sourceLabel(item.source)} />
            {item.provider ? <Meta label="Engine" value={item.provider} /> : null}
            {item.model ? <Meta label="Model" value={item.model} /> : null}
            {item.width && item.height ? (
              <Meta label="Dimensions" value={`${item.width} × ${item.height}`} />
            ) : null}
            {item.aspect_ratio ? <Meta label="Ratio" value={item.aspect_ratio} /> : null}
            {item.parent_id ? <Meta label="Parent image" value={item.parent_id.slice(0, 8)} /> : null}
          </dl>

          {/* Rename */}
          {renaming ? (
            <div className="mb-4 flex gap-1.5">
              <input
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    if (nameDraft.trim()) onRename(item, nameDraft.trim());
                    setRenaming(false);
                  }
                  if (event.key === 'Escape') setRenaming(false);
                }}
                autoFocus
                aria-label="New image name"
                className="h-8 min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-2 text-xs text-white outline-none focus:border-gray-400"
              />
              <button
                type="button"
                aria-label="Save name"
                className="flex h-8 items-center rounded-lg bg-white px-2 text-black transition hover:bg-gray-200"
                onClick={() => {
                  if (nameDraft.trim()) onRename(item, nameDraft.trim());
                  setRenaming(false);
                }}
              >
                <Check className="size-3.5" aria-hidden />
              </button>
            </div>
          ) : null}

          {/* Actions */}
          <div className="mb-5 grid grid-cols-2 gap-1.5">
            <DetailAction label="Download" icon={<Download className="size-3.5" aria-hidden />} onClick={() => void download()} disabled={!url} />
            <DetailAction
              label={copied ? 'Link copied!' : 'Copy link'}
              icon={copied ? <Check className="size-3.5 text-white" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
              onClick={() => void copyLink()}
              disabled={!url}
            />
            <DetailAction
              label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
              icon={<Heart className={cn('size-3.5', item.favorite && 'fill-red-500 text-red-500')} aria-hidden />}
              onClick={() => onToggleFavorite(item)}
            />
            <DetailAction label="Rename" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setRenaming(true)} />
            <DetailAction label="Create variation" icon={<Wand2 className="size-3.5" aria-hidden />} onClick={() => onVariation(item)} disabled={active || busyReason !== null} />
            <DetailAction label="Regenerate" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={() => onRegenerate(item)} disabled={!item.prompt || active || busyReason !== null} />
            <DetailAction label="Delete" danger icon={<Trash2 className="size-3.5" aria-hidden />} onClick={() => onDelete(item)} />
          </div>

          {/* Edit composer (image → image, real engine) */}
          <section aria-label="Edit image with instructions" className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-gray-400">Edit image</h3>
              {busyReason ? (
                <span className="flex items-center gap-1 text-[11px] text-gray-300">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  {busyReason}
                </span>
              ) : null}
            </div>
            <p className="text-[11px] leading-snug text-gray-400">
              Describe the edit in natural language — the original image is sent to the engine
              (image → image).
            </p>
            <div className="flex flex-wrap gap-1.5">
              {EDIT_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setEditPrompt(chip)}
                  className="h-7 rounded-full border border-white/15 px-2.5 text-[11px] text-gray-300 transition hover:border-white/40 hover:text-white"
                >
                  {chip}
                </button>
              ))}
            </div>
            <Textarea
              value={editPrompt}
              onChange={(event) => setEditPrompt(event.target.value)}
              placeholder="e.g. change the background to a futuristic night city…"
              aria-label="Image edit instructions"
              className="min-h-[72px] resize-none rounded-lg border-white/15 bg-white/5 text-xs text-white placeholder:text-gray-600 focus-visible:ring-gray-400"
            />
            <button
              type="button"
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-full bg-white text-xs font-medium text-black transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!editPrompt.trim() || active || busyReason !== null}
              onClick={() => {
                const trimmed = editPrompt.trim();
                if (trimmed) onEdit(item, trimmed);
              }}
            >
              {busyReason ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <ExternalLink className="size-3.5" aria-hidden />
              )}
              Edit with AI
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

function PromptBlock({ prompt }: { prompt: string }) {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-2.5">
      <p
        className={cn(
          'cursor-pointer text-xs leading-relaxed text-gray-300',
          !expanded && 'line-clamp-3'
        )}
        onClick={() => setExpanded((value) => !value)}
        title="Click to expand"
      >
        {prompt}
      </p>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-gray-500">{label}</dt>
      <dd className="truncate text-gray-200">{value}</dd>
    </div>
  );
}

function DetailIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg p-2 text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function NavArrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ArrowLeft : ArrowRight;
  return (
    <button
      type="button"
      aria-label={side === 'left' ? 'Previous image' : 'Next image'}
      onClick={onClick}
      className={
        'absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-2.5 text-white backdrop-blur transition hover:bg-black/80 ' +
        (side === 'left' ? 'left-3' : 'right-3')
      }
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function DetailAction({
  label,
  icon,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-[11px] font-medium transition hover:border-white/25 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40',
        danger && 'text-red-300 hover:border-red-400/40 hover:bg-red-500/10'
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
