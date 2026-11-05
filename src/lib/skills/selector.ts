/**
 * Deterministic per-turn skill pre-selection — the reliable trigger layer of
 * the Claude.ai-style skills system.
 *
 * The USE_SKILL protocol (manifest + model-decided marker, see registry.ts)
 * is the faithful lazy-loading path, but weak/free models do not reliably
 * emit the marker even when the task clearly matches a skill — the observed
 * bug: "créer-moi une landing page ultra moderne" answered without ever
 * loading frontend-design. This module fixes that the way Claude's runtime
 * effectively behaves: the PLATFORM loads the skill when the task clearly
 * matches, instead of hoping the model asks.
 *
 * The user's own words (this turn only, pre web-search augmentation) are
 * scored against the full library — Anthropic catalog + platform library:
 *
 *   +4  multi-word keyword phrase ("landing page", "lettre de motivation")
 *   +3  single keyword ("html", "traduire"); word-boundary match for very
 *       short acronyms (cv, seo, ux, kpi) to avoid substring false positives
 *   +4  the skill's own name spelled out in the message
 *   +5  unambiguous medium/format hint regex (pdf, xlsx, poster…)
 *   +1  significant word shared with name+description (capped at +3)
 *
 * Selection: score >= 3, top 3 skills, ~45k chars of instructions max.
 * Nothing is persisted — the injection lives only in this turn's request.
 */
import { SKILL_CATALOG } from './catalog';
import { DESIGN_SKILL_CATALOG } from './design-catalog';
import { LIBRARY_SKILLS } from './library';
import { configGet } from '@/lib/config';

