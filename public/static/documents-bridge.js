/*
 * Nelth-AI Documents — bridge SPA (cartes de chat + artefact aperçu code).
 *
 * ARCHITECTURE (même philosophie que loader.js / images-bridge.js — le SPA
 * Svelte compilé reste INTACT) :
 *
 *  1. ARTEFACT APERÇU CODE (le SYSTÈME NATIF du SPA) : chaque document
 *     généré est livré comme bloc ```html dans le message — le panneau
 *     Artifacts du SPA l'affiche (bouton « Preview » du bloc, versions,
 *     plein écran, téléchargement html natif). Le bloc html lui-même est
 *     MASQUÉ dans la conversation (aucun code brut visible) : la carte
 *     document placée SOUS la réponse le représente.
 *
 *  2. OUTILS DE MODIFICATION DANS l'ARTIFACT : le bundle html embarque le
 *     studio d'édition complet (textes, structures, IA, enregistrement).
 *     Le pont n'est qu'un PROXY API : l'iframe sandboxée (origine opaque)
 *     ne peut pas appeler l'API elle-même — postMessage « save / improve /
 *     fetch » → PATCH / POST / GET authentifiés ici, réponses renvoyées à
 *     l'iframe. « Modifier » sur la carte ouvre le panneau natif puis
 *     ordonne l'entrée en édition à l'artifact (commande postMessage).
 *
 *  3. CARTES DOCUMENT dans la conversation — TROIS chemins complémentaires
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
 *     Les cartes vivent dans la COLONNE DE CONTENU du message (SOUS la
 *     réponse) ; la génération animée aussi.
 *
 *  4. TÉLÉCHARGEMENT : la barre d'outils de l'artefact expose TOUS les
 *     formats via /api/v1/documents/{id}/export?format=… (postMessage →
 *     fetch authentifié) ; la carte propose le fichier d'origine
 *     /api/v1/files/{id}/content.
 *
 *  (L'ATELIER D'ÉDITION OVERLAY — l'ancien « nouvel artefact » — a été
 *   SUPPRIMÉ : la modification vit désormais dans l'aperçu du code,
 *   comme le reste du système.)
 */
