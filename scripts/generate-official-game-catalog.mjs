#!/usr/bin/env bun
/**
 * Generate src/lib/skills/design-catalog.ts from OFFICIAL vendor sources.
 *
 * Sources (v2, November 2025 — replacing the community freshtechbro/gamedev
 * catalogs with official-organization skills):
 *   - github/awesome-copilot (GitHub's OFFICIAL org repo, MIT license)
 *     · skills/game-engine            — web game engines + 216K of references
 *       (MDN / gamedev.net / deepnight sourced), pure markdown, no Python
 *     · skills/gsap-framer-scroll-animation — GSAP ScrollTrigger + Motion v12
 *     · skills/premium-frontend-ui    — premium UI/motion craftsmanship
 *     · skills/web-design-reviewer    — visual design inspection & fixes
 *
 * Local mirror: /skills-games/ (gitignored). The generated catalog is COMMITTED
 * so runtime code needs no filesystem access (serverless-safe).
 *
 * Usage:
 *   bun scripts/generate-official-game-catalog.mjs [src-root] [output.ts]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] || 'skills-games';
const OUT = process.argv[3] || 'src/lib/skills/design-catalog.ts';
const DESC_MAX = 230;
const MAX_CONTENT_CHARS = 24_000;

if (!existsSync(join(ROOT, 'game-engine', 'SKILL.md'))) {
  console.error(`usage: bun scripts/generate-official-game-catalog.mjs [src-root: ${ROOT}] [output.ts]`);
  console.error(`missing ${join(ROOT, 'game-engine', 'SKILL.md')} — clone github/awesome-copilot into skills-games/ first`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Verified guardrails — hallucinated CDN import paths are the #1 killer of
// generated single-file 3D pages (one 404 import = whole module script fails
// silently = blank page). Verified against unpkg three@0.160.0 on 2025-11-05.
// ---------------------------------------------------------------------------

const THREE_GUARDRAIL = `CRITICAL — THREE.JS IMPORT DISCIPLINE (verified against the CDN):
A single wrong import path in a module script makes the ENTIRE file fail SILENTLY — the user gets a blank page with no error. Apply these rules strictly:

1. ONLY these addon paths exist (exact, case-sensitive — verified on unpkg three@0.160.0):
   controls/: OrbitControls.js, PointerLockControls.js, TrackballControls.js, DragControls.js, TransformControls.js
   loaders/: GLTFLoader.js, DRACOLoader.js, FontLoader.js, OBJLoader.js, STLLoader.js, FBXLoader.js
   postprocessing/: EffectComposer.js, RenderPass.js, ShaderPass.js, UnrealBloomPass.js, SSAOPass.js, OutlinePass.js, AfterimagePass.js, BokehPass.js, BloomPass.js, FilmPass.js, GlitchPass.js, HalftonePass.js, SMAAPass.js, TAARenderPass.js
   shaders/: RGBShiftShader.js, FXAAShader.js (use them THROUGH ShaderPass)
   lines/: Line2.js, LineMaterial.js · utils/: BufferGeometryUtils.js · environments/: RoomEnvironment.js

2. NEVER invent module names. These DO NOT EXIST: postprocessing/RGBShift.js, postprocessing/FXAAPass.js, postprocessing/GlutPass.js, postprocessing/GodRaysPass.js, interaction/PointerRaycaster.js. If an effect you want is not in the list above, implement it with ShaderPass + an existing shader, or with plain scene techniques (fog, emissive materials, sprites) instead.

3. SELF-CHECK before finishing: re-read every line 'import ... from "three/addons/..."' in your output and confirm each path appears in the list in rule 1. If any does not, remove or replace it.

4. Pin the import map exactly: "three": "https://unpkg.com/three@0.160.0/build/three.module.js", "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/". NEVER use <script src="...three.min.js"> (removed since r150) and never a bare 'three' import without an import map.

5. Degrade gracefully: the scene must render even if an optional effect fails — wrap purely decorative postprocessing setup in try/catch and fall back to renderer.render() directly.

6. KEEP IT COMPACT — target under ~350 lines total. A modest scene that WORKS beats an ambitious one with a single broken line. Prefer plain scene techniques (fog, emissive materials, sprites, vertex colors, gradient backgrounds) over postprocessing chains; each pass you remove eliminates a failure surface and tokens spent on boilerplate instead of quality.`;

/** Skills whose instructions must carry the three.js import guardrail. */
const GUARDED_SKILLS = new Set(['3d-web-games', 'game-engine', 'web-game-apis']);

