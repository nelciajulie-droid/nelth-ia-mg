#!/usr/bin/env bun
/**
 * Generate src/lib/skills/design-catalog.ts from curated external skill
 * collections (Claude agent-skills format: <dir>/SKILL.md with YAML
 * frontmatter `name` + `description`, including folded `>` descriptions).
 *
 * Sources (v1, July 2025):
 *  - freshtechbro/claudedesignskills  (22 skills — 3D/WebGL/animation/design)
 *  - gamedev-skills/awesome-gamedev-agent-skills (19 skills — game engines,
 *    genres, disciplines + the master router, renamed `game-development`)
 *
 * Usage:
 *   bun scripts/generate-design-catalog.mjs <design-repo-root> <game-repo-root> [output.ts]
 *
 * The generated catalog is COMMITTED to the repo so runtime code needs no
 * filesystem access (serverless-safe). Each skill carries curated routing
 * keywords (FR+EN) for the deterministic pre-selector in selector.ts.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DESIGN_ROOT = process.argv[2];
const GAME_ROOT = process.argv[3];
const OUT = process.argv[4] || 'src/lib/skills/design-catalog.ts';
const DESC_MAX = 230;
const MAX_CONTENT_CHARS = 24_000;

if (!DESIGN_ROOT || !GAME_ROOT) {
  console.error('usage: bun scripts/generate-design-catalog.mjs <design-repo-root> <game-repo-root> [output.ts]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Curated skill list: id → source SKILL.md path (relative to repo root)
// ---------------------------------------------------------------------------

/** design repo: plugins/individual/<plugin>/skills/<skill>/SKILL.md */
const DESIGN_SKILLS = [
  'threejs-webgl', 'react-three-fiber', 'gsap-scrolltrigger', 'motion-framer',
  'babylonjs-engine', 'aframe-webxr', 'pixijs-2d', 'playcanvas-engine',
  'spline-interactive', 'blender-web-pipeline', 'substance-3d-texturing',
  'rive-interactive', 'lottie-animations', 'animejs', 'react-spring-physics',
  'locomotive-scroll', 'barba-js', 'scroll-reveal-libraries',
  'animated-component-libraries', 'lightweight-3d-effects',
  'modern-web-design', 'web3d-integration-patterns',
];

/** game repo: skills/<category>/<name>/SKILL.md (+ router/SKILL.md) */
const GAME_SKILLS = {
  router: ['game-development'],
  'web-engines': ['phaser-core', 'phaser-arcade-physics', 'pixijs-rendering', 'threejs-scene-setup', 'threejs-materials-lighting', 'threejs-gltf-loading'],
  genres: ['platformer', 'roguelike', 'rpg', 'card-game', 'tower-defense', 'fps-shooter', 'puzzle', 'visual-novel', 'survival-crafting'],
  disciplines: ['game-feel', 'game-ui-ux', 'procedural-gen'],
};

// ---------------------------------------------------------------------------
// Curated routing keywords (lowercase, accent-free FR + EN) — these feed the
// deterministic pre-selector (score >= 3 → skill injected for the turn).
// ---------------------------------------------------------------------------

