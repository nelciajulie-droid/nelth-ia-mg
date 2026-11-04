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
