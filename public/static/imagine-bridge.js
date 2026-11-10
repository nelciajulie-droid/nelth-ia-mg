/**
 * Nelth-IA — Imagine Studio sidebar bridge.
 *
 * Injects the « Imagine Studio » nav item into the compiled Open WebUI SPA:
 *   • desktop icon row — sibling right after the icon-only /workspace link ;
 *   • mobile/expanded drawer — a text row right after [data-id="workspace"].
 *
 * Robustness rules:
 *   • idempotent (data-imagine-studio markers) — Svelte re-renders (route
 *     changes, sidebar collapse/expand) re-inject through a MutationObserver ;
 *   • data-sveltekit-reload forces a FULL page load to /images (the studio is
 *     a Next.js route, not a SvelteKit one — its router must not intercept) ;
 *   • styling clones the surrounding sidebar utility classes (light + dark).
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

  /** Desktop — icon-only square link (same classes as /workspace). */
  function makeIconLink() {
    var a = document.createElement('a');
    a.className = ' cursor-pointer flex size-8 items-center justify-center transition group';
    a.setAttribute('draggable', 'false');
    a.setAttribute('href', '/images');
    a.setAttribute('aria-label', LABEL);
    a.setAttribute('title', LABEL);
    a.setAttribute('data-imagine-studio', '1');
    applyAttrs(a);
    a.innerHTML =
      '<div class="self-center flex size-[calc(30px*var(--app-text-scale,1))] items-center ' +
      'justify-center rounded-lg transition group-hover:bg-gray-100 dark:group-hover:bg-gray-900">' +
      ICON +
      '</div>';
    return a;
  }

  /** Drawer — icon + label row (same classes as the workspace row). */
  function makeDrawerLink() {
    var a = document.createElement('a');
    a.id = 'sidebar-imagine-button';
    a.className =
      'grow flex items-center space-x-2 rounded-xl px-2 py-1.5 transition ' +
      'hover:bg-gray-100 dark:hover:bg-gray-900';
    a.setAttribute('draggable', 'false');
    a.setAttribute('href', '/images');
    a.setAttribute('aria-label', LABEL);
    a.setAttribute('data-imagine-studio', '1');
    applyAttrs(a);
    a.innerHTML =
      '<div class="self-center flex size-4 shrink-0 items-center justify-center">' +
      ICON +
      '</div><span class="truncate">' +
      LABEL +
      '</span>';
    return a;
  }

  function insertAfter(node, anchor) {
    if (anchor.after) anchor.after(node);
    else if (anchor.parentElement) anchor.parentElement.appendChild(node);
  }

  function inject() {
    try {
      // 1) Desktop icon rows (the sidebar can exist twice in the DOM — the
      //    hidden drawer renders its own icon rows on some breakpoints).
      document.querySelectorAll('a[href="/workspace"]').forEach(function (ws) {
        var text = (ws.textContent || '').trim();
        if (text) return; // drawer text variant handled below
        var parent = ws.parentElement;
        if (!parent || parent.querySelector('[data-imagine-studio]')) return;
        insertAfter(makeIconLink(), ws);
      });

      // 2) Drawer rows (with label, wrapped in [data-id="workspace"]).
      document.querySelectorAll('[data-id="workspace"]').forEach(function (wrap) {
        var parent = wrap.parentElement;
        if (!parent || parent.querySelector('[data-id="imagine-studio"]')) return;
        var row = document.createElement('div');
        row.className = 'px-1 flex justify-center text-gray-700 dark:text-gray-300';
        row.setAttribute('data-id', 'imagine-studio');
        row.setAttribute('data-imagine-studio', '1');
        row.appendChild(makeDrawerLink());
        insertAfter(row, wrap);
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