const KEYWORDS = {
  // --- design / 3D / animation ---
  'threejs-webgl': ['three.js', 'threejs', 'webgl', 'webgpu', 'rendu 3d', 'scene 3d', 'monde 3d', 'objet 3d', 'modele 3d', 'visualisation 3d', 'configurateur 3d', 'camera 3d', 'experience immersive'],
  'react-three-fiber': ['react three fiber', 'react-three-fiber', 'r3f', 'drei', 'react 3d', 'react three'],
  'gsap-scrolltrigger': ['gsap', 'greensock', 'scrolltrigger', 'scroll trigger', 'animation au scroll', 'scroll animation', 'timeline gsap'],
  'motion-framer': ['framer motion', 'framer-motion', 'framer', 'layout animation', 'gesture animation'],
  'babylonjs-engine': ['babylonjs', 'babylon.js', 'babylon', 'babylon webgl'],
  'aframe-webxr': ['aframe', 'a-frame', 'webxr', 'casque vr', 'realite virtuelle', 'realite augmentee', 'experience vr', 'contenu vr'],
  'pixijs-2d': ['pixijs', 'pixi.js', 'pixi', 'sprite 2d', 'graphismes 2d', 'moteur 2d', 'pixijs 2d'],
  'playcanvas-engine': ['playcanvas', 'play canvas', 'playcanvas engine'],
  'spline-interactive': ['spline', 'spline design', 'spline 3d', 'scene spline', 'objet spline'],
  'blender-web-pipeline': ['blender', 'blender webgl', 'blender three', 'export gltf', 'modele blender', 'pipeline blender', 'blender web'],
  'substance-3d-texturing': ['substance painter', 'substance 3d', 'texturing 3d', 'texture 3d', 'pbr', 'materiaux pbr', 'substance'],
  'rive-interactive': ['rive animation', 'rive app', 'animations rive', 'rive interactive'],
  'lottie-animations': ['lottie', 'bodymovin', 'animations vectorielles', 'lottie web'],
  'animejs': ['anime.js', 'animejs', 'anime js'],
  'react-spring-physics': ['react spring', 'react-spring', 'spring animation', 'animation physique react', 'physique spring', 'springs react'],
  'locomotive-scroll': ['locomotive scroll', 'locomotive', 'smooth scroll', 'defilement fluide', 'parallax', 'parallaxe', 'scroll fluide'],
  'barba-js': ['barba', 'barba.js', 'transition de page', 'page transition', 'transitions de pages'],
  'scroll-reveal-libraries': ['scroll reveal', 'reveal au scroll', 'apparition au scroll', 'aos', 'reveal on scroll', 'apparition progressive'],
  'animated-component-libraries': ['magic ui', 'aceternity', 'composants animes', 'animated components', 'composant anime', 'ui animee'],
  'lightweight-3d-effects': ['vanta', 'vanta.js', 'fond 3d', 'arriere plan 3d', 'background 3d', 'effets 3d legers', 'shader background'],
  'modern-web-design': ['glassmorphism', 'neumorphism', 'bento', 'design trends', 'tendances design', 'award winning', 'awwwards', 'aesthetic', 'dark mode design', 'design system moderne'],
  'web3d-integration-patterns': ['integration 3d', 'performance 3d', 'optimisation 3d', 'architecture 3d', 'integration webgl', '3d en production'],
  // --- game development ---
  'game-development': ['jeu', 'jeux', 'game', 'games', 'gameplay', 'game design', 'creer un jeu', 'faire un jeu', 'developper un jeu', 'jeu video', 'video game', 'game jam', 'gamejam', 'level design', 'mechaniques de jeu'],
  'phaser-core': ['phaser', 'phaser.js', 'phaser 4', 'phaser 3', 'phaser game'],
  'phaser-arcade-physics': ['phaser arcade', 'arcade physics', 'physique arcade', 'collider', 'overlap phaser', 'gravite phaser'],
  'pixijs-rendering': ['pixijs rendering', 'rendu pixi', 'pixi rendering', 'batching pixi', 'pixi performance'],
  'threejs-scene-setup': ['three.js scene', 'scene setup', 'setup three', 'renderer three', 'camera three.js', 'init scene 3d', 'setup scene'],
  'threejs-materials-lighting': ['three.js material', 'materiaux three', 'eclairage three', 'three.js light', 'textures three', 'pbr three', 'lumieres 3d'],
  'threejs-gltf-loading': ['gltf', 'glb', 'charger modele 3d', 'draco', 'load gltf', 'modeles 3d', '3d model loading'],
  'platformer': ['platformer', 'plateformer', 'jeu de plateforme', 'jump and run', 'mario', 'celeste', 'coyote time', 'wall jump', 'saut plateforme'],
  'roguelike': ['roguelike', 'rogue like', 'rogue-lite', 'rogue lite', 'generation donjon', 'binding of isaac', 'run procedurale'],
  'rpg': ['rpg', 'jrpg', 'role playing', 'jeu de role', 'hack and slash', 'diablo like', 'statistiques personnage', 'level up', 'points experience'],
  'card-game': ['jeu de cartes', 'jeu de carte', 'card game', 'deckbuilding', 'deck building', 'solitaire', 'tarot', 'belote', 'poker', 'bataille', 'uno'],
  'tower-defense': ['tower defense', 'defense de tour', 'towerdefense', 'vagues d ennemis', 'defendre sa base', 'td game'],
  'fps-shooter': ['fps', 'shooter', 'shoot them up', 'shmup', 'jeu de tir', 'doom like', 'first person', 'vue subjective', 'bullet hell'],
  'puzzle': ['puzzle', 'casse tete', 'tetris', 'match 3', 'match three', 'sokoban', 'jeu de reflexion', '2048', 'candy crush', 'blocs'],
  'visual-novel': ['visual novel', 'roman visuel', 'dating sim', 'otome', 'renpy', "ren'py", 'narration interactive', 'histoire interactive jeu', 'dialogues jeu'],
  'survival-crafting': ['survie', 'survival', 'crafting', 'minecraft', 'faim', 'collecte de ressources', 'faire survivre', 'base de survie'],
  'game-feel': ['game feel', 'juice', 'screen shake', 'hit stop', 'impact frames', 'squash and stretch', 'punchy', 'game juice', 'feedback jeu'],
  'game-ui-ux': ['hud', 'health bar', 'barre de vie', 'menu de jeu', 'pause menu', 'interface de jeu', 'ui jeu', 'menu pause', 'ecran titre'],
  'procedural-gen': ['procedural', 'generation procedurale', 'perlin', 'simplex', 'noise terrain', 'wfc', 'wave function collapse', 'dungeon generator', 'donjon procedurale', 'loot table', 'heightmap', 'terrain generation', 'random seed'],
};

