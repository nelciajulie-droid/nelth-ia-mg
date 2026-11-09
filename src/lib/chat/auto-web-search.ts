import { kiloChatCompletion } from '@/lib/kilo-llm';

/**
 * Auto web-search engagement (TS-port extension).
 *
 * Mirrors the "let the model decide when to search" engagement mode: when the
 * user has NOT toggled the web-search tool, a lightweight classification call
 * on the built-in free chat model decides whether the latest user message
 * needs fresh information from the web. When it does, the regular search
 * chain (src/lib/retrieval/web-search.ts) runs and its results/citations ride
 * the completion exactly like an explicit toggle search.
 *
 * Robustness layers for real-world users (the reported failure modes):
 *   • Misspelled / phonetic messages ("presidan de la republik") — the prompt
 *     makes the decision model reconstruct the intent and write a CORRECTLY
 *     spelled query for the search engine.
 *   • Identity/ranking questions about volatile entities ("qui est le
 *     président", "l'homme le plus puissant", "la star la plus célèbre",
 *     "l'entreprise la plus riche") — the small model sometimes answers
 *     search=false on these; a high-confidence lexical safety net forces the
 *     search on regardless of the model's answer.
 *
 * The decision call is cheap: no thinking, temperature 0, ~150 max tokens,
 * messages truncated, last 6 turns only. Any failure fails open (no search —
 * the conversation proceeds normally).
 */

export type AutoSearchDecision = { search: boolean; query: string };

const SYSTEM_PROMPT = `You decide whether a web search is REQUIRED to answer the latest user message.

Reply STRICTLY with a single JSON object, no other text:
{"search": true|false, "query": "..."}

The user may write with SPELLING MISTAKES or phonetic approximations (any language, often French). First silently reconstruct what they MEAN, then decide on the corrected intent — never let a typo block a search the intent clearly calls for.

search=true whenever the answer depends on facts that change or that the assistant cannot reliably know:

1. CURRENT HOLDERS of a role/title/status — "qui est le président de la république", "le premier ministre", "qui gouverne X", "le PDG de Tesla", "le champion en titre", "le pape", "qui est le maire de Paris", "qui est le patron de X". These are time-sensitive EVEN WITHOUT words like "actuellement" or "aujourd'hui": the present tense is implicit in the question.
2. RANKINGS / SUPERLATIVES about people, companies or teams — "l'homme le plus puissant du monde", "la star la plus célèbre", "l'entreprise la plus riche", "le footballeur le mieux payé", "l'athlète le plus rapide", "la marque la plus vendue". Such rankings change constantly → always search.
3. PEOPLE / STARS / COMPANIES / TEAMS / BRANDS whose CURRENT situation matters — what a real public figure, celebrity, athlete, company or organization is doing now, what happened to them, their latest statements, releases, records, results, lawsuits, relationships, wealth, health, death, or any recent development about them.
4. NEWS & CURRENT EVENTS — "quoi de neuf sur X", "l'actualité de X", recent events, incidents, elections, wars, laws, verdicts, scores.
5. VOLATILE DATA — weather, sports results, stock/crypto/product prices, exchange rates, schedules (TV, transport, events), recent releases or updates (software, games, movies), anything explicitly time-bound ("en ce moment", "actuellement", "aujourd'hui", "hier", "dernier", "nouveau").
6. OBSCURE facts likely absent from training data.

search=false ONLY for: greetings, small talk, math/logic, coding help, creative writing, translation, explanations of STABLE knowledge (history, science, definitions), opinions/advice — or when the answer is ALREADY present in the conversation history or in attached <context> excerpts.

When genuinely uncertain, prefer search=true: a quick search costs a few seconds, while a stale or invented answer is much worse. Only choose search=false when you are CONFIDENT the message needs no fresh data.

query: an optimized keyword search query (max ~10 words) in the LANGUAGE OF the user's message, in CORRECT spelling (silently fix the user's mistakes so the search engine can match), only the essential keywords, no full sentence. Empty string when search=false.`;

/**
 * High-confidence lexical safety net. The exact reported failure mode: the
 * small decision model answering search=false on identity/ranking questions
 * about volatile entities. When a pattern below matches the latest user
 * message, the search is forced on — query: the model's (when it produced
 * one), else the raw text. Accent-variant tolerant.
 */
