/* ── autoscroll-bridge.js — scroll auto ChatGPT à l'envoi d'un message ────────
 * Demande : « quand l'utilisateur envoie un message, le dernier message
 * s'affiche directement comme PREMIER (en haut de la vue) et la discussion
 * précédente remonte au-dessus » — MAIS seulement à partir du DEUXIÈME
 * message utilisateur : le PREMIER message d'une discussion ne prend PAS
 * cet ancrage (il resterait seul tout en haut d'un écran vide) et garde
 * le comportement d'origine (en bas, la réponse streame dessous).
 *
 * Le bundle scrolle déjà vers le bas à l'envoi (le nouveau message atterrit au
 * milieu de la vue). Ce pont implémente la mécanique EXACTE de ChatGPT :
 *
 *   1. ENVOI à partir du 2ᵉ message (un seul nouveau message utilisateur
 *      ajouté à la fin, et au moins un message utilisateur précédent) →
 *      ESPACEUR (élément <li> à la fin de la liste, hauteur = la vue) puis
 *      smooth-scroll : le message s'ancre EN HAUT avec une marge (PAD_TOP),
 *      la discussion précédente remonte au-dessus, et l'espace libre
 *      dessous accueille la réponse.
 *      PREMIER message utilisateur d'une discussion → AUCUNE intervention :
 *      pas d'espaceur, pas d'ancrage — le bundle défile vers le bas comme
 *      à l'origine et suit nativement le streaming.
 *      (Sans espaceur, le scroll maximum colle le bas du contenu au bas de
 *      la vue : un message du bas ne peut JAMAIS atteindre le haut.)
 *      NB : l'espaceur doit être un ÉLÉMENT dans le flux — un padding sur
 *      #messages-container casserait son enfant h-full (height:100% de la
 *      content-box → 0) et effondrerait toute la géométrie.
 *   2. STREAMING → l'espaceur RÉTRÉCIT au fur et à mesure que la réponse
 *      grandit dessous (le total reste constant → aucun saut de vue) : la vue
 *      reste ancrée tant que la réponse tient à l'écran ; dès qu'elle
 *      déborde, la vue suit son BAS (le texte le plus récent reste visible
 *      juste au-dessus du composeur).
 *   3. Volonté humaine (molette/tactile vers le haut) → le follow s'arrête.
 *   4. Ouverture d'une discussion (plusieurs messages d'un coup) → espaceur
 *      retiré, comportement d'origine conservé (bas du contenu).
 *
 * La liste peut être virtualisée (content-visibility + contain-intrinsic-size
 * 150px) : les corrections itératives mesurent l'écart RÉEL et corrigent le
 * scrollTop du même delta ; si une estimation plafonne le défilement, on force
 * le rendu complet une fois (html.nelth-fullrender), on ré-ancre sur la
 * géométrie réelle, puis on relâche.
 *
 * Le follow du bundle (autoScroll = en-bas || (autoScroll && pas remonté))
 * se désactive de lui-même pendant notre glissement vers le haut — c'est
 * notre follow qui prend le relais, sans combat. */
