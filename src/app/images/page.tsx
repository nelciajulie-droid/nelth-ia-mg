'use client';

/**
 * Nelth-IA Images — dedicated studio page (/images).
 *
 * Sits NEXT to the original Open WebUI SPA (the sidebar's "Imagine Studio"
 * button navigates here). The route is excluded from the SPA fallback rewrite
 * in next.config.ts so Next.js serves it directly.
 *
 * Auth reuses the SPA's session (localStorage token / cookie). The visual
 * theme mirrors the SPA's stored theme (light / dark / system) so the studio
 * feels like the same product.
 */

import * as React from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import { ImagineStudio } from '@/components/imagine/ImagineStudio';
import { fetchSession, getImagineToken, type ImagineSessionUser } from '@/lib/images/client';

type Phase = { kind: 'loading' } | { kind: 'unauthenticated' } | { kind: 'ready'; user: ImagineSessionUser };

function useSession(): Phase {
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' });

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!getImagineToken()) {
        // Cookie fallback (HttpOnly session from the SPA sign-in).
        try {
          const user = await fetchSession();
          if (!cancelled) {
            setPhase(user ? { kind: 'ready', user } : { kind: 'unauthenticated' });
          }
          return;
        } catch {
          if (!cancelled) setPhase({ kind: 'unauthenticated' });
          return;
        }
      }
      try {
        const user = await fetchSession();
        if (!cancelled) {
          setPhase(user ? { kind: 'ready', user } : { kind: 'unauthenticated' });
        }
      } catch {
        if (!cancelled) setPhase({ kind: 'unauthenticated' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return phase;
}

/** Mirror the SPA's theme (localStorage.theme: light/dark/system/oled-dark/her). */
function useSvelteTheme(): 'light' | 'dark' {
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = window.localStorage.getItem('theme') ?? 'system';
    if (stored === 'light') return 'light';
    if (stored === 'dark' || stored === 'oled-dark' || stored === 'her') return 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const stored = window.localStorage.getItem('theme') ?? 'system';
      if (stored === 'system') setTheme(media.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, []);

  return theme;
}

export default function ImagesPage() {
  const session = useSession();
  const theme = useSvelteTheme();

  React.useEffect(() => {
    if (session.kind === 'unauthenticated') {
      // Hand back to the SPA's auth flow.
      window.location.replace('/');
    }
  }, [session.kind]);

  if (session.kind !== 'ready') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-zinc-50 dark:bg-zinc-950">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-600/20">
          <Sparkles className="size-7 text-white" aria-hidden />
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {session.kind === 'unauthenticated' ? 'Connexion requise…' : 'Ouverture du studio…'}
        </div>
      </div>
    );
  }

  return (
    <div className={theme === 'dark' ? 'dark' : undefined}>
      <ImagineStudio user={session.user} />
    </div>
  );
}
