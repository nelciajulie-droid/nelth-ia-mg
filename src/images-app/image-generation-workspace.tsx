/**
 * Nelth-IA Images — workspace de génération (transition type ChatGPT Images).
 *
 * En-tête compact ← « Retour à Images » … fil de générations au centre (le
 * prompt soumis + la carte animée du CHAT + actions) … composeur ancré en
 * bas. La carte est LA carte du chat (AiImageCard via image-generation-card).
 *
 * Le cycle de vie des jobs (items serveur, polling racine) est décorrélé de
 * l'état de navigation : retourner au studio ne stoppe RIEN — le fil se
 * restaure tel quel au retour (positions de défilement comprises).
 */

import * as React from 'react';
import { motion } from 'framer-motion';
import { ImageGenerationHeader } from './image-generation-header';
import { ImageGenerationCard } from './image-generation-card';
import { ImageResultActions, ItemFailureCard, TurnErrorCard } from './image-result';
import { ImageGenerationComposer } from './image-generation-composer';
import { cx } from './ui';
import type { GenerateInput } from './api';
import type { ComposerCategory, ImageModel, VideoResolution } from './composer';
import type { PanelTab } from './mediapanel';
import type { ImagineCapabilities, ImagineItem } from '../lib/images/types';

/** Payload de relance d'un tour (exactement la même requête). */
export type GenerationRetry =
  | { kind: 'generate'; input: GenerateInput }
  | { kind: 'edit'; itemId: string; prompt: string }
  | { kind: 'variation'; itemId: string };

/** Un « tour » du fil = une requête utilisateur + ses images. */
export interface GenerationTurn {
  id: string;
  /** Prompt soumis (affiché dans le fil, conservé pour « Générer autre »). */
  prompt: string;
  kind: 'generate' | 'edit' | 'variation';
  createdAt: number;
  /** Items serveur du tour (vides pendant l'envoi de la requête). */
  itemIds: string[];
  /** Ratio employé pour les placeholders (avant réponse du moteur). */
  ratio: string;
  /** Nombre de cartes attendues avant que la file ne réponde. */
  expectedCount: number;
  /** Non-null quand la REQUÊTE entière a échoué (rien mis en file). */
  error: string | null;
  /** Payload de relance exact. */
  retry: GenerationRetry | null;
}

const VIEW_TRANSITION = { duration: 0.34, ease: [0.22, 1, 0.36, 1] } as const;
const TURN_TRANSITION = { duration: 0.4, ease: [0.22, 1, 0.36, 1] } as const;

function TurnKindNote({ kind }: { kind: GenerationTurn['kind'] }) {
  if (kind === 'generate') return null;
  return (
    <span className="mt-1 self-end pr-1 text-[12px] font-medium text-[var(--images-faint)]">
      {kind === 'edit' ? 'Édition de l’image jointe' : 'Variation de l’image précédente'}
    </span>
  );
}

interface TurnBlockProps {
  turn: GenerationTurn;
  itemsById: Map<string, ImagineItem>;
  capabilities: ImagineCapabilities | null;
  busyId: string | null;
  retryBusy: boolean;
  /** Relance EXACTE d'un tour dont la requête a échoué (reçoit le tour). */
  onRetryTurn(turn: GenerationTurn): void;
  onEditImage(item: ImagineItem, focus: boolean): void;
  onVariation(item: ImagineItem): void;
  onDownload(item: ImagineItem): void;
  onSave(item: ImagineItem): void;
  onGenerateAnother(prompt: string): void;
}

