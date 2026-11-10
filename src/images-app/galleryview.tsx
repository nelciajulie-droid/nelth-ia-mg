/**
 * Nelth-IA Images — galerie d'inspiration masonry (référence vidéo).
 *
 * 3 colonnes (2 en mobile), cartes aux proportions naturelles, coins 12px,
 * gaps 8px, scrim dégradé bas + libellé d'action blanc (Modifier le texte /
 * Retouche précise / Boucle / Reimaginer). Un clic charge le prompt curaté
 * dans le composeur — chaque action lance une VRAIE génération.
 */

import { Image as ImageIcon } from 'lucide-react';
import { GALLERY_ENTRIES, type GalleryEntry } from '../lib/images/gallery';

const ACTION_BY_CATEGORY: Record<string, string> = {
  photorealistic: 'Modifier le texte',
  product: 'Modifier le texte',
  fashion: 'Retouche précise',
  architecture: 'Retouche précise',
  nature: 'Boucle',
  wallpaper: 'Boucle',
  anime: 'Reimaginer',
  '3d': 'Reimaginer',
  illustration: 'Reimaginer',
  art: 'Reimaginer',
};

export function InspirationGallery({ onUse }: { onUse(entry: GalleryEntry): void }) {
  return (
    <div>
      <div className="mb-4 flex items-center justify-center gap-2 text-[12px] font-medium text-[#777777]">
        <ImageIcon className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
        Idées pour commencer
      </div>
      <div className="columns-2 gap-2 md:columns-3">
        {GALLERY_ENTRIES.map((entry) => {
          const action = ACTION_BY_CATEGORY[entry.category] ?? 'Reimaginer';
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onUse(entry)}
              className="group relative mb-2 block w-full break-inside-avoid overflow-hidden rounded-[12px] text-left ring-1 ring-black/5 transition-shadow hover:ring-black/15"
              title={`${action} — ${entry.prompt.slice(0, 80)}…`}
            >
              <img
                src={entry.asset}
                alt={entry.prompt}
                loading="lazy"
                draggable={false}
                className="block w-full select-none transition-transform duration-500 ease-out group-hover:scale-[1.04]"
              />
              {/* Scrim dégradé bas — lisibilité du libellé (référence vidéo) */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[88px] bg-gradient-to-t from-black/60 to-transparent"
              />
              <span className="pointer-events-none absolute bottom-3 left-3 text-[13px] font-medium text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
                {action}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
