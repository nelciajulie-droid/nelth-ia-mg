/**
 * Nelth-IA Images — composeur du workspace de génération (ancré en bas).
 *
 * LE MÊME composeur que le studio (./composer.tsx) : mêmes contrôles, même
 * design, dictée, ratio, Vitesse|Qualité, bouton ↑ — simplement ancré en bas
 * du workspace comme le composeur d'une conversation. Le layoutId
 * « images-composer » (framer-motion) assure la transition fluide depuis la
 * position centrale du studio vers le bas du workspace.
 *
 * Référence d'édition : la dernière image complétée s'attache automatiquement
 * en puce amovible — les instructions suivantes partent en image-to-image
 * RÉEL (POST /edit), jamais en devinette.
 *
 * Le dock vit HORS de la zone de défilement (flex-col : en-tête / fil / dock)
 * — il ne recouvre donc jamais l'image générée, et respecte l'insert de
 * zone sûre sur mobile.
 */

import * as React from 'react';
import { motion } from 'framer-motion';
import { Composer, type ComposerMode } from './composer';
import { MediaPanel, type PanelTab } from './mediapanel';
import type { ImagineItem } from '../lib/images/types';

/** Transition du glissement composeur (studio → bas du workspace). */
export const COMPOSER_TRANSITION = { duration: 0.5, ease: [0.22, 1, 0.36, 1] } as const;

export interface ImageGenerationComposerProps {
  // ---- composeur (mêmes contrôles que le studio) ----
  prompt: string;
  onPromptChange(value: string): void;
  ratio: string;
  onRatioChange(value: string): void;
  ratios: string[];
  ratioDisabled: boolean;
  mode: ComposerMode;
  onModeChange(mode: ComposerMode): void;
  generating: boolean;
  disabled: boolean;
  onGenerate(): void;
  // ---- bibliothèque de médias attachée (popover au-dessus du dock) ----
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
  // ---- référence d'édition (puce amovible) ----
  editReference: ImagineItem | null;
  onRemoveEditReference(): void;
}

export function ImageGenerationComposer(props: ImageGenerationComposerProps) {
  const references = props.editReference
    ? [
        {
          id: props.editReference.id,
          label: props.editReference.name ?? props.editReference.prompt?.slice(0, 26) ?? 'Référence',
          url: props.editReference.url,
        },
      ]
    : [];

  return (
    <div
      data-nelth-composer=""
      className="relative z-30 shrink-0 bg-[var(--images-bg)] px-4 pt-2 pb-[max(env(safe-area-inset-bottom),10px)] sm:px-6"
    >
      {/* Fondu doux au-dessus du dock — le fil s'efface avant le composeur. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-b from-transparent to-[var(--images-bg)]"
      />

      {/* Bibliothèque média attachée (popover au-dessus du composeur). */}
      {props.panelOpen && (
        <div className="images-pop absolute inset-x-4 bottom-full z-40 mb-3 sm:inset-x-6">
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

      {/* Le composeur glisse depuis sa position studio (layoutId partagé). */}
      <motion.div
        layoutId="images-composer"
        data-composer-glide="dock"
        transition={COMPOSER_TRANSITION}
        className="mx-auto w-full max-w-[640px]"
      >
        <Composer
          prompt={props.prompt}
          onPromptChange={props.onPromptChange}
          ratio={props.ratio}
          onRatioChange={props.onRatioChange}
          ratios={props.ratios}
          ratioDisabled={props.ratioDisabled}
          mode={props.mode}
          onModeChange={props.onModeChange}
          compact={false}
          generating={props.generating}
          disabled={props.disabled}
          panelOpen={props.panelOpen}
          onTogglePanel={props.onTogglePanel}
          onGenerate={props.onGenerate}
          references={references}
          onRemoveReference={props.onRemoveEditReference}
        />
      </motion.div>
    </div>
  );
}
