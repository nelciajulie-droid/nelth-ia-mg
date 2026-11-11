import { kiloChatCompletion } from '@/lib/kilo-llm';

/**
 * Auto engagement router — ONE combined classifier call (TS-port extension).
 *
 * Replaces the three PARALLEL decision calls (auto-image.ts, auto-video.ts,
 * auto-web-search.ts). Why the change: on the keyless z-ai engine the three
 * calls fired simultaneously on EVERY gated turn, and the backend answers
 * "429 Too many requests" to concurrent bursts (reproduced: single call OK
 * in ~450ms, 3 parallel → 2 of 3 killed by 429). Each module retried, but the
 * retries re-collided — so on some turns the image/video/search engagement
 * silently failed open ("auto tools sometimes bug"), the turn fell back to a
 * plain chat answer, and the model then hallucinated refusals like "Je ne
 * peux pas générer d'images… utilisez l'icône d'upload". ONE call per turn
 * removes the intra-turn collision entirely, cuts decision latency ~3x, and
 * leaves the retry loop to absorb rare transient drops.
 *
 * The single JSON decides everything:
 *   {"video":…, "animate":…, "aspectRatio":…, "image":…, "edit":…, "search":…, "query":…}
 *
 * Semantics preserved from the three modules:
 *   • deterministic guards (SVG / code deliverable / video-word / image-word)
 *     applied AFTER parsing — a weak classifier can never hijack a code turn
 *     into the media engines ("créer landing page ultra moderne") nor miss an
 *     unambiguous routing ("dessine un logo" → image, "crée une vidéo" → video);
 *   • GIF/animated-artifact vocabulary (NEW — "génère un GIF de…" previously
 *     matched no engine vocabulary and fell through to a plain refusal): a
 *     GIF is a short ANIMATED artifact → the VIDEO engine owns it, with a
 *     deterministic lexical net as backstop when the classifier misses;
 *   • the high-confidence lexical search net from auto-web-search.ts
 *     (identity/ranking/news questions force the search on regardless of a
 *     conservative classifier answer or a failed call);
 *   • transcript isolation: only user/assistant turns ride the decision call —
 *     system prompts (capability blocks, misspell hints) never pollute it;
 *   • cheap call: no thinking, temperature 0, ~160 max tokens, last 6 turns
 *     only, any failure fails open (all false — the turn proceeds as chat).
 */

export type AutoEngagementDecision = {
  /** text→image or image→image generation (Nelthai engine) */
  image: boolean;
  /** image=true AND iterating on a previous visual ("fais-le en bleu") */
  edit: boolean;
  /** text→video or image→video generation (vibes engine) */
  video: boolean;
  /** video=true AND animating an image already present in the conversation */
  animate: boolean;
  /** vibes-engine format pick — 16:9 / 1:1 / 9:16 ONLY */
  aspectRatio?: '16:9' | '1:1' | '9:16';
  /** web search before answering (only consumed when no media turn) */
  search: boolean;
  /** optimized keyword query for the search engine (empty when no search) */
  query: string;
};

/** Fail-open neutral decision (used when no user message / total failure). */
const NO_ENGAGEMENT: AutoEngagementDecision = {
  image: false,
  edit: false,
  video: false,
  animate: false,
  search: false,
  query: '',
};

// ---------------------------------------------------------------------------
// Deterministic vocabulary (consolidated from the three per-tool modules)
// ---------------------------------------------------------------------------

