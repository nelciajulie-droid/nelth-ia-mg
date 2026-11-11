/**
 * Nelth-IA Images — résultat d'un tour de génération (workspace).
 *
 * Actions par résultat complété (parité ChatGPT Images) : Éditer (attache
 * l'image comme référence d'édition au composeur du bas — les instructions
 * suivantes partent en VRAI image-to-image), Variations, Télécharger,
 * Enregistrer (favori), Utiliser comme référence, Générer autre.
 *
 * Échecs : carte d'erreur claire + bouton Réessayer — le prompt et les
 * réglages ne se perdent jamais (le composeur du bas les conserve).
 */

import * as React from 'react';
import { Download, Heart, ImageOff, Pencil, RefreshCw, Repeat, Upload } from 'lucide-react';
import { cx, Spinner } from './ui';
import { aspectClassFor } from './image-generation-card';
import { downloadImage } from './api';
import type { ImagineCapabilities, ImagineItem } from '../lib/images/types';
import type { GenerationTurn } from './image-generation-workspace';

function pillButton(
  label: string,
  icon: React.ReactNode,
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'ink' | 'outline' | 'ghost' | 'danger';
    hideLabelOnMobile?: boolean;
  }
) {
  const { variant = 'outline', hideLabelOnMobile, className, ...rest } = props;
  const styles: Record<string, string> = {
    ink: 'bg-[var(--images-btn-ink)] text-[var(--images-btn-on-ink)] hover:opacity-90',
    outline: 'border border-[var(--images-line)] bg-[var(--images-surface)] text-[var(--images-ink)] hover:bg-[var(--images-hover)]',
    ghost: 'text-[var(--images-muted)] hover:bg-[var(--images-chip)] hover:text-[var(--images-ink)]',
    danger: 'text-[var(--images-muted)] hover:bg-[var(--images-danger-bg)] hover:text-[var(--images-danger)]',
  };
  return (
    <button
      type="button"
      className={cx(
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-all active:scale-[0.97]',
        styles[variant],
        className
      )}
      {...rest}
    >
      {icon}
      {hideLabelOnMobile ? <span className="max-sm:hidden">{label}</span> : label}
    </button>
  );
}

export interface ImageResultActionsProps {
  /** Items complétés du tour (la première image est la cible principale). */
  items: ImagineItem[];
  /** Prompt d'origine du tour — « Générer autre » le relance tel quel. */
  sourcePrompt: string;
  capabilities: ImagineCapabilities | null;
  /** Attache l'image comme référence d'édition du composeur (+ focus). */
  onEditImage(item: ImagineItem, focus: boolean): void;
  onVariation(item: ImagineItem): void;
  onDownload(item: ImagineItem): void;
  onSave(item: ImagineItem): void;
  /** Re-soumet le même prompt avec les réglages courants (nouveau tour). */
  onGenerateAnother(prompt: string): void;
  busyId: string | null;
}

export function ImageResultActions(props: ImageResultActionsProps) {
  const { items, capabilities } = props;
  const primary = items.find((i) => i.status === 'completed' && i.url);
  if (!primary) return null;

  const canEdit = Boolean(capabilities?.features.editing);
  const canVariation = Boolean(capabilities?.features.variations);
  const busy = props.busyId === primary.id;

  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
      {pillButton('Éditer', <Pencil className="size-3.5" strokeWidth={2} />, {
        variant: 'ink',
        onClick: () => props.onEditImage(primary, true),
        disabled: !canEdit,
        title: canEdit
          ? 'Attacher cette image au composeur — vos instructions l’éditeront'
          : 'Édition non prise en charge par le moteur actif',
      })}
      {pillButton('Variations', <Repeat className="size-3.5" strokeWidth={2} />, {
        onClick: () => props.onVariation(primary),
        disabled: !canVariation || busy,
        title: 'Générer une variation de cette image',
      })}
      {pillButton('Télécharger', <Download className="size-3.5" strokeWidth={2} />, {
        variant: 'ghost',
        onClick: () => props.onDownload(primary),
        title: 'Télécharger',
        hideLabelOnMobile: true,
      })}
      {pillButton(primary.favorite ? 'Enregistrée' : 'Enregistrer', (
        <Heart className={cx('size-3.5', primary.favorite && 'fill-current')} strokeWidth={2} />
      ), {
        variant: 'ghost',
        onClick: () => props.onSave(primary),
        title: primary.favorite ? 'Retirée des favoris' : 'Ajouter aux favoris',
        hideLabelOnMobile: true,
      })}
      {pillButton('Utiliser comme référence', <Upload className="size-3.5" strokeWidth={2} />, {
        variant: 'ghost',
        onClick: () => props.onEditImage(primary, false),
        disabled: !canEdit,
        title: 'Joindre cette image comme référence d’édition',
        hideLabelOnMobile: true,
        className: 'max-sm:px-2.5',
      })}
      {pillButton('Générer autre', <RefreshCw className="size-3.5" strokeWidth={2} />, {
        variant: 'ghost',
        onClick: () => props.onGenerateAnother(props.sourcePrompt),
        title: 'Relancer ce prompt — les résultats précédents restent dans le fil',
      })}
      {busy && (
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--images-muted)]">
          <Spinner className="size-3.5" />
          Mise en file…
        </span>
      )}
    </div>
  );
}

/** Échec d'UN item (statut failed côté serveur) — remplace la carte. */
export function ItemFailureCard({ item }: { item: ImagineItem }) {
  return (
    <div
      className={cx(
        'flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-[var(--images-line)] bg-[var(--images-subtle)] px-4 py-10 text-center',
        aspectClassFor(item.aspect_ratio)
      )}
      role="alert"
    >
      <ImageOff className="size-5 text-[var(--images-empty-icon)]" strokeWidth={1.8} aria-hidden="true" />
      <span className="text-[14px] font-medium text-[var(--images-ink)]">Échec de génération</span>
      <span className="max-w-[340px] text-center text-[12px] leading-5 text-[var(--images-muted)]">
        {item.error ?? 'Le moteur n’a pas pu produire cette image.'}
      </span>
    </div>
  );
}

/** Échec de la REQUÊTE entière (rien n'a été mis en file) — carte + Réessayer. */
export function TurnErrorCard({
  turn,
  onRetry,
  busy,
}: {
  turn: GenerationTurn;
  onRetry(): void;
  busy: boolean;
}) {
  return (
    <div
      className="images-pop flex w-full flex-col items-center gap-3 rounded-[20px] border border-[var(--images-line)] bg-[var(--images-subtle)] px-6 py-10 text-center"
      role="alert"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-[var(--images-chip)] text-[var(--images-danger)]">
        <ImageOff className="size-5" strokeWidth={1.8} aria-hidden="true" />
      </span>
      <div className="flex flex-col items-center gap-1">
        <p className="text-[14px] font-medium text-[var(--images-ink)]">Génération impossible</p>
        <p className="max-w-[420px] text-[13px] leading-5 text-[var(--images-muted)]">{turn.error}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-full bg-[var(--images-btn-ink)] px-4 py-2 text-[13px] font-medium text-[var(--images-btn-on-ink)] transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" strokeWidth={2} />}
        Réessayer
      </button>
      <p className="text-[12px] text-[var(--images-faint)]">
        Le prompt et les réglages sont conservés — « Réessayer » relance exactement la même requête.
      </p>
    </div>
  );
}