// ---------------------------------------------------------------------------
// Description / name overrides (platform-oriented rewrites)
// ---------------------------------------------------------------------------

const OVERRIDES = {
  'game-development': {
    label: 'game-development',
    description:
      'Master router for game development: detects the engine (Phaser, PixiJS, three.js, or plain JS/Canvas on this web platform) and the task (player, level, enemy, UI, camera, game feel, physics, procedural generation, saves, AI), then routes to the right specialized skill. Use for ANY request about creating, designing, or debugging a game — "make me a game", jeu vidéo, gameplay, game jam. Start here when unsure which game skill applies.',
  },
};

// ---------------------------------------------------------------------------
// Frontmatter parsing (plain scalars + folded `>` blocks)
// ---------------------------------------------------------------------------

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return { name: '', description: '', body: md };
  const raw = m[1];
  const lines = raw.split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    if (value === '>' || value === '|') {
      // folded block scalar — consume indented continuation lines
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j];
        if (/^\s+\S/.test(ln) || ln.trim() === '') buf.push(ln);
        else break;
      }
      const joined = buf.join('\n').replace(/^\s+|\s+$/g, '');
      value = joined
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s+/, ''))
        .join(value === '>' ? ' ' : '\n')
        .replace(/\s+/g, ' ')
        .trim();
      i += buf.length;
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

const PLATFORM_NOTE =
  'NOTE — platform adaptation: this skill was authored for a file-based coding agent. The `references/` and `scripts/` files it mentions are unavailable here; the guidance in this document is self-sufficient, rely on it and on code the user shares. When it says to read or load another skill, emit USE_SKILL(name) only if that skill exists in the platform\'s index; otherwise adapt using the engine-neutral patterns below.';

function capContent(body) {
  let out = body.replace(/\r\n/g, '\n').trim();
  if (out.length > MAX_CONTENT_CHARS) {
    const cut = out.slice(0, MAX_CONTENT_CHARS);
    const nl = cut.lastIndexOf('\n');
    out = (nl > MAX_CONTENT_CHARS / 2 ? cut.slice(0, nl) : cut).trimEnd() +
      '\n\n[--- skill instructions truncated for length ---]';
  }
  return `${PLATFORM_NOTE}\n\n${out}`;
}

// ---------------------------------------------------------------------------
// Collect entries
// ---------------------------------------------------------------------------

const entries = [];

function addSkill(id, path, fallbackLabel) {
  if (!existsSync(path)) {
    console.warn(`!! missing: ${path}`);
    return;
  }
  const raw = readFileSync(path, 'utf8');
  const { name, description, body } = parseFrontmatter(raw);
  const finalId = OVERRIDES[id]?.label || (name || id).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const label = OVERRIDES[id]?.label || name || fallbackLabel || finalId;
  const desc = OVERRIDES[id]?.description || description || `${fallbackIdFallback(id)} skill`;
  entries.push({
    name: finalId,
    label,
    description: trimDescription(desc),
    content: capContent(body),
    keywords: KEYWORDS[id] || KEYWORDS[finalId] || [],
  });
  console.log(`- ${finalId} (${Math.round(raw.length / 1024)}K → content ${entries[entries.length - 1].content.length} chars, ${entries[entries.length - 1].keywords.length} keywords)`);
}

function fallbackIdFallback(id) {
  return id;
}

// design repo
for (const s of DESIGN_SKILLS) {
  addSkill(s, join(DESIGN_ROOT, 'plugins', 'individual', s, 'skills', s, 'SKILL.md'), s);
}

// game repo
for (const [cat, names] of Object.entries(GAME_SKILLS)) {
  for (const s of names) {
    if (cat === 'router') addSkill(s, join(GAME_ROOT, 'router', 'SKILL.md'), s);
    else addSkill(s, join(GAME_ROOT, 'skills', cat, s, 'SKILL.md'), s);
  }
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

const header = `// AUTO-GENERATED by scripts/generate-design-catalog.mjs — DO NOT EDIT BY HAND.
// Sources:
//  - freshtechbro/claudedesignskills (22 skills — 3D/WebGL/animation/design)
//  - gamedev-skills/awesome-gamedev-agent-skills (19 skills — game engines,
//    genres, disciplines + master router, renamed "game-development")
// Regenerate: bun scripts/generate-design-catalog.mjs <design-repo> <game-repo>
//
// Merged at runtime with the Anthropic catalog (catalog.ts) and the platform
// library (library/) by registry.ts (manifest + USE_SKILL resolution) and
// selector.ts (deterministic pre-selection on the curated keywords).

export type DesignSkill = {
  /** kebab-case unique id — must not collide with catalog/library names. */
  name: string;
  /** Human label from the SKILL.md frontmatter. */
  label: string;
  /** Trimmed frontmatter description (manifest line). */
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
