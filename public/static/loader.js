/**
 * Nelth-AI — ChatGPT-style right Sources panel + inline citation badges.
 *
 * Injected from index.html (loaded on every page — SvelteKit keeps the
 * document alive across client-side navigation). The compiled frontend is
 * left untouched; the panel integrates as a layout region of the app:
 *
 *   • Desktop / tablet (≥768px): docked right region, width adapted to the
 *     viewport (min(410px, 48vw), up to 440px on wide screens). The app
 *     shell (#chat-container) animates its right margin so the sidebar,
 *     conversation and composer stay visible and functional — no overlap,
 *     no horizontal overflow, scroll position preserved.
 *   • Mobile / Android (<768px): full-screen right drawer (100% width,
 *     100dvh, safe-area aware) over a dimmed backdrop: body scroll lock,
 *     focus trap, focus restoration, Android back-button support (the
 *     drawer owns one history entry, closed by popstate).
 *   • Clicking the "N Sources" pill under an assistant response opens the
 *     panel with every source of that message. Inline citation badges and
 *     native source cards open it with the matching source highlighted —
 *     browsing citations of the SAME message updates the highlight in
 *     place (no close/reopen, no scroll reset, no favicon re-fetch).
 *   • Escape / backdrop tap / close button dismiss. Light + dark themes.
 *     Transitions are 280ms with natural easing and honor
 *     prefers-reduced-motion.
 *
 * Data comes from the chat history API (message.sources) — no fabricated
 * sources, the exact metadata produced by the web-search pipeline.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers

  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };

  // Overlay mode = viewport narrower than 768px (mobile / Android phones).
  // Layout itself is pure CSS (media queries) — this only drives the
  // dialog semantics, backdrop, scroll lock, history entry and focus trap.
  const overlayMq = window.matchMedia('(max-width: 767px)');
  const reduceMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isOverlay = () => overlayMq.matches;

  let panel = null;
  let backdrop = null;
  let state = { messageId: null, sources: [] };
  let pendingMessageId = null; // in-flight request — stale loads are dropped
  const messageCache = new Map(); // messageId → sources[] | null

  let lastActiveElement = null; // focus restoration target (opener element)
  let historyPushed = false; // the mobile drawer owns one history entry

  const isOpen = () => !!panel && panel.classList.contains('nsrc-visible');

  // ------------------------------------------------ inline chip CSS (immediate)

  // Injected at startup — NOT gated on the panel's first open: inline
  // citation chips decorate pills as they stream in, long before any panel
  // interaction. The native pill's span.line-clamp-1 is display:-webkit-box
  // (a block) which would stack the injected favicon ABOVE the domain text;
  // nsrc-chip re-lays the button as an inline-flex row so
  // [favicon] domain +N sit side by side, inline with the sentence
  // (ChatGPT Search reference).
  const chipStyle = document.createElement('style');
  chipStyle.textContent = `
.nsrc-pill-favicon{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;flex-shrink:0}
button.nsrc-chip{display:inline-flex !important;align-items:center;gap:4px;max-width:100%;vertical-align:middle}
button.nsrc-chip>span.line-clamp-1{display:inline;-webkit-box-orient:initial;-webkit-line-clamp:unset;overflow:visible;min-width:0;flex:0 1 auto;white-space:nowrap;text-overflow:ellipsis;max-width:26ch}
button.nsrc-chip>span.line-clamp-1>span{white-space:nowrap}
  `;
  document.head.appendChild(chipStyle);

  // ------------------------------------------------------------- data access

  function fetchChat(chatId) {
    return fetch(`/api/v1/chats/${encodeURIComponent(chatId)}`, {
      headers: { Authorization: `Bearer ${localStorage.token || ''}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  /** Normalize a stored citation into the panel's display shape. */
  function normalizeSource(s, idx) {
    const url = s?.source?.url || s?.metadata?.[0]?.source || '';
    const domain = hostOf(url) || s?.source?.name || '';
    const title = s?.metadata?.[0]?.title || s?.source?.name || domain || url;
    const rawExcerpt = String(s?.metadata?.[0]?.snippet ?? s?.document?.[0] ?? '');
    // Defense for legacy citations: strip leaked markup (GTM noscript…).
    const excerpt = rawExcerpt
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // og/twitter image extracted at search time — the source-card
    // thumbnail (ChatGPT-style). Legacy chats have none: the card renders
    // without a thumbnail.
    const image = s?.metadata?.[0]?.image;
    return {
      n: idx + 1,
      url,
      domain,
      title,
      excerpt: excerpt.slice(0, 400),
      image: typeof image === 'string' && /^https?:\/\//i.test(image) ? image : '',
    };
  }

  /** Try to read the sources of `messageId` from one chat; null when absent. */
  async function sourcesFromChat(chatId, messageId) {
    const chat = await fetchChat(chatId);
    const list = chat?.chat?.history?.messages?.[messageId]?.sources;
    if (!Array.isArray(list) || !list.length) return null;
    // Deduplicate by URL — the stored array may contain repeats (the native
    // source list dedupes too, keeping the counts consistent).
    const seen = new Set();
    const out = [];
    for (const s of list) {
      const url = s?.source?.url || s?.metadata?.[0]?.source || '';
      if (url && seen.has(url)) continue;
      if (url) seen.add(url);
      out.push(normalizeSource(s, out.length));
    }
    return out.length ? out : null;
  }

  async function loadSources(messageId) {
    if (messageCache.has(messageId)) return messageCache.get(messageId);
    const load = (async () => {
      try {
        if (!localStorage.token) return [];
        const urlChatId = location.pathname.match(/^\/c\/([^/?#]+)/)?.[1];
        if (urlChatId) {
          const direct = await sourcesFromChat(urlChatId, messageId);
          if (direct) return direct;
        }
        // Temporary conversation (URL still "/") — the active chat is the
        // most recently updated one; try the top ones until the message is
        // found.
        const res = await fetch('/api/v1/chats/?page=1', {
          headers: { Authorization: `Bearer ${localStorage.token}` },
        });
        if (!res.ok) return [];
        const list = await res.json();
        if (!Array.isArray(list)) return [];
        for (const c of list.slice(0, 3)) {
          const found = await sourcesFromChat(c.id, messageId);
          if (found) return found;
        }
        return [];
      } catch {
        return [];
      }
    })();
    messageCache.set(messageId, load);
    return load;
  }

  // ------------------------------------------------------------------ build

  function buildPanel() {
    if (panel) return;

    // Mobile scrim — sits between the app and the drawer: dims the
    // conversation, blocks accidental interaction and closes on tap.
    // Display:none ≥768px (docked region needs no scrim).
    backdrop = document.createElement('div');
    backdrop.className = 'nsrc-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', () => closePanel());
    document.body.appendChild(backdrop);

    panel = document.createElement('aside');
    panel.className = 'nsrc-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Sources');
    panel.innerHTML = `
      <div class="nsrc-head">
        <div class="nsrc-title">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><path d="M2 12h20"/></svg>
          <span>Sources</span>
          <span class="nsrc-count"></span>
        </div>
        <button class="nsrc-close" type="button" aria-label="Fermer les sources">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <div class="nsrc-body" role="list"></div>`;

    panel.querySelector('.nsrc-close').addEventListener('click', closePanel);
    document.body.appendChild(panel);

    // Layout + component styles. Width is a CSS custom property so the
    // docked region, the app-shell margin and the breakpoint logic all read
    // ONE responsive source of truth:
    //   ≥768px  : docked, min(410px, 48vw)  — tablet-adapted, never starves
    //                                        the conversation
    //   ≥1280px : clamp(380px, 30vw, 440px) — ChatGPT-like desktop width
    //   <768px  : full-screen drawer with backdrop, dvh height and safe
    //             areas (viewport-fit=cover is set in index.html).
    //
    // Card design follows the current ChatGPT sources panel: a tinted panel
    // background with white/dark rounded cards, each card carrying the
    // page's og:image thumbnail, a favicon+domain row, a prominent title
    // and a two-line excerpt. The citation number rides as a small badge
    // overlaid on the thumbnail (inline when there is no image). The
    // selected-source highlight is neutral (ChatGPT uses no accent color).
    const style = document.createElement('style');
    style.textContent = `
:root{--nsrc-w:min(410px,48vw)}
@media (min-width:1280px){:root{--nsrc-w:clamp(380px,30vw,440px)}}

/* Mobile scrim */
.nsrc-backdrop{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .25s ease}
.nsrc-backdrop.nsrc-b-visible{opacity:1;pointer-events:auto}
@media (min-width:768px){.nsrc-backdrop{display:none}}

/* Panel — docked region ≥768px, full drawer <768px. The closing state
   delays the visibility change by the transition duration so the
   slide-out is actually visible (no instant disappear). Tinted background
   (#f9f9f9 light / #212121 dark) so the source cards read as cards. */
.nsrc-panel{position:fixed;top:0;right:0;z-index:70;width:var(--nsrc-w);max-width:100%;height:100vh;height:100dvh;display:flex;flex-direction:column;background:#f9f9f9;color:#0d0d0d;border-left:1px solid #e5e5e5;box-shadow:-12px 0 40px rgba(0,0,0,.08);transform:translateX(100%);visibility:hidden;transition:transform .28s cubic-bezier(.32,.72,0,1),visibility 0s .28s}
.nsrc-panel.nsrc-visible{transform:translateX(0);visibility:visible;transition:transform .28s cubic-bezier(.32,.72,0,1),visibility 0s}
.dark .nsrc-panel{background:#212121;color:#ececec;border-left:1px solid rgba(255,255,255,.09);box-shadow:-12px 0 40px rgba(0,0,0,.35)}

/* Layout integration: the app's own layout root (#chat-container, which
   already carries Open WebUI's width transition) makes room for the docked
   panel on desktop/tablet; mobile keeps the full-screen overlay instead.
   Both animate with the same curve/duration as the panel slide. */
#chat-container{transition:margin-right .28s cubic-bezier(.32,.72,0,1),width .2s ease}
@media (min-width:768px){
  body.nsrc-open #chat-container{margin-right:var(--nsrc-w)}
}

/* Head — stable while the list scrolls; safe-area aware on mobile. */
.nsrc-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px 12px;border-bottom:1px solid #e7e7e7;flex-shrink:0}
.dark .nsrc-head{border-bottom:1px solid rgba(255,255,255,.08)}
.nsrc-title{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:600}
.nsrc-count{font-size:12px;font-weight:500;color:#5f5f5f;background:#e5e5e5;border-radius:9999px;padding:1px 8px}
.dark .nsrc-count{background:rgba(255,255,255,.1);color:#b4b4b4}
.nsrc-close{width:32px;height:32px;flex-shrink:0;border-radius:9999px;display:grid;place-items:center;color:inherit;opacity:.7;cursor:pointer;transition:background .15s ease,opacity .15s ease}
.nsrc-close:hover{background:rgba(0,0,0,.06);opacity:1}
.dark .nsrc-close:hover{background:rgba(255,255,255,.09)}

/* Body — independent vertical scroll, contained overscroll (no page
   scroll chaining on Android), safe-area aware bottom padding. */
.nsrc-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:12px 14px 16px;scrollbar-width:thin}

/* Source cards — ChatGPT-style link cards: white (light) / #2b2b2b (dark)
   rounded rectangles on the tinted panel, separated by 10px gaps. Each
   card: optional og:image thumbnail, favicon+domain row, title, excerpt. */
.nsrc-row{display:block;padding:10px;border-radius:14px;text-decoration:none;color:inherit;background:#ffffff;border:1px solid #ebebeb;transition:background .12s ease,border-color .12s ease}
.nsrc-row + .nsrc-row{margin-top:10px}
.nsrc-row:hover{background:#f4f4f4;border-color:#e0e0e0}
.dark .nsrc-row{background:#2b2b2b;border-color:rgba(255,255,255,.06)}
.dark .nsrc-row:hover{background:#323232;border-color:rgba(255,255,255,.1)}

/* Selected source (inline citation click) — neutral highlight, no accent
   color (ChatGPT selection is a subtle darker tint + hairline ring). */
.nsrc-row.nsrc-highlight{background:#f0f0f0;border-color:#dedede;box-shadow:inset 0 0 0 1px #dedede}
.dark .nsrc-row.nsrc-highlight{background:#303030;border-color:#3f3f3f;box-shadow:inset 0 0 0 1px #3f3f3f}

/* Thumbnail — og:image of the page, 1.91:1 (social card ratio), covered. */
.nsrc-thumb-wrap{position:relative;margin-bottom:10px}
.nsrc-thumb{display:block;width:100%;aspect-ratio:1.91/1;max-height:170px;object-fit:cover;border-radius:10px;background:#ececec}
.dark .nsrc-thumb{background:#242424}

/* Citation number — small badge overlaid on the thumbnail (ChatGPT cards
   carry no numbers; the badge stays subtle to preserve the [N] mapping).
   Without a thumbnail it sits inline in the domain row. */
.nsrc-badge{position:absolute;top:8px;left:8px;min-width:22px;height:22px;padding:0 6px;border-radius:7px;display:grid;place-items:center;font-size:11px;font-weight:600;color:#ffffff;background:rgba(0,0,0,.62);backdrop-filter:blur(4px)}
.nsrc-badge-inline{position:static;background:#ececec;color:#5f5f5f;flex-shrink:0}
.dark .nsrc-badge-inline{background:rgba(255,255,255,.1);color:#b4b4b4}
.nsrc-row.nsrc-highlight .nsrc-badge-inline{background:#dedede;color:#4a4a4a}
.dark .nsrc-row.nsrc-highlight .nsrc-badge-inline{background:#3f3f3f;color:#ffffff}

.nsrc-src-head{display:flex;align-items:center;gap:6px;min-width:0}
.nsrc-favicon{width:13px;height:13px;border-radius:3px;flex-shrink:0}
.nsrc-domain{font-size:12px;font-weight:500;color:#6b6b6b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dark .nsrc-domain{color:#a6a6a6}
.nsrc-title-txt{font-size:15px;font-weight:500;line-height:1.35;margin-top:6px;color:#0d0d0d;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dark .nsrc-title-txt{color:#ececec}
.nsrc-excerpt{font-size:13px;line-height:1.5;color:#6b6b6b;margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dark .nsrc-excerpt{color:#9b9b9b}
.nsrc-empty{padding:32px 20px;text-align:center;font-size:13px;color:#8f8f8f}

/* Mobile / Android drawer */
@media (max-width:767px){
  .nsrc-panel{width:100%;border-left:none;box-shadow:0 0 60px rgba(0,0,0,.32)}
  .nsrc-head{padding-top:calc(14px + env(safe-area-inset-top));padding-right:calc(12px + env(safe-area-inset-right));padding-left:calc(20px + env(safe-area-inset-left))}
  .nsrc-body{padding:12px 12px calc(16px + env(safe-area-inset-bottom))}
  .nsrc-row{padding:12px}
  .nsrc-thumb{max-height:180px}
}

/* Body scroll lock while the mobile drawer is open — scroll position is
   preserved (only overflow is clipped). */
html.nsrc-lock{overflow:hidden}

/* Reduced motion: no slide, no scrim fade, no margin transition. */
@media (prefers-reduced-motion:reduce){
  .nsrc-panel,.nsrc-backdrop,#chat-container{transition:none !important}
}
    `;
    document.head.appendChild(style);
  }

  function faviconFor(domain) {
    // Same-origin proxy (backend /api/v1/utils/favicon) — the images ride the
    // same gateway as every other asset, so favicons render on any client
    // network (a direct third-party icon URL silently fails when that host
    // is blocked, making the pills lose their icons).
    return `/api/v1/utils/favicon?domain=${encodeURIComponent(domain)}`;
  }

  function renderRows(sources) {
    const body = panel.querySelector('.nsrc-body');
    panel.querySelector('.nsrc-count').textContent = sources.length ? String(sources.length) : '';
    if (!sources.length) {
      body.innerHTML = '<div class="nsrc-empty">Aucune source disponible pour ce message.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of sources) {
      // ChatGPT-style link card: optional og:image thumbnail, favicon +
      // domain row, prominent title, two-line excerpt. The whole card is
      // the link — no raw URL line (the domain row carries the origin).
      const a = document.createElement('a');
      a.className = 'nsrc-row';
      a.setAttribute('role', 'listitem');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      a.dataset.n = String(s.n);
      a.dataset.domain = s.domain;

      let badgeInline = true;
      if (s.image) {
        const wrap = document.createElement('div');
        wrap.className = 'nsrc-thumb-wrap';
        const thumb = document.createElement('img');
        thumb.className = 'nsrc-thumb';
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.decoding = 'async';
        thumb.referrerPolicy = 'no-referrer';
        // Unreachable image → the wrapper disappears, the card stays clean.
        thumb.onerror = () => wrap.remove();
        thumb.src = s.image;
        const badge = document.createElement('span');
        badge.className = 'nsrc-badge';
        badge.textContent = String(s.n);
        wrap.append(thumb, badge);
        a.appendChild(wrap);
        badgeInline = false;
      }

      const head = document.createElement('div');
      head.className = 'nsrc-src-head';
      if (badgeInline) {
        const badge = document.createElement('span');
        badge.className = 'nsrc-badge nsrc-badge-inline';
        badge.textContent = String(s.n);
        head.appendChild(badge);
      }
      const favicon = document.createElement('img');
      favicon.className = 'nsrc-favicon';
      favicon.alt = '';
      favicon.width = 13;
      favicon.height = 13;
      favicon.loading = 'lazy';
      favicon.onerror = () => {
        favicon.style.visibility = 'hidden';
      };
      favicon.src = faviconFor(s.domain);
      const domain = document.createElement('span');
      domain.className = 'nsrc-domain';
      domain.textContent = s.domain;
      head.append(favicon, domain);

      const title = document.createElement('div');
      title.className = 'nsrc-title-txt';
      title.textContent = s.title;

      const excerpt = document.createElement('div');
      excerpt.className = 'nsrc-excerpt';
      excerpt.textContent = s.excerpt;

      a.append(head, title, excerpt);
      frag.appendChild(a);
    }
    body.innerHTML = '';
    body.appendChild(frag);
  }

  function highlightSource(match) {
    if (!match || !panel) return;
    const rows = [...panel.querySelectorAll('.nsrc-row')];
    const row =
      rows.find((r) => (match.url && r.href === match.url) || (match.domain && r.dataset.domain === match.domain)) ||
      (match.n ? rows.find((r) => Number(r.dataset.n) === match.n) : null);
    if (!row) return;
    rows.forEach((r) => r.classList.remove('nsrc-highlight'));
    row.classList.add('nsrc-highlight');
    row.scrollIntoView({
      block: 'center',
      behavior: reduceMotionMq.matches ? 'auto' : 'smooth',
    });
  }

  // ------------------------------------------------------------- open/close

  /** Overlay (mobile) vs docked (desktop) semantics for the live panel. */
  function applyMode() {
    if (!panel) return;
    if (isOverlay()) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
    } else {
      panel.setAttribute('role', 'complementary');
      panel.removeAttribute('aria-modal');
    }
  }

  /** Central open path: visibility, scrim, lock, history entry, focus. */
  function showPanel() {
    buildPanel();
    const wasOpen = isOpen();
    if (!wasOpen) {
      lastActiveElement =
        document.activeElement instanceof Element ? document.activeElement : null;
    }
    document.body.classList.add('nsrc-open');
    panel.classList.add('nsrc-visible');
    if (isOverlay()) {
      backdrop.classList.add('nsrc-b-visible');
      document.documentElement.classList.add('nsrc-lock');
      if (!historyPushed) {
        // The drawer owns one history entry — Android back closes it
        // instead of leaving the conversation.
        historyPushed = true;
        history.pushState({ nsrc: true }, '', location.href);
      }
    }
    applyMode();
    if (!wasOpen && isOverlay()) {
      // Keyboard/touch users land on a visible control inside the dialog.
      panel.querySelector('.nsrc-close').focus({ preventScroll: true });
    }
  }

  /** Central close path — also restores focus and the history entry. */
  function hidePanel() {
    if (!panel) return;
    panel.classList.remove('nsrc-visible');
    backdrop.classList.remove('nsrc-b-visible');
    document.body.classList.remove('nsrc-open');
    document.documentElement.classList.remove('nsrc-lock');
    if (historyPushed) {
      historyPushed = false;
      history.back(); // popstate listener is a no-op (flag already cleared)
    }
    [...panel.querySelectorAll('.nsrc-row')].forEach((r) => r.classList.remove('nsrc-highlight'));
    if (lastActiveElement && lastActiveElement.isConnected) {
      lastActiveElement.focus({ preventScroll: true });
    }
    lastActiveElement = null;
  }

  const closePanel = hidePanel;

  function openPanel(sources, highlight) {
    buildPanel();
    pendingMessageId = null;
    state = { messageId: null, sources };
    renderRows(sources);
    showPanel();
    requestAnimationFrame(() => highlightSource(highlight));
  }

  async function openForMessage(messageId, highlight) {
    buildPanel();
    // Same message already displayed → update the highlight in place:
    // no re-render, no scroll reset, no favicon re-fetch (the panel stays
    // visually stable while the user browses its citations).
    const sameMessage = state.messageId === messageId && state.sources.length > 0;
    pendingMessageId = messageId;
    showPanel();
    if (!sameMessage) {
      if (!messageCache.has(messageId)) {
        const body = panel.querySelector('.nsrc-body');
        body.innerHTML = '<div class="nsrc-empty">Chargement des sources…</div>';
        panel.querySelector('.nsrc-count').textContent = '';
      }
      const sources = await loadSources(messageId);
      // A newer open request superseded this one — drop the stale load.
      if (pendingMessageId !== messageId) return;
      state = { messageId, sources };
      renderRows(sources);
    }
    requestAnimationFrame(() => highlightSource(highlight));
  }

  // --------------------------------------------------- message id resolution

  function messageIdFrom(el) {
    const container = el?.closest?.('[id^="message-"]');
    if (!container) return null;
    return container.id.slice('message-'.length) || null;
  }

  // --------------------------------------------------- inline badge favicon

  /**
   * The native citation pills (compiled tokenizer) are text-only; the
   * ChatGPT Search reference shows favicon + domain (+N). This injects a
   * small favicon image in front of every rendered pill's label and turns
   * the pill into a proper inline-flex chip:
   *
   *   [favicon] domain.com +2
   *
   * The native span carries line-clamp-1 (display:-webkit-box — a BLOCK),
   * which stacks the injected favicon ABOVE the domain text. The nsrc-chip
   * class re-lays the button out as an inline-flex row so the favicon, the
   * domain and the native +N counter sit side by side, inline with the
   * sentence — exactly like the ChatGPT reference.
   */
  function decoratePill(btn) {
    if (btn.querySelector('img.nsrc-pill-favicon')) return;
    const span = btn.querySelector('span.line-clamp-1');
    if (!span) return;
    const domain = (span.textContent ?? '')
      .replace(/\s*\+\d+\s*$/, '')
      .replace(/\.{3}.*$/, '')
      .trim();
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}/i.test(domain)) return;
    btn.classList.add('nsrc-chip');
    const img = document.createElement('img');
    img.className = 'nsrc-pill-favicon';
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    img.src = faviconFor(domain);
    btn.insertBefore(img, span);
  }

  function scanForPills() {
    const pills = document.querySelectorAll('button[class*="text-[0.625rem]"][aria-label]');
    for (const btn of pills) {
      const label = btn.getAttribute('aria-label') ?? '';
      if (/source/i.test(label) || /more sources/i.test(label)) decoratePill(btn);
    }
  }

  let pillScanScheduled = false;
  const schedulePillScan = () => {
    if (pillScanScheduled) return;
    pillScanScheduled = true;
    requestAnimationFrame(() => {
      pillScanScheduled = false;
      scanForPills();
    });
  };

  // ------------------------------------------------------- click interception

  document.addEventListener(
    'click',
    (e) => {
      if (!(e.target instanceof Element)) return;

      // 1 — Source card in the native sources list (button[id^="source-{msg}-{n}"]).
      const card = e.target.closest('button[id^="source-"]');
      if (card) {
        const idMatch = card.id.match(/^source-(.+)-(\d+)$/);
        if (idMatch) {
          let url = '';
          const aria = card.getAttribute('aria-label') ?? '';
          const ariaMatch = aria.match(/(?:^|\s)(https?:\/\/\S+)$/i);
          if (ariaMatch) url = ariaMatch[1];
          if (!url) {
            const inner = [...card.querySelectorAll('div')]
              .map((d) => d.textContent.trim())
              .find((t) => /^https?:\/\//i.test(t));
            url = inner || '';
          }
          if (url) {
            e.preventDefault();
            e.stopImmediatePropagation();
            openForMessage(idMatch[1], { url, n: parseInt(idMatch[2], 10) });
            return;
          }
        }
      }

      // 2 — Inline citation badge (native tokenizer pill, [N] markers).
      //     aria-label: "View source: {domain}" (or the locale equivalent);
      //     the inner span carries the visible domain text.
      const pill = e.target.closest('button[aria-label]');
      if (pill && !pill.id.startsWith('source-')) {
        const label = pill.getAttribute('aria-label') ?? '';
        const hasSource = /source/i.test(label);
        const isSingle = hasSource && /:\s*[^:]+$/.test(label);
        const isMulti = /more sources/i.test(label) || (/source/i.test(label) && /\+\d+/.test(label));
        if (isSingle || isMulti) {
          const messageId = messageIdFrom(pill);
          if (messageId) {
            const span = pill.querySelector('span.line-clamp-1');
            const domain = (span ? span.textContent : '')
              .replace(/\s*\+\d+\s*$/, '')
              .replace(/\.{3}.*$/, '')
              .trim();
            e.preventDefault();
            e.stopImmediatePropagation();
            openForMessage(messageId, { domain });
            return;
          }
        }
      }

      // 3 — "N Sources" pill under the response → open the panel with every
      //     source of that message (replaces the native expanding list).
      const btn = e.target.closest('button');
      if (btn) {
        const text = (btn.textContent ?? '').trim();
        const m = text.match(/^(\+\d+\s*)?(\d+)\s+Sources$/i);
        if (m) {
          const messageId = messageIdFrom(btn);
          if (messageId) {
            e.preventDefault();
            e.stopImmediatePropagation();
            openForMessage(messageId, null);
          }
        }
      }
    },
    true
  );

  // -------------------------------------------------- keyboard + history + mq

  // Escape closes (desktop + mobile); Tab is trapped inside the drawer
  // while it is a modal (overlay mode) so keyboard focus cannot leak into
  // the dimmed conversation behind the scrim.
  document.addEventListener('keydown', (e) => {
    if (!panel || !isOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
      return;
    }
    if (e.key === 'Tab' && isOverlay()) {
      const focusables = [...panel.querySelectorAll('a[href], button:not([disabled])')].filter(
        (el) => el.offsetParent !== null
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // Android back button (and any popstate) closes the drawer instead of
  // leaving the conversation. The history entry was pushed on open.
  window.addEventListener('popstate', () => {
    if (historyPushed) {
      historyPushed = false;
      hidePanel();
    }
  });

  // Viewport crossing while the panel is open (rotation, window resize):
  // swap drawer ↔ docked semantics without closing.
  const onModeChange = () => {
    if (!panel || !isOpen()) return;
    if (isOverlay()) {
      backdrop.classList.add('nsrc-b-visible');
      document.documentElement.classList.add('nsrc-lock');
      if (!historyPushed) {
        historyPushed = true;
        history.pushState({ nsrc: true }, '', location.href);
      }
    } else {
      backdrop.classList.remove('nsrc-b-visible');
      document.documentElement.classList.remove('nsrc-lock');
      if (historyPushed) {
        historyPushed = false;
        history.back();
      }
    }
    applyMode();
  };
  if (typeof overlayMq.addEventListener === 'function') {
    overlayMq.addEventListener('change', onModeChange);
  } else if (typeof overlayMq.addListener === 'function') {
    overlayMq.addListener(onModeChange); // legacy Safari
  }

  // Pill favicons keep up with streaming / navigation renders.
  const observer = new MutationObserver(schedulePillScan);
  const startObserving = () => {
    observer.observe(document.body, { childList: true, subtree: true });
    scanForPills();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving);
  } else {
    startObserving();
  }
})();

/* ====================================================================
 * SERVERLESS REALTIME BRIDGE — socket.io event flow over HTTP SSE.
 *
 * Why: the compiled Open WebUI frontend v0.12.5 streams chat completions
 * through socket.io events (`session_id = $socket?.id`); its HTTP helper
 * parses the response as JSON. When no socket service exists (Vercel and
 * other serverless hosts) the socket never connects, `session_id` is
 * omitted, and the backend legitimately answers with SSE — which the JSON
 * helper cannot parse → “Unexpected token 'd', "data: {"id"…".
 *
 * Fix, entirely in this layer (compiled frontend untouched):
 *   • Fake engine.io server (XMLHttpRequest interception of /ws/socket.io):
 *     the real handshake gets one chance; when it fails (502…), every
 *     subsequent socket.io request is answered locally with a valid
 *     engine.io v4 / socket.io v5 polling session. The compiled client
 *     believes it is connected and dispatches server-pushed `42["events",
 *     …]` packets to the app's registered handlers.
 *   • Chat completions POST patch: when the payload has no `session_id`
 *     (socket not connected), inject one plus `__sse_events` — the backend
 *     then runs the exact socket-mode completion flow but serializes every
 *     event envelope into the HTTP response as SSE lines. Each line is fed
 *     back through the fake socket as an `events` message, and the fetch
 *     promise resolves with the same `null` JSON the real socket mode
 *     returns. Streaming, statuses, sources, titles and the done event all
 *   • flow exactly like on a socket-capable host. The sandbox (real socket
 *     service answering 200) is completely unaffected — native everywhere.
 * ==================================================================== */
(() => {
  'use strict';
  if (window.__NELTH_SSE_BRIDGE__) return;
  window.__NELTH_SSE_BRIDGE__ = true;

  const SOCKET_RE = /\/ws\/socket\.io\//;
  // Minimal ops probe: window.__NELTH_BRIDGE__() → live bridge counters.
  window.__NELTH_BRIDGE__ = () => ({
    engaged,
    sid,
    queued: queue.length,
    waiting: waiters.length,
    delivered: debugDelivered,
  });
  let debugDelivered = 0;
  const CHAT_RE = /\/api\/chat\/completions\/?(\?.*)?$/;

  let engaged = false; // fake socket active (real one proved unreachable)
  let handshakeFailures = 0; // consecutive failed native handshakes
  let sid = null; // engine.io session id handed to the client
  const queue = []; // server → client packets (concatenated per poll)
  const waiters = []; // pending GET polls: { xhr, resolve }

  const rand = () => Math.random().toString(36).slice(2, 10);
  const nowSid = () => 'nelth-' + rand() + rand();

  const deliver = () => {
    while (queue.length && waiters.length) {
      // engine.io v4 polling payload: packets joined by the record
      // separator \x1e (charCode 30) — exactly what the compiled client
      // splits on when decoding a poll response.
      const packets = queue.join('\x1e');
      queue.length = 0;
      waiters.shift().resolve(packets);
    }
  };
  const pushPacket = (p) => {
    queue.push(p);
    deliver();
  };
  /** Push one socket.io `events` message (the only kind the app consumes). */
  const pushEvent = (envelope) => {
    debugDelivered++;
    pushPacket('42' + JSON.stringify(['events', envelope]));
  };

  const engage = () => {
    if (engaged) return;
    engaged = true;
    // engine.io v4 server heartbeat — the client pongs via POST.
    setInterval(() => pushPacket('2'), 20000);
  };

  // ------------------------------------------------ fake XHR completion
  const finishXhr = (xhr, status, text) => {
    try {
      Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(xhr, 'status', { value: status, configurable: true });
      Object.defineProperty(xhr, 'responseText', { value: text, configurable: true });
      Object.defineProperty(xhr, 'response', { value: text, configurable: true });
      xhr.getAllResponseHeaders = () => 'Content-Type: text/plain; charset=UTF-8\r\n';
      xhr.getResponseHeader = (name) =>
        String(name).toLowerCase() === 'content-type' ? 'text/plain; charset=UTF-8' : null;
      const fn = xhr.onreadystatechange;
      if (typeof fn === 'function') fn.call(xhr, { type: 'readystatechange' });
    } catch (e) {
      /* the app may have nulled its handler — fine */
    }
  };

  // ------------------------------------------ engine.io protocol handling
  const handleFake = (xhr, method, url, body) => {
    if (method === 'GET') {
      if (!sid) {
        // Handshake: engine.io open packet (no upgrades → polling only).
        sid = nowSid();
        finishXhr(xhr, 200, '0' + JSON.stringify({
          sid,
          upgrades: [],
          pingInterval: 25000,
          pingTimeout: 20000,
          maxPayload: 1000000,
        }));
        return;
      }
      // Long poll — resolved when packets are pushed (or by a ping).
      new Promise((resolve) => {
        waiters.push({ xhr, resolve });
      }).then((packets) => finishXhr(xhr, 200, packets));
      deliver();
      return;
    }
    if (method === 'POST') {
      const text = typeof body === 'string' ? body : '';
      if (text === '40' || text.startsWith('40')) {
        // socket.io CONNECT (default namespace, optional auth JSON) — the
        // connect ack is delivered through the next poll, like the real one.
        pushPacket('40' + JSON.stringify({ sid }));
      } else if (/^42(\d+)-/.test(text)) {
        // Client event expecting an ack (user-join, heartbeat…) → ACK.
        const ackId = text.match(/^42(\d+)-/)[1];
        pushPacket('43' + ackId + '[{"status":true}]');
      }
      // '2' pongs and plain events need no server response beyond ok.
      finishXhr(xhr, 200, 'ok');
      return;
    }
    finishXhr(xhr, 400, '');
  };

  // ------------------------------------- XMLHttpRequest interception
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeAbort = XMLHttpRequest.prototype.abort;

  XMLHttpRequest.prototype.open = function (method, url) {
    const isSocket = SOCKET_RE.test(String(url));
    this.__nelth = isSocket
      ? { method: String(method || 'GET').toUpperCase(), url: String(url) }
      : null;
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const fake = this.__nelth;
    if (!fake) return nativeSend.call(this, body);

    if (engaged) {
      Promise.resolve().then(() => handleFake(this, fake.method, fake.url, body));
      return;
    }

    // Not engaged — the real service answered the handshake. Requests WITH
    // a session id are that connection's normal long-polls: pass through
    // natively (engaging here would hijack a healthy connection). Only a
    // fresh handshake (no sid — a reconnect attempt) gets failure-watched:
    // two consecutive failures mean the service is truly unreachable.
    const isHandshake = fake.method === 'GET' && !/[?&]sid=/.test(fake.url);
    if (!isHandshake) {
      return nativeSend.call(this, body);
    }

    const xhr = this;
    const check = () => {
      try {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200 || xhr.status === 1223) {
          handshakeFailures = 0;
          return;
        }
      } catch (e) {
        /* status unreadable — treat as failure */
      }
      if (++handshakeFailures >= 2) engage();
    };
    const origRSC = xhr.onreadystatechange;
    xhr.onreadystatechange = function () {
      check();
      if (typeof origRSC === 'function') origRSC.apply(this, arguments);
    };
    nativeSend.call(this, body);
  };

  XMLHttpRequest.prototype.abort = function () {
    const fake = this.__nelth;
    if (fake && engaged) {
      // Release any poll this xhr is holding (engine.io noop packet).
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].xhr === this) {
          waiters.splice(i, 1)[0].resolve('6');
          break;
        }
      }
      return;
    }
    return nativeAbort.apply(this, arguments);
  };

  // ------------------------------------------------ chat completions patch
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isChatPost =
      CHAT_RE.test(url) && !!init && String(init.method || '').toUpperCase() === 'POST';
    if (!isChatPost) return nativeFetch(input, init);

    let bodyObj = null;
    try {
      bodyObj = JSON.parse(String(init.body));
    } catch (e) {
      bodyObj = null;
    }

    // Socket-mode passthrough: a REAL socket service answered the handshake
    // (bridge not engaged) AND the socket is connected (session_id present)
    // — everything works natively (sandbox / self-hosted topology).
    const useSseTransport =
      engaged || !bodyObj || typeof bodyObj !== 'object' || !bodyObj.session_id;
    if (!useSseTransport) {
      return nativeFetch(input, init);
    }

    // Serverless mode — one of:
    //   • the real socket service is unreachable (engaged) — any session_id
    //     in the payload is our fake one, the backend socket hop is dead;
    //   • the socket is not connected yet (no session_id) — the backend
    //     would answer with raw SSE the JSON helper cannot parse.
    // Either way: ensure a session id + the SSE event transport flag — the
    // backend then runs the full socket-mode flow (statuses, deltas,
    // sources, titles, done) serialized into the HTTP response.
    engage();
    if (!bodyObj || typeof bodyObj !== 'object') {
      return nativeFetch(input, init); // not a JSON body — untouched
    }
    if (!bodyObj.session_id) bodyObj.session_id = 'nelth-sse-' + rand();
    bodyObj.__sse_events = true;
    const patchedInit = Object.assign({}, init, { body: JSON.stringify(bodyObj) });

    return nativeFetch(input, patchedInit).then(async (res) => {
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('text/event-stream')) return res; // JSON error path

      const chatId = bodyObj.chat_id || null;
      const messageId = bodyObj.id || null;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const env = JSON.parse(payload);
              if (env && typeof env === 'object' && env.data && env.data.type) {
                pushEvent(env); // full socket-event envelope from the backend
              }
            } catch (e) {
              /* skip malformed line */
            }
          }
        }
      } catch (e) {
        /* client aborted — the app's own abort flow takes over */
      }

      // The socket-mode HTTP response is `null` JSON — mirror it exactly so
      // the compiled helper's res.json() succeeds.
      return new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  };
})();

