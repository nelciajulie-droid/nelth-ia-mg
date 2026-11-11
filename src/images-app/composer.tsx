/**
 * Nelth-IA Images — composeur compact (référence vidéo).
 *
 * Carte blanche centrée ~640 px : placeholder « Décrivez ce que vous imaginez »,
 * barre d'outils + Catégorie (Image | Vidéo | Gif) + segment contextuel
 * (Nelth-V2 | Nelth-V3 pour les images — badge « NEW » bleu sur V3 ;
 * 480p | 720p pour la vidéo ; rien pour le GIF, V3 only) + Variations (1-4)
 * + ratio (8 ratios V3/GIF, 3 ratios V2/vidéo, « Auto » verrouillé quand le
 * format suit l'image de référence) + micro + bouton circulaire bleu ↑.
 * Compacté en pilule mono-ligne quand on défile.
 *
 * Barre d'outils UNE SEULE LIGNE (flex-nowrap) : + | chips | micro | envoyer.
 * Les chips défilent horizontalement (.images-chips-scroll) quand la place
 * manque ; micro et « Générer » restent ancrés à droite (ml-auto, shrink-0).
 * Jamais de retour à la ligne pour les deux boutons d'action.
 *
 * Pop-overs en PORTAL vers <body> (position fixe) : la zone des chips est
 * défilante (overflow-x) et clippait le menu Format à son bord droit — la
 * fenêtre 1:1|4:3|9:16 apparaissait tronquée. Rendus au niveau du body et
 * ancrés au bouton par calcul, ils ne sont plus jamais coupés.
 *
 * L'ancien segment « Vitesse | Qualité 2.0 » a disparu : chaque catégorie
 * apporte SES contrôles.
 */

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, ChevronDown, Clapperboard, Film, Image as ImageIcon, Mic, Plus } from 'lucide-react';
import { cx } from './ui';

// ---------------------------------------------------------------------------
// Types partagés des contrôles
// ---------------------------------------------------------------------------

/** Catégorie de média choisie dans le composeur. */
export type ComposerCategory = 'image' | 'video' | 'gif';

/** Modèle d'image (segment Nelth-V2 | Nelth-V3). */
export type ImageModel = 'v2' | 'v3';

/** Résolution vidéo (segment 480p | 720p). */
export type VideoResolution = '480p' | '720p';

export interface ComposerProps {
  prompt: string;
  onPromptChange(value: string): void;
  // ---- ratio ----
  ratio: string;
  onRatioChange(value: string): void;
  ratios: string[];
  ratioDisabled: boolean;
  /** Vrai quand le format suit l'image de référence (affiche « Auto »). */
  ratioAuto: boolean;
  // ---- catégorie de média ----
  category: ComposerCategory;
  onCategoryChange(category: ComposerCategory): void;
  // ---- modèle d'image (catégorie image uniquement) ----
  imageModel: ImageModel;
  onImageModelChange(model: ImageModel): void;
  // ---- résolution vidéo (catégorie vidéo uniquement) ----
  resolution: VideoResolution;
  onResolutionChange(resolution: VideoResolution): void;
  // ---- variations (1-4) ----
  variations: number;
  onVariationsChange(value: number): void;
  /** Vrai → verrouillé à 1 (image-to-image V2, image-to-video). */
  variationsLocked: boolean;
  /** Libellé du verrou (title du bouton). */
  variationsLockHint?: string;
  compact: boolean;
  generating: boolean;
  disabled: boolean;
  panelOpen: boolean;
  onTogglePanel(): void;
  onGenerate(): void;
  references: Array<{ id: string; label: string; url: string | null }>;
  onRemoveReference(id: string): void;
}

// ---------------------------------------------------------------------------
// Petits gabarits
// ---------------------------------------------------------------------------

/** Glyphe ratio : petit rectangle plein aux proportions réelles. */
function RatioGlyph({ ratio, className }: { ratio: string; className?: string }) {
  const [w, h] = ratio.split(':').map(Number);
  const value = w && h ? w / h : 1;
  const long = 13;
  const gw = value >= 1 ? long : Math.max(5, Math.round(long * value));
  const gh = value >= 1 ? Math.max(5, Math.round(long / value)) : long;
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block rounded-[2px] bg-[var(--images-glyph)]', className)}
      style={{ width: gw, height: gh }}
    />
  );
}

