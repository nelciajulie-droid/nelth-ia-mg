/**
 * Nelth-IA Images — composeur compact (référence vidéo).
 *
 * Carte blanche centrée ~640 px : placeholder « Décrivez ce que vous imaginez »,
 * barre d'outils + / Image / Vitesse|Qualité 2.0 / ratio 2:3 / micro / bouton
 * circulaire bleu ↑. Compacté en pilule mono-ligne quand on défile.
 */

import * as React from 'react';
import { ArrowUp, ChevronDown, Mic, Plus } from 'lucide-react';
import { cx } from './ui';

export type ComposerMode = 'vitesse' | 'qualite';

export interface ComposerProps {
  prompt: string;
  onPromptChange(value: string): void;
  ratio: string;
  onRatioChange(value: string): void;
  ratios: string[];
  ratioDisabled: boolean;
  mode: ComposerMode;
  onModeChange(mode: ComposerMode): void;
  compact: boolean;
  generating: boolean;
  disabled: boolean;
  panelOpen: boolean;
  onTogglePanel(): void;
  onGenerate(): void;
  references: Array<{ id: string; label: string; url: string | null }>;
  onRemoveReference(id: string): void;
}

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
      className={cx('inline-block rounded-[2px] bg-[#171717]', className)}
      style={{ width: gw, height: gh }}
    />
  );
}

/** Sélecteur de ratio (pop-over discret). */
function RatioPicker({
  ratio,
  ratios,
  disabled,
  onChange,
}: {
  ratio: string;
  ratios: string[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = React.useState(false);
  if (disabled) {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-[#EAEAEA] px-2.5 py-1.5 text-[13px] font-medium text-[#bdbdbd]" title="Format non contrôlable par le moteur actif">
        <RatioGlyph ratio={ratio} className="opacity-40" />
        {ratio}
      </span>
    );
  }
  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-full border border-[#EAEAEA] px-2.5 py-1.5 text-[13px] font-medium text-[#171717] transition-colors hover:bg-[#F7F7F7]"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Format"
      >
        <RatioGlyph ratio={ratio} />
        {ratio}
        <ChevronDown className="size-3 text-[#777777]" strokeWidth={2} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            className="images-pop absolute bottom-full left-0 z-50 mb-2 grid w-[188px] grid-cols-3 gap-1 rounded-[14px] border border-[#EAEAEA] bg-white p-2 shadow-[0_8px_28px_rgba(0,0,0,0.10)]"
          >
            {ratios.map((r) => (
              <button
                key={r}
                type="button"
                role="option"
                aria-selected={r === ratio}
                className={cx(
                  'flex items-center justify-center gap-1.5 rounded-[10px] px-2 py-2 text-[12px] font-medium transition-colors',
                  r === ratio ? 'bg-[#F2F2F2] text-[#171717]' : 'text-[#777777] hover:bg-[#F7F7F7] hover:text-[#171717]'
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
        </>
      )}
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
        'flex size-9 items-center justify-center rounded-full text-[#171717] transition-colors hover:bg-[#F2F2F2]',
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
    mode,
    onModeChange,
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
    <div className="rounded-[24px] border border-[#EAEAEA] bg-white shadow-[0_2px_16px_rgba(0,0,0,0.05)]">
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
          placeholder="Décrivez ce que vous imaginez"
          aria-label="Description de l'image à créer"
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[15px] leading-6 text-[#171717] outline-none placeholder:text-[#9aa0a6]"
        />
        {/* Références attachées (image-to-image) */}
        {references.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {references.map((ref) => (
              <span
                key={ref.id}
                className="flex max-w-[220px] items-center gap-1.5 rounded-full border border-[#EAEAEA] bg-[#FAFAFA] py-1 pl-1 pr-2 text-[12px] text-[#171717]"
              >
                <span className="flex size-6 items-center justify-center overflow-hidden rounded-full bg-[#F2F2F2] text-[10px] text-[#777777]">
                  {ref.label.slice(0, 2).toUpperCase()}
                </span>
                <span className="truncate font-medium">{ref.label}</span>
                <button
                  type="button"
                  onClick={() => onRemoveReference(ref.id)}
                  className="flex size-4 shrink-0 items-center justify-center rounded-full text-[#777777] hover:text-[#171717]"
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

      {/* Barre d'outils compacte (toujours visible) */}
      <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
        {/* + — attache la bibliothèque de médias sous le composeur */}
        <button
          type="button"
          onClick={onTogglePanel}
          className={cx(
            'flex size-8 items-center justify-center rounded-full text-[#171717] transition-colors',
            panelOpen ? 'bg-[#F2F2F2]' : 'hover:bg-[#F2F2F2]'
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
            placeholder="Décrivez ce que vous imaginez"
            aria-label="Description de l'image à créer"
            className="min-w-0 flex-1 bg-transparent px-2 text-[15px] leading-6 text-[#171717] outline-none placeholder:text-[#9aa0a6]"
          />
        )}

        {/* Chips (mode étendu) */}
        {!compact && (
          <>
            <span className="flex items-center gap-1.5 rounded-full bg-[#F2F2F2] px-3 py-1.5 text-[13px] font-medium text-[#171717]">
              <svg viewBox="0 0 24 24" className="size-[15px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="9" cy="9" r="1.6" />
                <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
              </svg>
              Image
            </span>

            {/* Segment Vitesse | Qualité 2.0 — vitesse = 1 image, qualité = 2 */}
            <div className="flex items-center gap-1 rounded-full bg-[#F5F5F5] p-[3px]" role="radiogroup" aria-label="Régime de génération">
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'vitesse'}
                onClick={() => onModeChange('vitesse')}
                className={cx(
                  'rounded-full px-3 py-1 text-[13px] transition-all',
                  mode === 'vitesse'
                    ? 'border border-[#EAEAEA] bg-white font-medium text-[#171717] shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                    : 'font-medium text-[#777777]'
                )}
              >
                Vitesse
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'qualite'}
                onClick={() => onModeChange('qualite')}
                className={cx(
                  'rounded-full px-3 py-1 text-[13px] transition-all',
                  mode === 'qualite'
                    ? 'border border-[#EAEAEA] bg-white font-medium text-[#171717] shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                    : 'font-medium text-[#777777]'
                )}
              >
                Qualité 2.0
              </button>
            </div>

            <RatioPicker ratio={ratio} ratios={ratios} disabled={ratioDisabled} onChange={onRatioChange} />

            <div className="min-w-2 flex-1" />
          </>
        )}

        {compact && <div className="flex-1" />}

        <MicButton onTranscript={(text) => onPromptChange(prompt ? `${prompt} ${text}`.trim() : text)} />

        {/* Générer — bouton circulaire bleu ↑ (référence vidéo) */}
        <button
          type="button"
          onClick={submit}
          disabled={disabled || generating || !prompt.trim()}
          className={cx(
            'flex size-9 items-center justify-center rounded-full text-white transition-all',
            disabled || generating || !prompt.trim()
              ? 'cursor-default bg-[#CDE0FA] text-white'
              : 'bg-[#4D9BF5] hover:bg-[#3D8BEA] active:scale-95'
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
  );
}