/* ====================================================================
 * THINKING BLOCK AUTO-OPEN — show the model's chain-of-thought while it
 * streams.
 *
 * Why: the compiled frontend renders reasoning / tool-execution detail
 * blocks COLLAPSED unless the user enabled the "expandDetails" setting
 * (default off). With the backend's paced reasoning reveal (the gateway
 * delivers the whole chain-of-thought in one burst; the backend re-emits it
 * progressively o1-style), a collapsed block would still hide the thinking
 * text behind a bare "Thinking…" line for the whole generation.
 *
 * Fix, entirely in this layer (compiled frontend untouched): while an
 * item is in_progress its header button carries a `shimmer` descendant and
 * an aria-expanded state — simulate ONE click on any still-collapsed
 * shimmering header (exactly what a manual click does) so the block opens
 * the moment the thinking phase starts. Completed blocks (no shimmer) are
 * never touched; the user remains free to collapse it again by hand.
 * ==================================================================== */
(() => {
  'use strict';
  if (window.__NELTH_THINKING_OPEN__) return;
  window.__NELTH_THINKING_OPEN__ = true;

  const OPENED_FLAG = 'nelthAutoOpen';

  const scanAndOpen = () => {
    let buttons;
    try {
      buttons = document.querySelectorAll('button[aria-expanded="false"]');
    } catch (e) {
      return;
    }
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (btn.dataset[OPENED_FLAG]) continue;
      let shimmer = null;
      try {
        shimmer = btn.querySelector('.shimmer');
      } catch (e) {
        continue;
      }
      if (!shimmer) continue;
      btn.dataset[OPENED_FLAG] = '1';
      try {
        btn.click();
      } catch (e) {
        /* header not clickable yet — retried on the next scan */
        delete btn.dataset[OPENED_FLAG];
      }
    }
  };

  // Debounced observer — the chat DOM mutates heavily while streaming; a
  // 250ms coalescing window keeps the scan cost negligible.
  let scanPending = false;
  const scheduleScan = () => {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => {
      scanPending = false;
      scanAndOpen();
    }, 250);
  };

  const start = () => {
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.body, { childList: true, subtree: true });
    scanAndOpen();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

