import { kiloChatCompletion } from '@/lib/kilo-llm';

/**
 * Auto image-generation engagement — mirror of auto-web-search.ts.
 *
 * When the user has NOT toggled the image tool, a lightweight classification
 * call on the built-in free chat model decides whether the latest user
 * message is a request to CREATE or EDIT a visual ("dessine-moi…", "génère
 * un logo", "fais-le en bleu"…). When it is, the Nelthai engine runs the
 * turn exactly like an explicit toggle turn — the user never has to touch
 * the image button.
 *
 * The decision call is cheap: no thinking, temperature 0, ~100 max tokens,
 * messages truncated, last 6 turns only. Any failure fails open (no image —
 * the conversation proceeds normally as a chat turn).
 *
 * The decision also flags ITERATION turns ("fais-le en bleu", "make it
 * blue"…): the caller then feeds the conversation's most recent generated
 * image into the Nelthai image-to-image endpoint, so edits transform the
 * actual previous visual instead of re-rolling from a context-free prompt.
 */

export type AutoImageDecision = { image: boolean; edit: boolean };

/**
 * Deterministic guard — requests that clearly ask for a CODE / WEB /
 * SOFTWARE deliverable can never become an image turn, whatever a weak
 * classifier model decides. Reproduced bug: "creer lading page ultra
 * moderne" (typo + style adjective) was classified image=true by the
 * free decision model and hijacked the turn into the Nelthai engine.
 *
 * The guard only fires when the message carries a code-deliverable noun
 * AND no explicit image-production word (dessine/logo/maquette/…) — the
 * mixed cases ("dessine une maquette de landing page", "crée le logo de
 * mon site") still go to the LLM classifier, which sees the draw intent.
 */
