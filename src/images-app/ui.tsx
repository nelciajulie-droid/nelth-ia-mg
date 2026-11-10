/**
 * Nelth-IA Images — utilitaires UI partagés (bundle autonome).
 */

import * as React from 'react';
import { peekImage, authImageUrl } from './api';
import type { ImagineItem, ImaginePhase } from '../lib/images/types';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Petit spinner (états de chargement des actions). */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin', className ?? 'size-4')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** <img> authentifié — résout un blob URL via Bearer, cache instantané. */
export function AuthImg({
  path,
  alt,
  className,
  fallbackClassName,
}: {
  path: string | null | undefined;
  alt?: string;
  className?: string;
  fallbackClassName?: string;
}) {
  const cached = path ? peekImage(path) : null;
  const [url, setUrl] = React.useState<string | null>(cached);

  React.useEffect(() => {
    let alive = true;
    setUrl(path ? peekImage(path) : null);
    if (!path) return;
    void authImageUrl(path).then((resolved) => {
      if (alive) setUrl(resolved);
    });
    return () => {
      alive = false;
    };
  }, [path]);

  if (!url) {
    return (
      <div
        className={cx('images-skeleton', fallbackClassName ?? className)}
        aria-label={alt}
        role="img"
      />
    );
  }
  return <img src={url} alt={alt ?? ''} className={className} draggable={false} />;
}

/** Libellés de phase (barre d'état des générations en cours). */
export function phaseLabel(phase: ImaginePhase | null): string {
  switch (phase) {
    case 'sending':
      return 'Envoi…';
    case 'generating':
      return 'Génération…';
    case 'image':
      return 'Finalisation…';
    default:
      return 'En file…';
  }
}

export function sourceLabel(item: ImagineItem): string {
  switch (item.source) {
    case 'generate':
      return 'Générée';
    case 'edit':
      return 'Éditée';
    case 'variation':
      return 'Variation';
    case 'upload':
      return 'Importée';
    default:
      return 'Image';
  }
}

export function formatTime(ts: number): string {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Requis pour bun build avec JSX classique éventuel. */
export const React_ref = React;