/** Petits pop-overs discrets — rendus au niveau de l'OVERLAY via un PORTAL.
 *
 * La zone centrale des chips est défilante (overflow-x) : elle clippait le
 * pop-over « absolute » à son bord droit (le menu Format tronqué, colonnes
 * 3:2/2:3 invisibles) ET gonflait sa zone de défilement fantôme. En position
 * fixe rendu à la racine de l'overlay (#nelth-images-overlay — le CSS du
 * bundle y est scopé, les utilitaires continuent de s'appliquer ; aucun
 * ancêtre transformé, la position fixe est donc rapportée au viewport), le
 * pop-over, ancré au bouton par getBoundingClientRect :
 * - est aligné au bord gauche du bouton par défaut ;
 * - basculé au bord droit du bouton s'il déborde de la fenêtre ;
 * - borné à 8 px des bords du viewport — jamais coupé ;
 * - au-dessus du bouton (8 px), sous le bouton si la place manque en haut ;
 * - se repositionne au défilement / redimensionnement (suit son ancre).
 * Visuel inchangé : mêmes jetons, rayons, ombre et animation d'entrée. */
function PopoverShell({
  open,
  onClose,
  children,
  width,
  anchorRef,
}: {
  open: boolean;
  onClose(): void;
  children: React.ReactNode;
  width: string;
  /** Ancre = l'enveloppe .relative du bouton déclencheur. */
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const popRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);

  React.useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;

    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const vw = window.innerWidth;
      let left = rect.left;
      if (left + pop.offsetWidth > vw - margin) left = rect.right - pop.offsetWidth;
      left = Math.max(margin, Math.min(left, vw - margin - pop.offsetWidth));
      let top = rect.top - pop.offsetHeight - 8;
      if (top < margin) top = Math.min(rect.bottom + 8, Math.max(margin, window.innerHeight - margin - pop.offsetHeight));
      setPos((prev) =>
        prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5 ? prev : { left, top },
      );
    };

    place();
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, anchorRef]);

  if (!open || typeof document === 'undefined') return null;

  // Cible du portal : la racine de l'overlay — le CSS du bundle y est scopé
  // (voir scripts/build-images.ts : les utilitaires Tailwind matchent
  // uniquement #nelth-images-overlay …). document.body en dernier recours
  // (overlay absent : les utilitaires ne s'appliqueraient plus).
  const host = document.getElementById('nelth-images-overlay') ?? document.body;

  return createPortal(
    <>
      {/* Rideau de fermeture — lui aussi en position fixe : superposition
          cohérente avec le pop-over où qu'il s'ouvre dans la fenêtre. */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        ref={popRef}
        className="images-pop fixed z-50 whitespace-nowrap rounded-[14px] border border-[var(--images-line)] bg-[var(--images-surface)] p-2 shadow-[var(--images-shadow-pop)]"
        style={{
          width,
          left: pos ? `${pos.left}px` : 0,
          top: pos ? `${pos.top}px` : 0,
          visibility: pos ? 'visible' : 'hidden',
        }}
      >
        {children}
      </div>
    </>,
    host,
  );
}

// ---------------------------------------------------------------------------
// Sélecteur de catégorie (Image | Vidéo | Gif) — remplace l'ancienne puce
// « Image » statique : un segment interactif comme l'était Vitesse|Qualité.
// ---------------------------------------------------------------------------

const CATEGORY_ICONS: Record<ComposerCategory, React.ReactNode> = {
  image: <ImageIcon className="size-[15px]" strokeWidth={2} aria-hidden="true" />,
  video: <Clapperboard className="size-[15px]" strokeWidth={2} aria-hidden="true" />,
  gif: <Film className="size-[15px]" strokeWidth={2} aria-hidden="true" />,
};

const CATEGORY_LABELS: Record<ComposerCategory, string> = {
  image: 'Image',
  video: 'Vidéo',
  gif: 'GIF',
};