function TurnBlock(props: TurnBlockProps) {
  const { turn } = props;
  const items = turn.itemIds
    .map((id) => props.itemsById.get(id))
    .filter((item): item is ImagineItem => Boolean(item));
  const completed = items.filter((item) => item.status === 'completed' && item.url);
  const failed = items.filter((item) => item.status === 'failed');
  const anyPending = items.some((item) => item.status === 'generating' || item.status === 'processing');

  // Pendant l'envoi de la requête : N placeholders (même carte animée, phase « Envoi… »).
  const cardCount = turn.itemIds.length > 0 ? items.length : turn.expectedCount;

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={TURN_TRANSITION}
      className="flex flex-col"
      aria-label="Tour de génération"
    >
      {/* Prompt soumis — bulle utilisateur, alignée à droite (fil conversationnel). */}
      <div className="flex flex-col">
        <div className="ml-auto max-w-[85%] rounded-[18px] rounded-br-[6px] bg-[var(--images-chip)] px-4 py-2.5 shadow-[var(--images-shadow-sm)]">
          <span className="whitespace-pre-wrap break-words text-[14px] leading-6 text-[var(--images-ink)]">
            {turn.prompt}
          </span>
        </div>
        <TurnKindNote kind={turn.kind} />
      </div>

      {/* Échec de la requête entière : carte d'erreur + Réessayer. */}
      {turn.error ? (
        <TurnErrorCard turn={turn} onRetry={() => props.onRetryTurn(turn)} busy={props.retryBusy} />
      ) : (
        <>
          {/* Cartes de génération — LA carte animée du chat, adaptée aux items. */}
          {cardCount > 0 && (
            <div
              className={cx(
                'mt-3 grid gap-3',
                cardCount > 1 ? 'mx-auto w-full max-w-[680px] sm:grid-cols-2' : 'mx-auto w-full max-w-[440px]'
              )}
            >
              {Array.from({ length: cardCount }).map((_, index) => {
                const item = items[index];
                if (item?.status === 'failed') {
                  return <ItemFailureCard key={`${turn.id}#${index}`} item={item} />;
                }
                return (
                  <ImageGenerationCard
                    key={`${turn.id}#${index}`}
                    item={item}
                    placeholderRatio={turn.ratio}
                  />
                );
              })}
            </div>
          )}

          {/* Réessayer local : un item a échoué APRÈS mise en file → nouveau tour,
              les résultats précédents restent dans le fil. */}
          {failed.length > 0 && !anyPending && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => props.onGenerateAnother(turn.prompt)}
                className="flex items-center gap-1.5 rounded-full border border-[var(--images-line)] bg-[var(--images-surface)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--images-ink)] shadow-[var(--images-shadow-sm)] transition-colors hover:bg-[var(--images-hover)]"
              >
                Réessayer
              </button>
            </div>
          )}

          {/* Actions par résultat complété (parité ChatGPT). */}
          {completed.length > 0 && !anyPending && (
            <ImageResultActions
              items={completed}
              sourcePrompt={turn.prompt}
              capabilities={props.capabilities}
              busyId={props.busyId}
              onEditImage={props.onEditImage}
              onVariation={props.onVariation}
              onDownload={props.onDownload}
              onSave={props.onSave}
              onGenerateAnother={props.onGenerateAnother}
            />
          )}
        </>
      )}
    </motion.section>
  );
}

export interface ImageGenerationWorkspaceProps {
  /** Tours visibles du fil (filtrés par la racine selon les items vivants). */
  turns: GenerationTurn[];
  itemsById: Map<string, ImagineItem>;
  items: ImagineItem[];
  capabilities: ImagineCapabilities | null;
  canGenerate: boolean;
  submitting: boolean;
  /** Items réellement en génération/processing (pilule d'en-tête). */
  pendingCount: number;
  busyId: string | null;

  // ---- navigation ----
  onBack(): void;
  /** Relance EXACTE d'un tour dont la requête a échoué (reçoit le tour). */
  onRetryTurn(turn: GenerationTurn): void;

  // ---- actions par résultat ----
  onEditImage(item: ImagineItem, focus: boolean): void;
  onVariation(item: ImagineItem): void;
  onDownload(item: ImagineItem): void;
  onSave(item: ImagineItem): void;
  onGenerateAnother(prompt: string): void;

