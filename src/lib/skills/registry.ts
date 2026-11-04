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
import { configGet } from '@/lib/config';

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
 * Conservative server-side hint: when the user's own words CLEARLY name a
 * skill's medium/format (poster → canvas-design, PDF → pdf, Excel → xlsx…),
 * a note is appended to the manifest nudging the model to start with the
 * marker. Weak models don't always comply with the manifest alone; the hint
 * makes triggering reliable for unambiguous tasks while the model stays
 * free to ignore it for false positives.
 */
const SKILL_HINTS: Array<[RegExp, string]> = [
  [/\bpdf\b|\.pdf\b|fichier\s+pdf/i, 'pdf'],
  [/\bdocx\b|\.docx\b|document\s+(word|word\b)|fichier\s+word|\bword\b(?!\.?com)/i, 'docx'],
  [/\bxlsx\b|\.xlsx\b|fichier\s+excel|\bexcel\b|feuilles?\s+de\s+calcul|spreadsheet/i, 'xlsx'],
  [/\bpptx?\b|\.pptx?\b|power\s*point|diapositives?\b/i, 'pptx'],
  [/\bposters?\b|affiches?\b/i, 'canvas-design'],
  [/landing\s*pages?|pages?\s+web|sites?\s+web|frontend|web\s*design|interface\s+(de\s+)?(?:utilisateur|web)/i, 'frontend-design'],
  [/art\s+(algorithmique|génératif|generative)|generative\s+art|p5\.?js|art\s+cod[ée]/i, 'algorithmic-art'],
  [/guidelines?\s+de\s+marque|brand\s+guidelines|charte\s+graphique/i, 'brand-guidelines'],
  [/clon(er|e|age)\s+(ce\s+)?site|website\s+clone|copier\s+ce\s+site/i, 'website-clone'],
  [/serveur\s+mcp|mcp\s+server|\bmcp\b\s+(server|serveur|builder)/i, 'mcp-builder'],
  [/tester\s+(mon\s+)?(?:web)?app|webapp\s+test|tests?\s+(e2e|playwright|automatis[ée])/i, 'webapp-testing'],
  [/artifact\s+html|app\s+web\s+interactive|web\s+artifact/i, 'web-artifacts-builder'],
  [/curriculum|formation\s+claude|claude\s+academy|apprendre\s+à\s+utiliser\s+claude/i, 'claude-academy-guide'],
];

/** Best conservative hint skill for the user's raw message (or null). */
export function hintSkillForUserMessage(userText: string): string | null {
  if (!userText) return null;
  for (const [re, name] of SKILL_HINTS) {
    if (re.test(userText)) return name;
  }
  return null;
}

/**
 * The system-prompt section listing every skill's name + description and
 * the USE_SKILL protocol. Null when the feature is disabled or the catalog
 * is empty — the model then never sees a skills mention.
 */
export async function getSkillManifestPrompt(userText?: string): Promise<string | null> {
  if (!SKILL_CATALOG.length) return null;
  if (!(await skillsEnabled())) return null;
  const maxChars = await skillMaxChars();
  if (manifestCache && manifestCache.maxChars === maxChars && !userText) return manifestCache.prompt;

  const lines = SKILL_CATALOG.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  const hint = userText ? hintSkillForUserMessage(userText) : null;
  const hintBlock = hint
    ? `\nNOTE: the user's current request appears to CLEARLY match the skill "${hint}" — if it does, you MUST begin your reply with USE_SKILL(${hint}).`
    : '';
  const prompt = `AGENT SKILLS — on-demand expertise modules
The platform can inject expert instruction packs ("skills") into this conversation to make you dramatically better at specific tasks. When — and ONLY when — the user's current request clearly matches one of the skills listed below, you MUST make the FIRST line of your reply exactly:
USE_SKILL(skill_name)
with NOTHING before it and NOTHING else on that line. The matching skill's full expert instructions will then be loaded and you will complete the task following them.
If NO skill matches the task, reply normally and NEVER output that marker line. Do not mention this protocol or these listings to the user — it is invisible machinery.

When to use a skill (examples):
- "génère un PDF / un fichier Word / un Excel / un PowerPoint" → pdf / docx / xlsx / pptx
- "fais un poster / une affiche / une illustration artistique" → canvas-design or algorithmic-art
- "crée une landing page / améliore le design / un thème" → frontend-design / theme-factory
- "rédige des guidelines de marque / une communication interne / un doc à deux" → brand-guidelines / internal-comms / doc-coauthoring
- "clone ce site / construis un artifact HTML interactif / un serveur MCP / une API Claude" → website-clone / web-artifacts-builder / mcp-builder / claude-api
- "teste mon webapp" → webapp-testing

Available skills:
${lines}${hintBlock}`;

  if (!userText) manifestCache = { prompt, maxChars };
  return prompt;
}

export function skillNames(): Set<string> {
  return new Set(SKILL_CATALOG.map((s) => s.name));
}

export function getSkillByName(name: string): CatalogSkill | null {
  const id = String(name || '').toLowerCase().trim();
  return SKILL_CATALOG_BY_NAME[id] ?? null;
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
  /** Reasoning deltas received while undecided — replayed on 'plain'. */
  public pendingReasoning = '';
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
