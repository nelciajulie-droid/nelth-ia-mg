/**
 * Nelth-IA Images — panneau médias attaché au composeur (référence vidéo).
 *
 * Colonne d'onglets à gauche : Générations / Importations (haut),
 * Dessiner / Importer des médias (bas). Contenu : titre + bouton noir
 * « + Importer », grille 5 colonnes, squelettes #ECECEC pendant la
 * génération, états vides (« Vos générations s'afficheront ici »…).
 */

import * as React from 'react';
import { Image as ImageIcon, Maximize2, Pencil, Sparkles, Upload } from 'lucide-react';
import { AuthImg, AuthVideo, cx, isVideoItem, phaseLabel } from './ui';
import type { ImagineItem } from '../lib/images/types';

export type PanelTab = 'generations' | 'imports';

export interface MediaPanelProps {
  items: ImagineItem[];
  tab: PanelTab;
  onTabChange(tab: PanelTab): void;
  onImportFiles(files: FileList | File[]): void;
  onDraw(): void;
  onPickReference(item: ImagineItem): void;
  onOpenDetail(item: ImagineItem): void;
  selectedIds: Set<string>;
  canAttach: boolean;
}

function sideItem(
  label: string,
  icon: React.ReactNode,
  active: boolean,
  onClick: () => void
) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'flex shrink-0 items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-medium transition-colors',
        active ? 'bg-[var(--images-chip)] text-[var(--images-ink)]' : 'text-[var(--images-muted)] hover:bg-[var(--images-hover)] hover:text-[var(--images-ink)]'
      )}
      aria-current={active ? 'true' : undefined}
    >
      {icon}
      {label}
    </button>
  );
}

function GridCard({
  item,
  selected,
  canAttach,
  onPick,
  onOpen,
}: {
  item: ImagineItem;
  selected: boolean;
  canAttach: boolean;
  onPick(): void;
  onOpen(): void;
}) {
  const pending = item.status === 'generating' || item.status === 'processing';
  const failed = item.status === 'failed';

  if (pending) {
    return (
      <div
        className="images-skeleton relative flex items-center justify-center rounded-[12px]"
        title={item.prompt ?? 'Génération en cours'}
      >
        <span className="relative z-10 px-1.5 py-1 text-center text-[11px] font-medium text-[var(--images-muted)]">
          {phaseLabel(item.phase)}
        </span>
      </div>
    );
  }

  if (failed) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center justify-center rounded-[12px] border border-[var(--images-line)] bg-[var(--images-subtle)] text-[11px] font-medium text-[var(--images-muted)] transition-colors hover:bg-[var(--images-chip)]"
        title={item.error ?? 'Génération échouée'}
      >
        Échec
      </button>
    );
  }

  return (
    <div
      className={cx(
        'group relative overflow-hidden rounded-[12px] transition-shadow',
        selected ? 'ring-2 ring-[var(--images-accent)]' : 'ring-1 ring-[var(--images-ring)] hover:ring-[var(--images-ring-strong)]'
      )}
    >
      <button
        type="button"
        onClick={canAttach ? onPick : onOpen}
        className="block w-full"
        aria-label={item.name ?? item.prompt ?? (isVideoItem(item) ? 'Vidéo' : 'Image')}
      >
        {isVideoItem(item) ? (
          <AuthVideo
            path={item.url}
            alt={item.name ?? item.prompt ?? 'Vidéo'}
            controls={false}
            autoPlay
            className="aspect-square h-full w-full object-cover"
          />
        ) : (
          <AuthImg
            path={item.url}
            alt={item.name ?? item.prompt ?? 'Image'}
            className="aspect-square h-full w-full object-cover"
          />
        )}
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/65 group-hover:opacity-100"
        aria-label="Agrandir"
        title="Agrandir"
      >
        <Maximize2 className="size-3" strokeWidth={2.2} />
      </button>
    </div>
  );
}