/** Code/web/software deliverable nouns — the assistant writes these as CODE. */
const CODE_DELIVERABLE_RE = new RegExp(
  [
    '\\bsvgs?\\b', // SVG / vector markup — code, never a raster media turn
    '\\bl(?:a|n|e|an)?ding\\s*pages?\\b', // landing page + "lading" typo
    '\\bpages?\\s+(?:d[’\']accueil|web|webs?)\\b',
    '\\bsites?\\s+(?:web|vitrines?|internets?|dynamiques?|e-?commerces?)\\b',
    '\\bsites?\\b|\\bwebsite\\b|\\bwebapp\\b|\\bweb\\s*app\\b',
    '\\bapplications?\\b|\\bapps?\\b|\\bapplications?\\s+mobiles?\\b',
    '\\btableaux?\\s+de\\s+bord\\b|\\bdashboards?\\b',
    '\\bportfolios?\\b|\\bblogs?\\b|\\bboutiques?\\b',
    '\\bjeux?\\s+vid[ée]o\\b|\\bjeux?\\b|\\bgame\\b|\\bgameplay\\b',
    '\\bfront[ -]?end\\b|\\bback[ -]?end\\b|\\bfull[ -]?stack\\b',
    '\\bapi\\b|\\bbase\\s+de\\s+donn[ée]es\\b|\\bcrud\\b',
    '\\bhtml\\b|\\bcss\\b|\\bjavascript\\b|\\btypescript\\b|\\breact\\b|\\bvue\\b|\\bangular\\b|\\bsvelte\\b',
    '\\bnext\\.?js\\b|\\btailwind\\b|\\bpython\\b|\\bphp\\b|\\blaravel\\b|\\bdjango\\b|\\bnode\\b',
    '\\bd[ée]velopp\\w+|\\bcod(?:er|e|ing)\\b|\\bprogramme[rz]?\\b|\\bprogrammant\\b',
    '\\bformulaire\\w*\\b|\\bcheckouts?\\b|\\btunnels?\\s+de\\s+vente\\b',
  ].join('|'),
  'i'
);

/** SVG hard guard — an SVG request is XML markup the assistant writes, NEVER
 *  a media turn, whatever draw verbs accompany it ("dessine-moi le SVG d'un
 *  chien"). The media engines produce raster pictures/videos, not SVG files. */
const SVG_REQUEST_RE = /\bsvgs?\b/i;

/** Static-image vocabulary (image engine territory). */
const IMAGE_WORD_RE = new RegExp(
  [
    '\\bimage\\w*\\b|\\bimages\\b',
    '\\bdessin\\w*\\b|\\bdesine\\w*\\b|\\bdraw\\w*\\b|\\bpaint\\w*\\b',
    '\\billustration\\w*\\b|\\bvisuels?\\b',
    '\\blogos?\\b|\\bicon(?:es?|s?)\\b|\\bavatars?\\b',
    '\\bfonds?\\s+d[’\']?[ée]cran\\b|\\bwallpapers?\\b',
    '\\bbanni[èe]res?\\b|\\baffiches?\\b|\\bposters?\\b',
    '\\bmaquettes?\\b|\\bmockups?\\b|\\bwireframes?\\b',
    '\\bphotos?\\b|\\bphotographie\\b|\\brendus?\\b|\\bconcept\\s+arts?\\b',
    '\\bstickers?\\b|\\bmemes?\\b|\\bpixel\\s+arts?\\b',
    '\\bmontage\\b|\\bcollage\\b',
  ].join('|'),
  'i'
);

/**
 * Video vocabulary (video engine territory) — GIF included: a GIF is a short
 * ANIMATED artifact, so "génère un GIF de…" routes to the video engine, never
 * the static-image one (reproduced bug: GIF requests matched no engine and
 * fell through to the model's "je ne peux pas générer…" hallucination).
 */
const VIDEO_WORD_RE = new RegExp(
  [
    '\\bvid[ée]os?\\b|\\bvideo\\w*\\b',
    '\\bgifs?\\b|\\bgif\\b', // animated artifact → video engine
    '\\bclips?\\b|\\bcourt[ -]?m[ée]trages?\\b|\\bfilmatique\\b',
    '\\banim(?:ation|ations|er|e|é|ée|es|ees)\\b|\\banim[ée]?\\b|\\banimate\\b|\\banimated\\b',
    '\\breels?\\b|\\bstories?\\b|\\btiktoks?\\b|\\bshorts?\\b',
    '\\bmotion\\b|\\bmovement\\b|\\bmouvement\\b',
    '\\b(?:fais|fait|met|mets|mettre)\\s+(?:[çc]a|ceci|cela)\\s+(?:bouger|en\\s+mouvement)\\b',
    '\\b(?:make|put)\\s+(?:it|this)\\s+(?:move|in\\s+motion)\\b',
    '\\bmoving\\s+(?:picture|image|photo)\\b',
  ].join('|'),
  'i'
);

/** GIF lexical net — a bare "gif" request deterministically engages the
 *  video engine even when the classifier misses it (a GIF can NEVER be
 *  answered by a plain text turn — that path produced the reported
 *  "je ne peux pas générer de GIF" refusals). */
const GIF_REQUEST_RE = /\b(?:gifs?|jifs?)\b/i;

// ---------------------------------------------------------------------------
// Lexical search safety net (verbatim from auto-web-search.ts)
// ---------------------------------------------------------------------------

