/**
 * Nelth-AI Documents — workspace premium (bundle autonome).
 *
 * Machine à états :
 *   ┌ idle    — pont monté, aucun document ouvert
 *   ├ loading — GET /api/v1/documents/:id
 *   ├ ready   — workspace : aperçu paginé (papier | diapositives | feuilles),
 *   │          panneau plan / modèle / IA / historique, autosave 1200 ms,
 *   │          undo-redo local, zoom, export multi-format, suppression
 *   └ error | denied — états d'échec avec nouvelle tentative
 *
 * Le pont SPA (window.NelthDocuments) monte cette racine dans son hôte ;
 * le bouton retour demande la fermeture au pont (window.__nelthDocsBridge),
 * repli sur NelthDocuments.close() (réinitialisation de l'état interne).
 *
 * Le layout s'adapte à la LARGEUR DU PANNEAU (container queries Tailwind 4,
 * pas de media queries viewport : le panneau docké fait ~640 px même sur un
 * grand écran) : sidebar inline ≥ 960 px, tiroir superposé en dessous.
 */

import * as React from 'react';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import {
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Check,
  CircleAlert,
  CircleCheck,
  Download,
  Ellipsis,
  FileText,
  Heading,
  Link2,
  List,
  Minus,
  PanelRight,
  Pencil,
  Pilcrow,
  Plus,
  SeparatorHorizontal,
  Sparkles,
  Table,
  Trash2,
  Undo2,
  Redo2,
  X,
} from 'lucide-react';
import * as api from './api';
import {
  ConfirmDialog,
  Editable,
  FORMAT_LABELS,
  formatIcon,
  IconButton,
  Menu,
  Spinner,
  cx,
  timeAgo,
  useHostTheme,
  type MenuItem,
} from './ui';
import type { LucideIcon } from 'lucide-react';
import { BlockView, inlineMarkdown, type BlockEditor } from './blocks';
import { buildPreview, type DocumentPreview } from '../lib/documents/preview/preview-model';
import { TEMPLATES, cssFonts, type DocumentTemplate } from '../lib/documents/templates';
import type {
  DocBlock,
  DocCallout,
  DocList,
  DocQuote,
  DocSheet,
  DocSlide,
  DocTable,
  DocumentDoc,
} from '../lib/documents/core/document-schema';

/** Contrôleur exposé au main.tsx (contrat window.NelthDocuments). */
export type DocumentsController = {
  open(id: string): void;
  close(): void;
};

type Toast = { id: number; text: string; tone: 'info' | 'success' | 'error' };
type SaveState = 'saved' | 'dirty' | 'saving' | 'error';
type Phase = 'idle' | 'loading' | 'ready' | 'error' | 'denied';
type Mode = 'paper' | 'slides' | 'sheets';

/** Instantané undo/redo du contenu éditable. */
type Snapshot = {
  title: string;
  template: string;
  blocks: DocBlock[];
  sheets: DocSheet[] | undefined;
  slides: DocSlide[] | undefined;
};

const DEFAULT_FORMATS = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'md', 'txt', 'html'] as const;

const IMPROVE_SUGGESTIONS = [
  'Rendre plus professionnel',
  'Raccourcir',
  'Ajouter une table des matières',
  'Traduire en anglais',
] as const;

function snapshotOf(doc: DocumentDoc): Snapshot {
  return {
    title: doc.title,
    template: doc.template,
    blocks: doc.blocks,
    sheets: doc.sheets,
    slides: doc.slides,
  };
}

function applySnapshot(doc: DocumentDoc, s: Snapshot): DocumentDoc {
  return { ...doc, title: s.title, template: s.template, blocks: s.blocks, sheets: s.sheets, slides: s.slides };
}

const clampZoom = (z: number) => Math.max(50, Math.min(160, Math.round(z / 10) * 10));

// ---------------------------------------------------------------------------
// Racine
// ---------------------------------------------------------------------------

