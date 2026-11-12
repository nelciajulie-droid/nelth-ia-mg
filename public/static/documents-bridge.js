/*
 * Nelth-AI Documents — bridge SPA (cartes de chat + artefact aperçu code).
 *
 * ARCHITECTURE (même philosophie que loader.js / images-bridge.js — le SPA
 * Svelte compilé reste INTACT) :
 *
 *  1. ARTEFACT APERÇU CODE (le SYSTÈME NATIF du SPA) : chaque document
 *     généré est livré comme bloc ```html dans le message — le panneau
 *     Artifacts du SPA l'affiche (bouton « Preview » du bloc, versions,
 *     plein écran, téléchargement html natif). La barre d'outils DANS
 *     l'artefact (téléchargements multi-formats + « Modifier ») parle au
 *     pont par postMessage (iframe sandboxée, origine opaque).
 *
 *  2. CARTES DOCUMENT dans la conversation — TROIS chemins complémentaires
 *     de découverte (le même rendu final converge vers attachDocCard) :
 *     a. TAP SSE (transport serverless) : window.__nelthEventTap (loader.js
 *        readEvents) voit `chat:message:document` + `status`
 *        (document_generation) AVANT l'app compilée — carte animée pendant
 *        la génération, carte document au dépôt + ouverture du panneau
 *        d'artefacts natif en fin de tour.
 *     b. POST /api/chat/completions (transport socket) : le wrapper fetch
 *        re-décharge le chat après la réponse — les fichiers persistés
 *        (message.files avec document_id) deviennent des cartes premium.
 *     c. NAVIGATION / historique : le chat actif (/c/{id}) est suivi (hook
 *        pushState + popstate) et chaque conversation ouverte est scannée.
 *
 *  3. ATELIER D'ÉDITION (overlay React autonome — un élément AJOUTÉ, pas le
 *     canal d'aperçu) : « Modifier » sur la carte ou dans la barre d'outils
 *     de l'artefact l'ouvre.
 *     • Desktop ≥1024px : panneau ancré à droite (min(880px, 72vw)) —
 *       #chat-container anime sa marge droite (même mécanique que le
 *       panneau Sources de loader.js) : la conversation RESTE visible.
 *     • <1024px : tiroir plein écran + backdrop, safe-areas, back Android.
 *     • Le bundle React (/static/documents/main.js + app.css) est chargé en
 *       LAZY au PREMIER open() — jamais au démarrage de l'app.
 *     • Contrat : window.NelthDocuments { mount/unmount/open/close } côté
 *       bundle, window.__nelthDocsBridge { open/close/isOpen } côté bridge
 *       (le bouton retour du workspace appelle le bridge).
 *
 *  4. TÉLÉCHARGEMENT : la barre d'outils de l'artefact expose TOUS les
 *     formats via /api/v1/documents/{id}/export?format=… (postMessage →
 *     fetch authentifié) ; la carte propose le fichier d'origine
 *     /api/v1/files/{id}/content.
 */