const FORCE_SEARCH_PATTERNS: RegExp[] = [
  // Identity question about a current holder/role/star/public figure.
  /(?:qui\s+(?:est|sont)|c\s*'?est\s+qui|quel(?:le|s)?\s+(?:est|sont)|le\s+nouveau|la\s+nouvelle)[^.?!]{0,80}(?:pr[eéè]sid(?:ent|ente|an[dt]|ong)|premier\s+ministre|ministre|roi|reine|pape|maire|gouverneur|pr[eé]fet|d[eé]put[eé]|s[eé]nateur|pdg\b|ceo\b|patron(?:ne)?|direct(?:eur|rice)|dirigeant(?:e)?|champion(?:ne)?|s[eé]cr[eé]taire\s+g[eé]n[eé]ral|star|c[eé]l[eé]brit[eé]|milliardaire|homme\s+d['’]état|dirigeante)/i,
  // Superlative rankings about volatile things (people, companies, prices…).
  /(?:\b(?:le|la|les|l|un|une|d)\s+|d['’])(?:plus|moins)\s+(?:riche|puissant(?:e)?|c[eéè]l[eèé]bre|populaire|influent(?:e)?|grand(?:e)?|fort(?:e)?|beau|belle|intelligent(?:e)?|rapide|cher(?:e)?|pay[eé]|gros(?:se)?|g[eé]nial(?:e)?|demand[eé]|suivi(?:e)?|regard[eé]|aim[eé]|aim[eé]e|écout[eé]|lu(?:e)?|vendu(?:e)?|co[uû]t(?:er)?[eé]?)/i,
  // Explicit news/currency phrasings.
  /(?:actualit[eé]s?|\bactus?\b|quoi\s+de\s+neuf|derni[eè]re?s?\s+(?:news|nouvelles|infos?|information|r[eé]sultats?)|les\s+news\b|vient\s+(?:de\s+)?(?:se\s+)?(?:passer|arriver|d[eé]c[eé]der|mourir|sortir|sorti))/i,
];

/**
 * Light phonetic normalization for the net ONLY (matching, never displayed):
 * the most common French misspellings on the question words — "ki" → "qui",
 * "qui et / quel et / qui ai" → "qui est" (the est/et/ai confusion), "qui son"
 * → "qui sont". Applied before the patterns so a faulty spelling cannot hide
 * an otherwise obvious identity question.
 */
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
  const lastUserContent = String(messages[lastUserIdx].content || '');

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

  // Model decision (null on total failure, {search:false} on a "no").
  let decision: AutoSearchDecision | null = null;
  try {
    // TOTAL time budget: this call gates the user-visible first token (the
    // "Réflexion" shimmer before the answer starts streaming) — a free
    // non-streaming gateway call can queue for tens of seconds, which used
    // to hang EVERY plain-chat turn. The budget fails open (no search).
    const deadline = Date.now() + 6_000;
    // Up to three attempts while the budget allows — the gateway
    // occasionally drops a request or the model returns an unparsable
    // answer; retrying both failures markedly improves reliability (a null
    // decision means NO search for that turn).
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
          max_tokens: 200,
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
        console.error('[auto-web-search] unparsable decision (attempt ' + (attempt + 1) + '):', content.slice(0, 200));
      } catch (e) {
        console.error('[auto-web-search] decision call failed (attempt ' + (attempt + 1) + ')', e);
      }
    }
  } catch (e) {
    console.error('[auto-web-search] decision failed', e);
  }

  // Lexical safety net — fires AFTER the model: the reported cases are
  // identity/ranking questions about volatile entities where the small model
  // is sometimes over-conservative. The net overrides a "no"/failure with
  // confidence: a wasted search costs seconds, a stale "le président est
  // X" costs the user's trust.
  if (decision?.search) return decision;
  if (forcedSearchMatch(lastUserContent)) {
    const rawQuery = lastUserContent.replace(/\s+/g, ' ').trim().slice(0, 150);
    const query = decision?.query?.trim() || rawQuery;
    console.log(
      '[auto-web-search] lexical net forced search' + (decision ? ' (model said false)' : ' (model decision unavailable)'),
      '— query:',
      query
    );
    return { search: true, query };
  }
  return decision;
}
