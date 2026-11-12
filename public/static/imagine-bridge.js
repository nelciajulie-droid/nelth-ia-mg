/**
 * Nelth-IA — Imagine Studio sidebar bridge.
 *
 * Injects the « Imagine Studio » nav item into the compiled Open WebUI SPA,
 * replicating EXACTLY the DOM structure of the sibling nav items:
 *
 *   • Icon rail (collapsed sidebar) — each nav icon lives in its OWN wrapper:
 *       <div>                          ← item wrapper (sibling of the others)
 *         <div class="flex">           ← row
 *           <a class="cursor-pointer flex size-8 …group">
 *             <div class="self-center flex size-[calc(30px*var(--app-text-scale,1))] …">
 *               <svg class="size-4">
 *     …so the icons stack VERTICALLY like New Chat / Search / Notes / Workspace
 *     (never side-by-side inside a single flex row).
 *
 *   • Drawer (expanded sidebar) — a row mirroring [data-id="workspace"]:
 *       <div data-id="imagine-studio" class="px-1 flex justify-center …">
 *         <a id="sidebar-imagine-button" class="grow flex items-center space-x-2 rounded-xl px-2 py-1.5 …">
 *           <div class="self-center flex size-4 shrink-0 …">svg</div>
 *           <div class="flex self-center translate-y-[0.5px]">
 *             <div class="self-center text-[0.8125rem] leading-5">Imagine Studio</div>
 *           </div>
 *
 * Robustness rules:
 *   • idempotent (data-imagine-studio markers) — Svelte re-renders (route
 *     changes, sidebar collapse/expand) re-inject through a MutationObserver ;
 *   • data-sveltekit-reload forces a FULL page load to /images (the studio is
 *     a Next.js route, not a SvelteKit one — its router must not intercept) ;
 *   • the bridge must never break the host SPA (all lookups guarded).
 */
(() => {
  if (window.__nelthImagineBridge) return;
  window.__nelthImagineBridge = true;

  var LABEL = 'Imagine Studio';

  // Lucide « image » (stroke 1.5 — same family as the other sidebar icons).
  var ICON =
    '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
    'fill="none" class="size-4" stroke-width="1.5">' +
    '<rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.5"></rect>' +
    '<circle cx="9" cy="9" r="2" stroke="currentColor" stroke-width="1.5"></circle>' +
    '<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"></path>' +
    '</svg>';

  var SVELTEKIT_ATTRS = {
    'data-sveltekit-reload': '',
    'data-sveltekit-preload-data': 'off',
    'data-sveltekit-preload-code': 'off',
  };

  function applyAttrs(el) {
    Object.keys(SVELTEKIT_ATTRS).forEach(function (key) {
      el.setAttribute(key, SVELTEKIT_ATTRS[key]);
    });
  }

  function insertAfter(node, anchor) {
    if (anchor.after) anchor.after(node);
    else if (anchor.parentElement) anchor.parentElement.appendChild(node);
  }

  /**
   * Rail icon link — SAME classes as the sibling `a[href="/notes"]` /
   * `a[href="/workspace"]` icon links (size-8 square, 30px hover tile).
   */
  function makeIconLink() {
    var a = document.createElement('a');
    a.className = ' cursor-pointer flex size-8 items-center justify-center transition group';
    a.setAttribute('draggable', 'false');
    a.setAttribute('href', '/images');
    a.setAttribute('aria-label', LABEL);
    a.setAttribute('title', LABEL);
    applyAttrs(a);
    a.innerHTML =
      '<div class="self-center flex size-[calc(30px*var(--app-text-scale,1))] items-center ' +
      'justify-center rounded-lg transition group-hover:bg-gray-100 dark:group-hover:bg-gray-900">' +
      ICON +
      '</div>';
    return a;
  }

  /**
   * Rail item wrapper — the EXACT structure of the other nav items:
   * bare <div> > <div class="flex"> > link. Inserted as a SIBLING wrapper
   * AFTER the Workspace item's own wrapper so the icons stack vertically.
   */
  function makeIconItem() {
    var item = document.createElement('div');
    item.setAttribute('data-imagine-studio', '1');
    var row = document.createElement('div');
    row.className = 'flex';
    row.appendChild(makeIconLink());
    item.appendChild(row);
    return item;
  }

  /**
   * Drawer row — same structure as the [data-id="workspace"] row:
   * px-1 wrapper > grow anchor > 16px icon tile + 13px label.
   */
  function makeDrawerRow() {
    var row = document.createElement('div');
    row.className = 'px-1 flex justify-center text-gray-700 dark:text-gray-300';
    row.setAttribute('data-id', 'imagine-studio');
    row.setAttribute('data-imagine-studio', '1');

    var a = document.createElement('a');
    a.id = 'sidebar-imagine-button';
    a.className =
      'grow flex items-center space-x-2 rounded-xl px-2 py-1.5 transition ' +
      'hover:bg-gray-100 dark:hover:bg-gray-900';
    a.setAttribute('draggable', 'false');
    a.setAttribute('href', '/images');
    a.setAttribute('aria-label', LABEL);
    applyAttrs(a);
    a.innerHTML =
      '<div class="self-center flex size-4 shrink-0 items-center justify-center">' +
      ICON +
      '</div>' +
      '<div class="flex self-center translate-y-[0.5px]">' +
      '<div class="self-center text-[0.8125rem] leading-5">' +
      LABEL +
      '</div>' +
      '</div>';
    row.appendChild(a);
    return row;
  }

  function inject() {
    try {
      // 1) Icon rail — every icon-only /workspace link (the sidebar can exist
      //    twice in the DOM at some breakpoints). The link sits 2 levels deep:
      //    a → div.flex → wrapper div. We insert our own FULL wrapper right
      //    after it, inside the nav items container — vertical stacking,
      //    exactly like New Chat / Search / Notes / Workspace.
      document.querySelectorAll('a[href="/workspace"]').forEach(function (ws) {
        var text = (ws.textContent || '').trim();
        if (text) return; // drawer text variant handled below
        var row = ws.parentElement; // div.flex
        var wrapper = row ? row.parentElement : null; // bare item wrapper
        if (!wrapper || !wrapper.parentElement) return;
        var host = wrapper.parentElement; // nav items container
        if (host.querySelector('[data-imagine-studio]')) return;
        insertAfter(makeIconItem(), wrapper);
      });

      // 2) Drawer rows (with label, wrapped in [data-id="workspace"]).
      document.querySelectorAll('[data-id="workspace"]').forEach(function (wrap) {
        var parent = wrap.parentElement;
        if (!parent || parent.querySelector('[data-id="imagine-studio"]')) return;
        insertAfter(makeDrawerRow(), wrap);
      });
    } catch (e) {
      /* the bridge must never break the host SPA */
    }
  }

  inject();

  // Re-inject after SPA re-renders (debounced).
  var scheduled = false;
  var observer = new MutationObserver(function () {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(function () {
      scheduled = false;
      inject();
    }, 150);
  });

  function start() {
    try {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      }
    } catch (e) {
      /* observer unavailable — the initial injection already landed */
    }
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
