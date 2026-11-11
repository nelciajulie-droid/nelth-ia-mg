/**
 * Nelth-IA Images — en-tête compact du workspace de génération.
 *
 * ← « Retour à Images » à gauche, pilule d'état à droite (N générations en
 * cours, point pulsant accent ciel — uniquement quand il y a VRAIMENT du
 * travail en vol). L'en-tête tient sur une seule ligne compacte : le fil de
 * générations est la vedette, pas le chrome.
 */

import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

export interface ImageGenerationHeaderProps {
  /** Items réellement en génération/processing côté serveur. */
  pendingCount: number;
  onBack(): void;
}

export function ImageGenerationHeader({ pendingCount, onBack }: ImageGenerationHeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--images-line)] px-3 sm:px-5">
      <button
        type="button"
        onClick={onBack}
        className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium text-[var(--images-muted)] transition-colors hover:bg-[var(--images-chip)] hover:text-[var(--images-ink)]"
        aria-label="Retour à Images"
      >
        <ArrowLeft className="size-4" strokeWidth={2} aria-hidden="true" />
        Retour à Images
      </button>

      <div className="min-w-0 flex-1" aria-hidden="true" />

      {pendingCount > 0 && (
        <span
          role="status"
          className="flex shrink-0 items-center gap-2 rounded-full border border-[var(--images-line)] bg-[var(--images-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--images-muted)] shadow-[var(--images-shadow-sm)]"
        >
          <span className="relative flex size-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--images-accent)] opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-[var(--images-accent)]" />
          </span>
          {pendingCount === 1 ? '1 génération en cours' : `${pendingCount} générations en cours`}
        </span>
      )}
    </header>
  );
}
