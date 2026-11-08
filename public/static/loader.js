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
    nativeSid: liveSid,
    nativeAge: liveSid ? Date.now() - liveSidAt : null,
    socketIdle: lastSocketActivity ? Date.now() - lastSocketActivity : null,
    liveSids: nativeSidActivity.size,
    ioSids: Array.from(ioSidByEngine.values()),
  });
  let debugDelivered = 0;
  const CHAT_RE = /\/api\/chat\/completions\/?(\?.*)?$/;

  let engaged = false; // fake socket active (real one proved unreachable)
  let handshakeFailures = 0; // consecutive failed native handshakes
  let sid = null; // engine.io session id handed to the client
  const queue = []; // server → client packets (concatenated per poll)
  const waiters = []; // pending GET polls: { xhr, resolve }

  // Native socket liveness tracking — used by the chat POST patch to detect
  // a stale `session_id` (the app sends the socket.io id; if the real socket
  // died while the page sat idle, socket-mode events would be emitted to a
  // ghost session and the reply would never render). The compiled app may
  // keep several live socket sessions side by side (component re-mounts
  // create a new socket without always closing the previous one), and since
  // socket.io v4.1 the socket.io id sent in the CONNECT ack differs from the
  // engine.io sid — so BOTH ids are tracked. A healthy socket exchanges XHRs
  // continuously (long-polls answered at least every ~25s by a server ping),
  // so each socket URL opened through open() refreshes its ids' timestamps,
  // and each poll response is peeked at for the `40{"sid":…}` CONNECT ack
  // that reveals the socket.io id.
  const nativeSidActivity = new Map(); // socket id (engine.io OR socket.io) → last XHR open time
  const ioSidByEngine = new Map(); // engine.io sid → socket.io id (CONNECT ack)
  let lastSocketActivity = 0;
  let liveSid = null;
  let liveSidAt = 0;
  // Trim the map so long-lived pages don't accumulate dead sessions.
  setInterval(() => {
    const cutoff = Date.now() - 3600000;
    for (const [s, t] of nativeSidActivity) {
      if (t < cutoff) nativeSidActivity.delete(s);
    }
  }, 300000);

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
    // engine.io v4 server heartbeat — the client pongs via POST. Pushed at
    // 20s (browsers throttle this timer to ~60s in hidden tabs, which is
    // fine: the client-side watchdog derives from the handshake windows
    // below — 25s + 1h — so even heavily throttled pings keep the fake
    // connection alive indefinitely). The queue is bounded so a frozen tab
    // (zero timer execution) cannot accumulate an endless pile of pings.
    const heartbeat = () => {
      if (waiters.length > 0 || queue.length < 2) pushPacket('2');
    };
    setInterval(heartbeat, 20000);
    // Instant watchdog reset the moment the tab becomes visible again
    // (post-freeze resume, back from system sleep, …).
    document.addEventListener('visibilitychange', () => {
      if (engaged && document.visibilityState === 'visible') heartbeat();
    });
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
      // Handshake detection is URL-based (no sid param), NOT first-call
      // based: after any disconnect (ping timeout on resume from sleep,
      // navigation, …) the engine.io client opens a FRESH session and its
      // handshake GET carries no sid even though we already served one.
      // Parking that handshake as a long-poll (the old `if (!sid)` behaviour)
      // fed the client a stray packet before the open packet and broke the
      // reconnect loop — the exact “Connexion perdue. Reconnexion…” stall.
      // Every fresh GET therefore gets a brand-new session + open packet,
      // making every reconnect instant and protocol-valid.
      if (!/[?&]sid=/.test(String(url))) {
        sid = nowSid();
        finishXhr(xhr, 200, '0' + JSON.stringify({
          sid,
          upgrades: [],
          // Wide keep-alive windows: the client watchdog waits
          // pingInterval + pingTimeout (≈1h) between pings, so hidden-tab
          // timer throttling (~1/min) can never trip it.
          pingInterval: 25000,
          pingTimeout: 3600000,
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
    if (isSocket) {
      lastSocketActivity = Date.now();
      const sidMatch = String(url).match(/[?&]sid=([^&]+)/);
      if (sidMatch) {
        const engineSid = sidMatch[1];
        nativeSidActivity.set(engineSid, Date.now());
        // The socket.io id (what the app actually sends as session_id) is
        // distinct from the engine.io sid since socket.io v4.1 — keep it
        // as fresh as the engine session it rides on.
        const ioId = ioSidByEngine.get(engineSid);
        if (ioId) nativeSidActivity.set(ioId, Date.now());
      }
    }
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
    // natively (engaging here would hijack a healthy connection). Their
    // responses are still peeked at to learn the socket.io id the CONNECT
    // ack assigns — that id is what the app later sends as `session_id`.
    // Only a fresh handshake (no sid — a reconnect attempt) gets
    // failure-watched: two consecutive failures mean the service is truly
    // unreachable.
    const isHandshake = fake.method === 'GET' && !/[?&]sid=/.test(fake.url);
    if (!isHandshake) {
      if (fake.method === 'GET') {
        const xhr = this;
        const origRSC = xhr.onreadystatechange;
        xhr.onreadystatechange = function () {
          try {
            if (xhr.readyState === 4 && (xhr.status === 200 || xhr.status === 1223)) {
              const ack = String(xhr.responseText || '').match(/40\{"sid":"([^"]+)"\}/);
              if (ack) {
                const em = String(fake.url).match(/[?&]sid=([^&]+)/);
                if (em) {
                  ioSidByEngine.set(em[1], ack[1]);
                  nativeSidActivity.set(ack[1], Date.now());
                }
              }
            }
          } catch (e) {
            /* unreadable response — tracking only, never fatal */
          }
          if (typeof origRSC === 'function') origRSC.apply(this, arguments);
        };
      }
      return nativeSend.call(this, body);
    }

    const xhr = this;
    const check = () => {
      try {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200 || xhr.status === 1223) {
          handshakeFailures = 0;
          try {
            const m = String(xhr.responseText || '').match(/"sid":"([^"]+)"/);
            if (m) {
              liveSid = m[1];
              liveSidAt = Date.now();
              lastSocketActivity = Date.now();
              nativeSidActivity.set(m[1], Date.now());
            }
          } catch (e) {
            /* response unreadable — liveness simply not updated */
          }
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
    // (bridge not engaged) AND the session's socket is ALIVE — the app may
    // keep several live sessions side by side, so the payload's session_id
    // just has to match ANY natively-polling engine.io sid (socket.io v4 uses
    // the engine.io sid as the socket id). A session_id whose socket died
    // while the page sat idle (no socket XHR for 90s; healthy sockets poll
    // at least every ~25s) would silently swallow the reply — fall back to
    // the SSE transport in that case instead.
    window.__NELTH_LASTPOST__ = {
      sid: bodyObj && typeof bodyObj === 'object' ? bodyObj.session_id : null,
      known: Array.from(nativeSidActivity.keys()),
      engaged,
    };
    const sidAlive =
      bodyObj &&
      typeof bodyObj === 'object' &&
      typeof bodyObj.session_id === 'string' &&
      Date.now() - (nativeSidActivity.get(bodyObj.session_id) || 0) < 90000;
    const nativeSocketAlive = !engaged && sidAlive;
    if (nativeSocketAlive) {
      return nativeFetch(input, init);
    }

    // Serverless mode — one of:
    //   • the real socket service is unreachable (engaged) — any session_id
    //     in the payload is our fake one, the backend socket hop is dead;
    //   • the socket is not connected yet (no session_id) — the backend
    //     would answer with raw SSE the JSON helper cannot parse;
    //   • the socket died while the page sat idle (stale session_id) —
    //     socket-mode events would be emitted to a ghost session.
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
      // Envelope ids (authoritative): a NEW chat's id is generated server-side
      // and only exists on the event envelopes — the continuation request must
      // carry it (plus the target assistant message id) explicitly.
      let envChatId = chatId;
      let envMessageId = messageId;

      // ---- Auto-continue chain (long code vs the serverless time cap) ----
      // The backend caps a completion at its time budget (Vercel maxDuration
      // ~300s). When a thinking-model generation of a very long code file
      // outruns it, the backend emits the `nelth:continue` marker with the
      // partial answer: WITHHOLD the round's done event, re-request with
      // __nelth_continue (a FRESH serverless invocation with its own full
      // budget) and keep piping the events into the same fake-socket stream.
      // The compiled app just sees one long generation — the code lands in a
      // single message, no error banner, no user action. Without the bridge
      // marker the behavior is exactly the previous one.
      const MAX_CONT_ROUNDS = 3;
      const contCtl = new AbortController();
      let contRounds = 0;
      let truncated = false; // marker seen in the CURRENT response
      let everTruncated = false;
      const abortChain = () => {
        try {
          contCtl.abort();
        } catch (e) {
          /* already aborted */
        }
      };
      if (init && init.signal) {
        if (init.signal.aborted) abortChain();
        else init.signal.addEventListener('abort', abortChain, { once: true });
      }

      const readEvents = async (response) => {
        const reader = response.body.getReader();
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
              let env;
              try {
                env = JSON.parse(payload);
              } catch (e) {
                continue; // skip malformed line
              }
              if (!env || typeof env !== 'object' || !env.data || !env.data.type) continue;
              if (typeof env.chat_id === 'string' && env.chat_id) envChatId = env.chat_id;
              if (typeof env.message_id === 'string' && env.message_id) envMessageId = env.message_id;
              const t = env.data.type;
              // Bridge-private marker: the backend hit its time budget with a
              // partial answer. (Harmless without this layer — the compiled
              // app's dispatcher ignores unknown event types.)
              if (t === 'nelth:continue') {
                truncated = true;
                everTruncated = true;
                continue;
              }
              // Withhold the truncated round's done event — superseded by the
              // continuation chain (or the bare-done fallback below).
              if (truncated && t === 'chat:completion' && env.data.data && env.data.data.done) {
                continue;
              }
              // Post-truncation error/list events would close the message on
              // the app side while the chain is still working — swallow them.
              if (truncated && (t === 'chat:message:error' || t === 'chat:list')) {
                continue;
              }
              pushEvent(env); // full socket-event envelope from the backend
            }
          }
        } catch (e) {
          /* client aborted — the app's own abort flow takes over */
          abortChain();
        }
      };

      await readEvents(res);
      while (truncated && contRounds < MAX_CONT_ROUNDS && !contCtl.signal.aborted && envMessageId) {
        truncated = false;
        contRounds++;
        try {
          const contBody = Object.assign({}, bodyObj, {
            __nelth_continue: true,
            chat_id: envChatId || bodyObj.chat_id || undefined,
            id: envMessageId,
          });
          if (contBody.chat_id === undefined) delete contBody.chat_id;
          const contInit = Object.assign({}, init, {
            body: JSON.stringify(contBody),
            signal: contCtl.signal,
          });
          const res2 = await nativeFetch(input, contInit);
          const ct2 = (res2.headers.get('content-type') || '').toLowerCase();
          if (!ct2.includes('text/event-stream')) break; // JSON error path → fallback finalize
          await readEvents(res2);
        } catch (e) {
          break; // network/abort → fallback finalize
        }
      }
      if (init && init.signal) {
        try {
          init.signal.removeEventListener('abort', abortChain);
        } catch (e) {
          /* best effort */
        }
      }

      // Fallback finalize: a truncated round whose continuation chain could
      // not complete (round cap reached / continuation request failed).
      // A BARE done event (no content) makes the compiled app finalize with
      // the message's CURRENT accumulated content — the full chain output or
      // the partial, either way graceful — and a hint tells the user how to
      // finish manually when the cap was the limit.
      if (everTruncated && envMessageId) {
        pushEvent({
          chat_id: envChatId,
          message_id: envMessageId,
          data: { type: 'chat:completion', data: { done: true } },
        });
        if (truncated) {
          pushEvent({
            chat_id: envChatId,
            message_id: envMessageId,
            data: {
              type: 'status',
              data: {
                action: 'chat',
                description: 'Limite de temps atteinte — tapez « continue » pour poursuivre la génération',
                done: true,
              },
            },
          });
        }
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
 * RECONNECT TOAST SUPPRESSION — “always ready” UX.
 *
 * Why: with the wide keep-alive windows above, an idle/background tab no
 * longer drops the realtime socket, and when a drop does happen (system
 * sleep, service restart) the connection now heals itself in a second or
 * two — the chat keeps working through the SSE transport meanwhile. The
 * compiled frontend still warns “Connexion perdue. Reconnexion en cours…”
 * whenever the socket is briefly down (2s grace), which reads like a
 * failure the user has to act on even though nothing is actually lost.
 *
 * Fix, entirely in this layer (compiled frontend untouched): toasts are
 * rendered by sonner — items carry `data-sonner-toast` — so a MutationObserver
 * mutes exactly the reconnect-warning and reconnect-ok toasts (structure
 * match + short exact/patterned text). Every other toast (API errors,
 * confirmations, …) is left untouched. Muted items are hidden with
 * display:none rather than removed, letting sonner run its own timers and
 * lifecycle undisturbed.
 * ==================================================================== */
(() => {
  'use strict';
  if (window.__NELTH_TOAST_MUTE__) return;
  window.__NELTH_TOAST_MUTE__ = true;

  const WARNING_EXACT = [
    'Connexion perdue. Reconnexion en cours...', // fr
    'Connection lost. Reconnecting...', // en
  ];
  const isReconnectWarning = (t) =>
    WARNING_EXACT.includes(t) ||
    (/^(connection|connexion|conexi|verbindung|connessione|соедин)/i.test(t) &&
      /(reconnect|reconect|verbind|riconn|подключ)/i.test(t));
  const isReconnectedToast = (t) =>
    /^(reconnected|reconnecté|reconectado|riconnesso|reconectou|wieder verbunden|neu verbunden)$/i.test(
      t
    );

  const mute = (el) => {
    el.setAttribute('data-nelth-muted', '');
    el.style.setProperty('display', 'none', 'important');
  };

  const scan = (node) => {
    const toasts = [];
    try {
      if (node.matches && node.matches('[data-sonner-toast]')) toasts.push(node);
      const found = node.querySelectorAll('[data-sonner-toast]');
      for (let k = 0; k < found.length; k++) toasts.push(found[k]);
    } catch (e) {
      return;
    }
    for (let i = 0; i < toasts.length; i++) {
      const el = toasts[i];
      if (el.hasAttribute('data-nelth-muted')) continue;
      const text = (el.textContent || '').trim();
      if (text.length > 90) continue; // safety: toasts are short
      if (isReconnectWarning(text) || isReconnectedToast(text)) mute(el);
    }
  };

  const start = () => {
    const obs = new MutationObserver((muts) => {
      for (let i = 0; i < muts.length; i++) {
        const added = muts[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j];
          if (n.nodeType !== 1) continue;
          scan(n);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    scan(document.body); // catch anything already on screen
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
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
      // Status-history timeline — NEVER auto-expanded. The live status line
      // (collapsed toggle) is the feedback; expanding it lays out the
      // dot-and-line Activity Timeline the user explicitly rejected. Only
      // reasoning/thinking content blocks (their headers carry no
      // aria-label) auto-open.
      if (btn.getAttribute('aria-label') === 'Toggle status history') continue;
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

/* ====================================================================
 * AI VIDEO GENERATION CARD — the vibes-engine twin of the image card.
 *
 * The vibes video engine (lib/video-generation.ts → nelcia.space-z.ai)
 * drives video jobs through three live phases — sending → rendering →
 * finalizing — surfaced as status rows by the compiled frontend
 * ('Generating video · sending'…). This layer swaps that text row for the
 * generation card:
 *
 *   • a canvas of 4px squares scintillating on desynchronized sine waves
 *     (grid dissolve → reveal when the video lands),
 *   • a live phase label plus a seconds counter — the ARRIVAL of the
 *     video stops it,
 *   • the reveal choreography: grid blurs out, the <video> fades in from
 *     blur(20px), a diagonal light sweep, a brief white flash, footer
 *     flips to 'Generated' + final duration,
 *   • the card then IS the player: <video controls autoplay muted loop
 *     playsinline> (no lightbox hop — the video carries its own controls);
 *     the video attachment carries type 'video' — the compiled message
 *     grid only maps ["image","file"], so NO native file card ever paints
 *     (the old "generated-video-….mp4 — 2.3 MB" flash is gone).
 *
 * Works with both event transports (native socket.io and the SSE bridge):
 * it watches the DOM, not the events.
 * ==================================================================== */
(() => {
  'use strict';
  if (window.__NELTH_VID_CARD__) return;
  window.__NELTH_VID_CARD__ = true;

  const VID_STATUS_RE = /^Generating video/i;
  // 'Generating video (9:16) · rendering' — the ratio tag (group 1) rides
  // along since the AI now picks the best format per prompt (16:9 / 1:1 /
  // 9:16 only); the live phase is group 2.
  const PHASE_RE = /Generating video\s*(?:\((\d{1,2}:\d{1,2})\))?\s*[·—–-]\s*([a-z]+)/i;
  const RATIO_RE = /\((\d{1,2}:\d{1,2})\)/;
  const reduceMotionMq = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  // ------------------------------------------------------------- styles
  if (!document.getElementById('nelth-vidc-style')) {
    const style = document.createElement('style');
    style.id = 'nelth-vidc-style';
    style.textContent = [
      /* card shell — 16:9 placeholder while generating (the video default);
         at the reveal it takes the video's NATURAL aspect ratio */
      '.nelth-vidc{position:relative;width:min(100%,420px);aspect-ratio:16/9;border-radius:1rem;',
      'overflow:hidden;background:#fff;border:1px solid #e5e5e5;',
      'transition:border-color .3s ease,width .55s cubic-bezier(.22,1,.36,1),',
      'aspect-ratio .55s cubic-bezier(.22,1,.36,1);isolation:isolate}',
      'html.dark .nelth-vidc{background:#171717;border-color:#262626}',

      /* scintillating grid (canvas) — dissolves at the reveal */
      '.nelth-vidc-grid{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'transition:opacity 1s cubic-bezier(.22,1,.36,1),transform 1s cubic-bezier(.22,1,.36,1),',
      'filter 1s cubic-bezier(.22,1,.36,1)}',
      '.nelth-vidc-grid canvas{width:100%;height:100%;display:block}',
      '.nelth-vidc.nelth-vidc-done .nelth-vidc-grid{opacity:0;transform:scale(1.08);',
      'filter:blur(14px);pointer-events:none}',

      /* revealed video — fade-in from blur + diagonal light sweep */
      '.nelth-vidc-photo{position:absolute;inset:0;opacity:0;filter:blur(20px);',
      'transition:opacity .9s cubic-bezier(.22,1,.36,1),filter .9s cubic-bezier(.22,1,.36,1)}',
      '.nelth-vidc.nelth-vidc-done .nelth-vidc-photo{opacity:1;filter:blur(0)}',
      '.nelth-vidc-photo video{width:100%;height:100%;object-fit:contain;display:block;',
      'background:#000}',
      '.nelth-vidc-sweep{position:absolute;inset:0;overflow:hidden;pointer-events:none}',
      '.nelth-vidc-sweep-bar{position:absolute;top:0;bottom:0;left:0;width:33.333%;',
      'background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);',
      'transform:translateX(-115%) skewX(-12deg)}',
      '.nelth-vidc.nelth-vidc-done .nelth-vidc-sweep-bar{',
      'animation:nelth-vidc-sweep 1.1s cubic-bezier(.65,0,.35,1) .3s 1 both}',
      '@keyframes nelth-vidc-sweep{from{transform:translateX(-115%) skewX(-12deg)}',
      'to{transform:translateX(345%) skewX(-12deg)}}',

      /* brief white flash at the reveal */
      '.nelth-vidc-flash{position:absolute;inset:0;pointer-events:none;background:#fff;opacity:0}',
      '.nelth-vidc.nelth-vidc-done .nelth-vidc-flash{',
      'animation:nelth-vidc-flash .7s ease-out .05s 1 both}',
      '@keyframes nelth-vidc-flash{0%{opacity:0}25%{opacity:.18}100%{opacity:0}}',

      /* footer — gradient-masked, label + seconds */
      '.nelth-vidc-footer{position:absolute;left:0;right:0;bottom:0;height:72px;',
      'background:rgba(255,255,255,.4);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);',
      '-webkit-mask-image:linear-gradient(to top,black 0%,transparent 100%);',
      'mask-image:linear-gradient(to top,black 0%,transparent 100%);pointer-events:none}',
      'html.dark .nelth-vidc-footer{background:rgba(0,0,0,.5)}',
      '.nelth-vidc-row{position:absolute;bottom:12px;left:20px;right:20px;display:flex;',
      'align-items:center;justify-content:space-between;gap:8px}',
      '.nelth-vidc-label,.nelth-vidc-seconds{font-size:.875rem;font-weight:500;color:#171717;',
      'font-variant-numeric:tabular-nums;line-height:1.25}',
      'html.dark .nelth-vidc-label,html.dark .nelth-vidc-seconds{color:#fff;',
      'text-shadow:0 1px 2px rgba(0,0,0,.25)}',
      '.nelth-vidc-seconds{opacity:.9}',
      /* the footer fades out a beat after the reveal — the player's own
         controls take over; the label lingers just long enough to read */
      '.nelth-vidc.nelth-vidc-done .nelth-vidc-footer{',
      'animation:nelth-vidc-footer 1.6s ease-out .9s 1 both}',
      '@keyframes nelth-vidc-footer{to{opacity:0}}',

      /* hidden layers */
      '.nelth-vidc-hide{display:none !important}',

      /* ---------------------------------------------------------- history
         videos — legacy 'file' turns render a generic FILE card (button):
         those cards are replaced with inline players (.nelth-vidh). Newer
         type-'video' turns render NOTHING natively — their players are
         inserted from the resolved history entries. Same URL resolution
         path as the live reveal (cached 15s). */
      '.nelth-vidh{width:min(100%,480px);border-radius:1rem;border:1px solid #e5e5e5;',
      'overflow:hidden;background:#000;isolation:isolate}',
      'html.dark .nelth-vidh{border-color:#262626}',
      '.nelth-vidh video{width:100%;max-height:420px;display:block;background:#000}',
      '.nelth-vidh-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:6px 10px;background:#fff;border-top:1px solid #f0f0f0}',
      'html.dark .nelth-vidh-bar{background:#171717;border-top-color:#262626}',
      '.nelth-vidh-name{font-size:.75rem;color:#525252;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;min-width:0}',
      'html.dark .nelth-vidh-name{color:#a3a3a3}',
      '.nelth-vidh-dl{font-size:.75rem;font-weight:500;color:#059669;text-decoration:none;',
      'white-space:nowrap;flex-shrink:0}',
      'html.dark .nelth-vidh-dl{color:#34d399}',
      '.nelth-vidh-dl:hover{text-decoration:underline}',

      /* reduced motion — settle instantly, no sweep/flash/footer fade */
      '.nelth-vidc.nelth-vidc-instant .nelth-vidc-grid{transition:none}',
      '.nelth-vidc.nelth-vidc-instant .nelth-vidc-photo{transition:none}',
      '.nelth-vidc.nelth-vidc-instant{transition:border-color .3s ease !important}',
      '.nelth-vidc.nelth-vidc-instant .nelth-vidc-sweep-bar{animation:none;opacity:0}',
      '.nelth-vidc.nelth-vidc-instant .nelth-vidc-flash{animation:none;opacity:0}',
      '.nelth-vidc.nelth-vidc-instant .nelth-vidc-footer{animation:none;opacity:0}',
      '@media (prefers-reduced-motion:reduce){.nelth-vidc-sweep-bar{animation:none !important;opacity:0}',
      '.nelth-vidc-flash{animation:none !important}',
      '.nelth-vidc-footer{animation:none !important;opacity:0}',
      '.nelth-vidc{transition:border-color .3s ease !important}}',
    ].join('');
    document.head.appendChild(style);
  }

  // ------------------------------------------------------- grid canvas
  /** Scintillating grid — same twin of the image card's canvas. */
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
          let opacity = 0.02;
          if (wave > 0.9) opacity = 0.1 + (wave - 0.9) * 3;
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
    card.className = 'nelth-vidc';
    card.setAttribute('role', 'video');
    card.setAttribute('aria-label', 'Generating video');
    card.innerHTML =
      '<div class="nelth-vidc-grid"><canvas aria-hidden="true"></canvas></div>' +
      '<div class="nelth-vidc-photo"><video controls autoplay muted loop playsinline preload="auto" ' +
      'aria-label="AI generated video"></video>' +
      '<div class="nelth-vidc-sweep" aria-hidden="true"><div class="nelth-vidc-sweep-bar"></div></div></div>' +
      '<div class="nelth-vidc-flash" aria-hidden="true"></div>' +
      '<div class="nelth-vidc-footer" aria-hidden="true"><div class="nelth-vidc-row">' +
      '<span class="nelth-vidc-label">Generating video</span>' +
      '<span class="nelth-vidc-seconds">0s</span></div></div>';
    return card;
  }

  // ------------------------------------------------------------- states
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
    state.card.setAttribute('aria-label', label === 'Generated' ? 'Generated video' : 'Generating video — ' + label);
  }

  /** Placeholder shape follows the CHOSEN ratio (9:16 → tall, 1:1 → square)
   *  so the user sees the selected format while the video renders — the
   *  reveal then refines to the video's natural dimensions (16:9 is the CSS
   *  default, nothing to do). */
  function applyPlaceholderRatio(state) {
    if (state.ratioApplied || !state.ratio || state.ratio === '16:9') return;
    var tall = state.ratio === '9:16';
    var w = tall ? 288 : 420; // 9:16 width capped by the 512px height budget
    var h = tall ? 512 : 420;
    state.card.style.width = 'min(100%, ' + w + 'px)';
    state.card.style.aspectRatio = w + ' / ' + h;
  }

  /** Status text → footer label + placeholder ratio ('rendering · 9:16').
   *  The ratio tag arrives with the very first status ('Generating video
   *  (9:16)…') and persists across phase rows. */
  function applyStatusText(state, text) {
    var phaseM = text.match(PHASE_RE);
    var ratioM = text.match(RATIO_RE);
    if (ratioM) state.ratio = ratioM[1];
    applyPlaceholderRatio(state);
    var label = phaseM ? phaseM[2].toLowerCase() : 'Generating video';
    if (state.ratio) label += ' · ' + state.ratio;
    setLabel(state, label);
  }

  /** Hide the native FILE CARD of the generated video (the card IS the
   *  player now). Only the card's own wrapper — never the whole files grid
   *  (other files of the message stay visible). */
  function hideNativeCard(state) {
    const btn = state.nativeCard;
    if (!btn || !btn.isConnected) return;
    let wrap = btn.parentElement;
    if (wrap && !/overflow-x-auto/.test(String(wrap.className || ''))) {
      state.nativeWrap = wrap;
      wrap.classList.add('nelth-vidc-hide');
    } else {
      state.nativeWrap = btn;
      btn.classList.add('nelth-vidc-hide');
    }
  }

  /** ChatGPT-style sizing: adopt the video's natural aspect ratio once its
   *  metadata is measurable — width capped at 420px, height at 512px. */
  function applyVideoRatio(state) {
    if (state.ratioApplied) return;
    var w = 0;
    var h = 0;
    var cardVideo = state.card.querySelector('.nelth-vidc-photo video');
    if (cardVideo && cardVideo.videoWidth > 0 && cardVideo.videoHeight > 0) {
      w = cardVideo.videoWidth;
      h = cardVideo.videoHeight;
    }
    if (!w || !h) return; // dimensions unknown yet — keep the 16:9 placeholder
    state.ratioApplied = true;
    var maxW = 420;
    var parent = state.card.parentElement;
    if (parent && parent.clientWidth > 0) maxW = Math.min(parent.clientWidth, 420);
    var maxH = 512;
    var scale = Math.min(maxW / w, maxH / h, 1);
    state.card.style.width = 'min(100%, ' + Math.round(w * scale) + 'px)';
    state.card.style.aspectRatio = w + ' / ' + h;
  }

  /** The reveal: grid dissolves, video fades in + plays, sweep + flash. */
  function reveal(state, src) {
    if (state.revealed) return;
    state.revealed = true;

    // freeze the chronometer at the arrival time
    stopTimer(state);
    if (state.secondsEl) state.secondsEl.textContent = state.seconds + 's';
    setLabel(state, 'Generated');

    const video = state.card.querySelector('.nelth-vidc-photo video');
    const show = () => {
      applyVideoRatio(state);
      state.card.classList.add('nelth-vidc-done');
      if (reduceMotionMq.matches) state.card.classList.add('nelth-vidc-instant');
      if (video && !video.src) {
        try { video.src = src; video.load(); video.play().catch(() => {}); } catch (e) { /* autoplay refused */ }
      }
    };
    if (video) {
      video.addEventListener('loadedmetadata', () => applyVideoRatio(state));
      try { video.src = src; video.load(); } catch (e) { /* src assignment */ }
      // A decoded first frame before the fade (1.2s fallback — a video's
      // metadata can be slow on mobile networks).
      video.addEventListener('loadeddata', show, { once: true });
    }
    setTimeout(show, 1200);

    stopGrid(state);
    hideNativeCard(state);
  }

  /** Remove a dead card (message re-render / navigation) — restore native. */
  function dropCard(state) {
    stopTimer(state);
    stopGrid(state);
    if (state.nativeWrap && state.nativeWrap.isConnected) {
      state.nativeWrap.classList.remove('nelth-vidc-hide');
    }
    if (state.statusBox && state.statusBox.isConnected) {
      state.statusBox.classList.remove('nelth-vidc-hide');
      delete state.statusBox.dataset.nelthVidCard;
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

  /** Create the card for an in-progress video generation status row. */
  function createCard(statusBox) {
    const card = buildCard();
    statusBox.parentElement.insertBefore(card, statusBox.nextSibling);
    statusBox.classList.add('nelth-vidc-hide'); // le texte shimmer est remplacé par la carte
    statusBox.dataset.nelthVidCard = '1';

    const state = {
      card,
      statusBox,
      labelEl: card.querySelector('.nelth-vidc-label'),
      secondsEl: card.querySelector('.nelth-vidc-seconds'),
      startedAt: Date.now(),
      seconds: 0,
      label: 'Generating video',
      ratio: null,
      revealed: false,
      finishedAt: null,
      ratioApplied: false,
      stopGrid: startGrid(card.querySelector('canvas')),
      timerId: null,
      nativeCard: null,
      nativeWrap: null,
      resolving: false,
      resolveStarted: false,
      msgObserver: null,
    };
    cards.set(statusBox, state);

    // Chronomètre (0,25s tick) — c'est l'ARRIVÉE de la vidéo qui le coupe.
    state.timerId = setInterval(() => {
      if (state.revealed) return;
      const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
      if (elapsed !== state.seconds) {
        state.seconds = elapsed;
        if (state.secondsEl) state.secondsEl.textContent = elapsed + 's';
      }
    }, 250);

    // Fast-path observer scoped to the message: the generated video's FILE
    // CARD (a button labelled with the .mp4 name) lands the frame it is
    // appended — before paint, no flicker of the native grid.
    const messageEl = statusBox.closest('[id^="message-"]') || statusBox.parentElement;
    if (messageEl) {
      state.msgObserver = new MutationObserver(() => checkReveal(state));
      state.msgObserver.observe(messageEl, { childList: true, subtree: true });
    }
    return state;
  }

  // ------------------------------------------- video URL resolution (API)
  // The video attachment carries type 'video' — the compiled message grid
  // maps only ["image","file"], so nothing renders natively and the URL is
  // never in the DOM. It is read from the chat history API: the message
  // element's id IS the history key, and the backend persists the message
  // BEFORE the files event / done status (reordered for exactly this).
  const chatCache = new Map(); // chatId → { at, data }
  function fetchChatCached(chatId, maxAgeMs) {
    const hit = chatCache.get(chatId);
    if (hit && Date.now() - hit.at < (maxAgeMs == null ? 15000 : maxAgeMs)) {
      return Promise.resolve(hit.data);
    }
    return fetch('/api/v1/chats/' + encodeURIComponent(chatId), {
      headers: { Authorization: 'Bearer ' + (localStorage.token || '') },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => {
        if (data) chatCache.set(chatId, { at: Date.now(), data });
        return data;
      });
  }

  const isVideoFileEntry = (f) =>
    !!f && (
      f.type === 'video' ||
      String(f.content_type || '').startsWith('video/') ||
      /\.mp4$/i.test(String(f.name || ''))
    );

  /** Chat id candidates for the message lookup. The URL is the truth once
   *  the user is IN a chat; during a live FIRST turn, though, the compiled
   *  frontend keeps the URL at "/" (the backend creates the chat itself) —
   *  the sidebar's newest entries (sorted by updated_at) cover that case.
   *  A wrong candidate simply misses the message id and is skipped. */
  function chatIdCandidates() {
    const out = [];
    const m = location.pathname.match(/\/c\/([a-zA-Z0-9-]{10,})/);
    if (m) out.push(m[1]);
    const links = document.querySelectorAll('a[href^="/c/"]');
    for (let i = 0; i < Math.min(links.length, 3); i++) {
      const mm = (links[i].getAttribute('href') || '').match(/\/c\/([a-zA-Z0-9-]{10,})/);
      if (mm && out.indexOf(mm[1]) === -1) out.push(mm[1]);
    }
    return out;
  }

  /** messageEl (id="message-{id}") → the video file entry of that message. */
  async function videoEntryOf(messageEl, maxAgeMs) {
    const id = (messageEl.id || '').replace(/^message-/, '');
    if (!id) return null;
    const candidates = chatIdCandidates();
    for (let c = 0; c < candidates.length; c++) {
      const chat = await fetchChatCached(candidates[c], maxAgeMs);
      const msgs = chat && chat.chat && chat.chat.history && chat.chat.history.messages
        ? chat.chat.history.messages
        : null;
      const files = msgs && msgs[id] ? msgs[id].files : null;
      if (!Array.isArray(files)) continue;
      for (let i = 0; i < files.length; i++) {
        if (isVideoFileEntry(files[i]) && typeof files[i].url === 'string' && files[i].url) {
          return files[i];
        }
      }
    }
    return null;
  }

  /** Resolve with retries — the files event lands a beat BEFORE the history
   *  upsert (fresh refetch on each retry), and a brand-new chat's URL may
   *  lag a second behind the first message. */
  async function resolveVideoUrl(messageEl, attempts) {
    const n = attempts || 4;
    for (let i = 0; i < n; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 800));
      const entry = await videoEntryOf(messageEl, i === 0 ? 15000 : 0).catch(() => null);
      if (entry) return entry;
    }
    return null;
  }

  /** Detect the generated video's native FILE CARD (a button whose label
   *  carries the .mp4 name — LEGACY 'file'-typed turns; newer turns attach
   *  type 'video' and render nothing natively) inside the message → async
   *  URL resolution → reveal. The native card is hidden SYNCHRONOUSLY the
   *  moment it appears (the scoped observer calls this before paint) — the
   *  raw "generated-video-….mp4 — 2.3 MB" card must never be seen. */
  function checkReveal(state) {
    if (state.revealed || !state.card.isConnected) return;
    const messageEl = state.statusBox.closest('[id^="message-"]') || state.card.parentElement;
    if (!messageEl) return;
    const btns = messageEl.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      if (state.card.contains(btn)) continue;
      const txt = (btn.textContent || '').trim();
      if (/\.mp4(\s|$)/i.test(txt)) {
        // hide BEFORE paint — and re-hide if Svelte recreated the button
        // while the URL resolution is still in flight.
        if (state.nativeCard !== btn) {
          state.nativeCard = btn;
          hideNativeCard(state);
        }
        if (!state.resolving) {
          state.resolving = true;
          resolveVideoUrl(messageEl, 4).then((entry) => {
            state.resolving = false;
            if (entry && entry.url && !state.revealed && state.card.isConnected) {
              reveal(state, entry.url);
            }
          });
        }
        return;
      }
    }
  }

  // ------------------------------------------------- history video players
  /** The inline player DOM (.nelth-vidh): <video controls> + a slim bar
   *  (name · Télécharger). Shared by the legacy-card swap and the
   *  type-'video' message players. */
  function buildPlayerDom(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'nelth-vidh';
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    video.setAttribute('aria-label', 'AI generated video');
    video.src = entry.url;

    const bar = document.createElement('div');
    bar.className = 'nelth-vidh-bar';
    const name = document.createElement('span');
    name.className = 'nelth-vidh-name';
    name.textContent = String(entry.name || 'generated-video.mp4');
    const dl = document.createElement('a');
    dl.className = 'nelth-vidh-dl';
    dl.textContent = 'Télécharger';
    dl.href = entry.url;
    dl.setAttribute('download', String(entry.name || 'generated-video.mp4'));
    bar.appendChild(name);
    bar.appendChild(dl);
    wrap.appendChild(video);
    wrap.appendChild(bar);
    return wrap;
  }

  /** LEGACY 'file'-typed turns: file cards (.mp4 names) in messages WITHOUT
   *  an active generation card → replace with an inline player. The URL
   *  comes from the chat history (same resolution path); the native card is
   *  hidden at once (never painted on chat load — restored if the resolution
   *  fails). */
  const upgradedCards = new WeakSet();

  function buildHistoryPlayer(btn, entry) {
    const wrap = buildPlayerDom(entry);
    // Insert after the card's own wrapper; hide the card (never the whole
    // files grid — other files of the message stay visible).
    const cardWrap = btn.parentElement && !/overflow-x-auto/.test(String(btn.parentElement.className || ''))
      ? btn.parentElement
      : btn;
    if (cardWrap.parentElement) {
      cardWrap.parentElement.insertBefore(wrap, cardWrap.nextSibling);
      cardWrap.classList.add('nelth-vidc-hide');
    }
  }

  function upgradeHistoryCards() {
    const btns = document.querySelectorAll('[id^="message-"] button');
    for (let i = 0; i < btns.length; i++) {
      const btn = btns[i];
      if (upgradedCards.has(btn) || btn.closest('.nelth-vidc')) continue;
      const txt = (btn.textContent || '').trim();
      if (!/\.mp4(\s|$)/i.test(txt)) continue;
      const messageEl = btn.closest('[id^="message-"]');
      if (!messageEl) continue;
      // Skip cards owned by a message with an ACTIVE generation card — the
      // live reveal handles those (and hides the card itself).
      let owned = false;
      for (const s of cards.values()) {
        if (s.card.isConnected && messageEl.contains(s.card)) { owned = true; break; }
      }
      if (owned) continue;
      upgradedCards.add(btn);
      // Hide the native card IMMEDIATELY (before it ever paints on chat
      // load) — the player replaces it; restored if resolution fails.
      const cardWrap = btn.parentElement && !/overflow-x-auto/.test(String(btn.parentElement.className || ''))
        ? btn.parentElement
        : btn;
      cardWrap.classList.add('nelth-vidc-hide');
      void resolveVideoUrl(messageEl, 2).then((entry) => {
        if (entry && entry.url && btn.isConnected) {
          buildHistoryPlayer(btn, entry);
        } else if (cardWrap.isConnected) {
          cardWrap.classList.remove('nelth-vidc-hide');
        }
      });
    }
  }

  /** type-'video' turns (the new attach type): the compiled message grid
   *  renders NOTHING for them (it only maps ["image","file"]) — no native
   *  card exists to swap. The player is inserted where the files grid would
   *  sit (first child of the .chat-assistant inner container), the URL
   *  resolved from the chat history API. */
  const upgradedVideos = new WeakMap(); // messageEl → { entry, wrap }
  const videosResolvedEmpty = new WeakSet(); // messageEl → looked, no video
  const videosInFlight = new WeakSet(); // resolution guard

  function insertHistoryVideoPlayer(messageEl, entry) {
    const wrap = buildPlayerDom(entry);
    const container = messageEl.querySelector('.chat-assistant > div') || messageEl;
    container.insertBefore(wrap, container.firstChild);
    return wrap;
  }

  function upgradeHistoryVideos() {
    const els = document.querySelectorAll('[id^="message-"]');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (videosResolvedEmpty.has(el) || videosInFlight.has(el)) continue;
      if (el.querySelector('.nelth-vidh') || el.querySelector('.nelth-vidc')) continue;
      // Legacy 'file'-typed message (a .mp4 card button is in the DOM) →
      // upgradeHistoryCards owns it — never both paths on one message.
      let hasLegacyCard = false;
      const btns = el.querySelectorAll('button');
      for (let j = 0; j < btns.length; j++) {
        if (/\.mp4(\s|$)/i.test((btns[j].textContent || '').trim())) { hasLegacyCard = true; break; }
      }
      if (hasLegacyCard) continue;
      // Messages with an ACTIVE generation card → the live reveal owns them.
      let owned = false;
      for (const s of cards.values()) {
        if (s.card.isConnected && el.contains(s.card)) { owned = true; break; }
      }
      if (owned) continue;
      const rec = upgradedVideos.get(el);
      if (rec) {
        // Svelte re-render dropped the player — re-insert (URL known).
        if (!el.contains(rec.wrap) && el.isConnected) {
          rec.wrap = insertHistoryVideoPlayer(el, rec.entry);
        }
        continue;
      }
      videosInFlight.add(el);
      void videoEntryOf(el, 15000).then((entry) => {
        videosInFlight.delete(el);
        if (!entry || !entry.url || !el.isConnected) {
          if (!entry) videosResolvedEmpty.add(el);
          return;
        }
        const wrap = insertHistoryVideoPlayer(el, entry);
        upgradedVideos.set(el, { entry, wrap });
      }).catch(() => { videosInFlight.delete(el); });
    }
  }

  // ------------------------------------------------------------- scanning
  function scan() {
    // 1 — dead cards. A card whose MESSAGE vanished (chat switch, re-render,
    //     navigation) is dropped at once. A card whose STATUS ROW vanished
    //     while the video is still unrevealed gets ONE resolution attempt
    //     first — with type 'video' nothing renders natively, and the app
    //     can drop the status row at the done status: the video entry is
    //     already persisted (the backend upserts BEFORE the files event), so
    //     resolving here reveals instead of losing the player. Revealed
    //     cards survive a dead status row — the player stays.
    for (const [box, state] of cards) {
      if (!state.card.isConnected) {
        dropCard(state);
        cards.delete(box);
        continue;
      }
      if (!box.isConnected && !state.revealed && !state.resolveStarted && !state.resolving) {
        state.resolveStarted = true;
        state.resolving = true;
        const messageEl = state.card.closest('[id^="message-"]');
        if (messageEl) {
          resolveVideoUrl(messageEl, 3).then((entry) => {
            state.resolving = false;
            if (entry && entry.url && !state.revealed && state.card.isConnected) {
              reveal(state, entry.url);
            } else if (!state.revealed) {
              dropCard(state);
              cards.delete(state.statusBox);
            }
          });
        } else {
          state.resolving = false;
          dropCard(state);
          cards.delete(box);
        }
      }
    }

    // 2 — create cards for in-progress video generations. The live status
    //     row carries the shimmer class while the job runs.
    const shimmerEls = document.querySelectorAll('.shimmer');
    for (let i = 0; i < shimmerEls.length; i++) {
      const el = shimmerEls[i];
      const text = (el.textContent || '').trim();
      if (!VID_STATUS_RE.test(text)) continue;
      const btn = el.closest ? el.closest('button') : null;
      const statusBox = btn ? btn.parentElement : null;
      if (!statusBox || !statusBox.parentElement) continue;
      if (statusBox.dataset.nelthVidCard) continue;
      createCard(statusBox);
    }

    for (const state of cards.values()) {
      if (!state.card.isConnected) continue;

      // 3 — live phase label + chosen ratio from the current status text.
      //     Once revealed the footer stays on 'Generated' (the trailing
      //     '· finalizing' phase must not overwrite it).
      const live = state.statusBox.querySelector('.shimmer');
      if (live && !state.revealed) {
        const text = (live.textContent || '').trim();
        applyStatusText(state, text);
      }

      // 4 — reveal check: the video's FILE CARD (the .mp4 button) triggers
      //     the async URL resolution (the fast observer covers the frames
      //     between scans; this is the safety net).
      checkReveal(state);

      // 5 — generation ended (the shimmer row is gone — or the row itself
      //     left, handled in step 1): resolve the video URL from the chat
      //     history — the message is persisted BEFORE the done status fires.
      //     Reveal on success; drop the card when no video is found (error /
      //     abort) — with type 'video' there is no native rendering to hand
      //     back to, the error message takes over.
      if (!state.revealed && !live && !state.resolveStarted) {
        state.resolveStarted = true;
        state.resolving = true;
        const messageEl = state.statusBox.closest('[id^="message-"]') || state.card.parentElement;
        if (messageEl) {
          resolveVideoUrl(messageEl, 3).then((entry) => {
            state.resolving = false;
            if (entry && entry.url && !state.revealed && state.card.isConnected) {
              reveal(state, entry.url);
            } else if (!state.revealed) {
              dropCard(state);
              cards.delete(state.statusBox);
            }
          });
        } else {
          state.resolving = false;
          dropCard(state);
          cards.delete(state.statusBox);
        }
      } else if (state.revealed) {
        // keep the native card hidden across Svelte re-renders
        hideNativeCard(state);
      }
    }

    // 6 — history videos: legacy 'file' cards (.mp4 buttons) → inline
    //     players; newer type-'video' messages render nothing natively —
    //     their players are inserted from the resolved history entries.
    upgradeHistoryCards();
    upgradeHistoryVideos();
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

/* ====================================================================
 * Thinking-status cleanup — « Réflexion »
 *
 * The backend shows a shimmer "Réflexion" status row the instant a message
 * is sent (instant feedback during the ~3s silent phase before the free
 * model's first token) and clears it when content starts. The frontend
 * keeps every status entry in the message's status history — right for
 * INFORMATIVE labels (« 10 résultats trouvés », « Generated ») but the
 * transient thinking label must not linger like a stray log line.
 *
 * Rule: the thinking rows hide the MOMENT the AI starts responding — i.e.
 * as soon as answer content (or streaming reasoning prose) is visible —
 * and stay hidden once the message is DONE (its action toolbar — Copy /
 * Read Aloud — renders only on completion). While the message is still
 * silent (no content yet, live shimmer row) the row stays: it IS the live
 * feedback. Both label spellings are matched — « Réflexion » (current) and
 * « Réflexion… » (history persisted before the ellipsis was dropped).
 * ==================================================================== */
(() => {
  'use strict';
  if (window.__NELTH_THINK_CLEAN__) return;
  window.__NELTH_THINK_CLEAN__ = true;

  const THINKING_LABELS = ['Réflexion', 'Réflexion…'];
  const isThinkingLabel = (txt) => THINKING_LABELS.indexOf((txt || '').trim()) !== -1;

  if (!document.getElementById('nelth-think-style')) {
    const style = document.createElement('style');
    style.id = 'nelth-think-style';
    style.textContent = '.nelth-think-hide,.nelth-think-plain{display:none !important}';
    document.head.appendChild(style);
  }

  /** The AI is already answering: answer text or streaming reasoning prose
   *  is on screen. The thinking row must vanish NOW, not at completion. */
  const messageResponding = (msgEl) => {
    const prose = msgEl.querySelectorAll('.markdown-prose, .markdown-prose-sm');
    for (let i = 0; i < prose.length; i++) {
      if ((prose[i].textContent || '').trim()) return true;
    }
    return false;
  };

  /**
   * Timeline chrome on the thinking label — state-dependent (latest ask):
   *   • Skills / web search engaged (the status block mixes « Réflexion »
   *     with informative rows) → the user LIKES the dot-and-line Activity
   *     Timeline: every visible row, thinking label included, KEEPS its
   *     decoration.
   *   • Direct answer (thinking-only block) → plain « Réflexion », no
   *     timeline chrome: the row loses its decoration wrapper (the dot +
   *     vertical connector line) and renders as simple text.
   * Reversible on purpose: a tool-less generation starts as a lone
   * « Réflexion » row (decor stripped), and the moment an informative
   * status joins the same block (web search fired) the timeline comes
   * back for every visible row.
   */
  function stripTimelineDecor(msgEl) {
    const rows = msgEl.querySelectorAll('.status-description');
    // Group rows by their enclosing status block so the decision is made
    // per block, not per row (same grouping as cleanMessage below).
    const blocks = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let block = row.parentElement;
      while (block && block !== msgEl) {
        if (String(block.className).indexOf('text-[0.9375rem]') !== -1) break;
        block = block.parentElement;
      }
      if (!block || block === msgEl) block = row.parentElement;
      if (!blocks.has(block)) blocks.set(block, []);
      blocks.get(block).push(row);
    }
    blocks.forEach((blockRows) => {
      let informative = 0;
      for (let i = 0; i < blockRows.length; i++) {
        if (!isThinkingLabel(blockRows[i].textContent)) informative++;
      }
      const plain = informative === 0; // thinking-only block → no timeline
      for (let i = 0; i < blockRows.length; i++) {
        // Expanded-view rows only: the description is a DIRECT child of the
        // timeline row (.flex.items-stretch) whose first child is the decor
        // (dot + connector). The collapsed toggle view carries no decor.
        const host = blockRows[i].parentElement;
        if (!host || String(host.className).indexOf('items-stretch') === -1) {
          continue;
        }
        const decor = host.firstElementChild;
        if (
          !decor ||
          decor === blockRows[i] ||
          decor.classList.contains('status-description') ||
          !(
            decor.querySelector('span.rounded-full') ||
            !(decor.textContent || '').trim()
          )
        ) {
          continue;
        }
        if (plain) decor.classList.add('nelth-think-plain');
        else decor.classList.remove('nelth-think-plain');
      }
    });
  }

  function cleanMessage(msgEl) {
    // Timeline de-decoration runs first, in every state.
    stripTimelineDecor(msgEl);
    // Done marker: the action toolbar only renders on completed messages.
    const done = !!msgEl.querySelector(
      'button[aria-label="Copy"], button[aria-label="Read Aloud"]'
    );
    if (!done && !messageResponding(msgEl)) {
      return; // still silent — keep the live shimmer row
    }
    // Status rows live in per-view blocks (collapsed toggle view + history
    // list). Group the .status-description rows by their enclosing block
    // (the div[class*="text-[0.9375rem]"] wrapper) so a thinking-only block
    // disappears entirely while a mixed one (search statuses…) only loses
    // its thinking rows.
    const blocks = new Map();
    const rows = msgEl.querySelectorAll('.status-description');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let block = row.parentElement;
      while (block && block !== msgEl) {
        if (String(block.className).indexOf('text-[0.9375rem]') !== -1) break;
        block = block.parentElement;
      }
      if (!block || block === msgEl) block = row.parentElement;
      if (!blocks.has(block)) blocks.set(block, []);
      blocks.get(block).push(row);
    }
    blocks.forEach((blockRows, block) => {
      let labelRows = 0;
      for (let i = 0; i < blockRows.length; i++) {
        if (isThinkingLabel(blockRows[i].textContent)) labelRows++;
      }
      if (!labelRows) return;
      if (labelRows === blockRows.length) {
        // Thinking-only block: hide the whole wrapper (no orphan panel).
        block.classList.add('nelth-think-hide');
      } else {
        for (let i = 0; i < blockRows.length; i++) {
          if (!isThinkingLabel(blockRows[i].textContent)) continue;
          // Expanded view: hide the WHOLE timeline row (decor + label) —
          // hiding the label alone would leave an orphan dot + connector
          // line behind. Collapsed toggle rows carry no decor: hiding the
          // label alone is enough there.
          const host = blockRows[i].parentElement;
          if (host && String(host.className).indexOf('items-stretch') !== -1) {
            host.classList.add('nelth-think-hide');
          } else {
            blockRows[i].classList.add('nelth-think-hide');
          }
        }
      }
    });
    // The collapse toggle shows the LAST status — hide it too when it is
    // the thinking label (mixed blocks keep their informative last status).
    const toggles = msgEl.querySelectorAll('button[aria-label="Toggle status history"]');
    for (let i = 0; i < toggles.length; i++) {
      if (isThinkingLabel(toggles[i].textContent)) {
        toggles[i].classList.add('nelth-think-hide');
      }
    }
    // Expanded history rows of the same label (panel open at completion).
    const shimmers = msgEl.querySelectorAll('.shimmer');
    for (let i = 0; i < shimmers.length; i++) {
      if (isThinkingLabel(shimmers[i].textContent)) {
        shimmers[i].classList.add('nelth-think-hide');
      }
    }
  }

  function scan() {
    const msgs = document.querySelectorAll('[id^="message-"]');
    for (let i = 0; i < msgs.length; i++) cleanMessage(msgs[i]);
  }

  let pending = false;
  const scheduleScan = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan();
    }, 300);
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

/* ====================================================================
 * CONTROLS PANEL GUARDIAN — the chat « Contrôles » panel is retired.
 *
 * The header button is already hidden (custom.css hides the sliders
 * button in the lg:mr-1 cluster), but the panel itself could still
 * surface through three side doors:
 *   1. the MOBILE right-edge swipe — the SwipeablePanel shell listens
 *      for touchstart on window (bubble, passive) and reveals the
 *      full-screen drawer (min-h-[100dvh]) from a finger dragged in
 *      from the right edge. On a phone this fires CONSTANTLY by
 *      accident (scrolling near the edge) — the « toujours affiché »
 *      report. A capture-phase listener stops those touches before
 *      the shell's listener ever sees them (left-edge sidebar swipe
 *      untouched).
 *   2. citation / file-nav clicks set the panel store directly
 *      (showControls.set(true)) — auto-open.
 *   3. any residual open state surviving a hot navigation.
 * This layer closes the panel through its OWN Close button the frame
 * it mounts — the app store resets to false, the drawer animates out,
 * unmounts and releases the body scroll lock. custom.css keeps both
 * surfaces from ever painting a frame in the meantime.
 *
 * Surfaces (verified unique in the compiled bundle):
 *   • mobile drawer:  [data-swipe-panel="right"]  (the swipeable modal)
 *   • desktop dock:   div.h-full.z-10.bg-white.dark:bg-gray-900 (the
 *     resizable sidebar, storageKey chatControlsSize) + its 1px resize
 *     handle sibling.
 * The panel's Close button is locale-proof: the only textless button
 * carrying the lucide X glyph (path starting "M6 18 18 6").
 * ==================================================================== */
(() => {
  'use strict';
  if (window.__NELTH_CONTROLS_GUARD__) return;
  window.__NELTH_CONTROLS_GUARD__ = true;

  // 1 — kill the right-edge swipe gesture at capture phase. The shell
  //     registers touchstart on window (bubble); stopping propagation
  //     during the window capture phase keeps the event from ever
  //     reaching it, so the drag never starts, the drawer never mounts,
  //     the scroll lock never engages.
  window.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      if (t.clientX > window.innerWidth - 24) e.stopPropagation();
    },
    { capture: true, passive: true }
  );

  // 2 — auto-close. Cooldown: clicking Close starts a ~210ms exit
  //     animation during which the surface is still mounted — do not
  //     re-click (and do not dispatch Escape) until it has settled.
  const COOLDOWN_MS = 450;
  let lastCloseAt = 0;

  function panelSurfaces() {
    const out = [];
    const drawer = document.querySelector('[data-swipe-panel="right"]');
    if (drawer && drawer.isConnected) out.push(drawer);
    const docks = document.querySelectorAll('div.h-full.z-10.bg-white.dark\\:bg-gray-900');
    for (let i = 0; i < docks.length; i++) {
      if (docks[i].isConnected) out.push(docks[i]);
    }
    return out;
  }

  function findCloseButton(surface) {
    const btns = surface.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      if ((b.textContent || '').trim()) continue; // tab buttons carry labels
      const path = b.querySelector('svg path');
      const d = path ? path.getAttribute('d') || '' : '';
      if (d.indexOf('M6 18 18 6') === 0) return b; // lucide X glyph
    }
    return null;
  }

  function guard() {
    if (Date.now() - lastCloseAt < COOLDOWN_MS) return;
    const surfaces = panelSurfaces();
    for (let i = 0; i < surfaces.length; i++) {
      const close = findCloseButton(surfaces[i]);
      if (close) {
        lastCloseAt = Date.now();
        close.click();
        return;
      }
    }
    // No Close button (call overlay replaces the tab row) — the swipe
    // drawer at least owns an Escape handler; give it one try.
    if (surfaces.length && document.querySelector('[data-swipe-panel="right"]')) {
      lastCloseAt = Date.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  }

  const start = () => {
    const obs = new MutationObserver(guard);
    obs.observe(document.body, { childList: true, subtree: true });
    guard();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