function CategorySegment({
  category,
  onChange,
}: {
  category: ComposerCategory;
  onChange(category: ComposerCategory): void;
}) {
  const options: ComposerCategory[] = ['image', 'video', 'gif'];
  return (
    <div className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--images-chip-soft)] p-[3px]" role="radiogroup" aria-label="Type de média">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={category === option}
          onClick={() => onChange(option)}
          title={
            option === 'image'
              ? 'Générer des images (Nelth-V2 ou Nelth-V3)'
              : option === 'video'
                ? 'Générer des vidéos (480p ou 720p)'
                : 'Générer des GIF animés (Nelth-V3)'
          }
          className={cx(
            'flex items-center gap-1 rounded-full px-2 py-1 text-[13px] transition-all',
            category === option
              ? 'border border-[var(--images-line)] bg-[var(--images-pill)] font-medium text-[var(--images-ink)] shadow-[var(--images-shadow-btn)]'
              : 'font-medium text-[var(--images-muted)] hover:text-[var(--images-ink)]'
          )}
        >
          {CATEGORY_ICONS[option]}
          {CATEGORY_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segment Nelth-V2 | Nelth-V3 (catégorie image) — « NEW » bleu au-dessus de V3.
// ---------------------------------------------------------------------------

function ImageModelSegment({
  model,
  onChange,
}: {
  model: ImageModel;
  onChange(model: ImageModel): void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--images-chip-soft)] p-[3px]" role="radiogroup" aria-label="Modèle d'image">
      <button
        type="button"
        role="radio"
        aria-checked={model === 'v2'}
        onClick={() => onChange('v2')}
        title="Nelth-V2 — édition d'image fidèle et rapide"
        className={cx(
          'rounded-full px-2.5 py-1 text-[13px] transition-all',
          model === 'v2'
            ? 'border border-[var(--images-line)] bg-[var(--images-pill)] font-medium text-[var(--images-ink)] shadow-[var(--images-shadow-btn)]'
            : 'font-medium text-[var(--images-muted)] hover:text-[var(--images-ink)]'
        )}
      >
        Nelth-V2
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={model === 'v3'}
        onClick={() => onChange('v3')}
        title="Nelth-V3 — nouveau modèle, jusqu’à 4 variations"
        className={cx(
          'relative rounded-full px-2.5 py-1 text-[13px] transition-all',
          model === 'v3'
            ? 'border border-[var(--images-line)] bg-[var(--images-pill)] font-medium text-[var(--images-ink)] shadow-[var(--images-shadow-btn)]'
            : 'font-medium text-[var(--images-muted)] hover:text-[var(--images-ink)]'
        )}
      >
        {/* Petit texte bleu « NEW » en haut de la pilule V3 */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-[9px] left-1/2 -translate-x-1/2 text-[9px] font-bold uppercase leading-none tracking-[0.08em] text-[var(--images-accent)]"
        >
          new
        </span>
        Nelth-V3
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segment 480p | 720p (catégorie vidéo)
// ---------------------------------------------------------------------------

function ResolutionSegment({
  resolution,
  onChange,
}: {
  resolution: VideoResolution;
  onChange(resolution: VideoResolution): void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--images-chip-soft)] p-[3px]" role="radiogroup" aria-label="Résolution vidéo">
      {(['480p', '720p'] as VideoResolution[]).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={resolution === option}
          onClick={() => onChange(option)}
          title={option === '480p' ? 'Résolution standard (plus rapide)' : 'Résolution HD 720p (plus lente)'}
          className={cx(
            'rounded-full px-2.5 py-1 text-[13px] transition-all',
            resolution === option
              ? 'border border-[var(--images-line)] bg-[var(--images-pill)] font-medium text-[var(--images-ink)] shadow-[var(--images-shadow-btn)]'
              : 'font-medium text-[var(--images-muted)] hover:text-[var(--images-ink)]'
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sélecteur de variations (1-4)
// ---------------------------------------------------------------------------

/** Glyphe variations : quatre petits carrés (grille 2×2). */
function VariationsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('size-[15px]', className)} fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="2.5" />
      <rect x="13" y="3" width="8" height="8" rx="2.5" opacity="0.55" />
      <rect x="3" y="13" width="8" height="8" rx="2.5" opacity="0.55" />
      <rect x="13" y="13" width="8" height="8" rx="2.5" opacity="0.3" />
    </svg>
  );
}

function VariationsPicker({
  value,
  locked,
  lockHint,
  onChange,
}: {
  value: number;
  locked: boolean;
  lockHint?: string;
  onChange(value: number): void;
}) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement | null>(null);

  if (locked) {
    return (
      <span
        className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--images-line)] px-2 py-1.5 text-[13px] font-medium text-[var(--images-disabled)]"
        title={lockHint ?? 'Une seule variation dans ce mode'}
      >
        <VariationsGlyph className="text-[var(--images-disabled)] opacity-60" />
        1×
      </span>
    );
  }

  return (
    <div ref={anchorRef} className="relative shrink-0 whitespace-nowrap">
      <button
        type="button"
        className="flex items-center gap-1 rounded-full border border-[var(--images-line)] px-2 py-1.5 text-[13px] font-medium text-[var(--images-ink)] transition-colors hover:bg-[var(--images-hover)]"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Nombre de variations"
        title="Nombre de variations (1 à 4)"
      >
        <VariationsGlyph className="text-[var(--images-muted)]" />
        {value}×
        <ChevronDown className="size-3 text-[var(--images-muted)]" strokeWidth={2} />
      </button>
      <PopoverShell open={open} onClose={() => setOpen(false)} width="164px" anchorRef={anchorRef}>
        <div role="listbox" aria-label="Variations" className="grid grid-cols-4 gap-1">
          {[1, 2, 3, 4].map((count) => (
            <button
              key={count}
              type="button"
              role="option"
              aria-selected={count === value}
              className={cx(
                'flex items-center justify-center rounded-[10px] px-0 py-2 text-[13px] font-medium transition-colors',
                count === value
                  ? 'bg-[var(--images-chip)] text-[var(--images-ink)]'
                  : 'text-[var(--images-muted)] hover:bg-[var(--images-hover)] hover:text-[var(--images-ink)]'
              )}
              onClick={() => {
                onChange(count);
                setOpen(false);
              }}
            >
              {count}×
            </button>
          ))}
        </div>
      </PopoverShell>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sélecteur de ratio (pop-over discret) — « Auto » quand le format suit la
// référence (image-to-image V2, image-to-video).
// ---------------------------------------------------------------------------

function RatioPicker({
  ratio,
  ratios,
  disabled,
  auto,
  onChange,
}: {
  ratio: string;
  ratios: string[];
  disabled: boolean;
  auto: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLDivElement | null>(null);

  if (disabled && auto) {
    return (
      <span
        className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--images-line)] px-2 py-1.5 text-[13px] font-medium text-[var(--images-disabled)]"
        title="Par défaut — suit le format de l’image de référence"
      >
        <svg viewBox="0 0 24 24" className="size-[15px] opacity-60" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
        </svg>
        Auto
      </span>
    );
  }
  if (disabled) {
    return (
      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--images-line)] px-2 py-1.5 text-[13px] font-medium text-[var(--images-disabled)]" title="Format non contrôlable par le moteur actif">
        <RatioGlyph ratio={ratio} className="opacity-40" />
        {ratio}
      </span>
    );
  }
  return (
    <div ref={anchorRef} className="relative shrink-0 whitespace-nowrap">
      <button
        type="button"
        className="flex items-center gap-1 rounded-full border border-[var(--images-line)] px-2 py-1.5 text-[13px] font-medium text-[var(--images-ink)] transition-colors hover:bg-[var(--images-hover)]"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Format"
      >
        <RatioGlyph ratio={ratio} />
        {ratio}
        <ChevronDown className="size-3 text-[var(--images-muted)]" strokeWidth={2} />
      </button>
      <PopoverShell open={open} onClose={() => setOpen(false)} width="188px" anchorRef={anchorRef}>
        <div role="listbox" className="grid grid-cols-3 gap-1">
          {ratios.map((r) => (
            <button
              key={r}
              type="button"
              role="option"
              aria-selected={r === ratio}
              className={cx(
                'flex items-center justify-center gap-1.5 rounded-[10px] px-2 py-2 text-[12px] font-medium transition-colors',
                r === ratio ? 'bg-[var(--images-chip)] text-[var(--images-ink)]' : 'text-[var(--images-muted)] hover:bg-[var(--images-hover)] hover:text-[var(--images-ink)]'
              )}
              onClick={() => {
                onChange(r);
                setOpen(false);
              }}
            >
              <RatioGlyph ratio={r} className="scale-[0.9]" />
              {r}
            </button>
          ))}
        </div>
      </PopoverShell>
    </div>
  );
}