export function DocumentsApp({
  host,
  register,
}: {
  host: HTMLElement | null;
  register: (controller: DocumentsController | null) => void;
}) {
  const theme = useHostTheme(host);

  // ---- Cycle de vie / chargement ----
  const [docId, setDocId] = React.useState<string | null>(null);
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = React.useState('');
  const [detail, setDetail] = React.useState<api.DocumentDetail | null>(null);
  const [doc, setDoc] = React.useState<DocumentDoc | null>(null);

  // ---- Historique local (undo/redo) ----
  const past = React.useRef<Snapshot[]>([]);
  const future = React.useRef<Snapshot[]>([]);
  const [undoDepth, setUndoDepth] = React.useState(0);
  const [redoDepth, setRedoDepth] = React.useState(0);
  const localRev = React.useRef(0);

  // ---- Enregistrement / sélection ----
  const [saveState, setSaveState] = React.useState<SaveState>('saved');
  const [selected, setSelected] = React.useState<DocBlock | null>(null);

  // ---- Zoom / navigation ----
  const [zoom, setZoom] = React.useState(100);
  const zoomTouched = React.useRef(false);
  const [currentPage, setCurrentPage] = React.useState(1);
  const [activeAnchor, setActiveAnchor] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const scrollTick = React.useRef(false);

  // ---- Panneau (inline ≥ 960 px conteneur, tiroir en dessous) ----
  const [panelOpen, setPanelOpen] = React.useState(false);

  // ---- Actions longues ----
  const [improving, setImproving] = React.useState(false);
  const [improveText, setImproveText] = React.useState('');
  const [sweep, setSweep] = React.useState(0);
  const [exporting, setExporting] = React.useState<string | null>(null);
  const [downloadOpen, setDownloadOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  // ---- Titre / toasts ----
  const [renaming, setRenaming] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const [historyOpen, setHistoryOpen] = React.useState(true);
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  // ---- Tableur : feuille active ----
  const [activeSheet, setActiveSheet] = React.useState(0);

  // Miroirs refs (lecture synchrone dans les gestionnaires)
  const docRef = React.useRef<DocumentDoc | null>(null);
  const docIdRef = React.useRef<string | null>(null);
  const openSeq = React.useRef(0);
  React.useEffect(() => {
    docRef.current = doc;
  }, [doc]);
  React.useEffect(() => {
    docIdRef.current = docId;
  }, [docId]);

  const pushToast = React.useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, text, tone }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  // ---- Fermeture (le pont possède la géométrie du panneau) ----
  const requestClose = React.useCallback(() => {
    const bridge = window.__nelthDocsBridge;
    if (bridge && typeof bridge === 'object' && typeof bridge.close === 'function') {
      bridge.close();
    } else {
      window.NelthDocuments?.close();
    }
  }, []);

  const closeWorkspace = React.useCallback(() => {
    openSeq.current += 1; // invalide les chargements en vol
    setDocId(null);
    setPhase('idle');
    setDetail(null);
    setDoc(null);
    setSelected(null);
    past.current = [];
    future.current = [];
    setUndoDepth(0);
    setRedoDepth(0);
    setSaveState('saved');
    setCurrentPage(1);
    setActiveAnchor(null);
    setConfirmDelete(false);
    setImproving(false);
    setImproveText('');
    setSweep(0);
  }, []);

  const openDocument = React.useCallback(
    (id: string) => {
      if (!id) return;
      const seq = ++openSeq.current;
      setDocId(id);
      setPhase('loading');
      setErrorMsg('');
      setDetail(null);
      setDoc(null);
      setSelected(null);
      past.current = [];
      future.current = [];
      setUndoDepth(0);
      setRedoDepth(0);
      setSaveState('saved');
      setCurrentPage(1);
      setActiveAnchor(null);
      setActiveSheet(0);
      setRenaming(false);
      setPanelOpen(!!host && host.clientWidth >= 960);
      (async () => {
        try {
          const d = await api.fetchDocument(id);
          if (openSeq.current !== seq) return;
          setDetail(d);
          setDoc(d.document);
          setPhase('ready');
        } catch (e) {
          if (openSeq.current !== seq) return;
          if (e instanceof api.DocumentsApiError && (e.status === 401 || e.status === 403)) {
            setPhase('denied');
          } else {
            setPhase('error');
            setErrorMsg(e instanceof Error ? e.message : 'Erreur inconnue');
          }
        }
      })();
    },
    [host]
  );

  // Enregistrement du contrôleur vers main.tsx (à chaque rendu — closures
  // fraîches ; l'appel est sans état, aucun re-rendu en boucle).
  React.useEffect(() => {
    register({ open: openDocument, close: closeWorkspace });
  });

  // Panneau ouvert par défaut quand l'hôte est large (mesuré une fois).
  React.useEffect(() => {
    if (host && host.clientWidth >= 960) setPanelOpen(true);
  }, [host]);

  // ---- Mise à jour du SDR + historique ----
  const mutate = React.useCallback((fn: (d: DocumentDoc) => DocumentDoc) => {
    const prev = docRef.current;
    if (!prev) return;
    past.current.push(snapshotOf(prev));
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    const next = fn(prev);
    docRef.current = next;
    localRev.current += 1;
    setDoc(next);
    setUndoDepth(past.current.length);
    setRedoDepth(0);
    setSaveState('dirty');
  }, []);

  const undo = React.useCallback(() => {
    const cur = docRef.current;
    const prev = past.current.pop();
    if (!cur || !prev) return;
    future.current.push(snapshotOf(cur));
    if (future.current.length > 100) future.current.shift();
    const next = applySnapshot(cur, prev);
    docRef.current = next;
    localRev.current += 1;
    setDoc(next);
    setUndoDepth(past.current.length);
    setRedoDepth(future.current.length);
    setSaveState('dirty');
  }, []);

  const redo = React.useCallback(() => {
    const cur = docRef.current;
    const nextSnap = future.current.pop();
    if (!cur || !nextSnap) return;
    past.current.push(snapshotOf(cur));
    if (past.current.length > 100) past.current.shift();
    const next = applySnapshot(cur, nextSnap);
    docRef.current = next;
    localRev.current += 1;
    setDoc(next);
    setUndoDepth(past.current.length);
    setRedoDepth(future.current.length);
    setSaveState('dirty');
  }, []);

  // ---- Autosave (1200 ms de débounce après chaque modification) ----
  const performSave = React.useCallback(async () => {
    const id = docIdRef.current;
    const d = docRef.current;
    if (!id || !d) return;
    const rev = localRev.current;
    setSaveState('saving');
    try {
      const res = await api.patchDocument(id, { document: d, title: d.title });
      if (localRev.current === rev) setSaveState('saved');
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              title: res.title,
              filename: res.filename,
              template: res.template,
              updated_at: res.updated_at ?? prev.updated_at,
            }
          : prev
      );
    } catch (e) {
      setSaveState('error');
      pushToast(e instanceof Error ? e.message : "Échec de l'enregistrement", 'error');
    }
  }, [pushToast]);

  React.useEffect(() => {
    if (saveState !== 'dirty' || !doc) return;
    const t = window.setTimeout(() => {
      void performSave();
    }, 1200);
    return () => window.clearTimeout(t);
  }, [saveState, doc, performSave]);

  // ---- Raccourcis undo/redo ----
  React.useEffect(() => {
    if (phase !== 'ready') return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, undo, redo]);

  // ---- Aperçu / modèle ----
  const preview = React.useMemo<DocumentPreview | null>(() => (doc ? buildPreview(doc) : null), [doc]);
  const tpl: DocumentTemplate = preview?.template ?? TEMPLATES[0];
  const fonts = React.useMemo(() => cssFonts(tpl), [tpl]);

  const mode: Mode = !doc
    ? 'paper'
    : doc.docType === 'presentation' && doc.slides?.length
      ? 'slides'
      : doc.docType === 'spreadsheet' && doc.sheets?.length
        ? 'sheets'
        : 'paper';

  // Index de blocs (data-bidx) + ancres de titres (data-anchor) — dans
  // l'ordre du document, identiques à la numérotation de buildPreview.
  const blockIndexMap = React.useMemo(() => {
    const m = new Map<DocBlock, number>();
    (doc?.blocks ?? []).forEach((b, i) => m.set(b, i));
    return m;
  }, [doc]);
  const headingAnchorMap = React.useMemo(() => {
    const m = new Map<DocBlock, string>();
    let seq = 0;
    (doc?.blocks ?? []).forEach((b) => {
      if (b.t === 'heading') {
        seq += 1;
        m.set(b, `h-${seq}`);
      }
    });
    return m;
  }, [doc]);

  const outlineItems = React.useMemo(() => {
    if (!doc) return [] as Array<{ id: string; level: number; text: string }>;
    if (mode === 'slides') {
      return (doc.slides ?? []).map((s, i) => ({
        id: `slide-${i}`,
        level: 2,
        text: s.title || `Diapositive ${i + 1}`,
      }));
    }
    if (mode === 'sheets') {
      return (doc.sheets ?? []).map((s, i) => ({ id: `sheet-${i}`, level: 2, text: s.name }));
    }
    return (preview?.headingIds ?? []).map((h) => ({ id: h.id, level: h.level, text: h.text }));
  }, [doc, mode, preview]);

  // ---- Éditeurs de blocs (papier) ----
  const withBlock = React.useCallback(
    (block: DocBlock, patch: Record<string, unknown>) => {
      const d = docRef.current;
      if (!d) return;
      const i = d.blocks.indexOf(block);
      if (i < 0) return;
      const nextBlock = { ...block, ...patch } as DocBlock;
      mutate((prev) => ({
        ...prev,
        blocks: [...prev.blocks.slice(0, i), nextBlock, ...prev.blocks.slice(i + 1)],
      }));
      setSelected((cur) => (cur === block ? nextBlock : cur));
    },
    [mutate]
  );

  const editor = React.useMemo<BlockEditor>(
    () => ({
      onSelect: (block) => setSelected(block),
      editText: (block, text) => withBlock(block, { text }),
      editListItem: (block, itemIndex, text) => {
        const d = docRef.current;
        if (!d) return;
        const i = d.blocks.indexOf(block);
        if (i < 0) return;
        const list = d.blocks[i] as DocList;
        const nextBlock: DocList = {
          ...list,
          items: list.items.map((it, j) => (j === itemIndex ? { ...it, text } : it)),
        };
        mutate((prev) => ({ ...prev, blocks: [...prev.blocks.slice(0, i), nextBlock, ...prev.blocks.slice(i + 1)] }));
        setSelected((cur) => (cur === block ? nextBlock : cur));
      },
      editQuoteAuthor: (block: DocQuote, author) => withBlock(block, { author }),
      editCalloutTitle: (block: DocCallout, title) => withBlock(block, { title }),
      editCalloutText: (block: DocCallout, text) => withBlock(block, { text }),
      editTableHeader: (block: DocTable, col, value) => {
        const d = docRef.current;
        if (!d) return;
        const i = d.blocks.indexOf(block);
        if (i < 0) return;
        const table = d.blocks[i] as DocTable;
        const nextBlock: DocTable = {
          ...table,
          header: table.header.map((c, j) => (j === col ? value : c)),
        };
        mutate((prev) => ({ ...prev, blocks: [...prev.blocks.slice(0, i), nextBlock, ...prev.blocks.slice(i + 1)] }));
        setSelected((cur) => (cur === block ? nextBlock : cur));
      },
      editTableCell: (block: DocTable, row, col, value) => {
        const d = docRef.current;
        if (!d) return;
        const i = d.blocks.indexOf(block);
        if (i < 0) return;
        const table = d.blocks[i] as DocTable;
        const nextBlock: DocTable = {
          ...table,
          rows: table.rows.map((r, ri) =>
            ri === row ? r.map((c, ci) => (ci === col ? value : c)) : r
          ),
        };
        mutate((prev) => ({ ...prev, blocks: [...prev.blocks.slice(0, i), nextBlock, ...prev.blocks.slice(i + 1)] }));
        setSelected((cur) => (cur === block ? nextBlock : cur));
      },
      addTableRow: (block: DocTable, row) => {
        const d = docRef.current;
        if (!d) return;
        const i = d.blocks.indexOf(block);
        if (i < 0) return;
        const table = d.blocks[i] as DocTable;
        const nextBlock: DocTable = {
          ...table,
          rows: [
            ...table.rows.slice(0, row + 1),
            Array.from({ length: table.header.length }, () => ''),
            ...table.rows.slice(row + 1),
          ],
        };
        mutate((prev) => ({ ...prev, blocks: [...prev.blocks.slice(0, i), nextBlock, ...prev.blocks.slice(i + 1)] }));
        setSelected((cur) => (cur === block ? nextBlock : cur));
      },
      removeTableRow: (block: DocTable, row) => {
        const d = docRef.current;
        if (!d) return;
        const i = d.blocks.indexOf(block);
        if (i < 0) return;
        const table = d.blocks[i] as DocTable;
        const nextBlock: DocTable = {
          ...table,
          rows: table.rows.filter((_, ri) => ri !== row),
        };
        mutate((prev) => ({ ...prev, blocks: [...prev.blocks.slice(0, i), nextBlock, ...prev.blocks.slice(i + 1)] }));
        setSelected((cur) => (cur === block ? nextBlock : cur));
      },
    }),
    [mutate, withBlock]
  );

  // ---- Diapositives ----
  const updateSlide = (i: number, patch: Partial<DocSlide>) => {
    mutate((prev) => ({
      ...prev,
      slides: (prev.slides ?? []).map((s, j) => (j === i ? { ...s, ...patch } : s)),
    }));
  };
  const updateSlideBullet = (i: number, bi: number, text: string) => {
    mutate((prev) => ({
      ...prev,
      slides: (prev.slides ?? []).map((s, j) =>
        j === i ? { ...s, bullets: s.bullets.map((b, bj) => (bj === bi ? text : b)) } : s
      ),
    }));
  };
  const addSlide = (i: number) => {
    mutate((prev) => ({
      ...prev,
      slides: [
        ...(prev.slides ?? []).slice(0, i + 1),
        { title: '', bullets: [''], layout: 'content' as const },
        ...(prev.slides ?? []).slice(i + 1),
      ],
    }));
  };
  const removeSlide = (i: number) => {
    mutate((prev) => ({ ...prev, slides: (prev.slides ?? []).filter((_, j) => j !== i) }));
  };
  const moveSlide = (i: number, dir: -1 | 1) => {
    mutate((prev) => {
      const slides = [...(prev.slides ?? [])];
      const j = i + dir;
      if (j < 0 || j >= slides.length) return prev;
      const tmp = slides[i];
      slides[i] = slides[j];
      slides[j] = tmp;
      return { ...prev, slides };
    });
  };

  // ---- Feuilles ----
  const sheetIdx = Math.max(0, Math.min(activeSheet, (doc?.sheets?.length ?? 1) - 1));
  const updateSheet = (si: number, fn: (s: DocSheet) => DocSheet) => {
    mutate((prev) => ({ ...prev, sheets: (prev.sheets ?? []).map((s, j) => (j === si ? fn(s) : s)) }));
  };
  const updateSheetCell = (si: number, row: number, col: number, value: string) =>
    updateSheet(si, (s) => ({
      ...s,
      rows: s.rows.map((r, ri) => (ri === row ? r.map((c, ci) => (ci === col ? value : c)) : r)),
    }));
  const updateSheetHeader = (si: number, col: number, value: string) =>
    updateSheet(si, (s) => ({ ...s, header: s.header.map((c, ci) => (ci === col ? value : c)) }));
  const addSheetRow = (si: number, row: number) =>
    updateSheet(si, (s) => ({
      ...s,
      rows: [...s.rows.slice(0, row + 1), Array.from({ length: s.header.length }, () => ''), ...s.rows.slice(row + 1)],
    }));
  const removeSheetRow = (si: number, row: number) =>
    updateSheet(si, (s) => ({ ...s, rows: s.rows.filter((_, ri) => ri !== row) }));
  const addSheet = () => {
    mutate((prev) => ({
      ...prev,
      sheets: [
        ...(prev.sheets ?? []),
        {
          name: `Feuille ${(prev.sheets?.length ?? 0) + 1}`,
          header: ['Colonne 1'],
          rows: [],
        },
      ],
    }));
  };

  // ---- Insertion de blocs (barre d'outils) ----
  const insertBlock = (make: () => DocBlock) => {
    const cur = docRef.current;
    if (!cur) return;
    const idx = selected ? cur.blocks.indexOf(selected) : -1;
    const at = idx >= 0 ? idx + 1 : cur.blocks.length;
    const nb = make();
    mutate((prev) => ({
      ...prev,
      blocks: [...prev.blocks.slice(0, at), nb, ...prev.blocks.slice(at)],
    }));
    setSelected(nb);
    window.setTimeout(() => {
      const d = docRef.current;
      if (!d) return;
      const bidx = d.blocks.indexOf(nb);
      if (bidx < 0) return;
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-bidx="${bidx}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  };

  // ---- Titre ----
  const beginRename = () => {
    if (!doc) return;
    setTitleDraft(doc.title);
    setRenaming(true);
  };
  const commitTitle = () => {
    setRenaming(false);
    const next = titleDraft.trim().slice(0, 300);
    if (!next || !doc || next === doc.title) return;
    mutate((prev) => ({ ...prev, title: next }));
    void performSave();
  };

  // ---- Modèle ----
  const switchTemplate = (templateId: string) => {
    const d = docRef.current;
    const id = docIdRef.current;
    if (!d || !id || d.template === templateId) return;
    mutate((prev) => ({ ...prev, template: templateId }));
    api
      .patchDocument(id, { template: templateId })
      .then((res) => {
        setDetail((prev) => (prev ? { ...prev, template: res.template, filename: res.filename } : prev));
      })
      .catch(() => {
        pushToast('Impossible de changer de modèle', 'error');
      });
  };

  // ---- Amélioration IA ----
  const runImprove = async (instruction: string) => {
    const id = docIdRef.current;
    const text = instruction.trim();
    if (!id || improving || !text) return;
    if (saveState === 'dirty') void performSave(); // persiste avant l'édition IA
    setImproving(true);
    try {
      const res = await api.improveDocument(id, text);
      const cur = docRef.current;
      if (cur) {
        past.current.push(snapshotOf(cur));
        if (past.current.length > 100) past.current.shift();
        future.current = [];
        setUndoDepth(past.current.length);
        setRedoDepth(0);
      }
      docRef.current = res.document;
      localRev.current += 1;
      setDoc(res.document);
      setDetail((prev) => {
        if (!prev) return prev;
        const nextSeq = (prev.revisions[0]?.seq ?? 0) + 1;
        return {
          ...prev,
          title: res.title,
          filename: res.filename,
          template: res.template,
          updated_at: res.updated_at ?? prev.updated_at,
          revisions: [
            {
              seq: nextSeq,
              at: Math.floor(Date.now() / 1000),
              by: 'ai' as const,
              note: text.slice(0, 200),
              title: res.title,
            },
            ...prev.revisions,
          ],
        };
      });
      setSaveState('saved'); // déjà persisté côté serveur
      setImproveText('');
      setSweep((k) => k + 1);
      window.setTimeout(() => setSweep(0), 1300);
      pushToast('Document mis à jour', 'success');
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "L'édition IA a échoué", 'error');
    } finally {
      setImproving(false);
    }
  };

  // ---- Export / lien / suppression ----
  const formats = detail?.exportFormats?.length ? detail.exportFormats : [...DEFAULT_FORMATS];
  const runExport = async (format: string) => {
    const id = docIdRef.current;
    if (!id || exporting) return;
    setExporting(format);
    try {
      const filename = await api.downloadExport(id, format);
      pushToast(`Téléchargé : ${filename}`, 'info');
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Échec de l'export", 'error');
    } finally {
      setExporting(null);
      setDownloadOpen(false);
    }
  };
  const copyLink = async () => {
    if (!detail) return;
    const url = `${window.location.origin}${detail.url}`;
    try {
      await navigator.clipboard.writeText(url);
      pushToast('Lien copié dans le presse-papiers', 'info');
    } catch {
      pushToast('Impossible de copier le lien', 'error');
    }
  };
  const doDelete = async () => {
    const id = docIdRef.current;
    if (!id || deleting) return;
    setDeleting(true);
    try {
      await api.deleteDocument(id);
      pushToast('Document supprimé', 'info');
    } catch (e) {
      pushToast(e instanceof Error ? e.message : 'Échec de la suppression', 'error');
      setDeleting(false);
      return;
    }
    setDeleting(false);
    setConfirmDelete(false);
    requestClose();
  };

  // ---- Zoom ----
  const stepZoom = (delta: number) => {
    zoomTouched.current = true;
    setZoom((z) => clampZoom(z + delta));
  };
  React.useEffect(() => {
    if (phase !== 'ready' || zoomTouched.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const pagePx = (preview?.pageWidth ?? 595.28) * (96 / 72);
    const raw = ((el.clientWidth - 40) / pagePx) * 100;
    const fit = Math.max(50, Math.min(160, Math.floor(raw / 10) * 10));
    if (fit < 100) setZoom(fit);
  }, [phase]);

  // Ctrl+molette = zoom (listener non-passif)
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTouched.current = true;
      setZoom((z) => Math.max(50, Math.min(160, z + (e.deltaY < 0 ? 10 : -10))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- Suivi de défilement : page courante + section active ----
  const onScrollArea = () => {
    if (scrollTick.current) return;
    scrollTick.current = true;
    requestAnimationFrame(() => {
      scrollTick.current = false;
      const el = scrollRef.current;
      if (!el) return;
      const elTop = el.getBoundingClientRect().top;
      let page = currentPage;
      for (const pg of Array.from(el.querySelectorAll<HTMLElement>('[data-page]'))) {
        const r = pg.getBoundingClientRect();
        if (r.bottom > elTop + 90) {
          page = Number(pg.dataset.page || '1') || 1;
          break;
        }
      }
      if (page !== currentPage) setCurrentPage(page);
      let active: string | null = null;
      for (const a of Array.from(el.querySelectorAll<HTMLElement>('[data-anchor]'))) {
        const r = a.getBoundingClientRect();
        if (r.top <= elTop + 130) active = a.dataset.anchor ?? null;
        else break;
      }
      setActiveAnchor((cur) => (cur === active ? cur : active));
    });
  };

  const scrollToAnchor = (id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-anchor="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('docs-flash');
    void el.offsetWidth;
    el.classList.add('docs-flash');
    window.setTimeout(() => el.classList.remove('docs-flash'), 1300);
  };
  const onOutlineClick = (id: string) => {
    if (mode === 'sheets') {
      const i = Number(id.replace('sheet-', ''));
      if (Number.isFinite(i)) setActiveSheet(i);
      return;
    }
    scrollToAnchor(id);
  };
  const goToPage = (dir: 1 | -1) => {
    const target = currentPage + dir;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${target}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ---------------------------------------------------------------------------
  // Menus d'en-tête
  // ---------------------------------------------------------------------------
  const exportItems: MenuItem[] = formats.map((f) => ({
    key: f,
    label: FORMAT_LABELS[f] ?? f.toUpperCase(),
    icon: formatIcon(f),
    busy: exporting === f,
    disabled: !!exporting && exporting !== f,
    keepOpen: true,
    onSelect: () => void runExport(f),
  }));

  const moreItems: MenuItem[] = [
    { key: 'rename', label: 'Renommer', icon: Pencil, disabled: !doc, onSelect: beginRename },
    { key: 'copylink', label: 'Dupliquer le lien', icon: Link2, disabled: !detail, onSelect: () => void copyLink() },
    { key: 'sep', label: '', separator: true },
    { key: 'delete', label: 'Supprimer', icon: Trash2, danger: true, disabled: !doc, onSelect: () => setConfirmDelete(true) },
  ];

  // ---------------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------------

  const pages = preview?.pages ?? [];
  const totalPages = pages.length;
  const ready = phase === 'ready' && !!doc;

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={cx('docs-root @container relative flex h-full w-full flex-col bg-[var(--docs-bg)] text-[var(--docs-ink)]')}
        data-theme={theme}
      >
        {/* ===== En-tête (52 px, sticky) ===== */}
        <header className="flex h-[52px] shrink-0 items-center gap-1.5 border-b border-[var(--docs-line)] bg-[var(--docs-bg-translucent)] px-2.5 backdrop-blur">
          <IconButton icon={ChevronLeft} label="Fermer le document" tip="Fermer" onClick={requestClose} />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {renaming && doc ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenaming(false);
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTitle();
                  }
                }}
                onBlur={commitTitle}
                aria-label="Titre du document"
                className="min-w-0 flex-1 rounded-md px-1.5 py-1 text-[13.5px] font-semibold text-[var(--docs-ink)] outline-none ring-1 ring-[var(--docs-accent)]"
              />
            ) : (
              <button
                type="button"
                onClick={beginRename}
                disabled={!doc}
                title="Renommer le document"
                className="group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--docs-hover)] disabled:cursor-default"
              >
                <span className="truncate text-[13.5px] font-semibold">{doc?.title ?? ''}</span>
                <Pencil className="size-3 shrink-0 text-[var(--docs-faint)] opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
              </button>
            )}
            {ready && detail ? (
              <span className="hidden items-center gap-1.5 whitespace-nowrap @min-[560px]:flex">
                <span className="text-[11.5px] text-[var(--docs-muted)]">{detail.typeLabel}</span>
                <span className="text-[11.5px] text-[var(--docs-faint)]">·</span>
                <span className="rounded border border-[var(--docs-line)] px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-[var(--docs-muted)]">
                  {detail.format || 'pdf'}
                </span>
              </span>
            ) : null}
          </div>

          {/* Statut d'enregistrement */}
          {ready ? (
            <span className="hidden items-center gap-1 text-[11px] text-[var(--docs-muted)] @min-[480px]:flex">
              {saveState === 'saved' ? (
                <>
                  <Check className="size-3.5" aria-hidden="true" />
                  Enregistré
                </>
              ) : saveState === 'saving' ? (
                <>
                  <Spinner className="size-3.5" />
                  Enregistrement…
                </>
              ) : saveState === 'dirty' ? (
                <>
                  <Spinner className="size-3.5" />
                  Modifications…
                </>
              ) : (
                <>
                  <CircleAlert className="size-3.5 text-[var(--docs-danger)]" aria-hidden="true" />
                  <button type="button" onClick={() => void performSave()} className="underline underline-offset-2">
                    Échec — réessayer
                  </button>
                </>
              )}
            </span>
          ) : null}

          <div className="mx-0.5 hidden h-5 w-px bg-[var(--docs-line)] @min-[560px]:block" />

          {/* Téléchargement (formats d'export) */}
          <Menu
            open={downloadOpen}
            onOpenChange={setDownloadOpen}
            tooltipLabel="Télécharger"
            align="end"
            trigger={
              <>
                <Download className="size-[15px]" aria-hidden="true" />
                <span className="hidden @min-[480px]:inline">Télécharger</span>
                <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
              </>
            }
            buttonClassName={cx(
              'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium shadow-[var(--docs-shadow-btn)] transition-opacity',
              ready ? 'bg-[var(--docs-accent)] text-[var(--docs-on-accent)] hover:opacity-90' : 'cursor-default bg-[var(--docs-accent)] text-[var(--docs-on-accent)] opacity-50'
            )}
            items={exportItems}
          />

          {/* Plus d'actions */}
          <Menu
            trigger={<Ellipsis className="size-[17px]" aria-hidden="true" />}
            tooltipLabel="Plus d'actions"
            buttonClassName="flex size-8 items-center justify-center rounded-lg text-[var(--docs-muted)] transition-colors hover:bg-[var(--docs-hover)] hover:text-[var(--docs-ink)]"
            items={moreItems}
          />

          <IconButton
            icon={PanelRight}
            label={panelOpen ? 'Masquer le panneau' : 'Afficher le panneau'}
            tip={panelOpen ? 'Masquer le panneau' : 'Afficher le panneau'}
            active={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          />
        </header>

        {/* ===== Zone principale ===== */}
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
            <main
              ref={scrollRef}
              onScroll={onScrollArea}
              className="docs-scroll relative flex-1 overflow-auto"
            >
              {phase === 'loading' ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <Spinner className="size-6 text-[var(--docs-accent)]" />
                  <p className="text-[13px] text-[var(--docs-muted)]">Chargement du document…</p>
                </div>
              ) : null}

              {phase === 'denied' ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-[15px] font-semibold">Session requise</p>
                  <p className="max-w-[320px] text-[13px] leading-5 text-[var(--docs-muted)]">
                    Ouvrez une session pour consulter vos documents.
                  </p>
                </div>
              ) : null}

              {phase === 'error' ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-[15px] font-semibold">Impossible de charger le document</p>
                  <p className="max-w-[320px] break-words text-[13px] leading-5 text-[var(--docs-muted)]">{errorMsg}</p>
                  <button
                    type="button"
                    onClick={() => docId && openDocument(docId)}
                    className="mt-1 flex h-8 items-center rounded-full bg-[var(--docs-btn-ink)] px-4 text-[12.5px] font-medium text-[var(--docs-btn-on-ink)] transition-opacity hover:opacity-90"
                  >
                    Réessayer
                  </button>
                </div>
              ) : null}

              {ready && doc && mode === 'paper' ? (
                <PaperArea
                  docId={docId}
                  doc={doc}
                  preview={preview}
                  tpl={tpl}
                  fonts={fonts}
                  zoom={zoom}
                  editor={editor}
                  selected={selected}
                  blockIndexMap={blockIndexMap}
                  headingAnchorMap={headingAnchorMap}
                  undoDepth={undoDepth}
                  redoDepth={redoDepth}
                  onUndo={undo}
                  onRedo={redo}
                  onInsert={insertBlock}
                />
              ) : null}

              {ready && doc && mode === 'slides' ? (
                <SlidesArea
                  docId={docId}
                  doc={doc}
                  tpl={tpl}
                  fonts={fonts}
                  onUpdateSlide={updateSlide}
                  onUpdateBullet={updateSlideBullet}
                  onAdd={addSlide}
                  onRemove={removeSlide}
                  onMove={moveSlide}
                />
              ) : null}

              {ready && doc && mode === 'sheets' ? (
                <SheetsArea
                  doc={doc}
                  tpl={tpl}
                  fonts={fonts}
                  activeSheet={sheetIdx}
                  onSelectSheet={setActiveSheet}
                  onAddSheet={addSheet}
                  onUpdateCell={updateSheetCell}
                  onUpdateHeader={updateSheetHeader}
                  onAddRow={addSheetRow}
                  onRemoveRow={removeSheetRow}
                />
              ) : null}
            </main>

            {/* Balayage « document mis à jour » (amélioration IA) */}
            {sweep > 0 ? <div key={sweep} className="docs-sweep" aria-hidden="true" /> : null}

            {/* Pilote de zoom (aperçu papier) */}
            {ready && mode === 'paper' ? (
              <div className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-[var(--docs-line)] bg-[var(--docs-bg-translucent)] p-1 shadow-[var(--docs-shadow-pop)] backdrop-blur">
                <IconButton icon={Minus} label="Zoom arrière" tip="Zoom arrière" onClick={() => stepZoom(-10)} />
                <button
                  type="button"
                  onClick={() => {
                    zoomTouched.current = true;
                    setZoom(100);
                  }}
                  className="h-8 min-w-[46px] rounded-full px-1 text-[11.5px] font-medium tabular-nums text-[var(--docs-muted)] transition-colors hover:bg-[var(--docs-hover)]"
                  title="Réinitialiser le zoom"
                >
                  {zoom}%
                </button>
                <IconButton icon={Plus} label="Zoom avant" tip="Zoom avant" onClick={() => stepZoom(10)} />
                <div className="mx-1 h-4 w-px bg-[var(--docs-line)]" />
                <IconButton
                  icon={ChevronUp}
                  label="Page précédente"
                  tip="Page précédente"
                  disabled={currentPage <= 1}
                  onClick={() => goToPage(-1)}
                />
                <span className="min-w-[46px] text-center text-[11.5px] tabular-nums text-[var(--docs-muted)]">
                  {currentPage} / {totalPages}
                </span>
                <IconButton
                  icon={ChevronDown}
                  label="Page suivante"
                  tip="Page suivante"
                  disabled={currentPage >= totalPages}
                  onClick={() => goToPage(1)}
                />
              </div>
            ) : null}
          </div>

          {/* Panneau inline (conteneur ≥ 960 px) */}
          {panelOpen && ready ? (
            <aside className="docs-scroll hidden w-[300px] shrink-0 flex-col overflow-y-auto border-l border-[var(--docs-line)] bg-[var(--docs-bg)] @min-[960px]:flex">
              <WorkspacePanel
                outlineItems={outlineItems}
                activeAnchor={activeAnchor}
                onOutlineClick={onOutlineClick}
                currentTemplateId={doc?.template ?? ''}
                onSwitchTemplate={switchTemplate}
                improving={improving}
                improveText={improveText}
                onImproveTextChange={setImproveText}
                onRunImprove={() => void runImprove(improveText)}
                revisions={detail?.revisions ?? []}
                historyOpen={historyOpen}
                onToggleHistory={() => setHistoryOpen((v) => !v)}
              />
            </aside>
          ) : null}
        </div>

        {/* Tiroir du panneau (conteneur < 960 px) */}
        <AnimatePresence>
          {panelOpen && ready ? (
            <div className="@min-[960px]:hidden fixed inset-0 z-40">
              <motion.div
                className="absolute inset-0 bg-black/40"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => setPanelOpen(false)}
                aria-hidden="true"
              />
              <motion.aside
                role="dialog"
                aria-label="Panneau du document"
                className="docs-scroll absolute inset-y-0 right-0 flex w-[300px] max-w-[85%] flex-col overflow-y-auto border-l border-[var(--docs-line)] bg-[var(--docs-bg)] shadow-[var(--docs-shadow-pop)]"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
              >
                <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-[var(--docs-line)] px-4">
                  <span className="text-[12px] font-semibold uppercase tracking-wide text-[var(--docs-muted)]">
                    Panneau
                  </span>
                  <IconButton icon={X} label="Fermer le panneau" onClick={() => setPanelOpen(false)} />
                </div>
                <WorkspacePanel
                  outlineItems={outlineItems}
                  activeAnchor={activeAnchor}
                  onOutlineClick={onOutlineClick}
                  currentTemplateId={doc?.template ?? ''}
                  onSwitchTemplate={switchTemplate}
                  improving={improving}
                  improveText={improveText}
                  onImproveTextChange={setImproveText}
                  onRunImprove={() => void runImprove(improveText)}
                  revisions={detail?.revisions ?? []}
                  historyOpen={historyOpen}
                  onToggleHistory={() => setHistoryOpen((v) => !v)}
                />
              </motion.aside>
            </div>
          ) : null}
        </AnimatePresence>

        {/* Toasts (pilule sombre, bas-centre — au-dessus du pilote de zoom) */}
        <div
          className={cx(
            'pointer-events-none absolute left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1.5',
            ready && mode === 'paper' ? 'bottom-[84px]' : 'bottom-5'
          )}
        >
          <AnimatePresence>
            {toasts.map((t) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: 10, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.97 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="docs-pop pointer-events-auto flex items-center gap-2 rounded-full px-3.5 py-2 text-[12.5px] font-medium text-white shadow-[var(--docs-shadow-toast)] ring-1 ring-white/15"
                style={{ background: 'rgba(24, 24, 27, 0.92)' }}
                role="status"
              >
                {t.tone === 'error' ? (
                  <CircleAlert className="size-4 shrink-0 text-red-400" aria-hidden="true" />
                ) : t.tone === 'success' ? (
                  <CircleCheck className="size-4 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Check className="size-4 shrink-0 opacity-70" aria-hidden="true" />
                )}
                <span className="max-w-[260px] truncate">{t.text}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Confirmation de suppression */}
        <ConfirmDialog
          open={confirmDelete}
          title="Supprimer ce document ?"
          message="Cette action est définitive : le document et son fichier associé seront supprimés."
          confirmLabel="Supprimer"
          danger
          busy={deleting}
          onConfirm={() => void doDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      </div>
    </MotionConfig>
  );
}

