/**
 * Nelth-IA Images — application principale (bundle autonome).
 *
 * Machine à états du workspace (transition type ChatGPT Images) :
 *
 *   ┌ studio    — vue par défaut (composeur central, galerie d'inspiration)
 *   ├ workspace— fil de générations (carte animée du chat + composeur en bas)
 *   └ (le cycle de vie des jobs — items serveur + polling — vit dans cette
 *      racine, décorrélé de la navigation : retourner au studio n'interrompt
 *      RIEN, le fil se restaure au retour)
 *
 * « Generate » → le composeur GLISSE de sa position studio vers le bas du
 * workspace (layoutId partagé, framer-motion) et la carte de génération du
 * CHAT (AiImageCard) prend le relais dans le fil.
 */

import * as React from 'react';
import { AnimatePresence, MotionConfig } from 'framer-motion';
import { ImageStudio } from './image-studio';
import { ImageGenerationWorkspace, type GenerationTurn } from './image-generation-workspace';
import { DetailOverlay } from './detail';
import { DrawOverlay } from './draw';
import * as api from './api';
import { isVideoItem, isGifItem, downloadExt } from './ui';
import type { ComposerCategory, ImageModel, VideoResolution } from './composer';
import type { ImagineCapabilities, ImagineItem } from '../lib/images/types';
import type { GalleryEntry } from '../lib/images/gallery';

type AuthState = { kind: 'checking' } | { kind: 'denied' } | { kind: 'ok' };

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

const MERGE_MS = 2200;

function newTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ImagesApp() {
  const [auth, setAuth] = React.useState<AuthState>({ kind: 'checking' });
  const [capabilities, setCapabilities] = React.useState<ImagineCapabilities | null>(null);
  const [items, setItems] = React.useState<ImagineItem[]>([]);

  // ---- État composeur (racine — préservé à travers les vues) ----
  const [prompt, setPrompt] = React.useState('');
  const [ratio, setRatio] = React.useState('2:3');
  // Catégorie de média (Image | Vidéo | GIF) + contrôles contextuels :
  // l'ancien segment Vitesse|Qualité 2.0 est remplacé par segment
  // Nelth-V2|Nelth-V3 (image), 480p|720p (vidéo), rien (GIF — V3 only).
  const [category, setCategory] = React.useState<ComposerCategory>('image');
  const [imageModel, setImageModel] = React.useState<ImageModel>('v3');
  const [resolution, setResolution] = React.useState<VideoResolution>('480p');
  const [variations, setVariations] = React.useState(2);
  const [styleId, setStyleId] = React.useState<string | null>(null);
  const [references, setReferences] = React.useState<ImagineItem[]>([]);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [panelTab, setPanelTab] = React.useState<'generations' | 'imports'>('generations');

  // ---- Surcouches studio (détail, dessin) ----
  const [detailItem, setDetailItem] = React.useState<ImagineItem | null>(null);
  const [drawing, setDrawing] = React.useState(false);
  const [savingDraw, setSavingDraw] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // ---- Machine à états studio | workspace ----
  const [view, setView] = React.useState<'studio' | 'workspace'>('studio');
  const [turns, setTurns] = React.useState<GenerationTurn[]>([]);
  const [submitting, setSubmitting] = React.useState(false);
  const [wsPrompt, setWsPrompt] = React.useState('');
  const [wsPanelOpen, setWsPanelOpen] = React.useState(false);
  const [wsPanelTab, setWsPanelTab] = React.useState<'generations' | 'imports'>('generations');
  const [refOverride, setRefOverride] = React.useState<string | null>(null);
  const [refAutoDisabled, setRefAutoDisabled] = React.useState(false);
  /** Vrai quand on REVIENT au fil (restaure la position, pas de saut en bas). */
  const [wsRestore, setWsRestore] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  // Positions de défilement — refs internes, lues/écrites uniquement dans les
  // effets et gestionnaires d'événements (jamais pendant le rendu).
  const studioScrollPos = React.useRef(0);
  const wsScrollPos = React.useRef(0);

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

  // ---- Polling pendant les générations (quel que soit l'état de navigation :
  //      les jobs continuent en fond quand on retourne au studio) ----
  const hasPending = items.some((i) => i.status === 'generating' || i.status === 'processing');
  React.useEffect(() => {
    if (!hasPending) return;
    const timer = window.setTimeout(() => void refresh(), MERGE_MS);
    return () => window.clearTimeout(timer);
  }, [hasPending, items, refresh]);

  const itemsById = React.useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const pendingCount = React.useMemo(
    () => items.filter((i) => i.status === 'generating' || i.status === 'processing').length,
    [items]
  );

  // Tours visibles : un tour dont TOUS les items ont été supprimés disparaît
  // du fil (les résultats complétés ne sont jamais écrasés, eux).
  const visibleTurns = React.useMemo(
    () =>
      turns.filter(
        (t) => !(t.itemIds.length > 0 && !t.itemIds.some((id) => itemsById.has(id)))
      ),
    [turns, itemsById]
  );
  const hasTurns = visibleTurns.length > 0;

  // Signature d'activité des items — change quand un statut bascule (une carte
  // se complète → ligne d'actions qui apparaît) : le fil suit alors le bas
  // UNIQUEMENT s'il y était déjà (auto-follow de chat, jamais de saut forcé).
  const activitySignature = React.useMemo(
    () => items.map((i) => `${i.id}:${i.status}`).join('|'),
    [items]
  );

  // ---- Référence d'édition automatique : la dernière image complétée du fil
  //      s'attache au composeur (puce amovible) — les instructions suivantes
  //      partent en image-to-image réel. Retirable, réattachable.
  //      (Les vidéos ne s'attachent pas : l'édition part d'une image.)
  const lastCompletedId = React.useMemo(() => {
    for (let t = turns.length - 1; t >= 0; t--) {
      const ids = turns[t].itemIds;
      for (let i = ids.length - 1; i >= 0; i--) {
        const item = itemsById.get(ids[i]);
        if (item?.status === 'completed' && item.url && !isVideoItem(item)) return item.id;
      }
    }
    return null;
  }, [turns, itemsById]);
  const editReferenceId = refOverride ?? (refAutoDisabled ? null : lastCompletedId);
  const editReferenceItem = editReferenceId ? (itemsById.get(editReferenceId) ?? null) : null;

  // ---- Défilement : positions conservées entre les vues ----
  // Hystérésis (entrée > 96, sortie < 40) : le compactage retire ~270px de
  // hauteur au bloc sticky (titre replié + composeur compacté). Avec un seuil
  // unique, un même scrollTop oscillait autour de 96 → scrolled clignotait
  // vrai/faux → tremblement du composeur. La bande morte casse ce cycle.
  const onStudioScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    setScrolled((prev) => (prev ? top > 40 : top > 96));
    studioScrollPos.current = top;
  };
  const onWorkspaceScroll = (e: React.UIEvent<HTMLDivElement>) => {
    wsScrollPos.current = e.currentTarget.scrollTop;
  };

  // Saut en bas du fil à chaque nouveau tour ; les complétions suivent le bas
  // uniquement si l'utilisateur y était déjà (comme un chat qui auto-follow).
  const prevTurnCountRef = React.useRef(0);
  React.useEffect(() => {
    const count = turns.length;
    const grew = count > prevTurnCountRef.current;
    prevTurnCountRef.current = count;
    if (view !== 'workspace') return;
    const scrollToBottom = (force: boolean) => {
      const el = document.querySelector<HTMLElement>('[data-nelth-images-scroll="workspace"]');
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 220;
      if (force || nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    };
    const raf = requestAnimationFrame(() => scrollToBottom(grew));
    const fallback = window.setTimeout(() => scrollToBottom(grew), 90);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fallback);
    };
  }, [turns, view, activitySignature]);

  // ---- Restauration des positions de défilement (aller-retour studio ↔
  //      workspace sans rechargement — retentatives douces car les hauteurs
  //      se stabilisent au montage des cartes/images). ----
  React.useEffect(() => {
    if (view !== 'studio') return;
    const target = studioScrollPos.current;
    if (!target) return;
    let tries = 0;
    let id: number | undefined;
    const apply = () => {
      const el = document.querySelector<HTMLElement>('[data-nelth-images-scroll="studio"]');
      if (!el) return;
      el.scrollTop = target;
      tries += 1;
      if (Math.abs(el.scrollTop - target) < 4 || tries > 8) window.clearInterval(id);
    };
    apply();
    id = window.setInterval(apply, 140);
    return () => window.clearInterval(id);
  }, [view]);

  React.useEffect(() => {
    if (view !== 'workspace' || !wsRestore) return;
    const target = wsScrollPos.current;
    if (!target) return;
    let tries = 0;
    let id: number | undefined;
    const apply = () => {
      const el = document.querySelector<HTMLElement>('[data-nelth-images-scroll="workspace"]');
      if (!el) return;
      el.scrollTop = target;
      tries += 1;
      if (Math.abs(el.scrollTop - target) < 4 || tries > 8) window.clearInterval(id);
    };
    apply();
    id = window.setInterval(apply, 140);
    return () => window.clearInterval(id);
  }, [view, wsRestore]);

  // ---- Escape : détail → dessin → (workspace → studio) → panneau → sortie ----
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (detailItem) setDetailItem(null);
      else if (drawing) setDrawing(false);
      else if (view === 'workspace') {
        if (wsPanelOpen) setWsPanelOpen(false);
        else setView('studio');
      } else if (panelOpen) setPanelOpen(false);
      else window.dispatchEvent(new CustomEvent('nelth:images:close'));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detailItem, drawing, view, wsPanelOpen, panelOpen]);

  // ---- Règles des contrôles (catégorie × modèle × références) ----
  // Ratios : 8 pour Nelth-V3 et le GIF ; 3 (1:1, 16:9, 9:16) pour Nelth-V2
  // image et la vidéo texte→vidéo. Image→image V2 et image→vidéo : « Auto » —
  // le format suit l'image de référence (verrouillé, inclicable).
  const hasRefs = references.length > 0;
  const activeRatios = React.useMemo(() => {
    if (category === 'video') return ['1:1', '16:9', '9:16'];
    if (category === 'image' && imageModel === 'v2') return ['1:1', '16:9', '9:16'];
    return ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'];
  }, [category, imageModel]);

  const ratioAuto =
    (category === 'video' && hasRefs) || (category === 'image' && imageModel === 'v2' && hasRefs);
  const ratioLocked = ratioAuto || capabilities?.aspectRatioMode === 'none';
  // Variations verrouillées à 1 dans les mêmes conditions (i2i V2, i2v).
  const variationsLocked = ratioAuto;
  const effectiveVariations = variationsLocked ? 1 : variations;

  // Ratio toujours valide pour la liste active (2:3 pour les 8 ratios,
  // 1:1 pour le trio image, 16:9 pour la vidéo).
  React.useEffect(() => {
    if (ratioAuto) return;
    if (!activeRatios.includes(ratio)) {
      setRatio(category === 'video' ? '16:9' : activeRatios.includes('2:3') ? '2:3' : '1:1');
    }
  }, [activeRatios, ratio, ratioAuto, category]);

  // Variations : défaut par catégorie/modèle (2 pour V3 et GIF, 1 sinon).
  React.useEffect(() => {
    const fallback = category === 'gif' || (category === 'image' && imageModel === 'v3') ? 2 : 1;
    setVariations(fallback);
  }, [category, imageModel]);

  // ---- Génération (text → média) : un tour + transition vers le workspace ----
  const submitGenerateTurn = React.useCallback(
    async (input: api.GenerateInput, prompt: string, expected: number, placeholderRatio?: string) => {
      if (!capabilities || submitting) return;
      const turnId = newTurnId();
      setWsRestore(false);
      setTurns((cur) => [
        ...cur,
        {
          id: turnId,
          prompt,
          kind: 'generate',
          createdAt: Date.now(),
          itemIds: [],
          ratio: placeholderRatio ?? input.aspectRatio ?? '1:1',
          expectedCount: expected,
          error: null,
          retry: { kind: 'generate', input },
        },
      ]);
      setView('workspace');
      setWsPrompt('');
      setSubmitting(true);
      try {
        const queued = await api.generate(input);
        mergeItems(queued);
        setTurns((cur) =>
          cur.map((t) =>
            t.id === turnId
              ? {
                  ...t,
                  itemIds: queued.map((i) => i.id),
                  ratio: queued[0]?.aspect_ratio ?? t.ratio,
                  expectedCount: queued.length,
                }
              : t
          )
        );
        const noun =
          input.kind === 'video' ? 'vidéo' : input.kind === 'gif' ? 'GIF' : 'image';
        pushToast(`Génération lancée — ${queued.length} ${noun}${queued.length > 1 ? 's' : ''}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Génération impossible';
        setTurns((cur) => cur.map((t) => (t.id === turnId ? { ...t, error: message } : t)));
        setWsPrompt(prompt); // le travail de l'utilisateur ne se perd jamais
        pushToast(message, 'error');
      } finally {
        setSubmitting(false);
      }
    },
    [capabilities, submitting, mergeItems, pushToast]
  );

  // ---- Édition / variation (image + instructions → image) ----
  const submitEditTurn = React.useCallback(
    async (itemId: string, instructions: string, kind: 'edit' | 'variation') => {
      if (!capabilities || submitting) return;
      if (kind === 'edit' && !capabilities.features.editing) {
        pushToast('Édition non prise en charge par le moteur actif', 'error');
        return;
      }
      if (kind === 'variation' && !capabilities.features.variations) {
        pushToast('Variations non prises en charge par le moteur actif', 'error');
        return;
      }
      const parent = itemsById.get(itemId);
      const turnId = newTurnId();
      setWsRestore(false);
      setTurns((cur) => [
        ...cur,
        {
          id: turnId,
          prompt: kind === 'variation' ? 'Variation de l’image' : instructions,
          kind,
          createdAt: Date.now(),
          itemIds: [],
          ratio: parent?.aspect_ratio ?? (capabilities.aspectRatioMode !== 'none' ? ratio : '1:1'),
          expectedCount: 1,
          error: null,
          retry:
            kind === 'variation'
              ? { kind: 'variation', itemId }
              : { kind: 'edit', itemId, prompt: instructions },
        },
      ]);
      setView('workspace');
      setWsPrompt('');
      setSubmitting(true);
      try {
        const item =
          kind === 'variation' ? await api.variationItem(itemId) : await api.editItem(itemId, instructions);
        mergeItems([item]);
        setTurns((cur) =>
          cur.map((t) => (t.id === turnId ? { ...t, itemIds: [item.id], ratio: item.aspect_ratio ?? t.ratio } : t))
        );
        pushToast(kind === 'variation' ? 'Variation lancée' : 'Édition lancée');
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Opération impossible';
        setTurns((cur) => cur.map((t) => (t.id === turnId ? { ...t, error: message } : t)));
        if (kind === 'edit') setWsPrompt(instructions);
        pushToast(message, 'error');
      } finally {
        setSubmitting(false);
      }
    },
    [capabilities, submitting, itemsById, ratio, mergeItems, pushToast]
  );

  // ---- Relance EXACTE d'un tour échoué (la requête elle-même a échoué) ----
  const retryTurn = React.useCallback(
    async (turn: GenerationTurn) => {
      if (!turn.retry || submitting) return;
      const turnId = turn.id;
      setSubmitting(true);
      setWsRestore(false);
      setView('workspace');
      setTurns((cur) => cur.map((t) => (t.id === turnId ? { ...t, error: null, itemIds: [] } : t)));
      try {
        if (turn.retry.kind === 'generate') {
          const queued = await api.generate(turn.retry.input);
          mergeItems(queued);
          setTurns((cur) =>
            cur.map((t) =>
              t.id === turnId
                ? {
                    ...t,
                    itemIds: queued.map((i) => i.id),
                    ratio: queued[0]?.aspect_ratio ?? t.ratio,
                    expectedCount: queued.length,
                  }
                : t
            )
          );
          pushToast('Génération relancée');
        } else if (turn.retry.kind === 'edit') {
          const item = await api.editItem(turn.retry.itemId, turn.retry.prompt);
          mergeItems([item]);
          setTurns((cur) => cur.map((t) => (t.id === turnId ? { ...t, itemIds: [item.id] } : t)));
          pushToast('Édition relancée');
        } else {
          const item = await api.variationItem(turn.retry.itemId);
          mergeItems([item]);
          setTurns((cur) => cur.map((t) => (t.id === turnId ? { ...t, itemIds: [item.id] } : t)));
          pushToast('Variation relancée');
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Relance impossible';
        setTurns((cur) => cur.map((t) => (t.id === turnId ? { ...t, error: message } : t)));
        pushToast(message, 'error');
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, mergeItems, pushToast]
  );

  // ---- Construction de la requête selon la catégorie / le modèle / le ratio
  const buildGenerateInput = React.useCallback(
    (text: string, refs: ImagineItem[]): api.GenerateInput => {
      const withUrl = refs.filter((r) => r.url);
      // Image→vidéo : une seule image source (le moteur anime la première).
      const effectiveRefs = category === 'video' ? withUrl.slice(0, 1) : withUrl;
      const attachable =
        effectiveRefs.length > 0 &&
        (category === 'video' || category === 'gif' || Boolean(capabilities?.features.imageToImage));
      return {
        prompt: text,
        kind: category,
        model: category === 'image' ? imageModel : category === 'gif' ? 'v3' : 'v2',
        resolution: category === 'video' ? resolution : undefined,
        aspectRatio: ratioAuto ? undefined : ratio,
        style: styleId ?? undefined,
        n: variationsLocked ? 1 : variations,
        sourceImages: attachable
          ? effectiveRefs.map((r) => ({ url: r.url ?? undefined, name: r.name ?? undefined, type: 'image' }))
          : [],
      };
    },
    [category, imageModel, resolution, ratio, ratioAuto, variations, variationsLocked, styleId, capabilities]
  );

  // ---- Texte → média depuis le composeur (studio ou workspace) ----
  const generateFromText = React.useCallback(
    (text: string) => {
      if (!text || !capabilities || submitting) return;
      const n = Math.min(effectiveVariations, capabilities.maxCount || 1);
      void submitGenerateTurn(buildGenerateInput(text, []), text, n);
    },
    [capabilities, submitting, effectiveVariations, buildGenerateInput, submitGenerateTurn]
  );

  const canGenerate = Boolean(capabilities?.features.textToImage) && auth.kind === 'ok';
  const maxRefs = 4;

  // Studio : « Generate » — le prompt et les références restent en place
  // (retour au studio = rien n'a bougé, §acceptation).
  const onStudioGenerate = React.useCallback(() => {
    const text = prompt.trim();
    if (!text || !capabilities || submitting) return;
    const n = Math.min(effectiveVariations, capabilities.maxCount || 1);
    // Placeholder au ratio de la première référence quand le format la suit.
    const placeholder = ratioAuto
      ? references[0]?.aspect_ratio ?? (category === 'video' ? '16:9' : '1:1')
      : ratio;
    void submitGenerateTurn(buildGenerateInput(text, references), text, n, placeholder);
  }, [
    prompt,
    capabilities,
    submitting,
    effectiveVariations,
    ratio,
    ratioAuto,
    references,
    category,
    buildGenerateInput,
    submitGenerateTurn,
  ]);

  // Workspace : référence d'édition + vidéo → image-to-video ; référence +
  // image → VRAI image-to-image ; sinon texte→média.
  const onWorkspaceGenerate = React.useCallback(() => {
    const text = wsPrompt.trim();
    if (!text || submitting) return;
    if (editReferenceItem && category === 'video') {
      // Image→vidéo : la référence devient la source d'animation (1 seule).
      const placeholder = editReferenceItem.aspect_ratio ?? '16:9';
      void submitGenerateTurn(
        { ...buildGenerateInput(text, [editReferenceItem]), n: 1 },
        text,
        1,
        placeholder
      );
      return;
    }
    if (editReferenceItem && capabilities?.features.editing && category === 'image') {
      void submitEditTurn(editReferenceItem.id, text, 'edit');
      return;
    }
    generateFromText(text);
  }, [
    wsPrompt,
    submitting,
    editReferenceItem,
    category,
    capabilities,
    buildGenerateInput,
    submitGenerateTurn,
    submitEditTurn,
    generateFromText,
  ]);

  // ---- Actions par résultat complété ----
  const attachEditReference = React.useCallback(
    (item: ImagineItem, focus: boolean) => {
      if (!capabilities?.features.editing) {
        pushToast('Édition non prise en charge par le moteur actif', 'error');
        return;
      }
      if (!item.url) return;
      setRefOverride(item.id);
      setRefAutoDisabled(false);
      if (focus) {
        setView('workspace');
        window.setTimeout(() => {
          const area = document.querySelector<HTMLTextAreaElement>('[data-nelth-composer] textarea');
          if (area instanceof HTMLTextAreaElement) area.focus();
        }, 260);
      } else {
        pushToast('Image jointe — vos prochaines instructions l’éditeront');
      }
    },
    [capabilities, pushToast]
  );

  const removeEditReference = React.useCallback(() => {
    setRefOverride(null);
    setRefAutoDisabled(true);
  }, []);

  const onDownloadAction = React.useCallback((item: ImagineItem) => {
    const fallback = `nelth-${isVideoItem(item) ? 'video' : isGifItem(item) ? 'gif' : 'image'}-${item.id}${downloadExt(item)}`;
    void api.downloadImage(item.url ?? '', item.name ?? fallback);
  }, []);

  const onSaveAction = React.useCallback(
    async (item: ImagineItem) => {
      try {
        const patched = await api.patchItem(item.id, { favorite: !item.favorite });
        mergeItems([patched]);
        pushToast(patched.favorite ? 'Ajoutée aux favoris' : 'Retirée des favoris');
      } catch (e) {
        pushToast(e instanceof Error ? e.message : 'Enregistrement impossible', 'error');
      }
    },
    [mergeItems, pushToast]
  );

  // ---- Édition / variation depuis la vue détail (surcouche studio) ----
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
          pushToast(`${file.name} — ${e instanceof Error ? e.message : 'import impossible'}`, 'error');
        }
      }
      if (done) {
        pushToast(`${done} image${done > 1 ? 's' : ''} ajoutée${done > 1 ? 's' : ''} aux importations`);
      }
    },
    [capabilities, mergeItems, pushToast]
  );

  // ---- Références image-to-image (composeur studio) ----
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
      setView('studio');
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
  const onNewCanvas = React.useCallback(() => {
    setPrompt('');
    setReferences([]);
    setStyleId(null);
    setPanelOpen(false);
    const el = () => document.querySelector<HTMLElement>('[data-nelth-images-scroll="studio"]');
    el()?.scrollTo({ top: 0, behavior: 'smooth' });
    window.setTimeout(() => {
      const area = document.querySelector<HTMLTextAreaElement>('[data-nelth-images-scroll="studio"] textarea');
      if (area instanceof HTMLTextAreaElement) area.focus();
    }, 260);
  }, []);

  // ---- Idée de la galerie → composeur ----
  const onUseIdea = React.useCallback(
    (entry: GalleryEntry) => {
      setPrompt(entry.prompt);
      setStyleId(entry.category);
      if (capabilities?.aspectRatios.includes(entry.ratio)) setRatio(entry.ratio);
      const el = document.querySelector<HTMLElement>('[data-nelth-images-scroll="studio"]');
      el?.scrollTo({ top: 0, behavior: 'smooth' });
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

  // ---- Navigation studio ↔ workspace ----
  const onBackToStudio = React.useCallback(() => {
    setWsPanelOpen(false);
    setView('studio');
  }, []);

  const onOpenWorkspace = React.useCallback(() => {
    setWsRestore(true); // restaurer la position du fil, pas de saut
    setView('workspace');
  }, []);

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
    <MotionConfig reducedMotion="user">
      <div className="images-root relative flex h-full flex-col bg-[var(--images-bg)] text-[var(--images-ink)]">
        {/* Machine à états studio | workspace — le composeur (layoutId partagé)
            glisse de sa position studio vers le bas du workspace. */}
        <AnimatePresence initial={false}>
          {view === 'studio' ? (
            <ImageStudio
              key="studio"
              onScroll={onStudioScroll}
              scrolled={scrolled}
              canGenerate={canGenerate}
              capabilities={capabilities}
              prompt={prompt}
              onPromptChange={setPrompt}
              ratio={ratio}
              onRatioChange={setRatio}
              ratios={activeRatios}
              ratioDisabled={ratioLocked}
              ratioAuto={ratioAuto}
              category={category}
              onCategoryChange={setCategory}
              imageModel={imageModel}
              onImageModelChange={setImageModel}
              resolution={resolution}
              onResolutionChange={setResolution}
              variations={variations}
              onVariationsChange={setVariations}
              variationsLocked={variationsLocked}
              variationsLockHint={
                category === 'video'
                  ? 'Image→vidéo : une seule variation (le format suit l’image source)'
                  : 'Image→image Nelth-V2 : une seule variation (le format suit l’image source)'
              }
              generating={submitting}
              onGenerate={onStudioGenerate}
              references={references.map((r) => ({
                id: r.id,
                label: r.name ?? r.prompt?.slice(0, 26) ?? 'Référence',
                url: r.url,
              }))}
              onRemoveReference={(id) => setReferences((cur) => cur.filter((r) => r.id !== id))}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((v) => !v)}
              panelTab={panelTab}
              onPanelTabChange={setPanelTab}
              items={items}
              onImportFiles={(files) => void onImportFiles(files)}
              onDraw={() => setDrawing(true)}
              onPickReference={toggleReference}
              onOpenDetail={(item) => setDetailItem(item)}
              selectedIds={selectedIds}
              canAttach={Boolean(capabilities?.features.imageToImage) || category === 'video' || category === 'gif'}
              onUseIdea={onUseIdea}
              onNewCanvas={onNewCanvas}
              hasTurns={hasTurns}
              pendingCount={pendingCount}
              onOpenWorkspace={onOpenWorkspace}
            />
          ) : (
            <ImageGenerationWorkspace
              key="workspace"
              turns={visibleTurns}
              itemsById={itemsById}
              items={items}
              capabilities={capabilities}
              canGenerate={canGenerate}
              submitting={submitting}
              pendingCount={pendingCount}
              busyId={busyId}
              onBack={onBackToStudio}
              onRetryTurn={retryTurn}
              onEditImage={attachEditReference}
              onVariation={(item) => void submitEditTurn(item.id, '', 'variation')}
              onDownload={onDownloadAction}
              onSave={(item) => void onSaveAction(item)}
              onGenerateAnother={generateFromText}
              composer={{
                prompt: wsPrompt,
                onPromptChange: setWsPrompt,
                ratio,
                onRatioChange: setRatio,
                ratios: activeRatios,
                ratioDisabled: ratioLocked,
                ratioAuto,
                category,
                onCategoryChange: setCategory,
                imageModel,
                onImageModelChange: setImageModel,
                resolution,
                onResolutionChange: setResolution,
                variations,
                onVariationsChange: setVariations,
                variationsLocked,
                variationsLockHint: 'Une seule variation dans ce mode',
                onGenerate: onWorkspaceGenerate,
                editReference: editReferenceItem,
                onRemoveEditReference: removeEditReference,
                panelOpen: wsPanelOpen,
                onTogglePanel: () => setWsPanelOpen((v) => !v),
                panelTab: wsPanelTab,
                onPanelTabChange: setWsPanelTab,
                onImportFiles: (files) => void onImportFiles(files),
                onDraw: () => setDrawing(true),
                onPickReference: (item) => attachEditReference(item, false),
                onOpenDetail: (item) => setDetailItem(item),
                selectedIds: new Set(editReferenceId ? [editReferenceId] : []),
                canAttach: Boolean(capabilities?.features.editing) || category === 'video' || category === 'gif',
              }}
              onScroll={onWorkspaceScroll}
            />
          )}
        </AnimatePresence>

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
              className={
                toast.tone === 'error'
                  ? 'images-pop rounded-full bg-[#B42318] px-4 py-2 text-[13px] font-medium text-white shadow-[var(--images-shadow-toast)]'
                  : 'images-pop rounded-full border border-[var(--images-line)] bg-[var(--images-surface)] px-4 py-2 text-[13px] font-medium text-[var(--images-ink)] shadow-[var(--images-shadow-toast)]'
              }
            >
              {toast.text}
            </div>
          ))}
        </div>
      </div>
    </MotionConfig>
  );
}
