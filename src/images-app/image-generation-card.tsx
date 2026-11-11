/**
 * Nelth-IA Images — carte de génération du workspace.
 *
 * RÉUTILISATION STRICTE de la carte du chat : src/components/app/AiImageCard.
 * Même grille de pixels scintillante, même pied « libellé de phase +
 * secondes », même révélation cinématique (dissolution de la grille, flou,
 * balayage lumineux diagonal, flash bref). Aucune seconde implémentation
 * visuelle — cette couche se contente d'adapter la carte au cycle de vie des
 * items du studio :
 *
 *   • phase réelle du moteur (item.phase → libellé FR du pied),
 *   • ratio réel de l'image (classe aspect !important sur la base carrée),
 *   • octets authentifiés (blob) — la révélation ne se déclenche que
 *     lorsque les pixels sont réellement affichables,
 *   • mode contrôlé (generateDuration 9999) : c'est l'arrivée de l'image
 *     qui termine le chargement, pas un minuteur.
 */

import * as React from 'react';
import { AiImageCard } from '../components/app/AiImageCard';
import { authImageUrl, peekImage } from './api';
import { isVideoItem, phaseLabel } from './ui';
import type { ImagineItem } from '../lib/images/types';

/**
 * Ratio → classe aspect AVEC !important : la carte du chat est aspect-square
 * de base ; l'important garantit que le ratio réel de l'image gagne quel que
 * soit l'ordre des utilitaires dans le CSS compilé.
 */
const ASPECT_CLASS: Record<string, string> = {
  '1:1': 'aspect-square!',
  '3:2': 'aspect-[3/2]!',
  '2:3': 'aspect-[2/3]!',
  '4:3': 'aspect-[4/3]!',
  '3:4': 'aspect-[3/4]!',
  '16:9': 'aspect-[16/9]!',
  '9:16': 'aspect-[9/16]!',
  '21:9': 'aspect-[21/9]!',
};

export function aspectClassFor(ratio: string | null | undefined): string {
  return (ratio && ASPECT_CLASS[ratio]) || 'aspect-square!';
}

/** Blob authentifié d'un item (cache instantané + résolution en vol). */
function useAuthedSrc(url: string | null | undefined): string | null {
  const [src, setSrc] = React.useState<string | null>(() => (url ? peekImage(url) : null));

  React.useEffect(() => {
    let alive = true;
    if (!url) {
      setSrc(null);
      return () => {
        alive = false;
      };
    }
    const cached = peekImage(url);
    if (cached) {
      setSrc(cached);
      return () => {
        alive = false;
      };
    }
    void authImageUrl(url).then((resolved) => {
      if (alive) setSrc(resolved);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  return src;
}

export interface ImageGenerationCardProps {
  /** Item du studio — absent pendant l'envoi de la requête (placeholder d'envoi). */
  item?: ImagineItem;
  /** Ratio employé avant que le moteur ne réponde (placeholder d'envoi). */
  placeholderRatio?: string;
}

export function ImageGenerationCard({ item, placeholderRatio }: ImageGenerationCardProps) {
  const url = item && item.status === 'completed' ? item.url : null;
  const src = useAuthedSrc(url);
  const pending = !item || item.status === 'generating' || item.status === 'processing';
  const label = item ? phaseLabel(item.phase) : 'Envoi…';
  const isVideo = isVideoItem(item);

  return (
    <AiImageCard
      generateDuration={9999}
      imageDone={!pending && Boolean(src)}
      imageSrc={src ?? undefined}
      imageAlt={item?.name ?? item?.prompt ?? (isVideo ? 'Vidéo générée' : 'Image générée')}
      label={label}
      video={isVideo}
      className={aspectClassFor(item?.aspect_ratio ?? placeholderRatio)}
    />
  );
}
