/* ── stream-fade-bridge.js — stagger du fondu streaming (spec Streamdown) ──────
 * custom.css pose le fondu par mot (.fade-in-token → 260ms ease-out, opacité
 * seule, fill both). Ce pont ajoute la pièce que le CSS seul ne peut pas
 * faire : le STAGGER.
 *
 *   stagger: 24  → chaque LOT de mots insérés par le flux reçoit un délai
 *                 progressif : mot 1 à 0ms, mot 2 à 24ms, mot 3 à 48ms…
 *                 Un chunk SSE de plusieurs mots s'écrit en CASCADE au lieu
 *                 de « poper » d'un bloc. Le compteur se RÉINITIALISE à
 *                 chaque nouveau lot (comme Streamdown, qui stagger par
 *                 batch de rendu).
 *
 * Garanti « never re-animates » : on ne touche QUE les nœuds nouvellement
 * insérés — les mots déjà affichés gardent leur nœud DOM (each-block Svelte
 * indexé) et ne sont jamais re-stylés ni re-animés.
 *
 * Pourquoi un MutationObserver plutôt que patcher le bundle :
 *   • le callback tourne en microtask AVANT le premier paint du mot → le
 *     delay est posé avant que le mot ne s'affiche (aucun flash à 0ms) ;
 *   • les spans .fade-in-token n'existent QUE pendant le streaming (le
 *     composant compilé les remplace par du texte brut dès que done=true,
 *     et respecte le réglage utilisateur chatFadeStreamingText) — ouvrir
 *     une ancienne discussion n'insère aucun span : rien ne s'anime ;
 *   • zéro modification du bundle immuable.
 *
 * Déduplication : un même lot peut arriver via un conteneur (<p> inséré) ET
 * via ses enfants directs (records distincts du subtree) — un Set + tri par
 * position DOM garantit un délai unique, croissant dans l'ordre de lecture.
 */
(function () {
        'use strict';

        if (window.__nelthStreamFadeBridge) return; // idempotent
        window.__nelthStreamFadeBridge = true;

        var STAGGER_MS = 24; // spec : stagger 24ms/mot

        function collect(node, set) {
                if (!node || node.nodeType !== 1) return; // nœuds texte ignorés
                if (node.classList.contains('fade-in-token')) {
                        set.add(node);
                        return;
                }
                // Conteneur inséré d'un coup (nouveau paragraphe…) → ses mots.
                var spans = node.querySelectorAll('.fade-in-token');
                for (var i = 0; i < spans.length; i++) set.add(spans[i]);
        }

        var observer = new MutationObserver(function (records) {
                var set = new Set();
                for (var i = 0; i < records.length; i++) {
                        var added = records[i].addedNodes;
                        for (var j = 0; j < added.length; j++) collect(added[j], set);
                }
                if (set.size === 0) return; // UI quelconque (menus, toasts…) → sortie
                // Ordre DOM → délais croissants dans l'ordre de lecture.
                // NB : Array.prototype.slice.call(set) serait VIDE (un Set n'a
                // ni .length ni indices) — Array.from gère l'itérable.
                var fresh = Array.from(set).sort(function (a, b) {
                        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
                });
                for (var k = 0; k < fresh.length; k++) {
                        fresh[k].style.animationDelay = (k * STAGGER_MS) + 'ms';
                }
        });

        function start() {
                observer.observe(document.body, { childList: true, subtree: true });
        }
        if (document.body) start();
        else window.addEventListener('DOMContentLoaded', start, { once: true });
})();