(() => {
  'use strict';
  if (window.__nelthDocsBridge) return;

  // Versionnée : garantit que les navigateurs laissent tomber un ancien
  // bundle après une mise à jour (les artefacts sont committés dans public/).
  // 20261113a1 — les documents passent par l'ARTEFACT APERÇU CODE natif du
  // SPA (bloc ```html + panneau Artifacts) ; la barre d'outils de l'artefact
  // (téléchargements + atelier) parle au pont par postMessage ; la carte
  // gagne « Modifier » et son action principale devient « Aperçu » natif.
  // 20261113a2 — mobile (<768px) : « Aperçu » et la fin de tour basculent sur
  //  l'atelier plein écran quand le panneau natif n'ouvre pas (auto-open et
  //  bouton Preview peu fiables en layout mobile du SPA).
  const BUILD = '20261113a2';
  const SCRIPT_URL = '/static/documents/main.js?v=' + BUILD;
  const CSS_URL = '/static/documents/app.css?v=' + BUILD;

  // ------------------------------------------------------------------ utils

  const getToken = () => {
    try {
      return localStorage.token || localStorage.owu_token || '';
    } catch (e) {
      return '';
    }
  };

  const authHeaders = () => {
    const t = getToken();
    return t ? { authorization: 'Bearer ' + t } : {};
  };

  const apiGet = (path) =>
    fetch(path, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

  /** Résolution id → document (cache positif ET négatif). */
  const docCache = new Map(); // id → DocumentSummary | null
  function resolveDocument(id) {
    if (docCache.has(id)) return Promise.resolve(docCache.get(id));
    const p = apiGet('/api/v1/documents/' + encodeURIComponent(id)).then((data) => {
      const doc = data && data.document ? data : null;
      docCache.set(id, doc);
      return doc;
    });
    return p;
  }

  const TYPE_LABELS = {
    report: 'Rapport',
    cv: 'CV',
    invoice: 'Facture',
    proposal: 'Proposition',
    letter: 'Lettre',
    presentation: 'Présentation',
    spreadsheet: 'Tableur',
    plan: 'Plan',
    contract: 'Contrat',
    research: 'Étude',
    other: 'Document',
  };
  const TEMPLATE_LABELS = {
    corporate: 'Corporate',
    minimalist: 'Minimaliste',
    modern: 'Moderne',
    academic: 'Académique',
    executive: 'Executive',
    creative: 'Créatif',
    financial: 'Financier',
    'professional-cv': 'CV Pro',
    'business-proposal': 'Proposition',
    invoice: 'Facture',
  };
  const TEMPLATE_ACCENTS = {
    corporate: '#0F6B61',
    minimalist: '#37424A',
    modern: '#7C3AED',
    academic: '#7A2E2E',
    executive: '#8C6D1F',
    creative: '#E11D48',
    financial: '#166534',
    'professional-cv': '#0D9488',
    'business-proposal': '#0F766E',
    invoice: '#334155',
  };
  const accentOf = (doc) => TEMPLATE_ACCENTS[doc?.template] || '#0F6B61';

  const fmtSize = (n) => {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' Ko';
    return (n / (1024 * 1024)).toFixed(1) + ' Mo';
  };

  /** Téléchargement authentifié (blob → a[download]). */
  function downloadFile(url, name) {
    fetch(url, { headers: authHeaders() })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
      })
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name || 'document';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      })
      .catch(() => {
        window.open(url, '_blank', 'noopener');
      });
  }

  // ------------------------------------------------ artefact aperçu code
  // Les documents générés empruntent le SYSTÈME D'ARTEFACTS NATIF du SPA :
  // un bloc ```html dans le message devient un aperçu dans le panneau
  // Artifacts (bouton « Preview » du bloc de code). Le pont se contente
  // d'AJOUTER les éléments documents : barre d'outils de l'artefact
  // (téléchargements multi-formats + atelier) via postMessage, cartes de
  // chat, et ouverture du panneau natif à la fin d'un tour de génération.

  /** Le panneau natif est-il ouvert ? (démonté quand fermé) */
  function nativeArtifactsOpen() {
    return !!document.getElementById('artifacts-container');
  }

  /** Clique le bouton « Preview » du bloc html du message — ouvre le panneau
   *  natif sur LA version de ce document. Retourne false si introuvable. */
  function openNativeArtifacts(msgEl) {
    try {
      if (!msgEl) return false;
      const btn = Array.from(msgEl.querySelectorAll('button')).find(
        (b) => /^(preview|aper[uç]u)$/i.test((b.textContent || '').trim())
      );
      if (btn) {
        btn.click();
        return true;
      }
    } catch (e) {
      /* le SPA reste maître */
    }
    return false;
  }

  const msgElOf = (el) => (el ? el.closest('[id^="message-"]') : null);

  /** Viewports étroits : le panneau d'artefacts natif du SPA y est peu fiable
   *  (pas d'auto-open, bouton Preview parfois absent du layout mobile) →
   *  l'atelier plein écran (tiroir + retour Android + safe-areas) prend le
   *  relais — même contenu, même barre d'outils. */
  const isNarrowViewport = () => window.matchMedia('(max-width: 767px)').matches;

  /** Ouvre le document dans le panneau d'artefacts natif ; repli atelier. */
  function previewDocument(docId, fromEl) {
    if (!isNarrowViewport() && openNativeArtifacts(msgElOf(fromEl))) {
      // le clic peut ne rien ouvrir (panneau indisponible) — vérifie puis repli.
      setTimeout(() => {
        if (!nativeArtifactsOpen()) open(docId);
      }, 450);
      return;
    }
    open(docId);
  }

  /** Hôte postMessage de la barre d'outils de l'artefact (iframe sandboxée,
   *  origine opaque → elle ne peut PAS appeler l'API elle-même). */
  window.addEventListener('message', (e) => {
    try {
      const payload = e.data && e.data.nelthDocArtifact;
      if (!payload || typeof payload.docId !== 'string') return;
      const docId = payload.docId;
      if (payload.action === 'edit') {
        open(docId);
        return;
      }
      if (payload.action === 'image') {
        // Image locale protégée de l'artefact → relue en data-URL authentifiée.
        const url = String(payload.url || '');
        const seq = Number(payload.seq) || 0;
        const reply = (dataUrl) => {
          try {
            e.source && e.source.postMessage({ nelthDocArtifactImage: { seq: seq, dataUrl: dataUrl || null } }, '*');
          } catch (err) {
            /* iframe partie */
          }
        };
        if (!seq || !url.startsWith('/')) {
          // chemins relatifs same-origin uniquement (jamais d'URL externe)
          reply(null);
          return;
        }
        fetch(url, { headers: authHeaders() })
          .then((r) => {
            if (!r.ok) throw new Error(String(r.status));
            return r.blob();
          })
          .then(
            (blob) =>
              new Promise((resolve) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = () => resolve(null);
                fr.readAsDataURL(blob);
              })
          )
          .then(reply)
          .catch(() => reply(null));
        return;
      }
      if (payload.action === 'download') {
        const fmt = String(payload.format || '').toLowerCase();
        if (!/^(pdf|docx|xlsx|pptx|csv|md|txt)$/.test(fmt)) return;
        resolveDocument(docId).then((data) => {
          const title =
            (data && data.document && data.document.title) || 'document';
          const safe =
            title.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() ||
            'document';
          downloadFile(
            '/api/v1/documents/' + encodeURIComponent(docId) + '/export?format=' + fmt,
            safe + '.' + fmt
          );
        });
      }
    } catch (err) {
      /* un bug du pont ne doit JAMAIS casser l'app hôte */
    }
  });

  // ------------------------------------------------------------------ style

  const style = document.createElement('style');
  style.textContent = `
/* ============================================================= CARTE CHAT */
.ndocs-gen{display:flex;align-items:center;gap:10px;width:min(100%,320px);margin:8px 0 2px;
  padding:10px 14px;border-radius:14px;border:1px solid #e7e7e7;background:#fafafa;
  font-size:13px;color:#5f5f5f;overflow:hidden;position:relative;align-self:flex-start}
.dark .ndocs-gen{background:#282828;border-color:#3d3d3d;color:#b4b4b4}
.ndocs-gen-dot{width:8px;height:8px;border-radius:99px;background:currentColor;flex-shrink:0;
  animation:ndocs-pulse 1.2s ease-in-out infinite}
@keyframes ndocs-pulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
.ndocs-gen-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ndocs-gen::after{content:'';position:absolute;inset:0;
  background:linear-gradient(100deg,transparent 30%,rgba(0,0,0,.045) 50%,transparent 70%);
  transform:translateX(-100%);animation:ndocs-sweep 1.6s ease-in-out infinite}
.dark .ndocs-gen::after{background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.05) 50%,transparent 70%)}
@keyframes ndocs-sweep{to{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.ndocs-gen-dot{animation:none}.ndocs-gen::after{animation:none;display:none}}

.ndocs-card{display:flex;gap:14px;width:min(100%,430px);margin:10px 0 4px;padding:12px;
  border-radius:16px;border:1px solid #e7e7e7;background:#ffffff;cursor:pointer;
  transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease;
  box-shadow:0 1px 2px rgba(0,0,0,.04);align-self:flex-start}
.ndocs-card:hover{border-color:#d6d6d6;box-shadow:0 6px 22px rgba(0,0,0,.09);transform:translateY(-1px)}
.ndocs-card:focus-visible{outline:2px solid #0F6B61;outline-offset:2px}
.dark .ndocs-card{background:#2b2b2b;border-color:rgba(255,255,255,.07)}
.dark .ndocs-card:hover{border-color:rgba(255,255,255,.14);box-shadow:0 6px 22px rgba(0,0,0,.4)}
.ndocs-card.ndocs-appear{animation:ndocs-in .3s cubic-bezier(.32,.72,0,1) both}
@keyframes ndocs-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){.ndocs-card.ndocs-appear{animation:none}}

/* Vignette papier A4 — aperçu miniature du document. */
.ndocs-thumb{width:64px;height:84px;flex-shrink:0;border-radius:6px;background:#fff;
  border:1px solid #e4e4e4;box-shadow:0 2px 6px rgba(0,0,0,.08);padding:9px 8px 8px;
  display:flex;flex-direction:column;gap:4px;overflow:hidden}
.dark .ndocs-thumb{background:#f7f7f7;border-color:#d9d9d9}
.ndocs-thumb-accent{height:4px;border-radius:2px;width:70%}
.ndocs-thumb-title{font-size:6.5px;line-height:1.25;font-weight:700;color:#1f2937;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.ndocs-thumb-line{height:3px;border-radius:2px;background:#e2e2e2}
.ndocs-thumb-line.short{width:55%}

.ndocs-info{min-width:0;flex:1;display:flex;flex-direction:column;gap:5px}
.ndocs-title{font-size:14px;font-weight:600;color:#171717;line-height:1.3;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dark .ndocs-title{color:#ececec}
.ndocs-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:#737373}
.dark .ndocs-meta{color:#a6a6a6}
.ndocs-chip{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:6px;
  font-size:10px;font-weight:700;letter-spacing:.04em;color:#fff;background:#0F6B61;text-transform:uppercase}
.ndocs-dot{opacity:.5}
.ndocs-actions{display:flex;gap:8px;margin-top:auto;align-items:center}
.ndocs-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:9px;
  border:1px solid #e0e0e0;background:#fff;color:#404040;font-size:12.5px;font-weight:600;cursor:pointer;
  transition:background .15s ease,border-color .15s ease,color .15s ease;font-family:inherit}
.ndocs-btn:hover{background:#f5f5f5;border-color:#d0d0d0}
.ndocs-btn-primary{background:#0F6B61;border-color:#0F6B61;color:#fff}
.ndocs-btn-primary:hover{background:#0b5850;border-color:#0b5850;color:#fff}
.dark .ndocs-btn{background:#303030;border-color:#4d4d4d;color:#d4d4d4}
.dark .ndocs-btn:hover{background:#3a3a3a}
.dark .ndocs-btn-primary{background:#0F6B61;border-color:#0F6B61;color:#fff}
.ndocs-btn svg{width:13px;height:13px;flex-shrink:0}
.ndocs-hide{display:none !important}

/* ============================================================ WORKSPACE */
:root{--ndocs-w:min(880px,72vw)}
@media (max-width:1023px){:root{--ndocs-w:100%}}

.ndocs-backdrop{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.45);opacity:0;
  pointer-events:none;transition:opacity .25s ease}
.ndocs-backdrop.ndocs-b-visible{opacity:1;pointer-events:auto}
@media (min-width:1024px){.ndocs-backdrop{display:none}}

.ndocs-panel{position:fixed;top:0;right:0;z-index:70;width:var(--ndocs-w);max-width:100%;
  height:100vh;height:100dvh;display:flex;flex-direction:column;background:#ffffff;color:#0d0d0d;
  border-left:1px solid #e5e5e5;box-shadow:-14px 0 44px rgba(0,0,0,.10);
  transform:translateX(100%);visibility:hidden;
  transition:transform .3s cubic-bezier(.32,.72,0,1),visibility 0s .3s}
.ndocs-panel.ndocs-visible{transform:translateX(0);visibility:visible;
  transition:transform .3s cubic-bezier(.32,.72,0,1),visibility 0s}
.dark .ndocs-panel{background:#212121;color:#ececec;border-left:1px solid rgba(255,255,255,.09);
  box-shadow:-14px 0 44px rgba(0,0,0,.4)}

#chat-container{transition:margin-right .3s cubic-bezier(.32,.72,0,1),width .2s ease}
@media (min-width:1024px){body.ndocs-open #chat-container{margin-right:var(--ndocs-w)}}

.ndocs-mount{flex:1;min-height:0;position:relative}
.ndocs-mount>*{position:absolute;inset:0}
.ndocs-loading{position:absolute;inset:0;display:flex;flex-direction:column;gap:14px;
  align-items:center;justify-content:center;color:#8f8f8f;font-size:13px}
.ndocs-spin{width:22px;height:22px;border-radius:99px;border:2px solid #e0e0e0;
  border-top-color:#0F6B61;animation:ndocs-rotate .8s linear infinite}
.dark .ndocs-spin{border-color:#3d3d3d;border-top-color:#34d399}
@keyframes ndocs-rotate{to{transform:rotate(360deg)}}

@media (max-width:1023px){
  .ndocs-panel{width:100%;border-left:none;box-shadow:0 0 60px rgba(0,0,0,.32)}
}
html.ndocs-lock{overflow:hidden}
@media (prefers-reduced-motion:reduce){.ndocs-panel,.ndocs-backdrop,#chat-container{transition:none !important}}
`;
  document.head.appendChild(style);

  // ------------------------------------------------- panel + lazy workspace

  let panel = null;
  let mountHost = null;
  let backdrop = null;
  let workspaceLoading = null; // Promise<boolean>
  let pendingDocId = null;
  let historyPushed = false;
  let lastActiveElement = null;

  const overlayMq = window.matchMedia('(max-width: 1023px)');
  const isOverlay = () => overlayMq.matches;

  function ensurePanel() {
    if (panel) return;
    backdrop = document.createElement('div');
    backdrop.className = 'ndocs-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', () => close());
    document.body.appendChild(backdrop);

    panel = document.createElement('aside');
    panel.className = 'ndocs-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Document');
    const loading = document.createElement('div');
    loading.className = 'ndocs-loading';
    loading.innerHTML =
      '<div class="ndocs-spin" aria-hidden="true"></div><span>Préparation du workspace…</span>';
    mountHost = document.createElement('div');
    mountHost.className = 'ndocs-mount';
    mountHost.id = 'nelth-documents-overlay';
    mountHost.appendChild(loading);
    panel.appendChild(mountHost);
    document.body.appendChild(panel);
  }

  /** Lazy-load du bundle React (une seule fois par page). */
  function loadWorkspace() {
    if (workspaceLoading) return workspaceLoading;
    workspaceLoading = new Promise((resolve) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = CSS_URL;
      document.head.appendChild(css);

      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => {
        const ready = () => {
          if (window.NelthDocuments && mountHost) {
            try {
              window.NelthDocuments.mount(mountHost);
              resolve(true);
            } catch (e) {
              console.error('[documents-bridge] mount failed', e);
              resolve(false);
            }
            return true;
          }
          return false;
        };
        if (!ready()) {
          let tries = 0;
          const iv = setInterval(() => {
            if (ready() || ++tries > 50) clearInterval(iv);
          }, 100);
        }
      };
      script.onerror = () => {
        console.error('[documents-bridge] workspace script failed to load');
        resolve(false);
      };
      document.head.appendChild(script);
    });
    return workspaceLoading;
  }

  function open(docId) {
    if (!docId) return;
    pendingDocId = docId;
    ensurePanel();
    document.body.classList.add('ndocs-open');
    panel.classList.add('ndocs-visible');
    if (isOverlay()) {
      backdrop.classList.add('ndocs-b-visible');
      document.documentElement.classList.add('ndocs-lock');
      if (!historyPushed) {
        history.pushState({ __nelthDocs: 1 }, '');
        historyPushed = true;
      }
      lastActiveElement = document.activeElement instanceof Element ? document.activeElement : null;
    }
    const loading = mountHost.querySelector('.ndocs-loading');
    if (loading) loading.style.display = '';
    void loadWorkspace().then((ok) => {
      if (!ok) return;
      if (loading) loading.style.display = 'none';
      if (pendingDocId && window.NelthDocuments) {
        window.NelthDocuments.open(pendingDocId);
      }
    });
  }

  function close() {
    if (!panel) return;
    if (window.NelthDocuments) {
      try {
        window.NelthDocuments.close();
      } catch (e) {
        /* workspace déjà parti */
      }
    }
    document.body.classList.remove('ndocs-open');
    panel.classList.remove('ndocs-visible');
    backdrop?.classList.remove('ndocs-b-visible');
    document.documentElement.classList.remove('ndocs-lock');
    if (historyPushed) {
      historyPushed = false;
      if (window.history.state && window.history.state.__nelthDocs) window.history.back();
    }
    if (lastActiveElement && lastActiveElement.isConnected) {
      try {
        lastActiveElement.focus({ preventScroll: true });
      } catch (e) {
        /* plus focusable */
      }
    }
    lastActiveElement = null;
    pendingDocId = null;
  }

  window.addEventListener('popstate', () => {
    if (historyPushed) {
      historyPushed = false;
      close();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && panel.classList.contains('ndocs-visible')) {
      close();
    }
  });

  // API publique — le workspace l'utilise pour son bouton retour.
  window.__nelthDocsBridge = {
    open,
    close,
    isOpen: () => !!panel && panel.classList.contains('ndocs-visible'),
  };

  // -------------------------------------------------------- cartes de chat

  const ICONS = {
    open:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 22s8-4 10-10 10-10 10-10"/><path d="M8.5 8.5 2 22l13.5-6.5"/></svg>',
    download:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    edit:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  };

  /** Carte premium d'un document (métadonnée du file payload ou de l'API).
   *  Actions : « Aperçu » ouvre le document dans le PANNEAU D'ARTEFACTS
   *  NATIF du SPA (même surface que l'aperçu de code) ; « Modifier » ouvre
   *  l'atelier d'édition ; « Télécharger » récupère le fichier d'origine. */
  function buildCard(doc) {
    const card = document.createElement('div');
    card.className = 'ndocs-card ndocs-appear';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.dataset.ndocsDoc = doc.id || doc.file_id;
    const accent = accentOf(doc);
    const title = doc.title || doc.filename || 'Document';
    const typeLabel = doc.typeLabel || TYPE_LABELS[doc.doc_type] || 'Document';
    const format = String(doc.format || (doc.filename || '').split('.').pop() || '').toUpperCase();
    const templateLabel = TEMPLATE_LABELS[doc.template] || doc.template || '';
    card.setAttribute('aria-label', 'Aperçu du document ' + title);
    card.innerHTML =
      '<div class="ndocs-thumb" aria-hidden="true">' +
      '<div class="ndocs-thumb-accent" style="background:' + accent + '"></div>' +
      '<div class="ndocs-thumb-title"></div>' +
      '<div class="ndocs-thumb-line"></div><div class="ndocs-thumb-line"></div>' +
      '<div class="ndocs-thumb-line short"></div></div>' +
      '<div class="ndocs-info">' +
      '<div class="ndocs-title"></div>' +
      '<div class="ndocs-meta"><span class="ndocs-chip" style="background:' + accent + '"></span>' +
      '<span></span><span class="ndocs-dot">·</span><span></span>' +
      (fmtSize(doc.size) ? '<span class="ndocs-dot">·</span><span></span>' : '') +
      '</div>' +
      '<div class="ndocs-actions">' +
      '<button type="button" class="ndocs-btn ndocs-btn-primary">' + ICONS.open + '<span>Aperçu</span></button>' +
      '<button type="button" class="ndocs-btn ndocs-btn-edit">' + ICONS.edit + '<span>Modifier</span></button>' +
      '<button type="button" class="ndocs-btn">' + ICONS.download + '<span>Télécharger</span></button>' +
      '</div></div>';
    card.querySelector('.ndocs-thumb-title').textContent = title;
    card.querySelector('.ndocs-title').textContent = title;
    const chip = card.querySelector('.ndocs-chip');
    chip.textContent = format || 'DOC';
    const metaSpans = card.querySelectorAll('.ndocs-meta span:not(.ndocs-chip):not(.ndocs-dot)');
    metaSpans[0].textContent = typeLabel;
    metaSpans[1].textContent = templateLabel ? 'Modèle ' + templateLabel : '';
    if (metaSpans[2]) metaSpans[2].textContent = fmtSize(doc.size);

    const docId = doc.id || doc.file_id;
    const fileUrl = doc.url || '/api/v1/files/' + encodeURIComponent(docId) + '/content';
    const previewIt = (e) => {
      e.stopPropagation();
      previewDocument(docId, card);
    };
    card.addEventListener('click', previewIt);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') previewIt(e);
    });
    card.querySelector('.ndocs-btn-primary').addEventListener('click', previewIt);
    card.querySelector('.ndocs-btn-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      open(docId);
    });
    card.querySelector('.ndocs-btn:not(.ndocs-btn-primary):not(.ndocs-btn-edit)').addEventListener('click', (e) => {
      e.stopPropagation();
      downloadFile(fileUrl, doc.filename || title);
    });
    setTimeout(() => card.classList.remove('ndocs-appear'), 400);
    return card;
  }

  /** Masque l'affichage fichier natif du SPA pour CE fichier (si le build
   *  du SPA en rend un — la carte premium est l'affichage). */
  function hideNativeFileCard(msgEl, fileId) {
    if (!msgEl) return;
    const sel =
      'a[href*="/api/v1/files/' + fileId + '"],[src*="/api/v1/files/' + fileId + '"]';
    msgEl.querySelectorAll(sel).forEach((el) => {
      let target = el;
      for (let i = 0; i < 4 && target.parentElement && target.parentElement !== msgEl; i++) {
        target = target.parentElement;
      }
      target.classList.add('ndocs-hide');
    });
  }

  /** Carte premium dans le message (idempotent, survit aux re-renders). */
  function attachDocCard(msgEl, doc) {
    const docId = String(doc.id || doc.file_id || '');
    if (!msgEl || !docId) return;
    const existing = msgEl.querySelector('[data-ndocs-doc="' + CSS.escape(docId) + '"]');
    if (existing) return;
    msgEl.appendChild(buildCard(doc));
    hideNativeFileCard(msgEl, docId);
  }

  const messageEl = (id) => (id ? document.getElementById('message-' + id) : null);

  // ------------------------------------------------- (a) TAP SSE (live)

  const genCards = new Map(); // message_id → element
  /** Messages dont le panneau d'artefacts natif a déjà été demandé. */
  const nativeOpenedFor = new Set();

  /** Fin d'un tour de génération de document : ouvre le document dans le
   *  PANNEAU D'ARTEFACTS NATIF (même surface que l'aperçu de code) dès que
   *  le bloc html est tombé dans le message (l'événement done remplace le
   *  contenu juste après les événements document). Viewports étroits : si le
   *  panneau natif n'ouvre toujours pas, l'atelier plein écran prend le
   *  relais ; sinon les cartes et le bouton « Preview » restent là. */
  function scheduleNativeOpen(messageId) {
    if (!messageId || nativeOpenedFor.has(messageId)) return;
    nativeOpenedFor.add(messageId);
    const attempts = [500, 1400, 2600, 4200];
    let docId = null;
    attempts.forEach((delay, i) => {
      setTimeout(() => {
        try {
          if (nativeArtifactsOpen()) return;
          openNativeArtifacts(messageEl(messageId));
          // Dernier essai écoulé sans panneau → mobile : l'atelier plein écran
          // prend le relais (le panneau natif n'y auto-ouvre pas).
          if (i === attempts.length - 1 && !nativeArtifactsOpen()) {
            if (isNarrowViewport()) {
              docId = docId || lastDocOfMessage(messageId);
              if (docId) open(docId);
            }
          }
        } catch (e) {
          /* le SPA reste maître */
        }
      }, delay);
    });
  }

  /** Dernier document connu rattaché à un message (cartes déjà posées). */
  function lastDocOfMessage(messageId) {
    try {
      const msgEl = messageEl(messageId);
      if (!msgEl) return null;
      const cards = msgEl.querySelectorAll('[data-ndocs-doc]');
      return cards.length ? cards[cards.length - 1].getAttribute('data-ndocs-doc') : null;
    } catch (e) {
      return null;
    }
  }

  function showGenerating(messageId, label) {
    const msgEl = messageEl(messageId);
    if (!msgEl) return;
    const old = genCards.get(messageId);
    if (old) {
      const span = old.querySelector('.ndocs-gen-label');
      if (span && label) span.textContent = label;
      if (old.parentElement !== msgEl) msgEl.appendChild(old);
      return;
    }
    const el = document.createElement('div');
    el.className = 'ndocs-gen';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="ndocs-gen-dot" aria-hidden="true"></span><span class="ndocs-gen-label"></span>';
    el.querySelector('.ndocs-gen-label').textContent = label || 'Génération du document…';
    msgEl.appendChild(el);
    genCards.set(messageId, el);
  }

  function clearGenerating(messageId) {
    const el = genCards.get(messageId);
    if (el) {
      el.remove();
      genCards.delete(messageId);
    }
  }

  window.__nelthEventTap = (env) => {
    try {
      const data = env && env.data;
      if (!data || !data.type) return;
      const messageId = env.message_id;

      if (data.type === 'status') {
        const payload = data.data || {};
        if (payload.action !== 'document_generation') return;
        if (payload.done === true) {
          clearGenerating(messageId);
        } else {
          showGenerating(
            messageId,
            String(payload.description || '').replace(
              /^Generating documents? · /i,
              'Génération du document · '
            )
          );
        }
        return;
      }

      if (data.type === 'chat:message:document') {
        const doc = (data.data || {}).document;
        if (!doc) return;
        clearGenerating(messageId);
        const docId = String(doc.id || doc.file_id || '');
        docCache.set(docId, {
          id: docId,
          file_id: doc.file_id || docId,
          title: doc.title,
          doc_type: doc.doc_type,
          template: doc.template,
          language: doc.language,
          format: doc.format,
          filename: doc.filename,
          url: doc.url,
          size: doc.size,
        });
        const tryAttach = () => {
          const msgEl = messageEl(messageId);
          if (msgEl) attachDocCard(msgEl, docCache.get(docId));
          return !!msgEl;
        };
        if (!tryAttach()) setTimeout(tryAttach, 350);
        setTimeout(tryAttach, 1200);
        scheduleNativeOpen(messageId);
      }
    } catch (e) {
      /* un bug du bridge ne doit JAMAIS casser l'app hôte */
    }
  };

  // ------------------------------------------- (b) POST completion → rescan

  /** Recharge le chat et dépose les cartes des documents persistés. */
  function renderChatDocuments(chatId) {
    if (!chatId) return;
    apiGet('/api/v1/chats/' + encodeURIComponent(chatId)).then((chat) => {
      if (!chat || !chat.chat) return;
      const messages = (chat.chat.history || {}).messages || {};
      Object.entries(messages).forEach(([msgId, msg]) => {
        if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.files)) return;
        msg.files.forEach((file) => {
          const docId = file && (file.document_id || file.id);
          if (!docId || file.type === 'image') return;
          const cached = docCache.get(docId);
          const doc =
            cached ||
            {
              id: docId,
              file_id: file.id || docId,
              title: file.title || file.name,
              doc_type: file.doc_type,
              template: file.template,
              format: (file.name || '').split('.').pop(),
              filename: file.name,
              url: file.url || '/api/v1/files/' + docId + '/content',
              size: file.size,
            };
          if (!cached) docCache.set(docId, doc);
          const tryAttach = () => {
            const msgEl = messageEl(msgId);
            if (msgEl) attachDocCard(msgEl, doc);
            return !!msgEl;
          };
          if (!tryAttach()) setTimeout(tryAttach, 600);
        });
      });
    });
  }

  /** chat_id du POST courant (le body l'emporte ; l'URL suit). */
  function currentChatIdFromBody(bodyObj) {
    try {
      if (bodyObj && typeof bodyObj.chat_id === 'string' && bodyObj.chat_id) return bodyObj.chat_id;
    } catch (e) {
      /* pas un body JSON */
    }
    const m = location.pathname.match(/^\/c\/([a-zA-Z0-9-]+)/);
    return m ? m[1] : null;
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isChatPost =
      /\/api\/chat\/completions\/?(\?.*)?$/.test(url) &&
      !!init &&
      String(init.method || '').toUpperCase() === 'POST';
    const res = nativeFetch(input, init);
    if (!isChatPost) return res;
    // Transport socket : la réponse JSON ne peut arriver qu'une fois le tour
    // traité côté serveur (persistance incluse) → re-scan différé.
    let bodyObj = null;
    try {
      bodyObj = JSON.parse(String(init.body));
    } catch (e) {
      bodyObj = null;
    }
    const chatId = currentChatIdFromBody(bodyObj);
    res.then(() => {
      setTimeout(() => renderChatDocuments(chatId), 1500);
      setTimeout(() => renderChatDocuments(chatId), 5000);
    }).catch(() => {});
    return res;
  };

  // ------------------------------------------ (c) navigation → scan du chat

  let lastChatUrl = null;
  function onChatNavigation() {
    const m = location.pathname.match(/^\/c\/([a-zA-Z0-9-]+)/);
    const chatId = m ? m[1] : null;
    if (chatId === lastChatUrl) return;
    lastChatUrl = chatId;
    if (!chatId) return;
    setTimeout(() => renderChatDocuments(chatId), 700);
    setTimeout(() => renderChatDocuments(chatId), 2200);
  }

  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn].bind(history);
    history[fn] = function () {
      const r = orig.apply(this, arguments);
      onChatNavigation();
      return r;
    };
  });
  window.addEventListener('popstate', onChatNavigation);

  // Premier chargement (deep-link /c/{id} après reload) + garde anti-zombi
  // (les cartes retirées par un re-render Svelte sont ré-insérées).
  let navScheduled = false;
  const observer = new MutationObserver(() => {
    if (navScheduled) return;
    navScheduled = true;
    requestAnimationFrame(() => {
      navScheduled = false;
      onChatNavigation();
    });
  });

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    lastChatUrl = null;
    onChatNavigation();
    setTimeout(() => renderChatDocuments((location.pathname.match(/^\/c\/([a-zA-Z0-9-]+)/) || [])[1]), 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