/* ====================================================================
 * AI IMAGE GENERATION CARD — the scintillating-grid card that replaces
 * the 'Generating image…' shimmer status text.
 *
 * The Nelthai metaai engine (lib/imagine/nelthai.ts) drives image jobs
 * through three live phases — sending → generating → image — surfaced as
 * status rows by the compiled frontend. This layer swaps that text row
 * for the generation card:
 *
 *   • a canvas of 4px squares scintillating on desynchronized sine waves
 *     (grid dissolve → reveal when the image lands),
 *   • a live phase label (the job's 'sending' | 'generating' | 'image')
 *     plus a seconds counter — the ARRIVAL of the image stops it,
 *   • the reveal choreography: grid blurs out (scale 1.08, blur 14px),
 *     image fades in from blur(20px), a diagonal light sweep, a brief
 *     white flash, footer flips to 'Generated' + final duration,
 *   • the card then stays as the image display (click → native lightbox
 *     through the hidden original image button).
 *
 * Works with both event transports (native socket.io and the SSE bridge
 * above): it watches the DOM, not the events.
 * ==================================================================== */
(() => {
  'use strict';
  if (window.__NELTH_IMG_CARD__) return;
  window.__NELTH_IMG_CARD__ = true;

  const IMG_STATUS_RE = /^Generating image/i;
  const PHASE_RE = /Generating image\s*[·—–-]\s*([a-z]+)/i;
  const FILE_IMG_RE = /\/api\/v1\/files\//;
  const reduceMotionMq = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  // ------------------------------------------------------------- styles
  if (!document.getElementById('nelth-imgc-style')) {
    const style = document.createElement('style');
    style.id = 'nelth-imgc-style';
    style.textContent = [
      /* card shell — square placeholder while generating; at the reveal it
         takes the image's NATURAL aspect ratio (ChatGPT-style, no forced crop) */
      '.nelth-imgc{position:relative;width:min(100%,384px);aspect-ratio:1/1;border-radius:1rem;',
      'overflow:hidden;background:#fff;border:1px solid #e5e5e5;',
      'transition:border-color .3s ease,width .55s cubic-bezier(.22,1,.36,1),',
      'aspect-ratio .55s cubic-bezier(.22,1,.36,1);isolation:isolate;cursor:default}',
      'html.dark .nelth-imgc{background:#171717;border-color:#262626}',

      /* scintillating grid (canvas) — dissolves at the reveal */
      '.nelth-imgc-grid{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'transition:opacity 1s cubic-bezier(.22,1,.36,1),transform 1s cubic-bezier(.22,1,.36,1),',
      'filter 1s cubic-bezier(.22,1,.36,1)}',
      '.nelth-imgc-grid canvas{width:100%;height:100%;display:block}',
      '.nelth-imgc.nelth-imgc-done .nelth-imgc-grid{opacity:0;transform:scale(1.08);',
      'filter:blur(14px);pointer-events:none}',

      /* revealed image — fade-in from blur + diagonal light sweep */
      '.nelth-imgc-photo{position:absolute;inset:0;opacity:0;filter:blur(20px);',
      'transition:opacity .9s cubic-bezier(.22,1,.36,1),filter .9s cubic-bezier(.22,1,.36,1)}',
      '.nelth-imgc.nelth-imgc-done .nelth-imgc-photo{opacity:1;filter:blur(0)}',
      '.nelth-imgc-photo img{width:100%;height:100%;object-fit:cover;display:block}',
      '.nelth-imgc-sweep{position:absolute;inset:0;overflow:hidden;pointer-events:none}',
      '.nelth-imgc-sweep-bar{position:absolute;top:0;bottom:0;left:0;width:33.333%;',
      'background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);',
      'transform:translateX(-115%) skewX(-12deg)}',
      '.nelth-imgc.nelth-imgc-done .nelth-imgc-sweep-bar{',
      'animation:nelth-imgc-sweep 1.1s cubic-bezier(.65,0,.35,1) .3s 1 both}',
      '@keyframes nelth-imgc-sweep{from{transform:translateX(-115%) skewX(-12deg)}',
      'to{transform:translateX(345%) skewX(-12deg)}}',

      /* brief white flash at the reveal */
      '.nelth-imgc-flash{position:absolute;inset:0;pointer-events:none;background:#fff;opacity:0}',
      '.nelth-imgc.nelth-imgc-done .nelth-imgc-flash{',
      'animation:nelth-imgc-flash .7s ease-out .05s 1 both}',
      '@keyframes nelth-imgc-flash{0%{opacity:0}25%{opacity:.18}100%{opacity:0}}',

      /* footer — gradient-masked, label + seconds */
      '.nelth-imgc-footer{position:absolute;left:0;right:0;bottom:0;height:96px;',
      'background:rgba(255,255,255,.4);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);',
      '-webkit-mask-image:linear-gradient(to top,black 0%,transparent 100%);',
      'mask-image:linear-gradient(to top,black 0%,transparent 100%);pointer-events:none}',
      'html.dark .nelth-imgc-footer{background:rgba(0,0,0,.5)}',
      '.nelth-imgc-row{position:absolute;bottom:12px;left:20px;right:20px;display:flex;',
      'align-items:center;justify-content:space-between;gap:8px}',
      '.nelth-imgc-label,.nelth-imgc-seconds{font-size:.875rem;font-weight:500;color:#171717;',
      'font-variant-numeric:tabular-nums;line-height:1.25}',
      'html.dark .nelth-imgc-label,html.dark .nelth-imgc-seconds{color:#fff;',
      'text-shadow:0 1px 2px rgba(0,0,0,.25)}',
      '.nelth-imgc-seconds{opacity:.9}',

      /* hidden layers */
      '.nelth-imgc-hide{display:none !important}',

      /* ---------------------------------------------------------- history
         images — messages from PAST discussions render natively (the files
         grid: button.w-full > img.rounded-lg): the w-full button stretches
         the image to the WHOLE message width (760px desktop / full screen
         mobile) while the live generation card caps at 384px — the reported
         "l'image devient très grande" in older chats. Same ChatGPT-style
         sizing as the card: width ≤ min(384px,100%), height ≤ 512px, natural
         ratio, never upscaled, card-like corners/border. */
      '.my-1.overflow-x-auto img.rounded-lg{max-width:min(384px,100%);max-height:512px;',
      'border-radius:1rem;border:1px solid #e5e5e5}',
      'html.dark .my-1.overflow-x-auto img.rounded-lg{border-color:#262626}',
      /* the lightbox button shrinks with the image so the clickable area
         matches what is visible (min() keeps it definite — fit-content would
         stay 760px: the img's percentage max-width is ignored during
         intrinsic sizing; graceful no-op where :has() is unsupported) */
      '.my-1.overflow-x-auto button:has(>img.rounded-lg){width:min(384px,100%)}',

      /* reduced motion — settle instantly, no sweep/flash, no resize morph */
      '.nelth-imgc.nelth-imgc-instant .nelth-imgc-grid{transition:none}',
      '.nelth-imgc.nelth-imgc-instant .nelth-imgc-photo{transition:none}',
      '.nelth-imgc.nelth-imgc-instant{transition:border-color .3s ease !important}',
      '.nelth-imgc.nelth-imgc-instant .nelth-imgc-sweep-bar{animation:none;opacity:0}',
      '.nelth-imgc.nelth-imgc-instant .nelth-imgc-flash{animation:none;opacity:0}',
      '@media (prefers-reduced-motion:reduce){.nelth-imgc-sweep-bar{animation:none !important;opacity:0}',
      '.nelth-imgc-flash{animation:none !important}',
      '.nelth-imgc{transition:border-color .3s ease !important}}',
    ].join('');
    document.head.appendChild(style);
  }

  // ------------------------------------------------------- grid canvas
  /**
   * Scintillating grid — carrés 4px, gap 2px, vagues sinusoïdales
   * désynchronisées (per-cell random offset + speed). Dark-mode aware.
   * Returns a stop() fn (cancels the rAF loop + resize listener).
   */
  function startGrid(canvas) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return () => {};
    let raf = 0;
    let width = 0;
    let height = 0;
    const size = 4;
    const gap = 2;
    const step = size + gap;
    let cols = 0;
    let rows = 0;
    let offsets = [];
    let speeds = [];

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      width = parent.clientWidth;
      height = parent.clientHeight;
      canvas.width = width;
      canvas.height = height;
      cols = Math.ceil(width / step);
      rows = Math.ceil(height / step);
      offsets = Array.from({ length: cols }, () =>
        Array.from({ length: rows }, () => Math.random() * Math.PI * 2)
      );
      speeds = Array.from({ length: cols }, () =>
        Array.from({ length: rows }, () => 0.35 + Math.random() * 0.95)
      );
    };
    window.addEventListener('resize', resize);
    resize();

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const time = Date.now() * 0.001;
      const isDark = document.documentElement.classList.contains('dark');
      const r = isDark ? 129 : 110;
      const g = isDark ? 129 : 110;
      const b = isDark ? 137 : 120;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const wave = Math.sin(time * speeds[i][j] + offsets[i][j]);
          let opacity = 0.02; // point éteint
          if (wave > 0.9) opacity = 0.1 + (wave - 0.9) * 3; // pics lumineux (max ~0.4)
          else if (wave > 0.7) opacity = 0.05 + (wave - 0.7) * 0.5;
          ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + opacity + ')';
          ctx.fillRect(i * step, j * step, size, size);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(raf);
    };
  }

  // ----------------------------------------------------------- the card
  function buildCard() {
    const card = document.createElement('div');
    card.className = 'nelth-imgc';
    card.setAttribute('role', 'img');
    card.setAttribute('aria-label', 'Generating image');
    card.innerHTML =
      '<div class="nelth-imgc-grid"><canvas aria-hidden="true"></canvas></div>' +
      '<div class="nelth-imgc-photo"><img alt="AI generated image" />' +
      '<div class="nelth-imgc-sweep" aria-hidden="true"><div class="nelth-imgc-sweep-bar"></div></div></div>' +
      '<div class="nelth-imgc-flash" aria-hidden="true"></div>' +
      '<div class="nelth-imgc-footer" aria-hidden="true"><div class="nelth-imgc-row">' +
      '<span class="nelth-imgc-label">Generating image</span>' +
      '<span class="nelth-imgc-seconds">0s</span></div></div>';
    return card;
  }

  // ------------------------------------------------------------- states
  // statusBox (the compiled status row container) → card state
  const cards = new Map();

  function stopGrid(state) {
    if (state.stopGrid) {
      state.stopGrid();
      state.stopGrid = null;
    }
  }

  function stopTimer(state) {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function setLabel(state, label) {
    if (state.label === label) return;
    state.label = label;
    if (state.labelEl) state.labelEl.textContent = label;
    state.card.setAttribute('aria-label', label === 'Generated' ? 'Generated image' : 'Generating image — ' + label);
  }

  /** Hide the native files grid of the generated image (the card is the display). */
  function hideNativeFiles(state) {
    if (!state.nativeImg || !state.nativeImg.isConnected) return;
    const grid = state.nativeImg.closest('[class*="overflow-x-auto"]');
    if (grid && grid.contains(state.nativeImg)) {
      state.nativeGrid = grid;
      grid.classList.add('nelth-imgc-hide');
    }
  }

  /** Forward card clicks to the native image button (opens the lightbox). */
  function forwardClicks(state) {
    state.card.addEventListener('click', () => {
      const img = state.nativeImg;
      if (!img || !img.isConnected) return;
      const btn = img.closest('button');
      if (btn) {
        try {
          btn.click();
        } catch (e) {
          /* lightbox unavailable — nothing to do */
        }
      }
    });
    state.card.style.cursor = 'zoom-in';
  }

  /** ChatGPT-style sizing: as soon as the real dimensions are measurable, the
   *  card adopts the image's natural aspect ratio — width capped at 384px,
   *  height at 512px, never upscaled. Until then the square placeholder stays. */
  function applyImageRatio(state) {
    if (state.ratioApplied) return;
    var w = 0;
    var h = 0;
    var cardImg = state.card.querySelector('.nelth-imgc-photo img');
    var sources = [state.preImg, cardImg, state.nativeImg];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (s && s.naturalWidth > 0 && s.naturalHeight > 0) {
        w = s.naturalWidth;
        h = s.naturalHeight;
        break;
      }
    }
    if (!w || !h) return; // dimensions unknown yet — keep the square placeholder
    state.ratioApplied = true;
    var maxW = 384;
    var parent = state.card.parentElement;
    if (parent && parent.clientWidth > 0) maxW = Math.min(parent.clientWidth, 384);
    var maxH = 512;
    var scale = Math.min(maxW / w, maxH / h, 1);
    state.card.style.width = 'min(100%, ' + Math.round(w * scale) + 'px)';
    state.card.style.aspectRatio = w + ' / ' + h;
  }

  /** The reveal: grid dissolves, image fades in, sweep + flash, footer flips. */
  function reveal(state, src, nativeImg) {
    if (state.revealed) return;
    state.revealed = true;
    state.nativeImg = nativeImg || null;

    // freeze the chronometer at the arrival time
    stopTimer(state);
    if (state.secondsEl) state.secondsEl.textContent = state.seconds + 's';
    setLabel(state, 'Generated');

    const img = state.card.querySelector('.nelth-imgc-photo img');
    if (img) {
      // the card adopts the image's ratio as soon as it is measurable
      img.addEventListener('load', () => applyImageRatio(state));
      if (!img.src) img.src = src;
    }
    const show = () => {
      applyImageRatio(state); // preloaded → ratio known before the fade starts
      state.card.classList.add('nelth-imgc-done');
      if (reduceMotionMq.matches) state.card.classList.add('nelth-imgc-instant');
    };
    // Preload so the reveal starts on a decoded frame (1.2s fallback).
    const pre = new Image();
    state.preImg = pre;
    pre.onload = pre.onerror = show;
    pre.src = src;
    setTimeout(show, 1200);

    stopGrid(state);
    hideNativeFiles(state);
    forwardClicks(state);
  }

  /** Remove a dead card (message re-render / navigation) — restore native. */
  function dropCard(state) {
    stopTimer(state);
    stopGrid(state);
    if (state.nativeGrid && state.nativeGrid.isConnected) {
      state.nativeGrid.classList.remove('nelth-imgc-hide');
    }
    if (state.statusBox && state.statusBox.isConnected) {
      state.statusBox.classList.remove('nelth-imgc-hide');
      delete state.statusBox.dataset.nelthImgCard;
    }
    if (state.card.isConnected) state.card.remove();
    if (state.msgObserver) {
      try {
        state.msgObserver.disconnect();
      } catch (e) {
        /* already gone */
      }
      state.msgObserver = null;
    }
  }

  /** Create the card for an in-progress image generation status row. */
  function createCard(statusBox) {
    const card = buildCard();
    statusBox.parentElement.insertBefore(card, statusBox.nextSibling);
    statusBox.classList.add('nelth-imgc-hide'); // le texte shimmer est remplacé par la carte
    statusBox.dataset.nelthImgCard = '1';

    const state = {
      card,
      statusBox,
      labelEl: card.querySelector('.nelth-imgc-label'),
      secondsEl: card.querySelector('.nelth-imgc-seconds'),
      startedAt: Date.now(),
      seconds: 0,
      label: 'Generating image',
      revealed: false,
      finishedAt: null,
      ratioApplied: false,
      preImg: null,
      stopGrid: startGrid(card.querySelector('canvas')),
      timerId: null,
      nativeImg: null,
      nativeGrid: null,
      msgObserver: null,
    };
    cards.set(statusBox, state);

    // Chronomètre (0,25s tick) — c'est l'ARRIVÉE de l'image qui le coupe.
    state.timerId = setInterval(() => {
      if (state.revealed) return;
      const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
      if (elapsed !== state.seconds) {
        state.seconds = elapsed;
        if (state.secondsEl) state.secondsEl.textContent = elapsed + 's';
      }
    }, 250);

    // Fast-path observer scoped to the message: catches the generated <img>
    // the frame it lands (before paint → no flicker of the native grid).
    const messageEl = statusBox.closest('[id^="message-"]') || statusBox.parentElement;
    if (messageEl) {
      state.msgObserver = new MutationObserver(() => checkReveal(state));
      state.msgObserver.observe(messageEl, { childList: true, subtree: true });
    }
    return state;
  }

  /** Look for the generated image in the message → trigger the reveal. */
  function checkReveal(state) {
    if (state.revealed || !state.card.isConnected) return;
    const messageEl = state.statusBox.closest('[id^="message-"]') || state.card.parentElement;
    if (!messageEl) return;
    const imgs = messageEl.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (state.card.contains(img)) continue;
      const src = img.getAttribute('src') || '';
      if (FILE_IMG_RE.test(src)) {
        reveal(state, img.src, img);
        return;
      }
    }
  }

  // ------------------------------------------------------------- scanning
  function scan() {
    // 1 — drop dead cards (chat switch, message re-render, navigation).
    for (const [box, state] of cards) {
      if (!state.card.isConnected || !box.isConnected) {
        dropCard(state);
        cards.delete(box);
      }
    }

    // 2 — create cards for in-progress image generations. The live status
    //     row carries the shimmer class while the job runs.
    const shimmerEls = document.querySelectorAll('.shimmer');
    for (let i = 0; i < shimmerEls.length; i++) {
      const el = shimmerEls[i];
      const text = (el.textContent || '').trim();
      if (!IMG_STATUS_RE.test(text)) continue;
      const btn = el.closest ? el.closest('button') : null;
      const statusBox = btn ? btn.parentElement : null;
      if (!statusBox || !statusBox.parentElement) continue;
      if (statusBox.dataset.nelthImgCard) continue;
      createCard(statusBox);
    }

    for (const state of cards.values()) {
      if (!state.card.isConnected) continue;

      // 3 — live phase label from the current status text. Once revealed the
      //     footer stays on 'Generated' (the image arrival is final — the
      //     trailing '· image' phase must not overwrite it).
      const live = state.statusBox.querySelector('.shimmer');
      if (live && !state.revealed) {
        const text = (live.textContent || '').trim();
        const m = text.match(PHASE_RE);
        setLabel(state, m ? m[1].toLowerCase() : 'Generating image');
      }

      // 4 — reveal check (img may land between scans too — fast observer
      //     covers it; this is the safety net).
      checkReveal(state);

      // 5 — generation ended without an image (error / abort): the shimmer
      //     is gone, no file arrived → hand the message back to the native
      //     error/status rendering after a short grace period.
      if (!state.revealed && !live) {
        if (state.finishedAt == null) state.finishedAt = Date.now();
        if (Date.now() - state.finishedAt > 2500) {
          dropCard(state);
          cards.delete(state.statusBox);
        }
      } else if (state.revealed) {
        // keep the native grid hidden across Svelte re-renders
        hideNativeFiles(state);
      }
    }
  }

  let scanPending = false;
  const scheduleScan = () => {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => {
      scanPending = false;
      scan();
    }, 250);
  };

  const start = () => {
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