// ---------------------------------------------------------------------------
// Aperçu papier — pages A4 paginées par buildPreview
// ---------------------------------------------------------------------------

function PaperArea({
  docId,
  doc,
  preview,
  tpl,
  fonts,
  zoom,
  editor,
  selected,
  blockIndexMap,
  headingAnchorMap,
  undoDepth,
  redoDepth,
  onUndo,
  onRedo,
  onInsert,
}: {
  docId: string | null;
  doc: DocumentDoc;
  preview: DocumentPreview | null;
  tpl: DocumentTemplate;
  fonts: ReturnType<typeof cssFonts>;
  zoom: number;
  editor: BlockEditor;
  selected: DocBlock | null;
  blockIndexMap: Map<DocBlock, number>;
  headingAnchorMap: Map<DocBlock, string>;
  undoDepth: number;
  redoDepth: number;
  onUndo(): void;
  onRedo(): void;
  onInsert(make: () => DocBlock): void;
}) {
  const scale = zoom / 100;
  const pages = preview?.pages ?? [];
  const w = preview?.pageWidth ?? 595.28;
  const h = preview?.pageHeight ?? 841.89;
  const m = preview?.margins ?? { top: 66, bottom: 62, side: 56 };

  const toolbarButton = (icon: LucideIcon, label: string, tip: string, onClick: () => void, disabled?: boolean) => (
    <IconButton icon={icon} label={label} tip={tip} tipPlacement="bottom" onClick={onClick} disabled={disabled} />
  );

  return (
    <div className="pb-6 pt-3">
      {/* Barre d'insertion — sticky, translucide, au-dessus du papier */}
      <div className="pointer-events-none sticky top-0 z-20 flex justify-end px-4 pt-2">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-[var(--docs-line)] bg-[var(--docs-bg-translucent)] p-1 shadow-[var(--docs-shadow-btn)] backdrop-blur">
          {toolbarButton(Heading, 'Ajouter un titre', 'Ajouter un titre', () =>
            onInsert(() => ({ t: 'heading', level: 2, text: 'Nouvelle section' }))
          )}
          {toolbarButton(Pilcrow, 'Ajouter un paragraphe', 'Ajouter un paragraphe', () =>
            onInsert(() => ({ t: 'para', text: 'Nouveau paragraphe' }))
          )}
          {toolbarButton(List, 'Ajouter une liste', 'Ajouter une liste à puces', () =>
            onInsert(() => ({ t: 'list', style: 'bullet', items: [{ text: 'Nouvel élément', level: 0 }] }))
          )}
          {toolbarButton(Table, 'Ajouter un tableau', 'Ajouter un tableau (2 colonnes × 3 lignes)', () =>
            onInsert(() => ({
              t: 'table',
              header: ['Colonne 1', 'Colonne 2'],
              rows: [
                ['', ''],
                ['', ''],
                ['', ''],
              ],
            }))
          )}
          {toolbarButton(SeparatorHorizontal, 'Ajouter un saut de page', 'Ajouter un saut de page', () =>
            onInsert(() => ({ t: 'pagebreak' }))
          )}
          <div className="mx-1 h-4 w-px bg-[var(--docs-line)]" />
          {toolbarButton(Undo2, 'Annuler', 'Annuler (Ctrl+Z)', onUndo, undoDepth === 0)}
          {toolbarButton(Redo2, 'Rétablir', 'Rétablir (Ctrl+Shift+Z)', onRedo, redoDepth === 0)}
        </div>
      </div>

      {/* Pages — crossfade au changement de modèle, stagger à la première ouverture */}
      <div className="mx-auto flex w-fit flex-col px-4 pt-4">
        <AnimatePresence mode="wait">
          <motion.div
            key={tpl.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            {pages.map((page, i) => (
              <motion.div
                key={`${docId}-${page.index}`}
                data-page={page.index}
                className="mb-6 last:mb-0"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: Math.min(i * 0.03, 0.32), ease: 'easeOut' }}
                style={{
                  width: `${(w * scale).toFixed(2)}pt`,
                  height: `${(h * scale).toFixed(2)}pt`,
                }}
              >
                <div
                  className="docs-paper relative"
                  style={{
                    width: `${w}pt`,
                    height: `${h}pt`,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                    fontFamily: fonts.body,
                    color: `#${tpl.palette.ink}`,
                    padding: `${m.top}pt ${m.side}pt ${m.bottom}pt`,
                    overflow: 'hidden',
                  }}
                >
                  {page.blocks.map((placed) => {
                    const block = placed.block;
                    return (
                      <BlockView
                        key={blockIndexMap.get(block) ?? page.index * 1000}
                        block={block}
                        tpl={tpl}
                        fonts={fonts}
                        editor={editor}
                        selected={selected === block}
                        bidx={blockIndexMap.get(block) ?? -1}
                        anchorId={block.t === 'heading' ? headingAnchorMap.get(block) : undefined}
                      />
                    );
                  })}
                  {page.index === 1 && doc.blocks.length === 0 ? (
                    <p className="pt-2 text-center" style={{ fontSize: '10.5pt', color: `#${tpl.palette.muted}` }}>
                      Document vide — ajoutez du contenu avec la barre d&apos;outils.
                    </p>
                  ) : null}
                  {/* Pied de page : titre à gauche, « N / total » à droite (dans la marge basse) */}
                  <div
                    className="pointer-events-none absolute flex items-center justify-between"
                    style={{
                      left: `${m.side}pt`,
                      right: `${m.side}pt`,
                      bottom: `${(m.bottom * 0.38).toFixed(1)}pt`,
                      fontSize: '8pt',
                      color: `#${tpl.palette.muted}`,
                    }}
                    aria-hidden="true"
                  >
                    <span className="truncate pr-4">{doc.title}</span>
                    <span className="shrink-0 tabular-nums">
                      {page.index} / {pages.length}
                    </span>
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aperçu présentation — cartes 16:9 empilées
// ---------------------------------------------------------------------------

function SlidesArea({
  docId,
  doc,
  tpl,
  fonts,
  onUpdateSlide,
  onUpdateBullet,
  onAdd,
  onRemove,
  onMove,
}: {
  docId: string | null;
  doc: DocumentDoc;
  tpl: DocumentTemplate;
  fonts: ReturnType<typeof cssFonts>;
  onUpdateSlide(i: number, patch: Partial<DocSlide>): void;
  onUpdateBullet(i: number, bi: number, text: string): void;
  onAdd(i: number): void;
  onRemove(i: number): void;
  onMove(i: number, dir: -1 | 1): void;
}) {
  const slides = doc.slides ?? [];
  return (
    <motion.div
      key={docId}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
      className="mx-auto w-full max-w-[880px] px-4 py-6 @min-[960px]:px-8"
    >
      {slides.map((slide, i) => {
        const big = slide.layout === 'title' || slide.layout === 'section';
        return (
          <motion.section
            key={`${docId}-s${i}`}
            data-anchor={`slide-${i}`}
            aria-label={`Diapositive ${i + 1}`}
            className="group/slide relative mb-6"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: Math.min(i * 0.03, 0.3), ease: 'easeOut' }}
          >
            <div
              className="relative overflow-hidden rounded-[14px]"
              style={{ aspectRatio: '16 / 9', background: `#${tpl.palette.tint}`, boxShadow: 'var(--docs-paper-shadow)' }}
            >
              <div className="absolute inset-y-0 left-0 w-[7px]" style={{ background: `#${tpl.palette.accent}` }} aria-hidden="true" />
              <div
                className={cx('flex h-full flex-col gap-4 px-12 py-10', big ? 'justify-center' : 'justify-center')}
                style={{ fontFamily: fonts.heading }}
              >
                <Editable
                  value={slide.title}
                  onCommit={(title) => onUpdateSlide(i, { title })}
                  placeholder="Titre de la diapositive…"
                  style={{
                    fontSize: big ? '28pt' : '21pt',
                    fontWeight: 700,
                    color: `#${tpl.palette.ink}`,
                    lineHeight: 1.12,
                  }}
                  render={(t) => inlineMarkdown(t, `st${i}`)}
                />
                {slide.bullets.length ? (
                  <ul className="mt-2 flex flex-col gap-2.5" style={{ fontSize: '13.5pt', color: `#${tpl.palette.body}` }}>
                    {slide.bullets.map((b, bi) => (
                      <li key={bi} className="flex items-start gap-3">
                        <span
                          className="mt-[0.55em] h-[5px] w-[5px] shrink-0 rounded-full"
                          style={{ background: `#${tpl.palette.accent}` }}
                          aria-hidden="true"
                        />
                        <Editable
                          value={b}
                          onCommit={(text) => onUpdateBullet(i, bi, text)}
                          className="min-w-0 flex-1"
                          style={{ lineHeight: 1.35 }}
                          render={(t) => inlineMarkdown(t, `sb${i}-${bi}`)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>

            {/* Contrôles au survol */}
            <div className="absolute right-2 top-2 flex gap-0.5 rounded-full border border-[var(--docs-line)] bg-[var(--docs-bg-translucent)] p-0.5 opacity-0 shadow-[var(--docs-shadow-btn)] backdrop-blur transition-opacity group-hover/slide:opacity-100">
              <IconButton icon={ChevronUp} label="Monter" tip="Monter" onClick={() => onMove(i, -1)} disabled={i === 0} />
              <IconButton
                icon={ChevronDown}
                label="Descendre"
                tip="Descendre"
                onClick={() => onMove(i, 1)}
                disabled={i === slides.length - 1}
              />
              <IconButton icon={Plus} label="Ajouter une diapositive en dessous" tip="Ajouter en dessous" onClick={() => onAdd(i)} />
              <IconButton icon={Trash2} label="Supprimer la diapositive" tip="Supprimer" danger onClick={() => onRemove(i)} />
            </div>

            {/* Notes du présentateur */}
            <div className="mt-2 flex items-start gap-2 pl-2">
              <span className="mt-[3px] shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-[var(--docs-faint)]">
                Notes
              </span>
              <Editable
                value={slide.notes ?? ''}
                onCommit={(notes) => onUpdateSlide(i, { notes })}
                multiline
                placeholder="Notes du présentateur…"
                className="min-w-0 flex-1"
                style={{ fontSize: '12px', lineHeight: 1.45, color: 'var(--docs-muted)' }}
              />
            </div>
          </motion.section>
        );
      })}

      {slides.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-[var(--docs-muted)]">Aucune diapositive.</p>
      ) : null}

      <button
        type="button"
        onClick={() => onAdd(slides.length - 1)}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--docs-line-strong)] text-[12.5px] font-medium text-[var(--docs-muted)] transition-colors hover:bg-[var(--docs-hover)]"
      >
        <Plus className="size-4" aria-hidden="true" />
        Ajouter une diapositive
      </button>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Aperçu tableur — onglets + grille éditable
// ---------------------------------------------------------------------------

function SheetsArea({
  doc,
  tpl,
  fonts,
  activeSheet,
  onSelectSheet,
  onAddSheet,
  onUpdateCell,
  onUpdateHeader,
  onAddRow,
  onRemoveRow,
}: {
  doc: DocumentDoc;
  tpl: DocumentTemplate;
  fonts: ReturnType<typeof cssFonts>;
  activeSheet: number;
  onSelectSheet(i: number): void;
  onAddSheet(): void;
  onUpdateCell(si: number, row: number, col: number, value: string): void;
  onUpdateHeader(si: number, col: number, value: string): void;
  onAddRow(si: number, row: number): void;
  onRemoveRow(si: number, row: number): void;
}) {
  const sheets = doc.sheets ?? [];
  const sheet = sheets[activeSheet];
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
      className="flex h-full flex-col"
    >
      {/* Onglets */}
      <div className="docs-scroll sticky top-0 z-10 flex items-center gap-1 overflow-x-auto border-b border-[var(--docs-line)] bg-[var(--docs-bg-translucent)] px-3 py-2 backdrop-blur">
        {sheets.map((s, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === activeSheet}
            onClick={() => onSelectSheet(i)}
            className={cx(
              'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-colors',
              i === activeSheet
                ? 'bg-[var(--docs-chip)] text-[var(--docs-ink)]'
                : 'text-[var(--docs-muted)] hover:bg-[var(--docs-hover)]'
            )}
          >
            {i === activeSheet ? (
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--docs-accent)]" aria-hidden="true" />
            ) : null}
            <span className="max-w-[140px] truncate">{s.name}</span>
          </button>
        ))}
        <IconButton icon={Plus} label="Ajouter une feuille" tip="Ajouter une feuille" tipPlacement="bottom" onClick={onAddSheet} />
      </div>

      {/* Grille */}
      {sheet ? (
        <div data-anchor={`sheet-${activeSheet}`} className="docs-scroll flex-1 overflow-auto p-3 @min-[960px]:p-6">
          <div className="docs-scroll-x overflow-x-auto">
            <table
              className="w-full"
              style={{ borderCollapse: 'collapse', fontSize: `${tpl.typography.size}pt`, fontFamily: fonts.body, tableLayout: 'fixed' }}
            >
              <thead>
                <tr>
                  {sheet.header.map((h, c) => (
                    <th
                      key={c}
                      style={{
                        background: `#${tpl.palette.accent}`,
                        color: '#ffffff',
                        fontWeight: 600,
                        textAlign: 'left',
                        padding: '6pt 9pt',
                        border: `0.75pt solid #${tpl.palette.accent}`,
                        minWidth: '90pt',
                      }}
                    >
                      <Editable
                        value={h}
                        onCommit={(v) => onUpdateHeader(activeSheet, c, v)}
                        style={{ color: '#ffffff', fontWeight: 600 }}
                        title="Modifier l'en-tête"
                      />
                    </th>
                  ))}
                  <th style={{ width: '34pt', border: 'none', padding: '0 2pt' }} aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row, r) => (
                  <tr key={r} className="group/trow" style={{ background: r % 2 === 1 ? `#${tpl.palette.zebra}` : 'transparent' }}>
                    {sheet.header.map((_, c) => {
                      const cell = row[c] ?? '';
                      const formula = cell.trim().startsWith('=');
                      return (
                        <td
                          key={c}
                          style={{
                            padding: '5pt 9pt',
                            border: `0.75pt solid #${tpl.palette.hairline}`,
                            color: `#${tpl.palette.ink}`,
                            verticalAlign: 'top',
                            minWidth: '90pt',
                          }}
                        >
                          <Editable
                            value={cell}
                            onCommit={(v) => onUpdateCell(activeSheet, r, c, v)}
                            style={
                              formula
                                ? { fontFamily: fonts.mono, color: `#${tpl.palette.accentDark}`, fontWeight: 500 }
                                : undefined
                            }
                          />
                        </td>
                      );
                    })}
                    <td style={{ border: 'none', padding: '2pt 2pt 0', verticalAlign: 'top' }} aria-hidden="true">
                      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/trow:opacity-100">
                        <button
                          type="button"
                          aria-label="Ajouter une ligne en dessous"
                          title="Ajouter une ligne en dessous"
                          onClick={() => onAddRow(activeSheet, r)}
                          className="flex size-[18px] items-center justify-center rounded text-[10px] text-[var(--docs-muted)] hover:bg-[var(--docs-hover)]"
                        >
                          +
                        </button>
                        <button
                          type="button"
                          aria-label="Supprimer la ligne"
                          title="Supprimer la ligne"
                          onClick={() => onRemoveRow(activeSheet, r)}
                          className="flex size-[18px] items-center justify-center rounded text-[10px] text-[var(--docs-danger)] hover:bg-[var(--docs-danger-bg)]"
                        >
                          ×
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
                {sheet.rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={sheet.header.length}
                      className="py-3 text-center"
                      style={{ color: `#${tpl.palette.muted}`, border: `0.75pt solid #${tpl.palette.hairline}` }}
                    >
                      <button
                        type="button"
                        onClick={() => onAddRow(activeSheet, -1)}
                        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-medium text-[var(--docs-muted)] hover:bg-[var(--docs-hover)]"
                      >
                        <Plus className="size-3.5" aria-hidden="true" />
                        Ajouter la première ligne
                      </button>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="py-10 text-center text-[13px] text-[var(--docs-muted)]">Aucune feuille.</p>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Panneau latéral — plan, modèle, IA, historique
// ---------------------------------------------------------------------------

function WorkspacePanel({
  outlineItems,
  activeAnchor,
  onOutlineClick,
  currentTemplateId,
  onSwitchTemplate,
  improving,
  improveText,
  onImproveTextChange,
  onRunImprove,
  revisions,
  historyOpen,
  onToggleHistory,
}: {
  outlineItems: Array<{ id: string; level: number; text: string }>;
  activeAnchor: string | null;
  onOutlineClick(id: string): void;
  currentTemplateId: string;
  onSwitchTemplate(id: string): void;
  improving: boolean;
  improveText: string;
  onImproveTextChange(text: string): void;
  onRunImprove(): void;
  revisions: api.RevisionEntry[];
  historyOpen: boolean;
  onToggleHistory(): void;
}) {
  return (
    <div className="docs-scroll flex h-full flex-col overflow-y-auto">
      {/* Plan du document */}
      <section className="border-b border-[var(--docs-line)] px-4 py-3.5" aria-label="Plan du document">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--docs-muted)]">
          Plan du document
        </h2>
        {outlineItems.length ? (
          <nav className="docs-scroll -mx-1 max-h-72 overflow-y-auto px-1">
            {outlineItems.map((item) => {
              const active = activeAnchor === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOutlineClick(item.id)}
                  className={cx(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-[12px] leading-4 transition-colors hover:bg-[var(--docs-hover)]',
                    active ? 'bg-[var(--docs-hover)] font-medium text-[var(--docs-ink)]' : 'text-[var(--docs-muted)]'
                  )}
                  style={{ paddingLeft: `${(item.level - 1) * 11 + 8}px` }}
                >
                  {active ? (
                    <span className="mt-[3px] h-3 w-[2px] shrink-0 rounded-full bg-[var(--docs-accent)]" aria-hidden="true" />
                  ) : null}
                  <span className="truncate">{item.text}</span>
                </button>
              );
            })}
          </nav>
        ) : (
          <p className="px-2 text-[12px] text-[var(--docs-faint)]">Aucun titre</p>
        )}
      </section>

      {/* Modèle */}
      <section className="border-b border-[var(--docs-line)] px-4 py-3.5" aria-label="Modèle">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--docs-muted)]">Modèle</h2>
        <div className="grid grid-cols-2 gap-1.5">
          {TEMPLATES.map((t) => {
            const current = t.id === currentTemplateId;
            return (
              <button
                key={t.id}
                type="button"
                disabled={improving}
                onClick={() => onSwitchTemplate(t.id)}
                title={t.description}
                aria-pressed={current}
                className={cx(
                  'flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors disabled:cursor-default disabled:opacity-50',
                  current
                    ? 'border-[var(--docs-accent)] bg-[var(--docs-accent-soft)]'
                    : 'border-[var(--docs-line)] hover:bg-[var(--docs-hover)]'
                )}
              >
                <span className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: `#${t.palette.accent}` }} />
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: `#${t.palette.accent2}` }} />
                </span>
                <span className="truncate text-[11.5px] font-medium text-[var(--docs-ink)]">{t.name}</span>
                <span className="text-[9.5px] font-medium uppercase tracking-wide text-[var(--docs-faint)]">
                  {t.typography.family === 'serif' ? 'Serif' : 'Sans'}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Améliorer avec l'IA */}
      <section className="border-b border-[var(--docs-line)] px-4 py-3.5" aria-label="Améliorer avec l'IA">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--docs-muted)]">
          <Sparkles className="size-3.5 text-[var(--docs-accent)]" aria-hidden="true" />
          Améliorer avec l&apos;IA
        </h2>
        {improving ? (
          <div className="mt-3 flex flex-col gap-2.5">
            <div className="docs-progress" role="progressbar" aria-label="Amélioration en cours" />
            <p className="text-[12px] text-[var(--docs-muted)]">L&apos;IA retravaille le document…</p>
          </div>
        ) : (
          <>
            <textarea
              value={improveText}
              onChange={(e) => onImproveTextChange(e.target.value)}
              rows={2}
              placeholder="Décrivez la modification souhaitée…"
              aria-label="Instruction d'amélioration"
              className="docs-scroll mt-2.5 w-full resize-none rounded-lg border border-[var(--docs-line)] bg-[var(--docs-surface)] px-2.5 py-2 text-[12.5px] leading-5 text-[var(--docs-ink)] outline-none placeholder:text-[var(--docs-faint)] focus:border-[var(--docs-accent)]"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {IMPROVE_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onImproveTextChange(s)}
                  className="rounded-full border border-[var(--docs-line)] px-2.5 py-1 text-[11px] text-[var(--docs-muted)] transition-colors hover:bg-[var(--docs-hover)]"
                >
                  {s}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={!improveText.trim()}
              onClick={onRunImprove}
              className="mt-2.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--docs-accent)] text-[12.5px] font-medium text-[var(--docs-on-accent)] shadow-[var(--docs-shadow-btn)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            >
              <Sparkles className="size-3.5" aria-hidden="true" />
              Améliorer
            </button>
          </>
        )}
      </section>

      {/* Historique */}
      <section className="px-4 py-3.5" aria-label="Historique">
        <button
          type="button"
          onClick={onToggleHistory}
          aria-expanded={historyOpen}
          className="flex w-full items-center justify-between"
        >
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--docs-muted)]">Historique</h2>
          <ChevronDown
            className={cx('size-3.5 text-[var(--docs-faint)] transition-transform', !historyOpen && '-rotate-90')}
            aria-hidden="true"
          />
        </button>
        {historyOpen ? (
          <ul className="docs-scroll max-h-72 overflow-y-auto">
            {revisions.length ? (
              revisions.map((rev) => (
                <li key={rev.seq} className="flex flex-col rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--docs-hover)]">
                  <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--docs-ink)]">
                    {rev.by === 'ai' ? (
                      <Sparkles className="size-3 shrink-0 text-[var(--docs-accent)]" aria-hidden="true" />
                    ) : rev.by === 'create' ? (
                      <FileText className="size-3 shrink-0 text-[var(--docs-faint)]" aria-hidden="true" />
                    ) : (
                      <Pencil className="size-3 shrink-0 text-[var(--docs-faint)]" aria-hidden="true" />
                    )}
                    {rev.by === 'ai' ? 'IA' : rev.by === 'create' ? 'Création' : 'Vous'}
                    <span className="ml-auto shrink-0 text-[10.5px] font-normal text-[var(--docs-faint)]">
                      {timeAgo(rev.at)}
                    </span>
                  </span>
                  {rev.note ? (
                    <span className="truncate text-[11px] text-[var(--docs-muted)]" title={rev.note}>
                      {rev.note}
                    </span>
                  ) : null}
                </li>
              ))
            ) : (
              <li className="px-2 py-1.5 text-[12px] text-[var(--docs-faint)]">Aucune révision</li>
            )}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