  // ---- composeur du bas (mêmes contrôles que le studio) ----
  composer: {
    prompt: string;
    onPromptChange(value: string): void;
    ratio: string;
    onRatioChange(value: string): void;
    ratios: string[];
    ratioDisabled: boolean;
    ratioAuto: boolean;
    category: ComposerCategory;
    onCategoryChange(category: ComposerCategory): void;
    imageModel: ImageModel;
    onImageModelChange(model: ImageModel): void;
    resolution: VideoResolution;
    onResolutionChange(resolution: VideoResolution): void;
    variations: number;
    onVariationsChange(value: number): void;
    variationsLocked: boolean;
    variationsLockHint?: string;
    onGenerate(): void;
    editReference: ImagineItem | null;
    onRemoveEditReference(): void;
    panelOpen: boolean;
    onTogglePanel(): void;
    panelTab: PanelTab;
    onPanelTabChange(tab: PanelTab): void;
    onImportFiles(files: FileList | File[]): void;
    onDraw(): void;
    onPickReference(item: ImagineItem): void;
    onOpenDetail(item: ImagineItem): void;
    selectedIds: Set<string>;
    canAttach: boolean;
  };

  // ---- défilement (la racine conserve la position entre les vues) ----
  onScroll(e: React.UIEvent<HTMLDivElement>): void;
}

export function ImageGenerationWorkspace(props: ImageGenerationWorkspaceProps) {
  const composer = props.composer;

  return (
    <motion.div
      className="absolute inset-0 flex flex-col"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={VIEW_TRANSITION}
      role="region"
      aria-label="Espace de génération"
    >
      <ImageGenerationHeader pendingCount={props.pendingCount} onBack={props.onBack} />

      {/* Fil de générations — zone de défilement centrale. */}
      <div
        data-nelth-images-scroll="workspace"
        onScroll={props.onScroll}
        className="images-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-4 py-8 sm:px-6">
          {props.turns.map((turn) => (
            <TurnBlock
              key={turn.id}
              turn={turn}
              itemsById={props.itemsById}
              capabilities={props.capabilities}
              busyId={props.busyId}
              retryBusy={props.submitting}
              onRetryTurn={props.onRetryTurn}
              onEditImage={props.onEditImage}
              onVariation={props.onVariation}
              onDownload={props.onDownload}
              onSave={props.onSave}
              onGenerateAnother={props.onGenerateAnother}
            />
          ))}
        </div>
      </div>

      {/* Composeur ancré en bas — hors de la zone de défilement (ne recouvre
          jamais l'image), respecte la zone sûre mobile. */}
      <ImageGenerationComposer
        prompt={composer.prompt}
        onPromptChange={composer.onPromptChange}
        ratio={composer.ratio}
        onRatioChange={composer.onRatioChange}
        ratios={composer.ratios}
        ratioDisabled={composer.ratioDisabled}
        ratioAuto={composer.ratioAuto}
        category={composer.category}
        onCategoryChange={composer.onCategoryChange}
        imageModel={composer.imageModel}
        onImageModelChange={composer.onImageModelChange}
        resolution={composer.resolution}
        onResolutionChange={composer.onResolutionChange}
        variations={composer.variations}
        onVariationsChange={composer.onVariationsChange}
        variationsLocked={composer.variationsLocked}
        variationsLockHint={composer.variationsLockHint}
        generating={props.submitting}
        disabled={!props.canGenerate}
        onGenerate={composer.onGenerate}
        panelOpen={composer.panelOpen}
        onTogglePanel={composer.onTogglePanel}
        panelTab={composer.panelTab}
        onPanelTabChange={composer.onPanelTabChange}
        items={props.items}
        onImportFiles={composer.onImportFiles}
        onDraw={composer.onDraw}
        onPickReference={composer.onPickReference}
        onOpenDetail={composer.onOpenDetail}
        selectedIds={composer.selectedIds}
        canAttach={composer.canAttach}
        editReference={composer.editReference}
        onRemoveEditReference={composer.onRemoveEditReference}
      />
    </motion.div>
  );
}