// ---------------------------------------------------------------------------
// Skill entries: id → { files (in order, concatenated), label, description,
// keywords, siblingNote }
// ---------------------------------------------------------------------------

const GAME_SIBLING_NOTE = `SIBLING SKILLS — this platform inlines the full game-engine reference set as separate skills. When the task needs deeper expertise, request them with USE_SKILL(name) if not already loaded: 3d-web-games (Three.js/WebGL/WebXR/Babylon.js/A-Frame theory & shaders), game-algorithms (collision, physics, raycasting, vector math), game-controls (touch/keyboard/mouse/gamepad), web-game-apis (Canvas/WebGL/WebAudio/Gamepad APIs), game-techniques (tilemaps, sprites, async, audio), game-engine-principles (engine architecture, ECS), 2d-platformer-engine (grid-based platformer engine, Dead Cells architecture), phaser-platformer (complete Phaser platformer template), paddle-game (complete pure-JS breakout template).`;

const ENTRIES = [
  {
    id: 'game-engine',
    label: 'game-engine',
    description:
      'Master skill for building web-based games and game engines with HTML5 Canvas, WebGL and JavaScript — game loops, physics, collision detection, sprites, controls, audio, multiplayer and publishing, with Phaser, Three.js, Babylon.js and A-Frame. Use for ANY request about creating, designing, debugging or shipping a game — "make me a game", jeu vidéo, gameplay, game jam, moteur de jeu. Start here; sibling skills carry the deep references.',
    keywords: [
      'jeu', 'jeux', 'game', 'games', 'gameplay', 'game design', 'creer un jeu', 'faire un jeu',
      'developper un jeu', 'jeu video', 'video game', 'game jam', 'gamejam', 'level design',
      'moteur de jeu', 'game engine', 'game loop', 'html5 game', 'canvas game', 'jeu web',
      'web game', 'mechaniques de jeu', 'sprite', 'sprites', 'tilemap', 'multiplayer jeu',
    ],
    files: [
      { path: 'game-engine/SKILL.md', stripFrontmatter: true },
    ],
    extra: GAME_SIBLING_NOTE,
  },
  {
    id: '2d-platformer-engine',
    label: '2d-platformer-engine',
    description:
      'Grid-based 2D platformer engine architecture by the lead developer of Dead Cells (deepnight): dual-coordinate positioning (grid cells + sub-pixel ratios), velocity/friction, gravity, and grid-lookup collision detection & response. Use for platformers, tile-based movement, precise jumps, coyote time, wall interactions.',
    keywords: [
      'platformer', 'plateformer', 'jeu de plateforme', 'jump and run', 'mario', 'celeste',
      'coyote time', 'wall jump', 'saut plateforme', 'dead cells', 'deepnight', 'grid collision',
      'moteur plateforme', 'double saut',
    ],
    files: [
      { path: 'game-engine/assets/simple-2d-engine.md', stripFrontmatter: false },
    ],
  },
  {
    id: '3d-web-games',
    label: '3d-web-games',
    description:
      'Complete 3D web game reference: 3D theory (coordinates, cameras, transforms), frameworks (Three.js, Babylon.js, A-Frame, PlayCanvas, model loaders), GLSL shader programming, 3D collision detection and WebXR immersive experiences. Use for ANY 3D scene, 3D game, WebGL/WebGPU rendering, shaders, VR/AR — scene 3D, rendu 3D, objet/modèle 3D, casque VR.',
    keywords: [
      'three.js', 'threejs', 'webgl', 'webgpu', 'babylonjs', 'babylon.js', 'babylon', 'aframe',
      'a-frame', 'webxr', 'rendu 3d', 'scene 3d', 'monde 3d', 'objet 3d', 'modele 3d',
      'visualisation 3d', 'configurateur 3d', 'camera 3d', 'experience immersive', 'jeu 3d',
      'cartes 3d', 'card 3d', 'shader', 'shaders', 'glsl', 'vertex', 'fragment', 'casque vr',
      'realite virtuelle', 'realite augmentee', 'experience vr', 'contenu vr', 'vr', 'ar',
      'lumieres 3d', 'eclairage 3d', 'materiaux 3d', 'texture 3d', 'gltf', 'glb', 'playcanvas',
    ],
    files: [
      { path: 'game-engine/references/3d-web-games.md', stripFrontmatter: false },
    ],
  },
  {
    id: 'game-algorithms',
    label: 'game-algorithms',
    description:
      'Game development algorithms reference: Bresenham line drawing, raycasting, line of sight, pathfinding, collision detection methods, physics simulation (velocity, gravity, springs) and vector mathematics. Use when implementing game physics, collision response, enemy AI movement, or any game math.',
    keywords: [
      'collision', 'collisions', 'physique', 'physics', 'raycasting', 'raycast', 'line of sight',
      'champ de vision', 'pathfinding', 'trouve chemin', 'vector math', 'vecteur math',
      'gravite', 'gravity', 'detection collision', 'rebond', 'bounce', 'spring', 'aabb',
      'sat collision', 'hitbox', 'algorithme jeu',
    ],
    files: [
      { path: 'game-engine/references/algorithms.md', stripFrontmatter: false },
    ],
  },
  {
    id: 'game-controls',
    label: 'game-controls',
    description:
      'Game control mechanisms reference: mobile touch controls (virtual joysticks, multi-touch), desktop keyboard/mouse (WASD, pointer lock), Gamepad API (buttons, axes, vibration) and unconventional inputs. Use for player controls, input handling, touch/multi-touch games, gamepad support.',
    keywords: [
      'manette', 'gamepad', 'controle jeu', 'touch controls', 'joystick virtuel', 'virtual joystick',
      'clavier', 'keyboard', 'wasd', 'touches', 'souris jeu', 'mouse control', 'pointer lock',
      'controles tactiles', 'multi touch', 'input jeu', 'controle joueur', 'boutons tactiles',
      'vibration manette', 'gamepad api',
    ],
    files: [
      { path: 'game-engine/references/game-control-mechanisms.md', stripFrontmatter: false },
    ],
  },
  {
    id: 'web-game-apis',
    label: 'web-game-apis',
    description:
      'Web APIs for games reference: Canvas 2D and WebGL rendering, Web Audio (sound synthesis, spatial audio), Gamepad, Fullscreen, Pointer Lock, requestAnimationFrame, device orientation, storage and network APIs. Use when wiring browser APIs into a game or interactive experience.',
    keywords: [
      'canvas api', 'web audio', 'audio jeu', 'son jeu', 'sound jeu', 'api navigateur',
      'requestanimationframe', 'fullscreen api', 'pointer lock api', 'device orientation',
      'local storage jeu', 'sauvegarde jeu', 'web api', 'api canvas', 'api webgl',
      'audio spatial', 'synthese sonore', 'musique jeu',
    ],
    files: [
      { path: 'game-engine/references/web-apis.md', stripFrontmatter: false },
    ],
  },
  {
    id: 'game-techniques',
    label: 'game-techniques',
    description:
      'Game development techniques reference: collision detection techniques, tilemaps (rendering, scrolling, collision), async script loading, audio in games, sprites and animation techniques. Use for level tiles, scrolling worlds, sprite animation, in-game audio pipelines.',
    keywords: [
      'tilemap', 'tilemaps', 'tuiles', 'scrolling', 'defilement', 'parallaxe jeu',
      'sprite sheet', 'animation sprite', 'audio dans les jeux', 'sons jeu', 'technique jeu',
      'grille', 'tiles', 'carte jeu', 'niveau jeu', 'background scroll',
    ],
    files: [
      { path: 'game-engine/references/techniques.md', stripFrontmatter: false },
    ],
  },
  {
    id: 'game-engine-principles',
    label: 'game-engine-principles',
    description:
      'Core design principles for game engine architecture: modularity, separation of engine vs game code, subsystem decomposition (rendering, physics, input, audio, scene), entity-component patterns and practical implementation guidance. Use when building a reusable engine or structuring a larger game codebase.',
    keywords: [
      'architecture moteur', 'game engine architecture', 'ecs', 'entity component', 'modularite',
      'architecture jeu', 'structure code jeu', 'moteur reutilisable', 'subsystems',
      'engine design', 'conception moteur',
    ],
    files: [
      { path: 'game-engine/references/game-engine-core-principles.md', stripFrontmatter: false },
    ],
  },
  {
    id: 'phaser-platformer',
    label: 'phaser-platformer',
    description:
      'Complete working Phaser framework platformer game template: scene setup, physics arcade, player controls, level building, collectibles, enemies, animations, camera follow and state management. Use when the user asks for a Phaser game or a platformer built with the Phaser framework.',
    keywords: [
      'phaser', 'phaser.js', 'phaser 3', 'phaser 4', 'phaser game', 'jeu phaser',
      'arcade physics', 'physique arcade', 'collider', 'overlap phaser',
    ],
    files: [
      { path: 'game-engine/assets/2d-platform-game.md', stripFrontmatter: false },
    ],
  },
  {
    id: 'paddle-game',
    label: 'paddle-game',
    description:
      'Complete pure-JavaScript 2D Breakout game tutorial (MDN-sourced): canvas setup, ball movement, wall bouncing, paddle keyboard/mouse controls, brick field, collision detection, score & lives, win/lose — with full final game code. Use for breakout/casse-briques/Arkanoid-style games and as a minimal-game skeleton.',
    keywords: [
      'breakout', 'casse briques', 'casse-briques', 'arkanoid', 'paddle', 'raquette',
      'briques', 'bricks', 'balle', 'ball game', 'jeu de balle',
    ],
    files: [
      { path: 'game-engine/assets/paddle-game-template.md', stripFrontmatter: false },
    ],
  },
  {
    id: 'gsap-scroll-animation',
    label: 'gsap-scroll-animation',
    description:
      'Production-grade GSAP ScrollTrigger skill: pinning, scrubbing, snapping, timelines, horizontal scroll, ScrollSmoother, matchMedia, React integration with useGSAP, Lenis smooth scroll, accessibility — plus the full API reference and 10 ready recipes. Use for ANY scroll animation, parallax, reveal, pinned section, or "animate on scroll" request.',
    keywords: [
      'gsap', 'greensock', 'scrolltrigger', 'scroll trigger', 'animation au scroll',
      'scroll animation', 'timeline gsap', 'parallax', 'parallaxe', 'section epinglee',
      'pinned section', 'scroll horizontal', 'lenis', 'smooth scroll', 'defilement fluide',
      'reveal au scroll', 'apparition au scroll', 'scrub', 'snap scroll',
    ],
    files: [
      { path: 'gsap-framer-scroll-animation/SKILL.md', stripFrontmatter: true },
      { path: 'gsap-framer-scroll-animation/references/gsap.md', stripFrontmatter: false, header: '\n\n---\n\n# FULL GSAP REFERENCE (inlined)\n\n' },
    ],
  },
  {
    id: 'framer-motion-animation',
    label: 'framer-motion-animation',
    description:
      'Production-grade Framer Motion / Motion v12 skill: useScroll, useTransform, useSpring, whileInView, variants, layout animations, gestures — with the full API reference, 8 ready recipes and Next.js integration tips. Use for ANY React animation request, entrance animations, scroll-linked motion in React/Next.js.',
    keywords: [
      'framer motion', 'framer-motion', 'framer', 'motion react', 'motion/react', 'useScroll',
      'useTransform', 'useSpring', 'whileInView', 'variants', 'layout animation',
      'gesture animation', 'animation react', 'react animation', 'animate react',
      'motion v12', 'package motion', 'entree animee react',
    ],
    files: [
      { path: 'gsap-framer-scroll-animation/SKILL.md', stripFrontmatter: true, only: 'framer' },
      { path: 'gsap-framer-scroll-animation/references/framer.md', stripFrontmatter: false, header: '\n\n---\n\n# FULL FRAMER MOTION REFERENCE (inlined)\n\n' },
    ],
  },
  {
    id: 'premium-frontend-ui',
    label: 'premium-frontend-ui',
    description:
      'Premium frontend UI craftsmanship: advanced motion, typography, and architectural quality for immersive high-performance web experiences. Pairs with frontend-design for aesthetics and with gsap/framer skills for implementation. Use when the user asks for premium, polished, immersive, high-end UI.',
    keywords: [
      'premium ui', 'interface premium', 'ui premium', 'animation premium', 'typographie premium',
      'micro interactions', 'micro-interactions', 'immersive', 'immersif', 'high end ui',
      'haut de gamme', 'luxury design', 'motion design web', 'polished ui', 'raffine',
      'experience premium', 'wow effect',
    ],
    files: [
      { path: 'premium-frontend-ui/SKILL.md', stripFrontmatter: true },
    ],
  },
  {
    id: 'web-design-reviewer',
    label: 'web-design-reviewer',
    description:
      'Visual design inspection and fixing: review website design, detect responsive breakage, accessibility issues, visual inconsistency and layout problems, then fix them at the source-code level — with a visual checklist and framework-specific fixes. Use when asked to review/audit/improve the design or fix layout/UI problems of an existing page.',
    keywords: [
      'review design', 'auditer design', 'audit design', 'corriger layout', 'probleme responsive',
      'design review', 'verifier design', 'inspecter design', 'corriger design',
      'probleme mise en page', 'layout casse', 'incoherence visuelle', 'checklist design',
      'corriger ui', 'fix layout', 'ameliorer apparence', 'audit ui',
    ],
    files: [
      { path: 'web-design-reviewer/SKILL.md', stripFrontmatter: true },
      { path: 'web-design-reviewer/references/visual-checklist.md', stripFrontmatter: false, header: '\n\n---\n\n# VISUAL CHECKLIST (inlined)\n\n' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Frontmatter parsing (plain scalars + folded `>` blocks + quoted strings)
// ---------------------------------------------------------------------------

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return { name: '', description: '', body: md };
  const lines = m[1].split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+\S/.test(lines[j]) || lines[j].trim() === '')) {
        block.push(lines[j].trim());
        j++;
      }
      while (block.length && block[block.length - 1] === '') block.pop();
      value = block.join(' ');
      i = j - 1;
    } else if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'")
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      value =
        quote === '"'
          ? value.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\')
          : value.replace(/''/g, "'");
    }
    meta[key] = value;
  }
  return { name: meta.name || '', description: meta.description || '', body: md.slice(m[0].length).replace(/^\s+/, '') };
}