const FORCE_SEARCH_PATTERNS: RegExp[] = [
  // Identity question about a current holder/role/star/public figure.
  /(?:qui\s+(?:est|sont)|c\s*'?est\s+qui|quel(?:le|s)?\s+(?:est|sont)|le\s+nouveau|la\s+nouvelle)[^.?!]{0,80}(?:pr[eéè]sid(?:ent|ente|an[dt]|ong)|premier\s+ministre|ministre|roi|reine|pape|maire|gouverneur|pr[eé]fet|d[eé]put[eé]|s[eé]nateur|pdg\b|ceo\b|patron(?:ne)?|direct(?:eur|rice)|dirigeant(?:e)?|champion(?:ne)?|s[eé]cr[eé]taire\s+g[eé]n[eé]ral|star|c[eé]l[eé]brit[eé]|milliardaire|homme\s+d['’]état|dirigeante)/i,
  // Superlative rankings about volatile things (people, companies, prices…).
  /(?:\b(?:le|la|les|l|un|une|d)\s+|d['’])(?:plus|moins)\s+(?:riche|puissant(?:e)?|c[eéè]l[eèé]bre|populaire|influent(?:e)?|grand(?:e)?|fort(?:e)?|beau|belle|intelligent(?:e)?|rapide|cher(?:e)?|pay[eé]|gros(?:se)?|g[eé]nial(?:e)?|demand[eé]|suivi(?:e)?|regard[eé]|aim[eé]|aim[eé]e|écout[eé]|lu(?:e)?|vendu(?:e)?|co[uû]t(?:er)?[eé]?)/i,
  // Explicit news/currency phrasings.
  /(?:actualit[eé]s?|\bactus?\b|quoi\s+de\s+neuf|derni[eè]re?s?\s+(?:news|nouvelles|infos?|information|r[eé]sultats?)|les\s+news\b|vient\s+(?:de\s+)?(?:se\s+)?(?:passer|arriver|d[eé]c[eé]der|mourir|sortir|sorti))/i,
];

/** Light phonetic normalization for the net ONLY (matching, never displayed). */
function normalizeForNet(text: string): string {
  return String(text || '')
    .replace(/\bki\b/gi, 'qui')
    .replace(/\b(qu+i|quelle?s?|c\s*['’]?\s*est)\s+(?:et|es|ai|é|è|est)\b/gi, (m) => m.replace(/\s(?:et|es|ai|é|è|est)\b/, ' est'))
    .replace(/\bqui\s+(?:son|sons)\b/gi, 'qui sont');
}

function forcedSearchMatch(text: string): boolean {
  const t = normalizeForNet(text);
  if (!t.trim()) return false;
  for (const re of FORCE_SEARCH_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Combined classifier prompt (merged from the three per-tool prompts)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the automatic tool router of the Nelth-AI chat platform. Decide, from the LATEST user message, whether THIS turn should engage the platform's VIDEO engine, IMAGE engine, or a WEB SEARCH.

The user may write with SPELLING MISTAKES or phonetic approximations (any language, often French — e.g. "desine moi", "fait un logo", "cre une image", "lading page" = landing page). First silently reconstruct what they MEAN, then decide on the corrected intent.

Reply STRICTLY with a single JSON object, no other text:
{"video": true|false, "animate": true|false, "aspectRatio": "16:9"|"1:1"|"9:16", "image": true|false, "edit": true|false, "search": true|false, "query": "..."}

VIDEO — video=true ONLY when the user clearly wants a MOVING artifact: a video file, short clip, ANIMATION or GIF, reel/story/TikTok/short, promo or product video, a moving version of a picture. Typical phrasings (any language): "génère/crée/fais-moi une vidéo de…", "fais un clip", "un GIF de…", "fais-moi un GIF", "anime cette image", "fais bouger cette photo", "make a video of…", "animate this image". ALSO video=true when the message carries an attached image AND asks to animate/bring it to life — in that case ALSO set animate=true.
animate=true ONLY when video=true AND it animates an image ALREADY PRESENT (attached to this message or generated earlier in the conversation): "anime cette image", "fais-la bouger", "mets cette photo en vidéo", "make it move". animate=false for every video created from scratch (pure text→video).
aspectRatio — when video=true AND animate=false, pick the ratio giving the BEST result for THIS video, exactly one of "16:9" (landscape, cinematic, wide scenes, vehicles, city, several elements), "9:16" (vertical, phone-screen, reel/story/TikTok content, standing/dancing person), "1:1" (square, single centered subject, product on plain background, logo-like loop). An EXPLICIT user format keyword ALWAYS wins: vertical/portrait/story/reel/TikTok/short → "9:16"; carré/square → "1:1"; horizontal/paysage/landscape → "16:9". When video=false or animate=true, set "16:9" (ignored anyway).

IMAGE — image=true ONLY when video=false AND the user clearly wants a STATIC visual produced: a drawing, painting, illustration, picture/photo-style render, logo, icon, avatar, wallpaper/background image, banner, poster, thumbnail, meme, sticker, 3D render, concept art, character design. Typical phrasings: "dessine-moi…", "génère/crée une image de…", "fais-moi un logo…", "imagine à quoi ressemblerait…", "montre-moi … en image", "draw me…", "show me what … would look like". ALSO image=true for ITERATION on an image the assistant previously generated ("fais-le en bleu", "même chose mais de nuit", "une autre version", "enlève le chapeau") — in that case ALSO set edit=true. edit=true ONLY when image=true AND it modifies or reiterates a visual ALREADY PRESENT; edit=false for every fresh creation.

CODE / SVG IS NEVER MEDIA — image=false AND video=false when the user asks for a WEB or SOFTWARE artifact: landing page, website, web page, site vitrine, app, application, dashboard, portfolio, blog, online store, game, API, script, HTML/CSS/JS/React/Python code — even with style adjectives like "ultra moderne" (those describe CODE quality). Also false for ANY SVG or vector-graphics request ("crée un SVG d'un chien", "dessine-moi le SVG", "convertis cette image en SVG"): an SVG is XML markup the assistant writes in its answer — this rule OVERRIDES any draw verb. EXCEPTION — explicit draw verbs win over code nouns for RASTER output: "dessine une maquette de landing page", "montre-moi un visuel du site" → image=true (the user wants a visual render). The exception NEVER covers SVG.

SEARCH — search=true ONLY when image=false AND video=false AND the answer depends on facts that change or the assistant cannot reliably know: CURRENT HOLDERS of a role/title ("qui est le président", "le PDG de Tesla", "le champion en titre" — time-sensitive EVEN WITHOUT "actuellement"); RANKINGS/SUPERLATIVES ("l'homme le plus puissant", "la star la plus célèbre", "l'entreprise la plus riche"); current situation of real people/stars/companies/teams; news & current events; volatile data (weather, scores, prices, schedules, recent releases); obscure facts. search=false for greetings, small talk, math/logic, coding help, creative writing, translation, STABLE knowledge (history, science, definitions), or when the answer is ALREADY present in the conversation history. query: an optimized keyword search query (max ~10 words) in the LANGUAGE of the user's message, CORRECTLY spelled (silently fix their mistakes), essential keywords only, no full sentence. Empty string when search=false.

PRIORITY — exactly ONE engine per turn: video outranks image (a GIF/clip/animation request is video, NEVER image), image outranks search, and a media turn never searches (search=false when image or video is true). When genuinely uncertain, prefer everything false: wrongly generating media or a search interrupts a normal conversation far more than missing one does. Only choose true when you are CONFIDENT.`;

// ---------------------------------------------------------------------------
// Decision call
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The three aspect ratios the vibes engine accepts — nothing else. */
const VIDEO_RATIOS = ['16:9', '1:1', '9:16'] as const;

/** Extract the first plausible JSON object from a raw LLM answer. */
function parseDecision(raw: string): AutoEngagementDecision | null {
  const content = String(raw ?? '').trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    const video = parsed?.video === true || parsed?.video === 'true';
    const image = parsed?.image === true || parsed?.image === 'true';
    const search = parsed?.search === true || parsed?.search === 'true';
    const rawRatio = String(parsed?.aspectRatio ?? '').trim();
    const aspectRatio = (VIDEO_RATIOS as readonly string[]).includes(rawRatio)
      ? (rawRatio as AutoEngagementDecision['aspectRatio'])
      : undefined;
    const query = typeof parsed?.query === 'string' ? parsed.query.trim().slice(0, 200) : '';
    return {
      video,
      animate: video && (parsed?.animate === true || parsed?.animate === 'true'),
      aspectRatio: video ? aspectRatio : undefined,
      image: !video && image, // video outranks image — never both
      edit: !video && image && (parsed?.edit === true || parsed?.edit === 'true'),
      search: !video && !image && search && !!query ? true : false,
      query,
    };
  } catch {
    return null;
  }
}

/**
 * Decide — in ONE classifier call — whether the latest user message should
 * engage the video engine, the image engine, or a web search.
 * Fail-open: returns the neutral all-false decision on any failure.
 */
export async function decideAutoEngagement(
  messages: { role: string; content: string }[]
): Promise<AutoEngagementDecision> {
  // Latest user message — the decision target.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return NO_ENGAGEMENT;
  const targetText = String(messages[lastUserIdx].content ?? '');

  // Compact transcript: last 6 turns, user/assistant ONLY (system prompts —
  // capability blocks, misspell hints — never pollute the routing decision),
  // older turns heavily truncated, the target turn itself generously capped.
  const window = messages
    .slice(Math.max(0, lastUserIdx - 5), lastUserIdx + 1)
    .filter((m) => m.role === 'user' || m.role === 'assistant');
  const transcript = window
    .map((m, i) => {
      const isTarget = i === window.length - 1;
      const cap = isTarget ? 1500 : 400;
      return `${m.role.toUpperCase()}: ${truncate(m.content, cap)}`;
    })
    .join('\n\n');
  const userPrompt = `${transcript}\n\n---\nDecide now. JSON only.`;

  // Classifier call with retry — the 6s total budget gates the user-visible
  // first token; a dropped request or unparsable answer retries while the
  // budget allows, then fails open (the turn proceeds as a normal chat).
  let decision: AutoEngagementDecision | null = null;
  try {
    const deadline = Date.now() + 6_500;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 1_200) break; // not enough budget left for a real call
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, Math.min(700 * attempt, Math.max(0, remaining - 1_000))));
      }
      try {
        const data = await kiloChatCompletion({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
          temperature: 0,
          max_tokens: 160,
          thinking: false,
          timeoutMs: Math.min(remaining, 5_000),
        });
        const content: string = data?.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) continue; // empty answer → retry
        const parsed = parseDecision(content);
        if (parsed) {
          decision = parsed;
          break;
        }
        console.error(
          '[auto-engage] unparsable decision (attempt ' + (attempt + 1) + '):',
          content.slice(0, 200)
        );
      } catch (e) {
        console.error('[auto-engage] decision call failed (attempt ' + (attempt + 1) + ')', e);
      }
    }
  } catch (e) {
    console.error('[auto-engage] decision failed', e);
  }

  const result: AutoEngagementDecision = decision ?? { ...NO_ENGAGEMENT };

  // ---- Deterministic guard overrides (post-parse — the classifier can never
  // ---- hijack a code turn into a media engine, and unambiguous routings are
  // ---- enforced even when the weak model misfires).
  const svg = SVG_REQUEST_RE.test(targetText);
  const imageWords = IMAGE_WORD_RE.test(targetText);
  const videoWords = VIDEO_WORD_RE.test(targetText);
  if (svg || (CODE_DELIVERABLE_RE.test(targetText) && !imageWords && !videoWords)) {
    console.log('[auto-engage] svg/code guard → image=false, video=false');
    result.image = false;
    result.edit = false;
    result.video = false;
    result.animate = false;
  } else {
    if (videoWords && !imageWords) result.image = false; // video engine owns it
    if (imageWords && !videoWords) result.video = false; // image engine owns it
    // GIF lexical net — a bare "gif" request deterministically routes to the
    // video engine (a GIF is animated); the animate flag stays as parsed so
    // "convertis cette image en gif" keeps its image→video animate source.
    if (!result.video && !result.image && GIF_REQUEST_RE.test(targetText)) {
      console.log('[auto-engage] gif net → video=true');
      result.video = true;
    }
  }

  // ---- Lexical search net — fires AFTER the classifier: identity/ranking/
  // ---- news questions force the search even when the model answered false
  // ---- or the call failed entirely (a wasted search costs seconds; a stale
  // ---- "le président est X" costs the user's trust).
  if (!result.search && !result.image && !result.video && forcedSearchMatch(targetText)) {
    const rawQuery = targetText.replace(/\s+/g, ' ').trim().slice(0, 150);
    result.search = true;
    result.query = decision?.query?.trim() || rawQuery;
    console.log(
      '[auto-engage] lexical net forced search' + (decision ? ' (model said false)' : ' (model decision unavailable)'),
      '— query:',
      result.query
    );
  }

  return result;
}
