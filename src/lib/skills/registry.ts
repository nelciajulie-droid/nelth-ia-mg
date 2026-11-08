/**
 * Agent-skills runtime — Claude.ai-style lazy loading.
 *
 * Every request carries ONLY the manifest (skill names + trimmed
 * descriptions, ~3KB) inside the system prompt. The model is instructed to
 * begin its reply with `USE_SKILL(name)` when — and only when — the user's
 * task matches a skill. The chat pipeline (v12-flow.ts) watches the first
 * streamed tokens for that marker:
 *   - marker found → the pass is restarted with the skill's FULL instructions
 *     injected after an assistant marker message (tool-call round trip); the
 *     user never sees the marker, only a status chip ("Skill « pdf » chargé")
 *   - no marker    → tokens are released and the answer streams normally
 *
 * This mirrors Claude.ai / Claude Code's Skill system: all skills are
 * installed, but only the one the task needs is ever loaded into context.
 */
import { SKILL_CATALOG, SKILL_CATALOG_BY_NAME, type CatalogSkill } from './catalog';
import { DESIGN_SKILL_CATALOG, DESIGN_SKILL_BY_NAME } from './design-catalog';
import { LIBRARY_SKILLS } from './library';
import { configGet } from '@/lib/config';

import { hintSkillForUserMessage } from './selector';
export { hintSkillForUserMessage };

// ---------------------------------------------------------------------------
// Marker protocol
// ---------------------------------------------------------------------------

