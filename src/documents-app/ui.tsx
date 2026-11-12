/**
 * Nelth-AI Documents — primitives UI du bundle autonome.
 *
 * Petites briques partagées : icônes-boutons avec tooltip-lite, menus
 * déroulants, dialogue de confirmation, badges de format, champ d'édition
 * contentEditable (Editable), détection du thème de l'hôte (html.dark).
 * Conventions du bundle Images : jetons --docs-*, texte français,
 * transitions framer-motion discrètes.
 */

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  File,
  FileSpreadsheet,
  FileText,
  FileType,
  Presentation,
  Rows3,
  Braces,
  type LucideIcon,
} from 'lucide-react';
import { peekBlob, authBlobUrl } from './api';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Petit spinner (chargements, enregistrement en cours). */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin', className ?? 'size-4')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Thème de l'hôte — html.dark observé (MutationObserver), repli sur un
// ancêtre .dark du point de montage. Requis car le CSS scopé du bundle ne
// peut pas cibler html.dark directement.
// ---------------------------------------------------------------------------

export function useHostTheme(host: HTMLElement | null): 'light' | 'dark' {
  const compute = React.useCallback((): 'light' | 'dark' => {
    if (typeof document === 'undefined') return 'light';
    if (document.documentElement.classList.contains('dark')) return 'dark';
    if (host && host.closest('.dark')) return 'dark';
    return 'light';
  }, [host]);
  const [theme, setTheme] = React.useState<'light' | 'dark'>(compute);
  React.useEffect(() => {
    setTheme(compute());
    const obs = new MutationObserver(() => setTheme(compute()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, [compute]);
  return theme;
}

// ---------------------------------------------------------------------------
// Icône-bouton + tooltip-lite (native aria + bulle custom au survol)
// ---------------------------------------------------------------------------

export function IconButton({
  icon: Icon,
  label,
  onClick,
  tip,
  tipPlacement = 'top',
  active,
  disabled,
  danger,
  className,
  buttonClassName,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  tip?: string;
  tipPlacement?: 'top' | 'right' | 'bottom';
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
  buttonClassName?: string;
}) {
  const tipClass =
    tipPlacement === 'right'
      ? 'left-full top-1/2 ml-2 -translate-y-1/2'
      : tipPlacement === 'bottom'
        ? 'top-full left-1/2 mt-1.5 -translate-x-1/2'
        : 'bottom-full left-1/2 mb-1.5 -translate-x-1/2';
  return (
    <span className={cx('group/ibtn relative inline-flex', className)}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cx(
          'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
          disabled
            ? 'cursor-default text-[var(--docs-disabled)]'
            : danger
              ? 'text-[var(--docs-danger)] hover:bg-[var(--docs-danger-bg)]'
              : active
                ? 'bg-[var(--docs-chip)] text-[var(--docs-ink)]'
                : 'text-[var(--docs-muted)] hover:bg-[var(--docs-hover)] hover:text-[var(--docs-ink)]',
          buttonClassName
        )}
      >
        <Icon className="size-[17px]" strokeWidth={2} aria-hidden="true" />
      </button>
      {tip && !disabled ? (
        <span
          role="tooltip"
          className={cx(
            'pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-[var(--docs-ink)] px-2 py-1 text-[10.5px] font-medium text-[var(--docs-bg)] opacity-0 shadow-[var(--docs-shadow-pop)] transition-opacity duration-150 group-hover/ibtn:opacity-100',
            tipClass
          )}
        >
          {tip}
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Menu déroulant (téléchargement, actions) — contrôlé ou non
// ---------------------------------------------------------------------------

export type MenuItem = {
  key: string;
  label?: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** Le menu reste ouvert après sélection (export : spinner sur l'item). */
  keepOpen?: boolean;
  /** Séparateur au-dessus de cet item. */
  separator?: boolean;
};

export function Menu({
  trigger,
  buttonClassName,
  items,
  align = 'end',
  tooltipLabel,
  open: controlled,
  onOpenChange,
}: {
  trigger: React.ReactNode;
  buttonClassName?: string;
  items: MenuItem[];
  align?: 'start' | 'end';
  tooltipLabel?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolled, setUncontrolled] = React.useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = (v: boolean) => {
    if (onOpenChange) onOpenChange(v);
    else setUncontrolled(v);
  };
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onOpenChange]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={tooltipLabel}
        onClick={() => setOpen(!open)}
        className={buttonClassName}
      >
        {trigger}
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className={cx(
              'absolute top-full z-50 mt-1.5 min-w-[210px] rounded-xl border border-[var(--docs-line)] bg-[var(--docs-surface)] p-1.5 shadow-[var(--docs-shadow-pop)]',
              align === 'end' ? 'right-0' : 'left-0'
            )}
          >
            {items.map((item) =>
              item.separator ? (
                <div key={item.key} role="separator" className="mx-1.5 my-1 h-px bg-[var(--docs-line)]" />
              ) : (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled || item.busy}
                  onClick={() => {
                    if (item.disabled || item.busy) return;
                    item.onSelect?.();
                    if (!item.keepOpen) setOpen(false);
                  }}
                  className={cx(
                    'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12.5px] transition-colors',
                    item.danger
                      ? 'text-[var(--docs-danger)] hover:bg-[var(--docs-danger-bg)]'
                      : 'text-[var(--docs-ink)] hover:bg-[var(--docs-hover)]',
                    (item.disabled || item.busy) && 'cursor-default opacity-50'
                  )}
                >
                  {item.busy ? (
                    <Spinner className="size-4 shrink-0" />
                  ) : item.icon ? (
                    <item.icon className="size-4 shrink-0 text-[var(--docs-muted)]" aria-hidden="true" />
                  ) : (
                    <span className="size-4 shrink-0" />
                  )}
                  <span className="flex-1 truncate">{item.label}</span>
                </button>
              )
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogue de confirmation (suppression)
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  busy,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          onClick={busy ? undefined : onCancel}
        >
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="w-full max-w-[340px] rounded-2xl border border-[var(--docs-line)] bg-[var(--docs-surface)] p-5 shadow-[var(--docs-shadow-pop)]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-[14px] font-semibold text-[var(--docs-ink)]">{title}</h2>
            <p className="mt-1.5 text-[12.5px] leading-5 text-[var(--docs-muted)]">{message}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="h-8 rounded-lg px-3 text-[12.5px] font-medium text-[var(--docs-muted)] transition-colors hover:bg-[var(--docs-hover)]"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={busy}
                className={cx(
                  'flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-opacity hover:opacity-90 disabled:opacity-60',
                  danger
                    ? 'bg-[var(--docs-danger)] text-white'
                    : 'bg-[var(--docs-accent)] text-[var(--docs-on-accent)]'
                )}
              >
                {busy ? <Spinner className="size-3.5" /> : null}
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Formats d'export — libellés et icônes
// ---------------------------------------------------------------------------

export const FORMAT_LABELS: Record<string, string> = {
  pdf: 'PDF Document',
  docx: 'Word (.docx)',
  xlsx: 'Excel (.xlsx)',
  pptx: 'PowerPoint (.pptx)',
  csv: 'CSV',
  md: 'Markdown',
  txt: 'Texte',
  html: 'HTML',
};

export function formatIcon(format: string): LucideIcon {
  switch (format) {
    case 'pdf':
      return FileText;
    case 'docx':
      return FileType;
    case 'xlsx':
      return FileSpreadsheet;
    case 'pptx':
      return Presentation;
    case 'csv':
      return Rows3;
    case 'md':
      return Braces;
    case 'html':
      return Braces;
    default:
      return File;
  }
}

// ---------------------------------------------------------------------------
// Time ago (révisions)
// ---------------------------------------------------------------------------

export function timeAgo(ts: number): string {
  if (!ts) return '';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 2592000) return `il y a ${Math.floor(diff / 86400)} j`;
  try {
    return new Date(ts * 1000).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Editable — champ contentEditable « cliquer pour éditer »
//
// Lecture : le texte est rendu via `render` (markdown inline des blocs).
// Édition : texte brut (marqueurs ** * ` conservés), commit au blur ou
// Ctrl+Enter ; Échap annule. Le commit ignore les valeurs vides (le schéma
// exige min 1 caractère sur les textes de blocs).
// ---------------------------------------------------------------------------

export function Editable({
  value,
  onCommit,
  render,
  multiline = false,
  className,
  style,
  tag = 'div',
  title = 'Cliquer pour modifier',
  placeholder,
}: {
  value: string;
  onCommit: (text: string) => void;
  /** Rendu lecture (markdown inline) — défaut : texte brut. */
  render?: (text: string) => React.ReactNode;
  multiline?: boolean;
  className?: string;
  style?: React.CSSProperties;
  tag?: 'div' | 'span';
  title?: string;
  placeholder?: string;
}) {
  const Tag = tag;
  const ref = React.useRef<HTMLElement | null>(null);
  const [editing, setEditing] = React.useState(false);
  const cancelRef = React.useRef(false);
  const editingRef = React.useRef(false);
  React.useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  React.useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.textContent = value;
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  const startEditing = () => {
    if (editingRef.current) return;
    cancelRef.current = false;
    setEditing(true);
  };

  const commit = () => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const el = ref.current;
    const raw = el?.innerText ?? '';
    const next = raw.replace(/\u00a0/g, ' ').replace(/\r/g, '').trim();
    setEditing(false);
    if (!next || next === value) return;
    onCommit(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelRef.current = true;
      editingRef.current = false;
      setEditing(false);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      commit();
      return;
    }
    if (e.key === 'Enter' && !multiline) {
      e.preventDefault();
      commit();
    }
  };

  if (editing) {
    return (
      <Tag
        key="editing"
        ref={ref as React.Ref<HTMLDivElement>}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline={multiline}
        spellCheck={false}
        className={cx('docs-editing', className)}
        style={style}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (cancelRef.current) {
            cancelRef.current = false;
            return;
          }
          commit();
        }}
      />
    );
  }

  const shown = value.trim() ? value : placeholder ?? '';
  return (
    <Tag
      key="read"
      tabIndex={0}
      title={title}
      className={cx('docs-editable', className)}
      style={style}
      onClick={startEditing}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          startEditing();
        }
      }}
    >
      {shown === value && value.trim() ? (
        (render ? render(value) : value)
      ) : shown ? (
        <span className="opacity-60 italic">{shown}</span>
      ) : null}
    </Tag>
  );
}

/** <img> authentifié pour les images des documents (blocs image). */
export function AuthImg({
  path,
  alt,
  className,
  style,
  fallbackClassName,
}: {
  path: string | null | undefined;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  fallbackClassName?: string;
}) {
  const cached = path ? peekBlob(path) : null;
  const [url, setUrl] = React.useState<string | null>(cached);

  React.useEffect(() => {
    let alive = true;
    setUrl(path ? peekBlob(path) : null);
    if (!path) return;
    void authBlobUrl(path).then((resolved) => {
      if (alive) setUrl(resolved);
    });
    return () => {
      alive = false;
    };
  }, [path]);

  if (!url) {
    return (
      <div
        className={cx('docs-skeleton', fallbackClassName ?? className)}
        style={style}
        aria-label={alt}
        role="img"
      />
    );
  }
  return <img src={url} alt={alt ?? ''} className={className} style={style} draggable={false} />;
}

/** Requis pour bun build avec JSX classique éventuel. */
export const React_ref = React;
