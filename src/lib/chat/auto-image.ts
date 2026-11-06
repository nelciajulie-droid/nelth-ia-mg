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

const SYSTEM_PROMPT = `You decide whether the latest user message is a request to CREATE or EDIT a visual (to be produced by an image-generation tool), rather than a normal chat message.

The user may write with SPELLING MISTAKES or phonetic approximations (any language, often French — e.g. "desine moi", "fait un logo", "cre une image"). First silently reconstruct what they MEAN, then decide on the corrected intent.

Reply STRICTLY with a single JSON object, no other text:
{"image": true|false, "edit": true|false}

image=true ONLY when the user clearly wants a visual produced: a drawing, painting, illustration, picture/photo-style render, logo, icon, avatar, wallpaper/background image, banner, poster, thumbnail, meme, sticker, 3D render, concept art, character design…
Typical phrasings (any language): "dessine-moi…", "dessine un…", "génère/crée une image de…", "fais-moi un logo…", "imagine à quoi ressemblerait…", "montre-moi … en image", "je veux une illustration de…", "un fond d'écran de…", "draw me…", "draw a…", "generate/create/make me an image|picture|logo|illustration…", "paint…", "design me a…", "show me what … would look like", "a photo of…".
ALSO image=true for ITERATION on an image the assistant previously generated: "fais-le en bleu", "même chose mais de nuit", "une autre version", "enlève le chapeau", "rends-le plus grand", "make it blue", "again but at sunset", "another one"… — in that case ALSO set edit=true.

edit=true ONLY when image=true AND the request modifies or reiterates a visual ALREADY PRESENT in the conversation (change its colors/style/size/composition, remove or add an element, "another version", "same but…"). edit=false for every fresh creation from scratch.

image=false when: questions or discussions ABOUT images/graphics in general (formats, compression, how to edit photos in an editor, art history, which tool to use), requests for text/code/data/tables/emails/essays, general conversation, math, translation, summaries, file/document generation, or anything that does NOT ask to produce a visual file. When image=false, edit must be false.

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