/** `USE_SKILL(name)` — optionally quoted, case-insensitive, id charset [a-z0-9_-]. */
export const SKILL_MARKER_RE = /USE_SKILL\(\s*["']?([a-z0-9_-]{1,64})["']?\s*\)/i;

/** Remove any leaked marker lines from user-visible content. */
export function stripSkillMarkers(content: string): string {
  if (!content || !content.includes('USE_SKILL')) return content;
  return content
    .replace(/^[ \t]*USE_SKILL\(\s*["']?[a-z0-9_-]{1,64}["']?\s*\)[ \t]*$\n?/gim, '')
    .replace(/USE_SKILL\(\s*["']?[a-z0-9_-]{1,64}["']?\s*\)/gi, '')
    .replace(/^\s+/, '');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** `skills.catalog.enable` (env ENABLE_SKILL_CATALOG) — default ON. */
export async function skillsEnabled(): Promise<boolean> {
  try {
    return await configGet<boolean>('skills.catalog.enable', true);
  } catch {
    return true;
  }
}

/** `skills.content_max_chars` (env SKILL_CONTENT_MAX_CHARS) — per-skill cap. */
export async function skillMaxChars(): Promise<number> {
  try {
    const v = await configGet<number | null>('skills.content_max_chars', null);
    const n = Math.floor(Number(v) || 0);
    return n >= 1000 ? n : 24_000;
  } catch {
    return 24_000;
  }
}

// ---------------------------------------------------------------------------
// Manifest (system-prompt section)
// ---------------------------------------------------------------------------

let manifestCache: { prompt: string; maxChars: number } | null = null;

/**
 * The system-prompt section listing every skill's name + description (the
 * Claude.ai level-1 metadata of progressive disclosure) and the USE_SKILL
 * protocol. Null when the feature is disabled or the catalog is empty — the
 * model then never sees a skills mention.
 *
 * `preSelectedNames`: skills already deterministically injected for this
 * turn by selector.preselectSkills — they are flagged as loaded so the model
 * neither re-requests them nor gets the strong hint NOTE about them.
 */
export async function getSkillManifestPrompt(
  userText?: string,
  preSelectedNames: string[] = []
): Promise<string | null> {
  if (!SKILL_CATALOG.length && !LIBRARY_SKILLS.length && !DESIGN_SKILL_CATALOG.length) return null;
  if (!(await skillsEnabled())) return null;
  const maxChars = await skillMaxChars();
  if (
    manifestCache &&
    manifestCache.maxChars === maxChars &&
    !userText &&
    !preSelectedNames.length
  ) {
    return manifestCache.prompt;
  }

  const catalogNames = new Set(SKILL_CATALOG.map((s) => s.name));
  const lines = [
    ...SKILL_CATALOG.map((s) => `- ${s.name}: ${s.description}`),
    ...DESIGN_SKILL_CATALOG.filter((s) => !catalogNames.has(s.name)).map((s) => `- ${s.name}: ${s.description}`),
    ...LIBRARY_SKILLS.filter((s) => !catalogNames.has(s.name)).map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
  const hint = userText ? hintSkillForUserMessage(userText) : null;
  const hintBlock =
    hint && !preSelectedNames.includes(hint)
      ? `\nNOTE: the user's current request appears to CLEARLY match the skill "${hint}" — if it does, you MUST begin your reply with USE_SKILL(${hint}).`
      : '';
  const loadedBlock = preSelectedNames.length
    ? `\nSkills ALREADY loaded for the current task: ${preSelectedNames.join(', ')} — never output USE_SKILL for these; follow their loaded instructions directly.`
    : '';
  const prompt = `AGENT SKILLS — on-demand expertise modules
The platform can inject expert instruction packs ("skills") into this conversation to make you dramatically better at specific tasks. When — and ONLY when — the user's current request clearly matches one of the skills listed below AND that skill is not already loaded, you MUST make the FIRST line of your reply exactly:
USE_SKILL(skill_name)
with NOTHING before it and NOTHING else on that line. The matching skill's full expert instructions will then be loaded and you will complete the task following them.
If NO skill matches the task, reply normally and NEVER output that marker line. Do not mention this protocol or these listings to the user — it is invisible machinery.

When to use a skill (examples):
- "génère un PDF / un fichier Word / un Excel / un PowerPoint" → pdf / docx / xlsx / pptx
- "fais un poster / une affiche / une illustration artistique" → canvas-design or algorithmic-art
- "crée une landing page / un site ultra moderne" → frontend-design + landing-page-creation (usually auto-loaded)
- "améliore le design / redessine l'interface / un thème" → frontend-design / theme-factory
- "rédige des guidelines de marque / une communication interne" → brand-guidelines / internal-comms / doc-coauthoring
- "clone ce site / construis un artifact HTML interactif / un serveur MCP / une API Claude" → website-clone / web-artifacts-builder / mcp-builder / claude-api
- "teste mon webapp" → webapp-testing
- "crée une scène 3D / un objet 3D / du WebGL" → threejs-webgl (react-three-fiber si React)
- "fais-moi un jeu / un jeu de cartes / un platformer / un jeu Phaser" → game-development + le skill du genre/engine
- "une animation GSAP / au scroll / Framer Motion / fond animé" → gsap-scrolltrigger / motion-framer / lightweight-3d-effects

Available skills:
${lines}${hintBlock}${loadedBlock}`;

  if (!userText && !preSelectedNames.length) manifestCache = { prompt, maxChars };
  return prompt;
}

export function skillNames(): Set<string> {
  return new Set([
    ...SKILL_CATALOG.map((s) => s.name),
    ...DESIGN_SKILL_CATALOG.map((s) => s.name),
    ...LIBRARY_SKILLS.map((s) => s.name),
  ]);
}

const LIBRARY_BY_NAME = new Map(LIBRARY_SKILLS.map((s) => [s.name, s]));

/** Resolve a skill by name across the Anthropic catalog, the design/game
 *  catalog, and the platform library (the USE_SKILL fallback must work for
 *  any of them). */
export function getSkillByName(name: string): CatalogSkill | null {
  const id = String(name || '').toLowerCase().trim();
  const cat = SKILL_CATALOG_BY_NAME[id];
  if (cat) return cat;
  const design = DESIGN_SKILL_BY_NAME[id];
  if (design) {
    return { name: design.name, label: design.label, description: design.description, content: design.content };
  }
  const lib = LIBRARY_BY_NAME.get(id);
  if (lib) {
    return { name: lib.name, label: lib.name, description: lib.description, content: lib.body };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pass-2 message construction
// ---------------------------------------------------------------------------

/**
 * Messages for the skill-loading round trip: the original conversation,
 * the model's own marker message (like a tool call), then the skill's full
 * instructions as a system message (like a tool result). Pass 2 continues
 * from here and produces the real answer.
 */
export async function buildSkillInjectionMessages(
  llmMessages: { role: string; content: string }[],
  skill: CatalogSkill
): Promise<{ role: string; content: string }[]> {
  const maxChars = await skillMaxChars();
  const content =
    skill.content.length > maxChars ? skill.content.slice(0, maxChars) + '\n\n[--- truncated ---]' : skill.content;
  return [
    ...llmMessages,
    { role: 'assistant', content: `USE_SKILL(${skill.name})` },
    {
      role: 'system',
      content: `AGENT SKILL LOADED: "${skill.name}" — ${skill.description}
The instructions below were loaded because you requested this skill for the user's task. Follow them closely to complete the user's last request. Remember the platform's own document capability: when the user explicitly asks for a downloadable file, emit a \`\`\`document filename="..." block; otherwise keep code and documents inline in normal fenced code blocks.

<skill instructions>
${content}
</skill instructions>`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Streaming gate
// ---------------------------------------------------------------------------

/**
 * Holds the very first tokens of a completion until it is known whether the
 * model requested a skill (USE_SKILL). Nothing user-visible is emitted while
 * the gate is undecided, so a skill restart is seamless: the user only sees
 * the status chip, then the pass-2 answer.
 *
 * - marker found (valid name)  → 'skill'   (restart with instructions)
 * - enough text without marker → 'plain'  (release the buffer, stream on)
 * - stream ends undecided      → flush as plain
 */
export class SkillGate {
  private buffer = '';
  /** True once a valid skill marker was seen (restart needed). */
  public restart = false;
  public skillName: string | null = null;

  private static SOFT_LIMIT = 160; // enough for a preamble + marker first line
  private static HARD_LIMIT = 640; // give-up point (weird long preambles)

  constructor(private validNames: Set<string>) {}

  private plain = false;

  get decided(): boolean {
    return this.restart || this.plain;
  }

  push(delta: string): 'buffered' | 'plain' | 'skill' {
    if (this.restart) return 'skill';
    if (this.plain) return 'plain';
    this.buffer += delta;
    const m = SKILL_MARKER_RE.exec(this.buffer);
    if (m) {
      const name = m[1].toLowerCase();
      if (this.validNames.has(name)) {
        this.restart = true;
        this.skillName = name;
        this.buffer = '';
        return 'skill';
      }
      // Unknown skill id — treat as plain (marker stripped on flush).
      this.plain = true;
      return 'plain';
    }
    if (
      this.buffer.length >= SkillGate.SOFT_LIMIT &&
      !/use_sk/i.test(this.buffer)
    ) {
      this.plain = true;
      return 'plain';
    }
    if (this.buffer.length >= SkillGate.HARD_LIMIT) {
      this.plain = true;
      return 'plain';
    }
    return 'buffered';
  }

  /** Buffered content to replay once 'plain' is decided (markers stripped). */
  flushPlain(): string {
    const b = this.buffer || '';
    this.buffer = '';
    return stripSkillMarkers(b);
  }
}