/** Micro — dictée Web Speech si le navigateur la supporte (sinon absent). */
function MicButton({ onTranscript }: { onTranscript(text: string): void }) {
  const [listening, setListening] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const recRef = React.useRef<any>(null);

  const supported =
    typeof window !== 'undefined' &&
    Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  if (!supported) return null;

  function toggle() {
    if (listening) {
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
      setListening(false);
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SR();
    recRef.current = rec;
    rec.lang = (navigator.language || 'fr-FR').toLowerCase();
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (event: any) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      if (text) onTranscript(text.trim());
    };
    rec.onerror = (event: any) => {
      setError(event?.error === 'not-allowed' ? 'Micro refusé' : null);
      setListening(false);
    };
    rec.onend = () => setListening(false);
    setError(null);
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={cx(
        'flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--images-ink)] transition-colors hover:bg-[var(--images-chip)]',
        listening && 'images-mic-live'
      )}
      title={listening ? 'Arrêter la dictée' : 'Dicter le prompt'}
      aria-label={listening ? 'Arrêter la dictée' : 'Dicter le prompt'}
      aria-pressed={listening}
    >
      <Mic className="size-[18px]" strokeWidth={1.8} />
      {listening && error && <span className="sr-only">{error}</span>}
    </button>
  );
}

export function Composer(props: ComposerProps) {
  const {
    prompt,
    onPromptChange,
    ratio,
    onRatioChange,
    ratios,
    ratioDisabled,
    ratioAuto,
    category,
    onCategoryChange,
    imageModel,
    onImageModelChange,
    resolution,
    onResolutionChange,
    variations,
    onVariationsChange,
    variationsLocked,
    variationsLockHint,
    compact,
    generating,
    disabled,
    panelOpen,
    onTogglePanel,
    onGenerate,
    references,
    onRemoveReference,
  } = props;

  const areaRef = React.useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow (max ~5 lignes).
  React.useEffect(() => {
    const el = areaRef.current;
    if (!el || compact) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [prompt, compact]);

  const submit = () => {
    if (!prompt.trim() || generating || disabled) return;
    onGenerate();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="rounded-[24px] border border-[var(--images-line)] bg-[var(--images-surface)] shadow-[var(--images-shadow-card)]">
      {/* Zone de saisie (masquée en mode compact) */}
      <div
        className={cx(
          'overflow-hidden transition-[max-height,opacity] duration-200',
          compact ? 'max-h-0 opacity-0' : 'max-h-[170px] opacity-100'
        )}
      >
        <textarea
          ref={areaRef}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={
            category === 'video'
              ? 'Décrivez la vidéo à créer'
              : category === 'gif'
                ? 'Décrivez le GIF à créer'
                : 'Décrivez ce que vous imaginez'
          }
          aria-label="Description du média à créer"
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-6 text-[var(--images-ink)] outline-none placeholder:text-[var(--images-faint)]"
        />
        {/* Références attachées (image-to-image / image-to-video) */}
        {references.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {references.map((ref) => (
              <span
                key={ref.id}
                className="flex max-w-[220px] items-center gap-1.5 rounded-full border border-[var(--images-line)] bg-[var(--images-subtle)] py-1 pl-1 pr-2 text-[12px] text-[var(--images-ink)]"
              >
                <span className="flex size-6 items-center justify-center overflow-hidden rounded-full bg-[var(--images-chip)] text-[10px] text-[var(--images-muted)]">
                  {ref.label.slice(0, 2).toUpperCase()}
                </span>
                <span className="truncate font-medium">{ref.label}</span>
                <button
                  type="button"
                  onClick={() => onRemoveReference(ref.id)}
                  className="flex size-4 shrink-0 items-center justify-center rounded-full text-[var(--images-muted)] hover:text-[var(--images-ink)]"
                  aria-label={`Détacher ${ref.label}`}
                >
                  <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Barre d'outils compacte (toujours visible) — UNE SEULE LIGNE :
          + | chips | micro | envoyer (flex + align-items:center, sans
          flex-wrap). Les chips défilent horizontalement sur écran étroit
          (.images-chips-scroll) ; micro + « Générer » restent ancrés à
          droite (ml-auto, flex-shrink: 0) — jamais de deuxième ligne. */}
      <div className="relative flex items-center gap-1 px-2.5 pb-2.5 pt-2">
        {/* + — attache la bibliothèque de médias sous le composeur */}
        <button
          type="button"
          onClick={onTogglePanel}
          className={cx(
            'flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--images-ink)] transition-colors',
            panelOpen ? 'bg-[var(--images-chip)]' : 'hover:bg-[var(--images-chip)]'
          )}
          title="Joindre des médias"
          aria-label="Joindre des médias"
          aria-expanded={panelOpen}
        >
          <Plus className="size-[18px]" strokeWidth={2} />
        </button>

        {/* Saisie mono-ligne en mode compact */}
        {compact && (
          <input
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              category === 'video'
                ? 'Décrivez la vidéo à créer'
                : category === 'gif'
                  ? 'Décrivez le GIF à créer'
                  : 'Décrivez ce que vous imaginez'
            }
            aria-label="Description du média à créer"
            className="min-w-0 flex-1 bg-transparent px-2 text-[15px] leading-6 text-[var(--images-ink)] outline-none placeholder:text-[var(--images-faint)]"
          />
        )}

        {/* Chips (mode étendu) — zone centrale défilante : la rangée entière
            (catégorie, segment, variations, format) reste sur LA ligne de la
            barre d'outils ; sur écran étroit elle défile horizontalement
            (overflow-x-auto) au lieu de passer à la ligne. */}
        {!compact && (
          <div className="images-chips-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {/* Catégorie de média — Image | Vidéo | GIF */}
            <CategorySegment category={category} onChange={onCategoryChange} />

            {/* Segment contextuel : modèle d'image OU résolution vidéo.
                (GIF : aucun — le V3 est le seul modèle GIF.) */}
            {category === 'image' && (
              <ImageModelSegment model={imageModel} onChange={onImageModelChange} />
            )}
            {category === 'video' && (
              <ResolutionSegment resolution={resolution} onChange={onResolutionChange} />
            )}

            {/* Variations (1 à 4) */}
            <VariationsPicker
              value={variations}
              locked={variationsLocked}
              lockHint={variationsLockHint}
              onChange={onVariationsChange}
            />

            {/* Ratio — toujours présent */}
            <RatioPicker
              ratio={ratio}
              ratios={ratios}
              disabled={ratioDisabled}
              auto={ratioAuto}
              onChange={onRatioChange}
            />
          </div>
        )}

        {/* Fondu droit de la zone défilante — les chips s'effacent dans le
            fond de la carte juste avant les boutons d'action : coupure
            invisible quand tout tient, transition douce quand ça défile.
            (Peint la couleur de surface : invisible sur fond de carte.) */}
        {!compact && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-20 w-5 bg-gradient-to-l from-[var(--images-surface)] to-transparent"
          />
        )}

        {/* Micro + Générer — ancrés à droite de LA ligne (margin-left:auto,
            flex-shrink: 0) : jamais de retour à la ligne, jamais d'écrasement. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <MicButton onTranscript={(text) => onPromptChange(prompt ? `${prompt} ${text}`.trim() : text)} />

          {/* Générer — bouton circulaire bleu ↑ (référence vidéo) */}
          <button
            type="button"
            onClick={submit}
            disabled={disabled || generating || !prompt.trim()}
            className={cx(
              'flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--images-on-accent)] transition-all',
              disabled || generating || !prompt.trim()
                ? 'cursor-default bg-[var(--images-accent-soft)] text-[var(--images-on-accent)]'
                : 'bg-[var(--images-accent)] hover:bg-[var(--images-accent-strong)] active:scale-95'
            )}
            title="Générer"
            aria-label="Générer"
          >
            {generating ? (
              <svg className="size-[18px] animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2.5" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            ) : (
              <ArrowUp className="size-[18px]" strokeWidth="2.4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
