import { kiloChatCompletion } from '@/lib/kilo-llm';

/**
 * Auto video-generation engagement — mirror of auto-image.ts.
 *
 * When the user has NOT toggled any tool, a lightweight classification call
 * on the built-in free chat model decides whether the latest user message
 * is a request to CREATE a VIDEO ("génère une vidéo d'un chat", "fais un
 * clip", "anime cette image"…). When it is, the vibes engine runs the turn
 * exactly like an image turn — the user never has to touch anything.
 *
 * The decision call is cheap: no thinking, temperature 0, ~100 max tokens,
 * messages truncated, last 6 turns only. Any failure fails open (no video —
 * the conversation proceeds normally as a chat turn).
 *
 * The decision also flags ANIMATE turns ("anime cette image", "fais bouger
 * cette photo"…): the caller then feeds the conversation's most recent
 * image (attached this turn, or generated earlier) into the image→video
 * animate endpoint — the video transforms the actual visual instead of
 * re-rolling from a context-free prompt.
 */

export type AutoVideoDecision = { video: boolean; animate: boolean };

/**
 * Deterministic guards — requests that clearly ask for a CODE / WEB artifact
 * can never become a video turn (mirror of the auto-image guard that keeps
 * "créer une landing page ultra moderne" out of the image engine), and
 * requests that clearly ask for a STATIC IMAGE (no video word anywhere) are
 * left to the image engine without burning a classifier call.
 */
const CODE_DELIVERABLE_RE = new RegExp(
  [
    '\\bl(?:a|n|e|an)?ding\\s*pages?\\b',
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

const VIDEO_WORD_RE = new RegExp(
  [
    '\\bvid[ée]os?\\b|\\bvideo\\w*\\b',
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

/** True when the message unambiguously asks for a code/web artifact. */
function clearlyCodeRequest(text: string): boolean {
  if (!text) return false;
  return CODE_DELIVERABLE_RE.test(text) && !VIDEO_WORD_RE.test(text);
}

/** True when the message unambiguously asks for a STATIC image (image tool). */
function clearlyImageRequest(text: string): boolean {
  if (!text) return false;
  return IMAGE_WORD_RE.test(text) && !VIDEO_WORD_RE.test(text);
}

const SYSTEM_PROMPT = `You decide whether the latest user message is a request to CREATE or ANIMATE a VIDEO (to be produced by a video-generation tool), rather than a normal chat message.

The user may write with SPELLING MISTAKES or phonetic approximations (any language, often French — e.g. "cre une video", "fait un clip", "anim ca"). First silently reconstruct what they MEAN, then decide on the corrected intent.

Reply STRICTLY with a single JSON object, no other text:
{"video": true|false, "animate": true|false}

video=true ONLY when the user clearly wants a VIDEO FILE produced: a short clip, animation, animated scene, motion clip, reel / story / TikTok / short, promo or product video, "a video of a cat walking", a moving version of a picture… Typical phrasings (any language): "génère/crée/fais-moi une vidéo de…", "fais un clip de…", "une vidéo où…", "mets-le en vidéo", "anime cette image", "fais bouger cette photo", "make a video of…", "generate a video…", "create an animation of…", "animate this image".
ALSO video=true when the message carries an attached image AND asks to animate/bring it to life — in that case ALSO set animate=true.

animate=true ONLY when video=true AND the request animates an image ALREADY PRESENT (attached to this message or generated earlier in the conversation): "anime cette image", "fais-la bouger", "mets cette photo en vidéo", "animate this", "make it move". animate=false for every video created from scratch (pure text→video).

video=false when: the user asks for a STATIC IMAGE — a drawing, painting, illustration, logo, icon, poster, photo, wallpaper, banner, mockup (that is the IMAGE tool's job, not video) — a WEB or SOFTWARE artifact (landing page, website, app, dashboard, game, code), text deliverables (emails, essays, translations, summaries, video-SCRIPT writing: "écris un script vidéo" is text, NOT a video file), general conversation, math, or questions ABOUT video editing/formats/tools in general. When video=false, animate must be false.

When genuinely uncertain, prefer video=false: wrongly generating a video interrupts a normal conversation far more than missing one does. Only choose video=true when you are CONFIDENT the user wants a produced video file.`;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Extract the first plausible JSON object from a raw LLM answer. */
function parseDecision(raw: string): AutoVideoDecision | null {
  const content = String(raw ?? '').trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    const video = parsed?.video === true || parsed?.video === 'true';
    return { video, animate: video && (parsed?.animate === true || parsed?.animate === 'true') };
  } catch {
    return null;
  }
}

/**
 * Decide whether the latest user message asks for video generation.
 * Returns null on any failure → caller treats it as "no video".
 */
export async function decideAutoVideoGeneration(
  messages: { role: string; content: string }[]
): Promise<AutoVideoDecision | null> {
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
  // ultra moderne") never reaches the classifier, and a clearly-image request
  // ("dessine un logo") belongs to the image engine — zero latency, zero risk
  // of a weak-model misfire hijacking the turn.
  if (clearlyCodeRequest(targetText)) {
    console.log('[auto-video] code-deliverable guard: video=false (no LLM call)');
    return { video: false, animate: false };
  }
  if (clearlyImageRequest(targetText)) {
    console.log('[auto-video] static-image guard: video=false (no LLM call)');
    return { video: false, animate: false };
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
    // model returns an unparsable answer; a null decision means NO video for
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
          '[auto-video] unparsable decision (attempt ' + (attempt + 1) + '):',
          content.slice(0, 200)
        );
      } catch (e) {
        console.error('[auto-video] decision call failed (attempt ' + (attempt + 1) + ')', e);
      }
    }
    return null;
  } catch (e) {
    console.error('[auto-video] decision failed', e);
    return null;
  }
}