(function () {
        'use strict';

        if (window.__nelthAutoscrollBridge) return; // idempotent
        window.__nelthAutoscrollBridge = true;

        var PAD_TOP = 32;          // respiration au-dessus du message ancré (px) —
                                   // « le message est trop haut » : ne pas le
                                   // coller au bord supérieur de la vue
        var PAD_BOTTOM = 14;       // marge sous le bas du contenu suivi (px)
        var ANCHOR_WINDOW_MS = 750; // fenêtre pendant laquelle nos scrolls sont « programme »
        var WHEEL_STOP_MS = 900;   // après une molette vers le haut, on ne suit plus

        var anchorUntil = 0;       // smooth d'ancre en cours (ignorer ses scroll events)
        var progUntil = 0;         // follow programme en cours
        var follow = false;        // follow streaming actif
        var lastTop = -1;          // dernier scrollTop observé (détection manuel)
        var DBG = (window.__nelthAutoscrollDebug = []); // file de diagnostic (capée)
        function dbg(e) { DBG.push(e); if (DBG.length > 50) DBG.shift(); }

        function container() {
                return document.getElementById('messages-container');
        }

        function clamp(v, lo, hi) {
                return Math.max(lo, Math.min(v, hi));
        }

        /** La UL qui porte les messages (celle qui contient les rangées). */
        function messagesUl(el) {
                var row = el.querySelector('.user-message, .chat-assistant');
                if (!row) return null;
                var ul = row.closest('ul');
                return ul || null;
        }

        /** L'espaceur : <li> à la fin de la UL des messages. C'est LUI qui
         *  rend le haut atteignable — le contenu sous le dernier message
         *  (réponse à venir + espace) doit remplir la vue entière. */
        function spacer(el) {
                var ul = messagesUl(el);
                if (!ul) return null;
                var s = ul.querySelector(':scope > li.nelth-spacer');
                if (!s) {
                        s = document.createElement('li');
                        s.className = 'nelth-spacer';
                        s.style.listStyle = 'none';
                        s.style.height = '0px';
                        ul.appendChild(s);
                }
                return s;
        }

        function setSpacer(el, px) {
                var s = spacer(el);
                if (!s) return 0;
                var h = clamp(Math.round(px), 0, el.clientHeight);
                if (Math.round(parseFloat(s.style.height) || 0) !== h) s.style.height = h + 'px';
                return h;
        }

        function spacerH(el) {
                var ul = messagesUl(el);
                if (!ul) return 0;
                var s = ul.querySelector(':scope > li.nelth-spacer');
                return s ? Math.round(parseFloat(s.style.height) || 0) : 0;
        }

        /** Position du BAS de la dernière rangée dans le contenu défilable. */
        function lastRowBottomInContent(el) {
                var rows = el.querySelectorAll('.user-message, .chat-assistant');
                var last = rows[rows.length - 1];
                if (!last) return null;
                return el.scrollTop + (last.getBoundingClientRect().bottom - el.getBoundingClientRect().top);
        }

        /** Ajuste l'espaceur : contenu dessous la dernière rangée + espaceur
         *  ≈ hauteur de la vue → la vue reste stable pendant que la réponse
         *  remplit l'espace, puis l'espaceur disparaît (réponse longue) et le
         *  follow prend le relais. */
        function retuneSpacer(el, why) {
                var rowBottom = lastRowBottomInContent(el);
                if (rowBottom === null) { setSpacer(el, 0); return 0; }
                var contentH = el.scrollHeight - spacerH(el);
                var below = contentH - rowBottom;               // contenu sous la rangée
                var h = clamp(el.clientHeight - below - PAD_BOTTOM, 0, el.clientHeight);
                setSpacer(el, h);
                if (why) dbg({ ev: 'retune-' + why, pad: h, below: Math.round(below) });
                return h;
        }

        function anchorRow(row) {
                var el = container();
                if (!el || !el.contains(row)) return;

                follow = true;
                lastTop = -1;
                // L'espaceur PLEIN d'abord : c'est lui qui rend le haut
                // ATTEIGNABLE.
                setSpacer(el, el.clientHeight);
                anchorUntil = performance.now() + ANCHOR_WINDOW_MS;
                row.scrollIntoView({ block: 'start', behavior: 'smooth' });
                dbg({ ev: 'anchor', clientH: el.clientHeight, spacer: spacerH(el) });

                // Corrections itératives (virtualisation, stabilisation du
                // rendu) : mesurer l'écart RÉEL, corriger du même delta.
                var tries = 0;
                var stalled = 0;
                var lastOff = -1;
                (function correct() {
 setTimeout(function () {
  var el2 = container();
  if (!el2 || !el2.contains(row)) return;
  var off = Math.round(row.getBoundingClientRect().top - el2.getBoundingClientRect().top) - PAD_TOP;
  if (Math.abs(off) <= 24) { releaseFullRender(1200); return; }
  if (tries >= 6) { releaseFullRender(1200); return; }
  tries++;
  if (Math.abs(off - lastOff) < 4) stalled++; else stalled = 0;
  lastOff = off;
  if (stalled >= 2) forceFullRender();
  setSpacer(el2, el2.clientHeight);
  anchorUntil = performance.now() + 300;
  el2.scrollTop += off; // correction par delta réel (borne par le navigateur)
  dbg({ ev: 'correct', off: off, tries: tries, stalled: stalled });
  correct();
 }, 260);
                })();
        }

        /** Rendu complet ponctuel : sort la liste du mode virtualisé pour que
         *  la géométrie (scrollHeight, positions) devienne RÉELLE. */
        function forceFullRender() {
                if (!document.documentElement.classList.contains('nelth-fullrender')) {
                        document.documentElement.classList.add('nelth-fullrender');
                        dbg({ ev: 'fullrender-on' });
                }
        }
        function releaseFullRender(afterMs) {
                setTimeout(function () {
                        document.documentElement.classList.remove('nelth-fullrender');
                }, afterMs || 1500);
        }

        /** Follow : garder le BAS de la réponse visible ; ne défiler que vers
         *  le bas (jamais de rappel vers le haut) — et l'espaceur rétrécit en
         *  même temps que la réponse grandit, donc la vue ne saute jamais. */
        function followTick() {
                if (!follow) return;
                var el = container();
                if (!el) return;
                retuneSpacer(el, null);
                var rowBottom = lastRowBottomInContent(el);
                if (rowBottom === null) return;
                var target = rowBottom + PAD_BOTTOM - el.clientHeight;
                target = clamp(target, 0, el.scrollHeight - el.clientHeight);
                if (target > el.scrollTop + 1) {
                        progUntil = performance.now() + 120;
                        el.scrollTop = target; // instantané, comme le follow du bundle
                }
        }

        // Follow sur chaque mutation (mots streamés = spans ajoutés, blocs…).
        var followObs = new MutationObserver(followTick);

        // Détection d'ENVOI : exactement UNE rangée utilisateur ajoutée.
        // Ouverture d'une discussion (plusieurs rangées d'un coup) → ignoré :
        // on retire l'espaceur et on laisse le comportement d'origine (bas).
        var sendObs = new MutationObserver(function (records) {
                var added = [];
                for (var i = 0; i < records.length; i++) {
                        var nodes = records[i].addedNodes;
                        for (var j = 0; j < nodes.length; j++) {
                                var n = nodes[j];
                                if (n.nodeType !== 1) continue;
                                if (n.classList && n.classList.contains('user-message')) added.push(n);
                                else if (n.querySelectorAll) {
                                        var found = n.querySelectorAll('.user-message');
                                        for (var k = 0; k < found.length; k++) added.push(found[k]);
                                }
                        }
                }
                if (added.length === 0) return;
                if (added.length > 1) { // historique complet (ouverture) → reset
                        var el = container();
                        if (el) setSpacer(el, 0);
                        follow = false;
                        dbg({ ev: 'history', added: added.length });
                        return;
                }
                var row = added[0];
                var el2 = container();
                if (!el2 || !el2.contains(row)) return;
                var userRows = el2.querySelectorAll('.user-message');
                if (userRows.length > 0 && userRows[userRows.length - 1] !== row) return;
                // PREMIER message utilisateur de la discussion (cette rangée
                // est la SEULE) → PAS d'ancrage en haut : le message resterait
                // seul tout en haut d'un écran vide (« trop haut »). On
                // neutralise espaceur + follow et on rend la main au bundle :
                // message en bas, réponse qui streame dessous, suivi natif.
                // L'ancrage ChatGPT ne s'active qu'à partir du 2ᵉ message.
                if (userRows.length < 2) {
                        setSpacer(el2, 0);
                        follow = false;
                        dbg({ ev: 'first-msg-skip', rows: userRows.length });
                        return;
                }
                anchorRow(row);
        });

        function onScroll(el) {
                return function () {
                        var now = performance.now();
                        if (now < anchorUntil || now < progUntil) { lastTop = el.scrollTop; return; }
                        if (follow && lastTop >= 0 && el.scrollTop < lastTop - 2) follow = false;
                        lastTop = el.scrollTop;
                };
        }

        function start() {
                sendObs.observe(document.body, { childList: true, subtree: true });
                var el = container();
                if (el) {
                        el.addEventListener('scroll', onScroll(el), { passive: true, capture: true });
                        followObs.observe(el, { childList: true, subtree: true, characterData: true });
                } else {
                        // Le conteneur monte après le premier rendu — s'y attacher.
                        var boot = new MutationObserver(function () {
                                var c = container();
                                if (c) {
                                        boot.disconnect();
                                        c.addEventListener('scroll', onScroll(c), { passive: true, capture: true });
                                        followObs.observe(c, { childList: true, subtree: true, characterData: true });
                                }
                        });
                        boot.observe(document.body, { childList: true, subtree: true });
                }
                // Molette/tactile vers le haut = volonté humaine → arrêter le follow.
                window.addEventListener('wheel', function (e) {
                        if (follow && e.deltaY < 0) {
                                progUntil = performance.now() + WHEEL_STOP_MS;
                                follow = false;
                        }
                }, { passive: true });
                var lastTouchY = null;
                window.addEventListener('touchmove', function (e) {
                        if (!follow || !e.touches || !e.touches.length) { lastTouchY = null; return; }
                        var y = e.touches[0].clientY;
                        if (lastTouchY !== null && y > lastTouchY + 12) follow = false; // doigt descend = contenu remonte
                        lastTouchY = y;
                }, { passive: true });
                window.addEventListener('touchend', function () { lastTouchY = null; }, { passive: true });
        }
        if (document.body) start();
        else window.addEventListener('DOMContentLoaded', start, { once: true });
})();