export interface PreSelectedSkill {
  name: string;
  label: string;
  description: string;
  content: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Hints — conservative, unambiguous medium/format triggers
// ---------------------------------------------------------------------------

/** Extended from registry.ts (kept here so selector has no import cycle). */
const SKILL_HINTS: Array<[RegExp, string]> = [
  // Most specific first — the first match wins the +5 hint boost.
  [/\bseo\b|r[ée]f[ée]rencement\b|positionnement\s+(?:google|web|naturel)/i, 'seo-optimization'],
  [/\bpdf\b|\.pdf\b|fichier\s+pdf/i, 'pdf'],
  [/\bdocx\b|\.docx\b|document\s+(word|word\b)|fichier\s+word|\bword\b(?!\.?com)/i, 'docx'],
  [/\bxlsx\b|\.xlsx\b|fichier\s+excel|\bexcel\b|feuilles?\s+de\s+calcul|spreadsheet/i, 'xlsx'],
  [/\bpptx?\b|\.pptx?\b|power\s*point|diapositives?\b/i, 'pptx'],
  [/\bposters?\b|affiches?\b/i, 'canvas-design'],
  // 3D / animation / game engines — specific first, umbrella last.
  [/\bphaser\b/i, 'phaser-core'],
  [/\bgsap\b|greensock|scroll\s*trigger/i, 'gsap-scrolltrigger'],
  [/framer\s*motion/i, 'motion-framer'],
  [/\bthree\.?js\b|\bwebgl\b|\bwebgpu\b|\bbabylon(?:\.?js)?\b|\b3d\b|rendu\s+3d|sc[èe]ne\s+3d|monde\s+3d|objet\s+3d|mod[èe]le\s+3d|jeu\s+3d/i, 'threejs-webgl'],
  [/\bjeu(?:x)?\b|\bgames?\b|gameplay|game\s*design|game\s*jam/i, 'game-development'],
  [
    /landing\s*pages?|pages?\s+web|sites?\s+web|sites?\s+vitrines?|front[ -]?end|web\s*design|ui\s*design|design\s+(?:tr[èe]s\s+|ultra\s+)?(?:moderne|modern\w*)|moderne\s+(?:web|site|page|interface)|modernis(?:er|e[rs]?)|redesign\w*|interface\s+(?:de\s+)?(?:utilisateur|web)|am[ée]lior\w*\s+(?:le\s+|la\s+|l['’]?)?(?:design|ui|interface|apparence|aspect|look)|am[ée]lior\w*.{0,80}\b(?:design|ui\b|apparence|interface)|(?:refaire|relooker|moderniser)\s+(?:le\s+|la\s+|l['’]?)?(?:design|ui|interface|apparence|aspect|site|page|app)|rend\w*.{0,40}\b(?:design|ui\b|apparence|interface)|design\s+(?:de|du)\s?(?:mon|ma|mes|l['’]?|le|la|ce(?:tte)?|notre|votre)\s?(?:application|app|site|page|web|interface|profil|portfolio|jeu)/i,
    'frontend-design',
  ],
  [/art\s+(algorithmique|g[ée]n[ée]ratif|generative)|generative\s+art|p5\.?js|art\s+cod[ée]/i, 'algorithmic-art'],
  [/guidelines?\s+de\s+marque|brand\s+guidelines|charte\s+graphique/i, 'brand-guidelines'],
  [/clon(er|e|age)\s+(ce\s+)?site|website\s+clone|copier\s+ce\s+site/i, 'website-clone'],
  [/serveur\s+mcp|mcp\s+server|\bmcp\b\s+(server|serveur|builder)/i, 'mcp-builder'],
  [/tester\s+(mon\s+)?(?:web)?app|webapp\s+test|tests?\s+(e2e|playwright|automatis[ée])/i, 'webapp-testing'],
  [/artifact\s+html|app\s+web\s+interactive|web\s+artifact/i, 'web-artifacts-builder'],
  [/curriculum|formation\s+claude|claude\s+academy|apprendre\s+[àa]\s+utiliser\s+claude/i, 'claude-academy-guide'],
];

/** Best conservative hint skill for the user's raw message (or null). */
export function hintSkillForUserMessage(userText: string): string | null {
  if (!userText) return null;
  for (const [re, name] of SKILL_HINTS) {
    if (re.test(userText)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified candidate pool (catalog + library)
// ---------------------------------------------------------------------------

interface Candidate {
  name: string;
  label: string;
  description: string;
  content: string;
  keywords: string[];
}

const CANDIDATES: Candidate[] = [
  ...SKILL_CATALOG.map((s) => ({
    name: s.name,
    label: s.label,
    description: s.description,
    content: s.content,
    keywords: [] as string[],
  })),
  ...DESIGN_SKILL_CATALOG.map((s) => ({
    name: s.name,
    label: s.label,
    description: s.description,
    content: s.content,
    keywords: (s.keywords ?? []) as string[],
  })),
  ...LIBRARY_SKILLS.map((s) => ({
    name: s.name,
    label: s.name,
    description: s.description,
    content: s.body,
    keywords: s.keywords ?? [],
  })),
];

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** lowercase, accent/apostrophe-stripped, whitespace-collapsed text. */
function normalize(input: string): string {
  return (input || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\u2019\u02BC'`´]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'their', 'there', 'these', 'those', 'other',
  'which', 'while', 'when', 'with', 'from', 'this', 'that', 'your', 'using',
  'users', 'user', 'skill', 'skills', 'create', 'created', 'creating', 'request',
  'requests', 'requested', 'should', 'would', 'could', 'based', 'every', 'into',
  'more', 'than', 'also', 'them', 'they', 'have', 'been', 'were', 'will', 'what',
  'only', 'some', 'such', 'then', 'upon', 'where', 'both', 'each', 'like', 'made',
  'make', 'most', 'over', 'very', 'just', 'best', 'need', 'wants', 'tools',
  'tool', 'file', 'files', 'works', 'help', 'helps', 'task', 'tasks', 'system',
  'process', 'document', 'documents', 'example', 'examples', 'specific',
  'general', 'content', 'produce', 'producing', 'format', 'formats',
  'structured', 'interactive', 'because', 'before', 'through', 'between',
]);

const DERIVED_CACHE = new Map<string, string[]>();

/** Significant (>= 5 chars, non-stopword) terms from name + description. */
function derivedWords(c: Candidate): string[] {
  const cached = DERIVED_CACHE.get(c.name);
  if (cached) return cached;
  const words = normalize(`${c.name.replace(/-/g, ' ')} ${c.description}`)
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 5 && !STOPWORDS.has(w));
  const unique = [...new Set(words)].slice(0, 24);
  DERIVED_CACHE.set(c.name, unique);
  return unique;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scoreCandidate(c: Candidate, normText: string): number {
  if (!normText) return 0;
  let score = 0;
  for (const kwRaw of c.keywords) {
    const kw = normalize(kwRaw);
    if (!kw) continue;
    if (kw.includes(' ')) {
      if (normText.includes(kw)) score += 4;
    } else if (kw.length <= 4) {
      // Short/acronym keywords (cv, seo, ux, kpi, rest, copy…) — word-boundary
      // match: "rest" must not fire inside "restaurant", nor "copy" in
      // "copyright".
      if (new RegExp(`(^|[^a-z0-9])${escapeRe(kw)}([^a-z0-9]|$)`).test(normText)) score += 3;
    } else if (normText.includes(kw)) {
      score += 3;
    }
  }
  // The skill's own name spelled out ("utilise le skill pdf").
  const nameSpaced = normalize(c.name).replace(/-/g, ' ');
  const nameCompact = nameSpaced.replace(/ /g, '');
  if (
    nameSpaced.length >= 6 &&
    (normText.includes(nameSpaced) || normText.includes(nameCompact))
  ) {
    score += 4;
  }
  // Weak corroborating signal: significant name/description terms.
  let weak = 0;
  for (const w of derivedWords(c)) {
    if (weak >= 3) break;
    if (normText.includes(w)) weak++;
  }
  score += weak;
  return score;
}

// ---------------------------------------------------------------------------
// Pre-selection
// ---------------------------------------------------------------------------

const THRESHOLD = 3;
const MAX_SKILLS = 3;
const MAX_TOTAL_CHARS = 45_000;

/**
 * Deterministically pick the skills whose expertise the user's message
 * clearly calls for. Returns [] for chit-chat, ambiguous or off-library
 * messages (the USE_SKILL fallback then remains the only skills path).
 * Respects the `skills.catalog.enable` feature flag.
 */
export async function preselectSkills(userText: string): Promise<PreSelectedSkill[]> {
  if (!userText || !userText.trim()) return [];
  try {
    if (!(await configGet<boolean>('skills.catalog.enable', true))) return [];
  } catch {
    /* default: enabled */
  }
  const normText = normalize(userText);
  const hintName = hintSkillForUserMessage(userText);

  const scored: PreSelectedSkill[] = [];
  for (const c of CANDIDATES) {
    let score = scoreCandidate(c, normText);
    if (hintName && c.name === hintName) score += 5;
    if (score >= THRESHOLD) {
      scored.push({ name: c.name, label: c.label, description: c.description, content: c.content, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const out: PreSelectedSkill[] = [];
  let total = 0;
  for (const s of scored) {
    if (out.length >= MAX_SKILLS) break;
    if (out.length > 0 && total + s.content.length > MAX_TOTAL_CHARS) break;
    out.push(s);
    total += s.content.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Injection message (built once per turn, never persisted)
// ---------------------------------------------------------------------------

async function maxChars(): Promise<number> {
  try {
    const v = await configGet<number | null>('skills.content_max_chars', null);
    const n = Math.floor(Number(v) || 0);
    return n >= 1000 ? n : 24_000;
  } catch {
    return 24_000;
  }
}

/**
 * The system message carrying the FULL instructions of the pre-selected
 * skills. It is inserted right after the last user message (the tool-result
 * position, like Claude's skill load) and lives only in this turn's request.
 */
export async function buildPreLoadedSkillsMessage(
  skills: PreSelectedSkill[]
): Promise<{ role: 'system'; content: string }> {
  const cap = await maxChars();
  const blocks = skills
    .map((s) => {
      const content =
        s.content.length > cap ? s.content.slice(0, cap) + '\n\n[--- truncated ---]' : s.content;
      return `<skill name="${s.name}">\n${s.name} — ${s.description}\n\n${content}\n</skill>`;
    })
    .join('\n\n');
  return {
    role: 'system',
    content: `AGENT SKILLS LOADED FOR THIS TASK
The skill packs below were loaded automatically because the user's current request clearly matches them. Follow their instructions closely while answering — they define the standards expected for this task. These skills are ALREADY loaded: never output USE_SKILL(...) for any skill listed below, answer directly instead. You may still begin your reply with USE_SKILL(other_skill) if a DIFFERENT skill from the Agent Skills index is genuinely required for this task.
Remember the platform's document capability: when the user explicitly asks for a downloadable file, emit a \`\`\`document filename="..." block; otherwise keep code and documents inline in normal fenced code blocks.

${blocks}`,
  };
}