const CODE_DELIVERABLE_RE = new RegExp(
  [
    '\\bsvgs?\\b', // SVG / vector markup — code, never a raster image turn
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

/**
 * SVG hard guard — "créer un SVG d'un chien" is a CODE deliverable: the
 * assistant writes the XML markup directly in its answer. It can NEVER
 * become an image turn, whatever draw verbs or image words accompany it
 * ("dessine-moi le SVG d'un chien", "convertis cette image en SVG") — the
 * image engine produces raster pictures, not SVG files. Reproduced bug:
 * "creer un svg d'un chien" was classified image=true by the free decision
 * model ("créer un … d'un chien" looks like a visual request) and hijacked
 * the turn into the Nelthai engine.
 */
const SVG_REQUEST_RE = /\bsvgs?\b/i;

function clearlySvgRequest(text: string): boolean {
  return SVG_REQUEST_RE.test(text || '');
}

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

/** True when the message unambiguously asks for a code/web artifact. */
function clearlyCodeRequest(text: string): boolean {
  if (!text) return false;
  return CODE_DELIVERABLE_RE.test(text) && !IMAGE_WORD_RE.test(text);
}

/**
 * Video words — a message that asks for a VIDEO ("crée une vidéo d'un chat",
 * "fais un clip", "anime ça"…) belongs to the VIDEO engine, never to the
 * image engine. Symmetric guard of auto-video's static-image guard.
 */
const VIDEO_WORD_RE = new RegExp(
  [
    '\\bvid[ée]os?\\b|\\bvideo\\w*\\b',
    '\\bclips?\\b|\\bcourt[ -]?m[ée]trages?\\b',
    '\\banim(?:ation|ations|er|e|é|ée|es|ees)\\b|\\banim[ée]?\\b|\\banimate\\b|\\banimated\\b',
    '\\breels?\\b|\\bstories?\\b|\\btiktoks?\\b|\\bshorts?\\b',
    '\\bmotion\\b|\\bmouvement\\b',
    '\\b(?:fais|fait|met|mets|mettre)\\s+(?:[çc]a|ceci|cela)\\s+(?:bouger|en\\s+mouvement)\\b',
    '\\b(?:make|put)\\s+(?:it|this)\\s+(?:move|in\\s+motion)\\b',
  ].join('|'),
  'i'
);

/** True when the message unambiguously asks for a video (video tool). */
function clearlyVideoRequest(text: string): boolean {
  if (!text) return false;
  return VIDEO_WORD_RE.test(text) && !IMAGE_WORD_RE.test(text);
}

const SYSTEM_PROMPT = `You decide whether the latest user message is a request to CREATE or EDIT a visual (to be produced by an image-generation tool), rather than a normal chat message.

The user may write with SPELLING MISTAKES or phonetic approximations (any language, often French — e.g. "desine moi", "fait un logo", "cre une image", "lading page" = landing page). First silently reconstruct what they MEAN, then decide on the corrected intent.

Reply STRICTLY with a single JSON object, no other text:
{"image": true|false, "edit": true|false}

image=true ONLY when the user clearly wants a visual produced: a drawing, painting, illustration, picture/photo-style render, logo, icon, avatar, wallpaper/background image, banner, poster, thumbnail, meme, sticker, 3D render, concept art, character design…
Typical phrasings (any language): "dessine-moi…", "dessine un…", "génère/crée une image de…", "fais-moi un logo…", "imagine à quoi ressemblerait…", "montre-moi … en image", "je veux une illustration de…", "un fond d'écran de…", "draw me…", "draw a…", "generate/create/make me an image|picture|logo|illustration…", "paint…", "design me a…", "show me what … would look like", "a photo of…".
ALSO image=true for ITERATION on an image the assistant previously generated: "fais-le en bleu", "même chose mais de nuit", "une autre version", "enlève le chapeau", "rends-le plus grand", "make it blue", "again but at sunset", "another one"… — in that case ALSO set edit=true.

edit=true ONLY when image=true AND the request modifies or reiterates a visual ALREADY PRESENT in the conversation (change its colors/style/size/composition, remove or add an element, "another version", "same but…"). edit=false for every fresh creation from scratch.

image=false when: the user asks for a WEB or SOFTWARE artifact — a landing page, website, web page, site vitrine, app, application, dashboard, portfolio, blog, online store, game, API, script, or any HTML/CSS/JS/React/Python code — even with style adjectives like "ultra moderne", "moderne", "beau", "impressionnant": those describe CODE quality, NOT an image. Building a page IS writing code. Also image=false for: any SVG or vector-graphics CODE request ("crée un SVG", "génère le SVG d'un chien", "dessine-moi un SVG", "convertis cette image en SVG") — an SVG is XML markup the assistant writes in its answer, NOT an image-generation output, and this rule OVERRIDES any draw verb; questions or discussions ABOUT images/graphics in general (formats, compression, how to edit photos in an editor, art history, which tool to use), requests for text/code/data/tables/emails/essays, general conversation, math, translation, summaries, file/document generation, or anything that does NOT ask to produce a visual raster file. When image=false, edit must be false.

EXCEPTION — explicit draw verbs win: when the message combines an IMAGE-PRODUCTION verb or noun ("dessine", "draw", "génère une image", "montre-moi en image", "une maquette/mockup/visuel DE …") with a code noun ("dessine une maquette de landing page", "montre-moi un visuel du site"), the user wants a VISUAL RENDER of that artifact → image=true. The draw intent outranks the code noun. The exception NEVER covers SVG: an SVG request stays image=false whatever the verb — an SVG is code, and the image engine cannot produce one.

When genuinely uncertain, prefer image=false: wrongly generating an image interrupts a normal conversation far more than missing one does (the user can always use the image toggle). Only choose image=true when you are CONFIDENT the user wants a produced visual.`;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Extract the first plausible JSON object from a raw LLM answer. */
function parseDecision(raw: string): AutoImageDecision | null {
  const content = String(raw ?? '').trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    const image = parsed?.image === true || parsed?.image === 'true';
    return { image, edit: image && (parsed?.edit === true || parsed?.edit === 'true') };
  } catch {
    return null;
  }
}

/**
 * Decide whether the latest user message asks for image generation.
 * Returns null on any failure → caller treats it as "no image".
 */
export async function decideAutoImageGeneration(
  messages: { role: string; content: string }[]
): Promise<AutoImageDecision | null> {
  // Latest user message — the decision target.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return null;
  const targetText = String(messages[lastUserIdx].content ?? '');

  // Deterministic guards FIRST: a clearly-code request ("créer landing page
  // ultra moderne", "développe une app") never reaches the classifier —
  // zero latency, zero risk of a weak-model misfire hijacking the turn. A
  // clearly-VIDEO request ("crée une vidéo", "fais un clip") equally stays
  // out: the video engine owns that turn, not the image engine. And an SVG
  // request is ALWAYS code — even "dessine-moi le SVG d'un chien" (the
  // classifier cannot be trusted to know an SVG is XML, so this guard runs
  // before it, unconditionally).
  if (clearlySvgRequest(targetText)) {
    console.log('[auto-image] svg-code guard: image=false (no LLM call)');
    return { image: false, edit: false };
  }
  if (clearlyCodeRequest(targetText)) {
    console.log('[auto-image] code-deliverable guard: image=false (no LLM call)');
    return { image: false, edit: false };
  }
  if (clearlyVideoRequest(targetText)) {
    console.log('[auto-image] video-request guard: image=false (no LLM call)');
    return { image: false, edit: false };
  }

  // Compact transcript: last 6 turns, older ones heavily truncated.
  const window = messages.slice(Math.max(0, lastUserIdx - 5), lastUserIdx + 1);
  const transcript = window
    .map((m, i) => {
      const isTarget = lastUserIdx - Math.max(0, lastUserIdx - 5) === i;
      const cap = isTarget ? 1500 : 400;
      return `${m.role.toUpperCase()}: ${truncate(m.content, cap)}`;
    })
    .join('\n\n');
  const userPrompt = `${transcript}\n\n---\nDecide now. JSON only.`;

  try {
    // Up to three attempts — the gateway occasionally drops a request or the
    // model returns an unparsable answer; a null decision means NO image for
    // that turn (fail open, the chat proceeds normally).
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 700 * attempt));
      try {
        const data = await kiloChatCompletion({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
          temperature: 0,
          max_tokens: 100,
          thinking: false,
        });
        const content: string = data?.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) continue; // empty answer → retry
        const decision = parseDecision(content);
        if (decision) return decision;
        console.error(
          '[auto-image] unparsable decision (attempt ' + (attempt + 1) + '):',
          content.slice(0, 200)
        );
      } catch (e) {
        console.error('[auto-image] decision call failed (attempt ' + (attempt + 1) + ')', e);
      }
    }
    return null;
  } catch (e) {
    console.error('[auto-image] decision failed', e);
    return null;
  }
}