export function MediaPanel(props: MediaPanelProps) {
  const { items, tab, onTabChange, onImportFiles, onDraw, onPickReference, onOpenDetail, selectedIds, canAttach } =
    props;

  const generations = items.filter((i) => i.source !== 'upload');
  const imports = items.filter((i) => i.source === 'upload');
  const list = tab === 'generations' ? generations : imports;

  return (
    <div className="images-fade mt-2 flex h-[min(480px,62vh)] flex-col overflow-hidden rounded-[20px] border border-[var(--images-line)] bg-[var(--images-surface)] shadow-[var(--images-shadow-card)] sm:flex-row">
      {/* Colonne d'onglets (référence vidéo : liste verticale ~200px) */}
      <nav
        className="flex items-center gap-1 overflow-x-auto border-b border-[var(--images-line)] p-2 sm:w-[200px] sm:flex-col sm:items-stretch sm:overflow-visible sm:border-b-0 sm:border-r"
        aria-label="Bibliothèque"
      >
        {sideItem(
          'Générations',
          <Sparkles className="size-4" strokeWidth={1.8} />,
          tab === 'generations',
          () => onTabChange('generations')
        )}
        {sideItem(
          'Importations',
          <ImageIcon className="size-4" strokeWidth={1.8} />,
          tab === 'imports',
          () => onTabChange('imports')
        )}
        <div className="hidden sm:mt-auto sm:block">
          <div className="mx-2 my-1 h-px bg-[var(--images-line)]" />
          {sideItem(
            'Dessiner',
            <Pencil className="size-4" strokeWidth={1.8} />,
            false,
            onDraw
          )}
          <label
            htmlFor="nelth-images-file"
            className="flex shrink-0 cursor-pointer select-none items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-medium text-[var(--images-muted)] transition-colors hover:bg-[var(--images-hover)] hover:text-[var(--images-ink)]"
          >
            <Upload className="size-4" strokeWidth={1.8} />
            Importer des médias
          </label>
        </div>
      </nav>

      {/* Contenu */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-[15px] font-semibold text-[var(--images-ink)]">
            {tab === 'generations' ? 'Générations' : 'Importations'}
          </span>
          <label
            htmlFor="nelth-images-file"
            className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-full bg-[var(--images-btn-ink)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--images-btn-on-ink)] transition-opacity hover:opacity-90 active:scale-[0.98]"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Importer
          </label>
        </div>

        <div className="images-scroll flex-1 overflow-y-auto px-4 pb-4">
          {list.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <ImageIcon className="mb-3 size-6 text-[var(--images-empty-icon)]" strokeWidth={1.5} aria-hidden="true" />
              <p className="text-[13px] text-[var(--images-muted)]">
                {tab === 'generations'
                  ? 'Vos générations s’afficheront ici'
                  : 'Vos fichiers importés s’afficheront ici'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {list.map((item) => (
                <GridCard
                  key={item.id}
                  item={item}
                  selected={selectedIds.has(item.id)}
                  canAttach={canAttach}
                  onPick={() => onPickReference(item)}
                  onOpen={() => onOpenDetail(item)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Actions mobiles bas de colonne ( Dessiner / Importer des médias ) */}
      <div className="flex items-center gap-1 border-t border-[var(--images-line)] p-2 sm:hidden">
        {sideItem('Dessiner', <Pencil className="size-4" strokeWidth={1.8} />, false, onDraw)}
        <label
          htmlFor="nelth-images-file"
          className="flex shrink-0 cursor-pointer select-none items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-medium text-[var(--images-muted)] transition-colors hover:bg-[var(--images-hover)] hover:text-[var(--images-ink)]"
        >
          <Upload className="size-4" strokeWidth={1.8} />
          Importer des médias
        </label>
      </div>

      <input
        id="nelth-images-file"
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onImportFiles(e.target.files);
          e.target.value = '';
        }}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}
