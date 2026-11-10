/**
 * Nelth-IA Images — application principale (bundle autonome).
 *
 * Structure (référence vidéo) :
 *   ┌ header sticky — « + Nouveau Canvas » en haut à droite
 *   ├ titre centré « Qu'allons-nous imaginer ? » (disparaît au défilement)
 *   ├ composeur compact centré (pilule au défilement, panel média attaché)
 *   └ galerie d'inspiration masonry 3 colonnes
 */

import * as React from 'react';
import { Composer, type ComposerMode } from './composer';
import { MediaPanel, type PanelTab } from './mediapanel';
import { InspirationGallery } from './galleryview';
import { DetailOverlay } from './detail';
import { DrawOverlay } from './draw';
import { cx } from './ui';
import * as api from './api';
import type { ImagineCapabilities, ImagineItem } from '../lib/images/types';
import type { GalleryEntry } from '../lib/images/gallery';

type AuthState = { kind: 'checking' } | { kind: 'denied' } | { kind: 'ok' };

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

const MERGE_MS = 2200;

export function ImagesApp() {
  const [auth, setAuth] = React.useState<AuthState>({ kind: 'checking' });
  const [capabilities, setCapabilities] = React.useState<ImagineCapabilities | null>(null);
  const [items, setItems] = React.useState<ImagineItem[]>([]);
  const [prompt, setPrompt] = React.useState('');
  const [ratio, setRatio] = React.useState('2:3');
  const [mode, setMode] = React.useState<ComposerMode>('qualite');
  const [styleId, setStyleId] = React.useState<string | null>(null);
  const [references, setReferences] = React.useState<ImagineItem[]>([]);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [panelTab, setPanelTab] = React.useState<PanelTab>('generations');
  const [detailItem, setDetailItem] = React.useState<ImagineItem | null>(null);
  const [drawing, setDrawing] = React.useState(false);
  const [savingDraw, setSavingDraw] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [generating, setGenerating] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const focusRef = React.useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const promptInputRef = React.useCallback((el: HTMLTextAreaElement | HTMLInputElement | null) => {
    focusRef.current = el;
  }, []);

  const pushToast = React.useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, text, tone }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, 3400);
  }, []);

  const mergeItems = React.useCallback((incoming: ImagineItem[]) => {
    if (!incoming.length) return;
    setItems((current) => {
      const map = new Map(current.map((i) => [i.id, i]));
      for (const item of incoming) map.set(item.id, item);
      return [...map.values()].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    });
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const fresh = await api.fetchItems();
      setItems(fresh);
      // La vue détail suit son item à travers les rafraîchissements
      // (skeleton → image complétée) au lieu de garder un snapshot périmé.
      setDetailItem((current) => (current ? (fresh.find((i) => i.id === current.id) ?? current) : null));
      return fresh;
    } catch {
      return null;
    }
  }, []);

  // ---- Boot : capabilities + bibliothèque ----
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const caps = await api.fetchCapabilities();
        if (!alive) return;
        setCapabilities(caps);
        setRatio(caps.aspectRatios.includes('2:3') ? '2:3' : (caps.aspectRatios[0] ?? '1:1'));
        await refresh();
        if (alive) setAuth({ kind: 'ok' });
      } catch (e) {
        if (!alive) return;
        if (e instanceof api.ImagesApiError && (e.status === 401 || e.status === 403)) {
          setAuth({ kind: 'denied' });
        } else {
          setAuth({ kind: 'ok' });
          pushToast(e instanceof Error ? e.message : 'Erreur inconnue', 'error');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [refresh, pushToast]);

  // ---- Polling pendant les générations ----
  const hasPending = items.some((i) => i.status === 'generating' || i.status === 'processing');
  React.useEffect(() => {
    if (!hasPending) return;
    const timer = window.setTimeout(() => void refresh(), MERGE_MS);
    return () => window.clearTimeout(timer);
  }, [hasPending, items, refresh]);

  // ---- Défilement → composer compact ----
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrolled(e.currentTarget.scrollTop > 96);
  };

  const scrollToTop = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ---- Escape (fermeture des vues internes) ----
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (detailItem) setDetailItem(null);
      else if (drawing) setDrawing(false);
      else if (panelOpen) setPanelOpen(false);
      else window.dispatchEvent(new CustomEvent('nelth:images:close'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailItem, drawing, panelOpen]);

  // ---- Génération ----
  const canGenerate = Boolean(capabilities?.features.textToImage) && auth.kind === 'ok';
  const maxRefs = 4;

  const onGenerate = React.useCallback(async () => {
    const text = prompt.trim();
    if (!text || !capabilities || generating) return;
    const n = Math.min(mode === 'vitesse' ? 1 : 2, capabilities.maxCount || 1);
    const canAttach = capabilities.features.imageToImage && references.length > 0;
    setGenerating(true);
    try {
      const queued = await api.generate({
        prompt: text,
        aspectRatio: capabilities.aspectRatioMode !== 'none' ? ratio : undefined,
        style: styleId ?? undefined,
        n,
        sourceImages: canAttach
          ? references.filter((r) => r.url).map((r) => ({ url: r.url ?? undefined }))
          : [],
      });
      mergeItems(queued);
      setPrompt('');
      setReferences([]);
      setPanelOpen(true);
      setPanelTab('generations');
      pushToast(`Génération lancée — ${queued.length} image${queued.length > 1 ? 's' : ''}`);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Génération impossible', 'error');
    } finally {
      setGenerating(false);
    }
  }, [prompt, capabilities, generating, mode, ratio, styleId, references, mergeItems, pushToast]);

  // ---- Édition / variation (vues détail) ----
  const runEdit = React.useCallback(
    async (itemId: string, instructions: string) => {
      if (!capabilities?.features.editing) {
        pushToast('Édition non prise en charge par le moteur actif', 'error');
        return;
      }
      setBusyId(itemId);
      try {
        const queued = await api.editItem(itemId, instructions);
        mergeItems([queued]);
        setDetailItem(queued);
        pushToast('Édition lancée');
      } catch (e) {
        pushToast(e instanceof Error ? e.message : 'Édition impossible', 'error');
      } finally {
        setBusyId(null);
      }
    },
    [capabilities, mergeItems, pushToast]
  );

  const runVariation = React.useCallback(
    async (itemId: string) => {
      if (!capabilities?.features.variations) {
        pushToast('Variations non prises en charge par le moteur actif', 'error');
        return;
      }
      setBusyId(itemId);
      try {
        const queued = await api.variationItem(itemId);
        mergeItems([queued]);
        setDetailItem(queued);
        pushToast('Variation lancée');
      } catch (e) {
        pushToast(e instanceof Error ? e.message : 'Variation impossible', 'error');
      } finally {
        setBusyId(null);
      }
    },
    [capabilities, mergeItems, pushToast]
  );

  // ---- Import de fichiers ----
  const onImportFiles = React.useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (!list.length) return;
      if (!capabilities?.features.uploads) {
        pushToast('Import non activé', 'error');
        return;
      }
      pushToast(list.length > 1 ? `Import de ${list.length} images…` : 'Import en cours…');
      let done = 0;
      for (const file of list) {
        try {
          const item = await api.uploadImage(file);
          mergeItems([item]);
          done += 1;
        } catch (e) {
          pushToast(
            `${file.name} — ${e instanceof Error ? e.message : 'import impossible'}`,
            'error'
          );
        }
      }
      if (done) {
        setPanelTab('imports');
        setPanelOpen(true);
        pushToast(`${done} image${done > 1 ? 's' : ''} ajoutée${done > 1 ? 's' : ''} aux importations`);
      }
    },
    [capabilities, mergeItems, pushToast]
  );

  // ---- Références image-to-image ----
  const toggleReference = React.useCallback(
    (item: ImagineItem) => {
      setReferences((current) => {
        const exists = current.some((r) => r.id === item.id);
        if (exists) return current.filter((r) => r.id !== item.id);
        if (current.length >= maxRefs) {
          pushToast(`Jusqu’à ${maxRefs} images de référence`, 'error');
          return current;
        }
        return [...current, item];
      });
    },
    [pushToast]
  );

  const useAsReference = React.useCallback(
    (item: ImagineItem) => {
      if (!item.url) return;
      setReferences((current) =>
        current.some((r) => r.id === item.id) ? current : [...current, item].slice(0, maxRefs)
      );
      setDetailItem(null);
      setPanelOpen(true);
      pushToast('Image attachée comme référence');
    },
    [pushToast]
  );

  // ---- Suppression ----
  const onDelete = React.useCallback(
    async (itemId: string) => {
      try {
        await api.deleteItem(itemId);
        setItems((current) => current.filter((i) => i.id !== itemId));
        setReferences((current) => current.filter((r) => r.id !== itemId));
        setDetailItem(null);
        pushToast('Image supprimée');
      } catch (e) {
        pushToast(e instanceof Error ? e.message : 'Suppression impossible', 'error');
      }
    },
    [pushToast]
  );

  // ---- Nouveau Canvas ----
  const onNewCanvas = () => {
    setPrompt('');
    setReferences([]);
    setStyleId(null);
    setPanelOpen(false);
    scrollToTop();
    window.setTimeout(() => focusRef.current?.focus(), 250);
  };

  // ---- Idée de la galerie → composeur ----
  const onUseIdea = React.useCallback(
    (entry: GalleryEntry) => {
      setPrompt(entry.prompt);
      setStyleId(entry.category);
      if (capabilities?.aspectRatios.includes(entry.ratio)) setRatio(entry.ratio);
      scrollToTop();
      window.setTimeout(() => focusRef.current?.focus(), 250);
    },
    [capabilities]
  );

  // ---- Dessin → import ----
  const onSaveDrawing = React.useCallback(
    async (file: File) => {
      setSavingDraw(true);
      try {
        const item = await api.uploadImage(file);
        mergeItems([item]);
        setDrawing(false);
        setPanelOpen(true);
        setPanelTab('imports');
        pushToast('Dessin ajouté aux importations');
      } catch (e) {
        pushToast(e instanceof Error ? e.message : 'Enregistrement impossible', 'error');
      } finally {
        setSavingDraw(false);
      }
    },
    [mergeItems, pushToast]
  );

  // ---------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------

  if (auth.kind === 'checking') {
    return (
      <div className="images-root flex h-full items-center justify-center bg-[var(--images-bg)]">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--images-line)] border-t-[var(--images-accent)]" />
      </div>
    );
  }

  if (auth.kind === 'denied') {
    return (
      <div className="images-root flex h-full flex-col items-center justify-center gap-3 bg-[var(--images-bg)] px-6 text-center">
        <p className="text-[15px] font-semibold text-[var(--images-ink)]">Session requise</p>
        <p className="max-w-[320px] text-[13px] leading-5 text-[var(--images-muted)]">
          Connectez-vous à Nelth-IA puis rouvrez Images depuis la barre latérale.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-2 rounded-full bg-[var(--images-btn-ink)] px-4 py-2 text-[13px] font-medium text-[var(--images-btn-on-ink)] hover:opacity-90"
        >
          Recharger
        </button>
      </div>
    );
  }

  const selectedIds = new Set(references.map((r) => r.id));

  return (
    <div className="images-root relative flex h-full flex-col bg-[var(--images-bg)] text-[var(--images-ink)]">
      <div ref={scrollRef} onScroll={onScroll} className="images-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* Bloc sticky : header + titre + composeur (titre/toolbar se compactent au défilement) */}
        <div className="sticky top-0 z-30 bg-[var(--images-bg-translucent)] backdrop-blur-md">
          <div className="flex items-center justify-end px-4 pt-4 pb-1 sm:px-6">
            <button
              type="button"
              onClick={onNewCanvas}
              className="flex items-center gap-1.5 rounded-full border border-[var(--images-line)] bg-[var(--images-surface)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--images-ink)] shadow-[var(--images-shadow-sm)] transition-colors hover:bg-[var(--images-hover)]"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Nouveau Canvas
            </button>
          </div>

          {/* Titre centré — se replie quand on défile (référence vidéo) */}
          <div
            className={cx(
              'overflow-hidden transition-[max-height,opacity,padding-top,padding-bottom] duration-300',
              scrolled ? 'max-h-0 overflow-hidden py-0 opacity-0' : 'max-h-28 pt-8 pb-2 opacity-100'
            )}
            aria-hidden={scrolled}
          >
            <h1 className="px-4 text-center text-[22px] font-bold leading-8 tracking-[-0.015em] text-[var(--images-ink)] sm:text-[26px]">
              Qu’allons-nous imaginer ?
            </h1>
          </div>

          {/* Composeur */}
          <div className="px-4 pb-3 sm:px-6">
            <div className="mx-auto w-full max-w-[640px]">
              <Composer
                prompt={prompt}
                onPromptChange={setPrompt}
                ratio={ratio}
                onRatioChange={setRatio}
                ratios={capabilities?.aspectRatios ?? ['1:1']}
                ratioDisabled={capabilities?.aspectRatioMode === 'none' || !capabilities}
                mode={mode}
                onModeChange={setMode}
                compact={scrolled}
                generating={generating}
                disabled={!canGenerate}
                panelOpen={panelOpen}
                onTogglePanel={() => setPanelOpen((v) => !v)}
                onGenerate={() => void onGenerate()}
                references={references.map((r) => ({
                  id: r.id,
                  label: r.name ?? r.prompt?.slice(0, 26) ?? 'Référence',
                  url: r.url,
                }))}
                onRemoveReference={(id) => setReferences((cur) => cur.filter((r) => r.id !== id))}
              />
            </div>
          </div>

          {/* Séparateur fluide quand compact */}
          {scrolled && <div className="h-px bg-[var(--images-line)]" />}
        </div>

        {/* Panneau média attaché (non sticky — défile avec le contenu) */}
        {panelOpen && (
          <div className="px-4 sm:px-6">
            <div className="mx-auto w-full max-w-[640px]">
              <MediaPanel
                items={items}
                tab={panelTab}
                onTabChange={setPanelTab}
                onImportFiles={(files) => void onImportFiles(files)}
                onDraw={() => setDrawing(true)}
                onPickReference={toggleReference}
                onOpenDetail={(item) => setDetailItem(item)}
                selectedIds={selectedIds}
                canAttach={Boolean(capabilities?.features.imageToImage)}
              />
            </div>
          </div>
        )}

        {/* Galerie d'inspiration */}
        <main className="mx-auto w-full max-w-[1080px] px-4 pb-24 pt-10 sm:px-6">
          <InspirationGallery onUse={onUseIdea} />
        </main>
      </div>

      {/* Surcouche détail */}
      {detailItem && (
        <DetailOverlay
          item={detailItem}
          busy={busyId}
          onClose={() => setDetailItem(null)}
          onEdit={(itemId, instructions) => void runEdit(itemId, instructions)}
          onVariation={(itemId) => void runVariation(itemId)}
          onUseReference={useAsReference}
          onDelete={(itemId) => void onDelete(itemId)}
        />
      )}

      {/* Surcouche dessin */}
      {drawing && (
        <DrawOverlay onClose={() => setDrawing(false)} onSave={(file) => void onSaveDrawing(file)} saving={savingDraw} />
      )}

      {/* Toasts */}
      <div className="pointer-events-none absolute inset-x-0 bottom-5 z-50 flex flex-col items-center gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cx(
              'images-pop rounded-full px-4 py-2 text-[13px] font-medium shadow-[var(--images-shadow-toast)]',
              toast.tone === 'error'
                ? 'bg-[#B42318] text-white'
                : 'border border-[var(--images-line)] bg-[var(--images-surface)] text-[var(--images-ink)]'
            )}
          >
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}
