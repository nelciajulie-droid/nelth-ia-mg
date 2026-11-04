import { kiloChatCompletion } from '@/lib/kilo-llm';

/**
 * Auto web-search engagement (TS-port extension).
 *
 * Mirrors the "let the model decide when to search" engagement mode: when the
 * user has NOT toggled the web-search tool, a lightweight classification call
 * on the built-in free chat model decides whether the latest user message
 * needs fresh information from the web (news, prices, weather, releases,
 * post-cutoff facts…). When it does, the regular search chain
 * (src/lib/retrieval/web-search.ts) runs and its results/citations ride the
 * completion exactly like an explicit toggle search.
 *
 * The decision call is cheap: no thinking, temperature 0, ~150 max tokens,
 * messages truncated, last 6 turns only. Any failure fails open (no search —
 * the conversation proceeds normally).
 */

export type AutoSearchDecision = { search: boolean; query: string };

const SYSTEM_PROMPT = `You decide whether a web search is REQUIRED to answer the latest user message.

Reply STRICTLY with a single JSON object, no other text:
{"search": true|false, "query": "..."}

Rules:
- search=true when the message needs FRESH or VOLATILE information the assistant cannot reliably know: current events, news, today's date relative facts, weather, sports results, stock/crypto prices, product prices or availability, recent releases or updates (software, games, movies), recent status of people/companies/countries, anything explicitly time-bound (latest, now, today, yesterday, "en ce moment", "actuellement"), or obscure facts likely absent from training data.
- search=false when: greetings, small talk, math/logic, coding help, creative writing, translation, explanations of stable knowledge, opinions/advice, or when the answer is ALREADY present in the conversation history or in attached <context> document excerpts.
- query: an optimized keyword search query (max ~10 words) in the LANGUAGE OF the user's message, only the essential keywords, no full sentence. Empty string when search=false.`;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Extract the first plausible JSON object from a raw LLM answer. */
function parseDecision(raw: string): AutoSearchDecision | null {
  const content = String(raw ?? '').trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    const search = parsed?.search === true || parsed?.search === 'true';
    const query = typeof parsed?.query === 'string' ? parsed.query.trim() : '';
    if (search && !query) return { search: false, query: '' };
    return { search, query: query.slice(0, 200) };
  } catch {
    return null;
  }
}

/**
 * Decide whether the conversation needs a web search before answering.
 * Returns null on any failure → caller treats it as "no search".
 */
export async function decideAutoWebSearch(
  messages: { role: string; content: string }[]
): Promise<AutoSearchDecision | null> {
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
    // model returns an unparsable answer; retrying both failures markedly
    // improves reliability (a null decision means NO search for that turn).
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
          max_tokens: 200,
          thinking: false,
        });
        const content: string = data?.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) continue; // empty answer → retry
        const decision = parseDecision(content);
        if (decision) return decision;
        console.error('[auto-web-search] unparsable decision (attempt ' + (attempt + 1) + '):', content.slice(0, 200));
      } catch (e) {
        console.error('[auto-web-search] decision call failed (attempt ' + (attempt + 1) + ')', e);
      }
    }
    return null;
  } catch (e) {
    console.error('[auto-web-search] decision failed', e);
    return null;
  }
}