function trimDescription(d) {
  if (d.length <= DESC_MAX) return d;
  const cut = d.slice(0, DESC_MAX);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > 60) return cut.slice(0, stop + 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > 60 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/** Filter a multi-library SKILL.md body to the sections about one library. */
function filterSections(body, mode) {
  if (mode !== 'framer') return body;
  // Keep setup + workflow + patterns relevant to Framer, drop GSAP-only blocks.
  const lines = body.split('\n');
  const out = [];
  let dropping = false;
  for (const ln of lines) {
    if (/^###\s+\d\.\s+.*\((GSAP)\)/.test(ln)) { dropping = true; out.push(ln.replace(/\(GSAP\)/, '(GSAP — see the gsap-scroll-animation skill)')); continue; }
    if (/^###\s/.test(ln) || /^##\s/.test(ln)) dropping = false;
    if (!dropping) out.push(ln);
  }
  return out.join('\n');
}

function capContent(body) {
  let out = body.replace(/\r\n/g, '\n').trim();
  if (out.length > MAX_CONTENT_CHARS) {
    const cut = out.slice(0, MAX_CONTENT_CHARS);
    const nl = cut.lastIndexOf('\n');
    out = (nl > MAX_CONTENT_CHARS / 2 ? cut.slice(0, nl) : cut).trimEnd() +
      '\n\n[--- skill instructions truncated for length ---]';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Build entries
// ---------------------------------------------------------------------------

const SOURCE_NOTE = (id) =>
  `SOURCE — official skill inlined from github/awesome-copilot (GitHub's official repository, MIT).`;

const entries = [];
for (const spec of ENTRIES) {
  const parts = [];
  for (const f of spec.files) {
    const p = join(ROOT, f.path);
    if (!existsSync(p)) {
      console.warn(`!! missing: ${p}`);
      continue;
    }
    const raw = readFileSync(p, 'utf8');
    const body = f.stripFrontmatter ? parseFrontmatter(raw).body : raw;
    parts.push((f.header || '') + filterSections(body, f.only));
  }
  const guardrail = GUARDED_SKILLS.has(spec.id) ? THREE_GUARDRAIL + '\n\n' : '';
  const extra = spec.extra ? '\n\n' + spec.extra : '';
  const content = `${SOURCE_NOTE(spec.id)}\n\n${guardrail}${capContent(parts.join('\n'))}${extra}`;
  entries.push({
    name: spec.id,
    label: spec.label,
    description: trimDescription(spec.description),
    content,
    keywords: spec.keywords,
  });
  console.log(`- ${spec.id} (content ${content.length} chars, ${spec.keywords.length} keywords)`);
}

// sanity: unique ids
const seen = new Set();
for (const e of entries) {
  if (seen.has(e.name)) throw new Error(`duplicate skill id: ${e.name}`);
  seen.add(e.name);
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const header = `// AUTO-GENERATED by scripts/generate-official-game-catalog.mjs — DO NOT EDIT BY HAND.
// Sources (v2, 2025-11): github/awesome-copilot — GitHub's OFFICIAL org repo (MIT).
//  - game-engine (SKILL.md + full references/ + assets/: MDN, gamedev.net,
//    deepnight sources) — pure markdown, zero Python.
//  - gsap-framer-scroll-animation (SKILL.md + references/gsap.md + framer.md)
//  - premium-frontend-ui (SKILL.md)
//  - web-design-reviewer (SKILL.md + references/visual-checklist.md)
// Regenerate: bun scripts/generate-official-game-catalog.mjs skills-games
//
// Merged at runtime with the Anthropic catalog (catalog.ts) and the platform
// library (library/) by registry.ts (manifest + USE_SKILL resolution) and
// selector.ts (deterministic pre-selection on the curated keywords).

export type DesignSkill = {
  /** kebab-case unique id — must not collide with catalog/library names. */
  name: string;
  /** Human label. */
  label: string;
  /** Trimmed manifest line. */
  description: string;
  /** Full instructions, platform-adapted, capped. */
  content: string;
  /** Curated FR+EN routing keywords for the pre-selector. */
  keywords: string[];
};

export const DESIGN_SKILL_CATALOG: DesignSkill[] = [
`;

const body = entries
  .map((e) => {
    return `  {\n    name: ${JSON.stringify(e.name)},\n    label: ${JSON.stringify(e.label)},\n    description: ${JSON.stringify(e.description)},\n    content: ${JSON.stringify(e.content)},\n    keywords: [${e.keywords.map((k) => JSON.stringify(k)).join(', ')}],\n  },`;
  })
  .join('\n');

const footer = `
];

export const DESIGN_SKILL_BY_NAME: Record<string, DesignSkill> = Object.fromEntries(
  DESIGN_SKILL_CATALOG.map((s) => [s.name, s])
);
`;

writeFileSync(OUT, header + body + footer);
console.log(`\nwrote ${OUT}: ${entries.length} skills, manifest ≈ ${entries.reduce((a, e) => a + e.name.length + e.description.length + 12, 0)} chars, total content ≈ ${Math.round(entries.reduce((a, e) => a + e.content.length, 0) / 1024)}K`);