(() => {
  'use strict';
  if (window.__nelthDocsBridge) return;

  // Versionnée : garantit que les navigateurs laissent tomber un ancien
  // bundle après une mise à jour (les artefacts sont committés dans public/).
  // 20261114a1 — l'atelier overlay est SUPPRIMÉ : les outils de modification
  // vivent DANS l'artefact aperçu code (édition, IA, enregistrement) ; la
  // carte passe SOUS la réponse ; le bloc html est masqué dans le chat ; le
  // pont proxie save/improve/fetch pour l'iframe sandboxée.
  // 20261114a2 — JAMAIS de blanc sur la réponse : hideNativeFileCard s'arrête
  // dès qu'un parent porte de la substance (markdown, code, .cm-line) ; le
  // bloc html est masqué AUSSI pendant le streaming (rendu pre/code en plus
  // du CodeMirror final).
  const BUILD = '20261114a4';

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
  // d'AJOUTER les éléments documents : proxy API pour l'iframe sandboxée,
  // cartes de chat SOUS la réponse, masquage du code brut, et ouverture du
  // panneau natif à la fin d'un tour de génération.

  /** Le panneau natif est-il ouvert ? (démonté quand fermé) */
  function nativeArtifactsOpen() {
    return !!document.getElementById('artifacts-container');
  }

  /** Clique le bouton « Preview » du bloc html du message — ouvre le panneau
   *  natif sur LA version de ce document (le bouton reste cliquable même
   *  quand le bloc est masqué : le handler Svelte vit sur l'élément).
   *  Retourne false si introuvable. */
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

  /** Commande postMessage à l'artifact (l'iframe filtre par docId). */
  function sendArtifactCommand(docId, action) {
    try {
      document.querySelectorAll('iframe').forEach((f) => {
        try {
          f.contentWindow.postMessage({ nelthDocCommand: { docId: docId, action: action } }, '*');
        } catch (e) {
          /* iframe partie */
        }
      });
    } catch (e) {
      /* un bug du pont ne doit JAMAIS casser l'app hôte */
    }
  }

  /** Ouvre le document dans le panneau d'artefacts NATIF ; réessaie
   *  quelques fois (le message/le bouton peuvent arriver plus tard). Le
   *  clic bascule aussi le panneau déjà ouvert sur LA version de ce doc. */
  function previewDocument(docId, fromEl, command) {
    const msgEl = msgElOf(fromEl);
    let done = false;
    const attempts = [80, 450, 1100, 2200, 3800];
    attempts.forEach((delay) => {
      setTimeout(() => {
        if (done) return;
        try {
          openNativeArtifacts(msgEl);
          if (nativeArtifactsOpen()) {
            done = true;
            if (command) setTimeout(() => sendArtifactCommand(docId, command), 400);
          }
        } catch (e) {
          /* le SPA reste maître */
        }
      }, delay);
    });
  }

  /** Proxy API pour la barre d'outils / le studio DANS l'artefact (iframe
   *  sandboxée, origine opaque → elle ne peut PAS appeler l'API elle-même). */
  window.addEventListener('message', (e) => {
    try {
      const payload = e.data && e.data.nelthDocArtifact;
      if (!payload || typeof payload.docId !== 'string') return;
      const docId = payload.docId;
      const replyTo = (msg) => {
        try {
          e.source && e.source.postMessage(msg, '*');
        } catch (err) {
          /* iframe partie */
        }
      };
      const apiErr = (r, body) => {
        let detail = body && body.detail;
        if (Array.isArray(detail) && detail.length && detail[0] && detail[0].msg) detail = detail[0].msg;
        return typeof detail === 'string' && detail.trim() ? detail.trim() : 'Erreur ' + r.status;
      };

      if (payload.action === 'image') {
        // Image locale protégée de l'artefact → relue en data-URL authentifiée.
        const url = String(payload.url || '');
        const seq = Number(payload.seq) || 0;
        const reply = (dataUrl) =>
          replyTo({ nelthDocArtifactImage: { seq: seq, dataUrl: dataUrl || null } });
        if (!seq || !url.startsWith('/')) {
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
        return;
      }

      // ---- studio d'édition DANS l'aperçu : proxy authentifié ----
      if (payload.action === 'save') {
        const doc = payload.document;
        if (!doc || typeof doc !== 'object') return;
        fetch('/api/v1/documents/' + encodeURIComponent(docId), {
          method: 'PATCH',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ document: doc, note: "Édition depuis l'aperçu" }),
        })
          .then((r) =>
            r
              .json()
              .catch(() => null)
              .then((body) => ({ ok: r.ok, status: r.status, body }))
          )
          .then(({ ok, status, body }) => {
            docCache.delete(docId);
            if (!ok || !body || !body.document) {
              replyTo({ nelthDocSaved: { for: docId, ok: false, error: apiErr({ status }, body) } });
              return;
            }
            replyTo({
              nelthDocSaved: { for: docId, ok: true, saved_at: body.saved_at, document: body.document },
            });
          })
          .catch(() => replyTo({ nelthDocSaved: { for: docId, ok: false, error: 'Réseau indisponible' } }));
        return;
      }

      if (payload.action === 'improve') {
        const instruction = String(payload.instruction || '').trim();
        if (!instruction) return;
        fetch('/api/v1/documents/' + encodeURIComponent(docId) + '/improve', {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ instruction }),
        })
          .then((r) =>
            r
              .json()
              .catch(() => null)
              .then((body) => ({ ok: r.ok, status: r.status, body }))
          )
          .then(({ ok, status, body }) => {
            docCache.delete(docId);
            if (!ok || !body || !body.document) {
              replyTo({ nelthDocImproved: { for: docId, ok: false, error: apiErr({ status }, body) } });
              return;
            }
            replyTo({ nelthDocImproved: { for: docId, ok: true, document: body.document } });
          })
          .catch(() => replyTo({ nelthDocImproved: { for: docId, ok: false, error: 'Réseau indisponible' } }));
        return;
      }

      if (payload.action === 'fetch') {
        // TOUJOURS frais (jamais docCache — il ne porte que des résumés) :
        // l'aperçu doit refléter la dernière version enregistrée du document.
        fetch('/api/v1/documents/' + encodeURIComponent(docId), { headers: authHeaders() })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
          .then((data) => {
            if (data && data.document) {
              docCache.set(docId, data);
              replyTo({
                nelthDocFetched: { for: docId, ok: true, document: data.document, thenEdit: !!payload.thenEdit },
              });
            } else {
              replyTo({ nelthDocFetched: { for: docId, ok: false, thenEdit: !!payload.thenEdit } });
            }
          });
        return;
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
.ndocs-actions{display:flex;gap:8px;margin-top:auto;align-items:center;flex-wrap:wrap}
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
`;
  document.head.appendChild(style);

  // -------------------------------------------------------- cartes de chat

  const ICONS = {
    open:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 22s8-4 10-10 10-10 10-10"/><path d="M8.5 8.5 2 22l13.5-6.5"/></svg>',
    download:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    edit:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  };

  /** Colonne de CONTENU du message — les cartes y vivent SOUS la réponse
   *  (l'élément racine du message est un rang flex : y appending aurait
   *  placé la carte À DROITE de la réponse). */
  function contentColumnOf(msgEl) {
    if (!msgEl) return null;
    try {
      const col = msgEl.querySelector('.flex-auto.w-0');
      if (col) return col;
      const role = msgEl.querySelector('[class*="chat-user"],[class*="chat-assistant"],[class*="chat-system"]');
      if (role) return role;
      const prose = msgEl.querySelector('.markdown-prose,[class*="markdown"],.prose');
      if (prose && prose.parentElement && prose.parentElement !== msgEl) return prose.parentElement;
    } catch (e) {
      /* DOM inattendu — repli racine */
    }
    return msgEl;
  }

  /** Carte premium d'un document (métadonnée du file payload ou de l'API).
   *  Actions : « Aperçu » ouvre le document dans le PANNEAU D'ARTEFACTS
   *  NATIF du SPA (même surface que l'aperçu de code, rafraîchi du serveur) ;
   *  « Modifier » ouvre le même panneau puis ordonne l'entrée en édition à
   *  l'artifact (les outils de modification vivent DANS l'aperçu) ;
   *  « Télécharger » récupère le fichier d'origine. */
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
      previewDocument(docId, card, 'open');
    };
    card.addEventListener('click', previewIt);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') previewIt(e);
    });
    card.querySelector('.ndocs-btn-primary').addEventListener('click', previewIt);
    card.querySelector('.ndocs-btn-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      // même surface que l'aperçu de code — puis édition DANS l'artifact
      previewDocument(docId, card, 'edit');
    });
    card.querySelector('.ndocs-btn:not(.ndocs-btn-primary):not(.ndocs-btn-edit)').addEventListener('click', (e) => {
      e.stopPropagation();
      downloadFile(fileUrl, doc.filename || title);
    });
    setTimeout(() => card.classList.remove('ndocs-appear'), 400);
    return card;
  }

  /** Masque l'affichage fichier natif du SPA pour CE fichier — sans jamais
   *  toucher un conteneur qui porterait de la substance (la réponse).
   *  Couvre la carte fichier native (bouton), les liens et images.
   *  v2 : un parent qui contient le MOINDRE texte de réponse (.markdown-prose,
   *  pre, .cm-line, .language-html) est intouchable — c'est lui qui causait
   *  le « blanc qui cache la réponse de l'IA » (ascension à l'aveugle). */
  var SUBSTANCE_SEL = '.markdown-prose, pre, code, .cm-line, .language-html, [class*="markdown"]';
  function hideNativeFileCard(msgEl, doc) {
    if (!msgEl || !doc) return;
    try {
      const fileId = String(doc.id || doc.file_id || '');
      const name = String(doc.filename || doc.name || doc.title || '');
      const targets = [];
      if (fileId) {
        const sel = 'a[href*="/api/v1/files/' + fileId + '"],[src*="/api/v1/files/' + fileId + '"]';
        Array.prototype.push.apply(targets, msgEl.querySelectorAll(sel));
      }
      // Carte fichier native du SPA : bouton portant le nom du fichier.
      msgEl.querySelectorAll('button').forEach((b) => {
        if (b.closest('.ndocs-card') || b.closest('.ndocs-gen') || b.closest('.ndoc-bar')) return;
        const t = (b.textContent || '').trim();
        if (name && t.indexOf(name) !== -1 && t.length < 160) targets.push(b);
      });
      targets.forEach((el) => {
        let target = el;
        for (let i = 0; i < 4; i++) {
          const p = target.parentElement;
          if (!p || p === msgEl) break;
          // substance dans ce parent → il porte la réponse ou le code : STOP.
          if (p.querySelector(SUBSTANCE_SEL)) break;
          const txt = (p.textContent || '').trim();
          if (txt.length > 400) break;
          target = p;
        }
        if (target && target !== msgEl) target.classList.add('ndocs-hide');
      });
    } catch (e) {
      /* best effort */
    }
  }

  /** Carte premium dans le message (idempotent, survit aux re-renders). */
  function attachDocCard(msgEl, doc) {
    const docId = String(doc.id || doc.file_id || '');
    if (!msgEl || !docId) return;
    const existing = msgEl.querySelector('[data-ndocs-doc="' + CSS.escape(docId) + '"]');
    if (existing) {
      hideNativeFileCard(msgEl, doc);
      return;
    }
    const col = contentColumnOf(msgEl);
    if (col) col.appendChild(buildCard(doc));
    hideNativeFileCard(msgEl, doc);
  }

  const messageEl = (id) => (id ? document.getElementById('message-' + id) : null);

  // -------------------------------- masquage du bloc html (code brut)
  // Le document vit dans le panneau d'artefacts NATIF — le bloc ```html du
  // message n'est qu'un transport : son code brut n'a rien à faire dans la
  // conversation. Le bouton « Preview » reste cliquable (handler sur
  // l'élément) pour ouvrir le panneau natif.

  function hideDocCodeBlocks() {
    try {
      // Le SPA rend les blocs de code via CodeMirror une fois le tour fini
      // (div.language-html + barre d'outils dans le parent) MAIS pendant le
      // streaming, le rendu passe par pre/code classiques — on couvre les
      // DEUX : le marqueur nelth-doc-artifact ouvre le flux dès le début,
      // le code brut n'apparaît donc JAMAIS dans la conversation.
      const blocks = document.querySelectorAll(
        'div[class~="language-html"], pre[class~="language-html"], code[class~="language-html"]'
      );
      for (let i = 0; i < blocks.length; i++) {
        const area = blocks[i];
        let host = area;
        for (let k = 0; k < 4; k++) {
          const p = host.parentElement;
          if (!p || (p.id && /^message-/.test(p.id))) break;
          // ne JAMAIS remonter dans le conteneur de la réponse (markdown) —
          // pendant le streaming la barre d'outils n'existe pas encore.
          if (p.querySelector('.markdown-prose, [class*="markdown"]')) break;
          host = p;
          if (p.querySelector('button')) break; // conteneur avec la barre d'outils
        }
        if (host.classList.contains('ndocs-hide')) continue;
        const firstLine = host.querySelector('.cm-line');
        const txt = firstLine ? firstLine.textContent || '' : host.textContent || '';
        if (txt.indexOf('nelth-doc-artifact:') === -1) continue;
        host.classList.add('ndocs-hide');
      }
    } catch (e) {
      /* best effort */
    }
  }

  // ------------------------------------------------- (a) TAP SSE (live)

  const genCards = new Map(); // message_id → element
  /** Messages dont le panneau d'artefacts natif a déjà été demandé. */
  const nativeOpenedFor = new Set();

  /** Fin d'un tour de génération : ouvre le document dans le panneau
   *  d'artefacts NATIF dès que le bloc html est tombé dans le message. */
  function scheduleNativeOpen(messageId) {
    if (!messageId || nativeOpenedFor.has(messageId)) return;
    nativeOpenedFor.add(messageId);
    const attempts = [500, 1400, 2600, 4200, 6500];
    attempts.forEach((delay) => {
      setTimeout(() => {
        try {
          if (nativeArtifactsOpen()) return;
          openNativeArtifacts(messageEl(messageId));
        } catch (e) {
          /* le SPA reste maître */
        }
      }, delay);
    });
  }

  function showGenerating(messageId, label) {
    const msgEl = messageEl(messageId);
    if (!msgEl) return;
    const col = contentColumnOf(msgEl) || msgEl;
    const old = genCards.get(messageId);
    if (old) {
      const span = old.querySelector('.ndocs-gen-label');
      if (span && label) span.textContent = label;
      if (!old.isConnected || old.parentElement !== col) col.appendChild(old);
      return;
    }
    const el = document.createElement('div');
    el.className = 'ndocs-gen';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="ndocs-gen-dot" aria-hidden="true"></span><span class="ndocs-gen-label"></span>';
    el.querySelector('.ndocs-gen-label').textContent = label || 'Génération du document…';
    col.appendChild(el);
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
        cardRegistry.set(docId, messageId);
        const tryAttach = () => {
          const msgEl = messageEl(messageId);
          if (msgEl) attachDocCard(msgEl, docCache.get(docId));
          hideDocCodeBlocks();
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
    if (!chatId) {
      // Nouvelle conversation depuis « / » : le POST part sans chat_id et
      // l'URL ne bouge pas — après le tour, le chat LE PLUS RÉCENT de
      // l'utilisateur EST cette conversation (mise à jour par le serveur) :
      // on le résout puis on le scanne (la carte arrive en direct, sans
      // attendre une navigation dans l'historique).
      apiGet('/api/v1/chats/?page=1').then((list) => {
        if (Array.isArray(list) && list.length) renderChatDocuments(list[0].id);
      });
      return;
    }
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
          cardRegistry.set(docId, msgId);
          const tryAttach = () => {
            const msgEl = messageEl(msgId);
            if (msgEl) attachDocCard(msgEl, doc);
            return !!msgEl;
          };
          if (!tryAttach()) setTimeout(tryAttach, 600);
        });
      });
      setTimeout(hideDocCodeBlocks, 200);
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

  // Premier chargement (deep-link /c/{id} après reload) + garde anti-zombi :
  // les cartes masquées/retirées par un re-render Svelte sont ré-insérées,
  // le code brut des documents reste masqué. Tout ça rAF-throttlé.
  const cardRegistry = new Map(); // docId → messageId
  let sweepScheduled = false;
  function sweep() {
    if (sweepScheduled) return;
    sweepScheduled = true;
    requestAnimationFrame(() => {
      sweepScheduled = false;
      hideDocCodeBlocks();
      cardRegistry.forEach((messageId, docId) => {
        const msgEl = messageEl(messageId);
        if (!msgEl) return;
        const existing = msgEl.querySelector('[data-ndocs-doc="' + CSS.escape(docId) + '"]');
        if (!existing) {
          if (docCache.has(docId)) {
            const doc = docCache.get(docId);
            if (doc) attachDocCard(msgEl, doc);
          } else {
            resolveDocument(docId).then((data) => {
              if (data && data.document) {
                const msgEl2 = messageEl(messageId);
                if (msgEl2) attachDocCard(msgEl2, Object.assign({}, data, { doc_type: data.docType }));
              }
            });
          }
        } else {
          hideNativeFileCard(msgEl, docCache.get(docId) || { id: docId });
        }
      });
    });
  }

  const observer = new MutationObserver(sweep);

  function start() {
    observer.observe(document.body, { childList: true, subtree: true });
    lastChatUrl = null;
    onChatNavigation();
    sweep();
    setTimeout(() => renderChatDocuments((location.pathname.match(/^\/c\/([a-zA-Z0-9-]+)/) || [])[1]), 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
