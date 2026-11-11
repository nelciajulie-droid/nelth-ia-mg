/**
 * Nelth-IA Images — vue principale « Image Studio ».
 *
 * Vue par défaut de l'espace Images (référence vidéo) : en-tête sticky
 * (« + Nouveau Canvas », pilule de retour au workspace quand un fil existe),
 * titre centré « Qu'allons-nous imaginer ? », composeur compact centré
 * (layoutId partagé avec le workspace — il glisse en bas à la génération),
 * panneau média attaché, galerie d'inspiration.
 *
 * La position de défilement et l'état du composeur vivent dans la racine :
 * partir au workspace puis revenir restaure TOUT, sans rechargement.
 */

import * as React from 'react';
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import { Composer, type ComposerMode } from './composer';
import { MediaPanel, type PanelTab } from './mediapanel';
import { InspirationGallery } from './galleryview';
import { COMPOSER_TRANSITION } from './image-generation-composer';
import { cx } from './ui';
import type { GalleryEntry } from '../lib/images/gallery';
import type { ImagineCapabilities, ImagineItem } from '../lib/images/types';

const VIEW_TRANSITION = { duration: 0.3, ease: [0.22, 1, 0.36, 1] } as const;

export interface ImageStudioProps {
  // ---- défilement (la racine conserve la position entre les vues) ----
  onScroll(e: React.UIEvent<HTMLDivElement>): void;
  scrolled: boolean;

  // ---- composeur (état racine — préservé à travers les vues) ----
  canGenerate: boolean;
  capabilities: ImagineCapabilities | null;
  prompt: string;
  onPromptChange(value: string): void;
  ratio: string;
  onRatioChange(value: string): void;
  mode: ComposerMode;
  onModeChange(mode: ComposerMode): void;
  generating: boolean;
  onGenerate(): void;
  references: Array<{ id: string; label: string; url: string | null }>;
  onRemoveReference(id: string): void;

  // ---- panneau média attaché ----
  panelOpen: boolean;
  onTogglePanel(): void;
  panelTab: PanelTab;
  onPanelTabChange(tab: PanelTab): void;
  items: ImagineItem[];
  onImportFiles(files: FileList | File[]): void;
  onDraw(): void;
  onPickReference(item: ImagineItem): void;
  onOpenDetail(item: ImagineItem): void;
  selectedIds: Set<string>;
  canAttach: boolean;

  // ---- galerie + en-tête ----
  onUseIdea(entry: GalleryEntry): void;
  onNewCanvas(): void;

  // ---- retour au workspace de génération ----
  hasTurns: boolean;
  pendingCount: number;
  onOpenWorkspace(): void;
}

export function ImageStudio(props: ImageStudioProps) {
  const capabilities = props.capabilities;

  return (
    <motion.div
      className="absolute inset-0 flex flex-col"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={VIEW_TRANSITION}
      role="region"
      aria-label="Studio d'images"
    >
      <div
        data-nelth-images-scroll="studio"
        onScroll={props.onScroll}
        className="images-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {/* Bloc sticky : header + titre + composeur (se compacte au défilement) */}
        <div className="sticky top-0 z-30 bg-[var(--images-bg-translucent)] backdrop-blur-md">
          <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-1 sm:px-6">
            {/* Retour au fil de génération (les jobs continuent en fond). */}
            {props.hasTurns && (
              <button
                type="button"
                onClick={props.onOpenWorkspace}
                className="flex items-center gap-1.5 rounded-full border border-[var(--images-line)] bg-[var(--images-surface)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--images-ink)] shadow-[var(--images-shadow-sm)] transition-colors hover:bg-[var(--images-hover)]"
                aria-label="Reprendre l'espace de génération"
                title="Reprendre l'espace de génération — les générations suivent leur cours"
              >
                <Sparkles
                  className={cx('size-3.5', props.pendingCount > 0 && 'text-[var(--images-accent)]')}
                  strokeWidth={2}
                  aria-hidden="true"
                />
                <span className="hidden sm:inline">Espace de génération</span>
                {props.pendingCount > 0 && (
                  <span className="flex min-w-[18px] items-center justify-center rounded-full bg-[var(--images-accent)] px-1 py-px text-[11px] font-semibold leading-4 text-[var(--images-on-accent)]">
                    {props.pendingCount}
                  </span>
                )}
              </button>
            )}
            <div className="min-w-0 flex-1" aria-hidden="true" />
            <button
              type="button"
              onClick={props.onNewCanvas}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--images-line)] bg-[var(--images-surface)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--images-ink)] shadow-[var(--images-shadow-sm)] transition-colors hover:bg-[var(--images-hover)]"
            >
              <svg
                viewBox="0 0 24 24"
                className="size-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Nouveau Canvas
            </button>
          </div>

          {/* Titre centré — se replie quand on défile (référence vidéo) */}
          <div
            className={cx(
              'overflow-hidden transition-[max-height,opacity,padding-top,padding-bottom] duration-300',
              props.scrolled ? 'max-h-0 py-0 opacity-0' : 'max-h-28 pt-8 pb-2 opacity-100'
            )}
            aria-hidden={props.scrolled}
          >
            <h1 className="px-4 text-center text-[22px] font-bold leading-8 tracking-[-0.015em] text-[var(--images-ink)] sm:text-[26px]">
              Qu’allons-nous imaginer ?
            </h1>
          </div>

          {/* Composeur — layoutId partagé : il glisse vers le bas du workspace. */}
          <div className="px-4 pb-3 sm:px-6">
            <motion.div
              layoutId="images-composer"
        data-composer-glide="studio"
              transition={COMPOSER_TRANSITION}
              className="mx-auto w-full max-w-[640px]"
            >
              <Composer
                prompt={props.prompt}
                onPromptChange={props.onPromptChange}
                ratio={props.ratio}
                onRatioChange={props.onRatioChange}
                ratios={capabilities?.aspectRatios ?? ['1:1']}
                ratioDisabled={capabilities?.aspectRatioMode === 'none' || !capabilities}
                mode={props.mode}
                onModeChange={props.onModeChange}
                compact={props.scrolled}
                generating={props.generating}
                disabled={!props.canGenerate}
                panelOpen={props.panelOpen}
                onTogglePanel={props.onTogglePanel}
                onGenerate={props.onGenerate}
                references={props.references}
                onRemoveReference={props.onRemoveReference}
              />
            </motion.div>
          </div>

          {/* Séparateur fluide quand compact */}
          {props.scrolled && <div className="h-px bg-[var(--images-line)]" />}
        </div>

        {/* Panneau média attaché (non sticky — défile avec le contenu) */}
        {props.panelOpen && (
          <div className="px-4 sm:px-6">
            <div className="mx-auto w-full max-w-[640px]">
              <MediaPanel
                items={props.items}
                tab={props.panelTab}
                onTabChange={props.onPanelTabChange}
                onImportFiles={props.onImportFiles}
                onDraw={props.onDraw}
                onPickReference={props.onPickReference}
                onOpenDetail={props.onOpenDetail}
                selectedIds={props.selectedIds}
                canAttach={props.canAttach}
              />
            </div>
          </div>
        )}

        {/* Galerie d'inspiration */}
        <main className="mx-auto w-full max-w-[1080px] px-4 pb-24 pt-10 sm:px-6">
          <InspirationGallery onUse={props.onUseIdea} />
        </main>
      </div>
    </motion.div>
  );
}
