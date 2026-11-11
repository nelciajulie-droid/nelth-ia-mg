/**
 * Nelth-IA Images — vue détail plein blanc (édition prompt, retouche,
 * variations, téléchargement, réutilisation en référence, suppression).
 */

import * as React from 'react';
import {
  ArrowLeft,
  Download,
  Pencil,
  Repeat,
  Trash2,
  Type,
  Upload,
  Wand2,
} from 'lucide-react';
import { AuthImg, AuthVideo, cx, downloadExt, formatTime, isVideoItem, phaseLabel, sourceLabel, Spinner } from './ui';
import { downloadImage } from './api';
import type { ImagineItem } from '../lib/images/types';

export interface DetailOverlayProps {
  item: ImagineItem;
  busy: string | null;
  onClose(): void;
  onEdit(itemId: string, prompt: string, kind: 'texte' | 'retouche'): void;
  onVariation(itemId: string): void;
  onUseReference(item: ImagineItem): void;
  onDelete(itemId: string): void;
}

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

export function DetailOverlay(props: DetailOverlayProps) {
  const { item, busy, onClose, onEdit, onVariation, onUseReference, onDelete } = props;
  const [editor, setEditor] = React.useState<'texte' | 'retouche' | null>(null);
  const [instructions, setInstructions] = React.useState('');

  const pending = item.status === 'generating' || item.status === 'processing';
  const isVideo = isVideoItem(item);
  const ratio = item.aspect_ratio ?? '1:1';
  const [rw, rh] = ratio.split(':').map(Number);
  const aspect = rw && rh ? `${rw} / ${rh}` : '1 / 1';

  function submitEditor() {
    if (!instructions.trim() || !editor) return;
    onEdit(item.id, instructions.trim(), editor);
    setEditor(null);
    setInstructions('');
  }

  return (
    <div
      className="images-fade fixed inset-0 z-50 flex flex-col bg-[var(--images-bg)]"
      role="dialog"
      aria-modal="true"
      aria-label="Détail de l'image"
    >
      {/* Barre supérieure */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-[var(--images-line)] px-3 sm:px-5">
        <button
          type="button"
          onClick={onClose}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--images-muted)] transition-colors hover:bg-[var(--images-chip)] hover:text-[var(--images-ink)]"
          aria-label="Retour à la bibliothèque"
        >
          <ArrowLeft className="size-4" strokeWidth={2} />
          Retour
        </button>
        <span className="mx-2 hidden min-w-0 flex-1 truncate text-center text-[13px] text-[var(--images-muted)] sm:mx-3 sm:block">
          {item.name ?? item.prompt ?? 'Image'}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {pillButton('Télécharger', <Download className="size-3.5" strokeWidth={2} />, {
            variant: 'ghost',
            onClick: () =>
              void downloadImage(
                item.url ?? '',
                item.name ?? `nelth-${isVideo ? 'video' : 'image'}-${item.id}${downloadExt(item)}`
              ),
            disabled: pending || !item.url,
            title: 'Télécharger',
            hideLabelOnMobile: true,
          })}
          {pillButton('Utiliser comme référence', <Upload className="size-3.5" strokeWidth={2} />, {
            variant: 'ghost',
            onClick: () => onUseReference(item),
            disabled: pending || !item.url,
            title: 'Utiliser comme référence',
            hideLabelOnMobile: true,
            className: 'max-sm:px-2.5',
          })}
        </div>
      </header>

      {/* Corps : grand aperçu centré */}
      <div className="images-scroll flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-6 sm:px-8 sm:py-10">
        <div className="flex w-full max-w-[820px] flex-col items-center">
          {pending ? (
            <div
              className="images-skeleton flex w-full max-w-[520px] items-center justify-center rounded-[16px]"
              style={{ aspectRatio: aspect }}
            >
              <span className="z-10 text-[13px] font-medium text-[var(--images-muted)]">{phaseLabel(item.phase)}</span>
            </div>
          ) : item.status === 'failed' ? (
            <div
              className="flex w-full max-w-[520px] flex-col items-center justify-center gap-2 rounded-[16px] border border-[var(--images-line)] bg-[var(--images-subtle)] py-16"
              style={{ aspectRatio: aspect }}
            >
              <span className="text-[14px] font-medium text-[var(--images-ink)]">Génération échouée</span>
              <span className="max-w-[380px] px-4 text-center text-[12px] text-[var(--images-muted)]">
                {item.error ?? 'Le moteur n’a pas pu produire cette image.'}
              </span>
            </div>
          ) : isVideo ? (
            <AuthVideo
              path={item.url}
              alt={item.name ?? item.prompt ?? 'Vidéo'}
              controls
              className="max-h-[58vh] w-auto max-w-full rounded-[16px] ring-1 ring-[var(--images-ring)]"
              fallbackClassName="max-h-[58vh] w-full max-w-[520px] rounded-[16px]"
            />
          ) : (
            <AuthImg
              path={item.url}
              alt={item.name ?? item.prompt ?? 'Image'}
              className="max-h-[58vh] w-auto max-w-full rounded-[16px] ring-1 ring-[var(--images-ring)]"
              fallbackClassName="max-h-[58vh] w-auto max-w-full rounded-[16px]"
            />
          )}

          {/* Métadonnées */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px] text-[var(--images-muted)]">
            <span>{sourceLabel(item)}</span>
            {item.aspect_ratio && (
              <>
                <span aria-hidden="true">·</span>
                <span>{item.aspect_ratio}</span>
              </>
            )}
            {item.width && item.height && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {item.width}×{item.height}
                </span>
              </>
            )}
            {item.created_at && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatTime(item.created_at)}</span>
              </>
            )}
          </div>

          {/* Prompt d'origine */}
          {item.prompt && (
            <p className="mt-3 max-w-[560px] text-center text-[13px] leading-5 text-[var(--images-muted)]">
              {item.prompt}
            </p>
          )}

          {/* Éditeur d'instructions (Modifier le texte / Retouche précise) */}
          {editor && (
            <div className="images-pop mt-5 w-full max-w-[560px] rounded-[16px] border border-[var(--images-line)] bg-[var(--images-surface)] p-4 shadow-[var(--images-shadow-card)]">
              <label className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-[var(--images-ink)]">
                {editor === 'texte' ? <Type className="size-3.5" strokeWidth={2} /> : <Pencil className="size-3.5" strokeWidth={2} />}
                {editor === 'texte' ? 'Nouveau texte ou description' : 'Retouche précise souhaitée'}
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={2}
                placeholder={
                  editor === 'texte'
                    ? 'Ex. : remplace le texte par « NELTH » dans le même style…'
                    : 'Ex. : éclaircit l’arrière-plan, garde le sujet intact…'
                }
                className="block w-full resize-none rounded-[10px] border border-[var(--images-line)] px-3 py-2.5 text-[14px] leading-6 text-[var(--images-ink)] outline-none placeholder:text-[var(--images-faint)] focus:border-[var(--images-line-strong)]"
              />
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded-full px-3.5 py-1.5 text-[13px] font-medium text-[var(--images-muted)] transition-colors hover:bg-[var(--images-chip)] hover:text-[var(--images-ink)]"
                  onClick={() => {
                    setEditor(null);
                    setInstructions('');
                  }}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  disabled={!instructions.trim()}
                  onClick={submitEditor}
                  className="flex items-center gap-1.5 rounded-full bg-[var(--images-btn-ink)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--images-btn-on-ink)] transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  Régénérer
                </button>
              </div>
            </div>
          )}

          {/* Actions (référence vidéo + master prompt §8) — édit image
              indisponible sur les vidéos. */}
          <div className="mb-4 mt-6 flex flex-wrap items-center justify-center gap-2">
            {!isVideo && (
              <>
                {pillButton('Modifier le texte', <Type className="size-3.5" strokeWidth={2} />, {
                  variant: 'ink',
                  onClick: () => {
                    setEditor('texte');
                    setInstructions('');
                  },
                  disabled: pending,
                  title: 'Éditer le texte ou la description de l’image',
                })}
                {pillButton('Retouche précise', <Pencil className="size-3.5" strokeWidth={2} />, {
                  variant: 'outline',
                  onClick: () => {
                    setEditor('retouche');
                    setInstructions('');
                  },
                  disabled: pending,
                })}
                {pillButton('Reimaginer', <Wand2 className="size-3.5" strokeWidth={2} />, {
                  variant: 'outline',
                  onClick: () => onVariation(item.id),
                  disabled: pending || busy === item.id,
                  title: 'Générer une variation de cette image',
                })}
              </>
            )}
            {pillButton('Boucle', <Repeat className="size-3.5" strokeWidth={2} />, {
              variant: 'outline',
              disabled: true,
              title: 'Bientôt disponible — boucle animée',
            })}
            {pillButton('Supprimer', <Trash2 className="size-3.5" strokeWidth={2} />, {
              variant: 'danger',
              onClick: () => onDelete(item.id),
              disabled: pending,
            })}
          </div>
          {busy === item.id && (
            <div className="mb-4 flex items-center gap-2 text-[12px] text-[var(--images-muted)]">
              <Spinner className="size-3.5" />
              Mise en file…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
