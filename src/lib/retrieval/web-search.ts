/**
 * Built-in web search engine — TS-port extension (replaces the un-ported
 * Python search providers).
 *
 * Zero-config fallback chain (endpoints validated by the user):
 *   1. DuckDuckGo Lite  — POST https://lite.duckduckgo.com/lite/   (form: q)
 *   2. DuckDuckGo HTML  — GET  https://html.duckduckgo.com/html/?q=
 *   3. 4get instance    — GET  https://search.yonderly.org/web?s=
 *
 * Requests are intentionally bare: only the query parameter is sent
 * (no kl/region/time/etc. search parameters — extra params trigger DDG
 * bot blocks). Each provider gets a short timeout; the first provider
 * returning usable results wins, otherwise we fall through to the next.
 */

export type WebSearchResult = {
  url: string;
  title: string;
  snippet: string;
};

export type WebSearchSource = {
  provider: string;
  results: WebSearchResult[];
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** Per-provider timeouts. DDG endpoints answer fast when reachable (Vercel)
 *  but burn the full timeout when network-blocked; the 4get fallback is slower
 *  (~4s+) so it gets a larger budget. */
const PROVIDER_TIMEOUT_MS: Record<string, number> = {
  'duckduckgo-lite': 5000,
  'duckduckgo-html': 5000,
  '4get-yonderly': 12000,
};

/** In-process memory: provider that last succeeded is tried first on the
 *  next search (skips burning timeouts on unreachable endpoints). */
let preferredProvider: string | null = null;

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/g, ' ');

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** Decode DDG redirect links: //duckduckgo.com/l/?uddg=<urlencoded>&rut=... */
function unwrapDdgHref(href: string): string | null {
  let h = href.trim();
  if (h.startsWith('//')) h = `https:${h}`;
  if (!h.startsWith('http')) {
    // relative l/?uddg=... links on lite/html endpoints
    if (h.startsWith('/l/') || h.startsWith('l/')) h = `https://duckduckgo.com${h.startsWith('/') ? '' : '/'}${h}`;
    else return null;
  }
  try {
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    if (uddg) {
      const target = decodeURIComponent(uddg);
      return /^https?:\/\//i.test(target) ? target : null;
    }
    // plain external link
    if (u.hostname.endsWith('duckduckgo.com')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider 1 — DDG Lite (POST). Result markup: table rows with
// <a class="result-link" href="//duckduckgo.com/l/?uddg=...">Title</a>
// followed by <td class="result-snippet">…</td>.
// ---------------------------------------------------------------------------
async function searchDdgLite(query: string, count: number): Promise<WebSearchResult[]> {
  const body = new URLSearchParams({ q: query }); // bare query — no extra params
  const res = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, accept: 'text/html' },
    body: body.toString(),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS['duckduckgo-lite']),
  });
  if (!res.ok) throw new Error(`ddg-lite HTTP ${res.status}`);
  const html = await res.text();
  if (/anomaly|captcha|bots/i.test(html.slice(0, 4000))) throw new Error('ddg-lite blocked');

  const results: WebSearchResult[] = [];
  const linkRe = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));

  let lm: RegExpExecArray | null;
  let idx = 0;
  while ((lm = linkRe.exec(html)) && results.length < count) {
    const url = unwrapDdgHref(lm[1]);
    const title = stripTags(lm[2]);
    if (url && title) results.push({ url, title, snippet: snippets[idx] ?? '' });
    idx++;
  }
  if (!results.length) throw new Error('ddg-lite empty');
  return results;
}

// ---------------------------------------------------------------------------
// Provider 2 — DDG HTML (GET). Result markup:
// <a class="result__a" href="//duckduckgo.com/l/?uddg=...">Title</a>
// + <a class="result__snippet" ...>…</a>
// ---------------------------------------------------------------------------
async function searchDdgHtml(query: string, count: number): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`; // bare query param only
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS['duckduckgo-html']),
  });
  if (!res.ok) throw new Error(`ddg-html HTTP ${res.status}`);
  const html = await res.text();
  if (/anomaly|captcha|bots/i.test(html.slice(0, 4000))) throw new Error('ddg-html blocked');

  const results: WebSearchResult[] = [];
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|<\/body>|$)/gi;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html)) && results.length < count) {
    const link = unwrapDdgHref(bm[1]);
    const title = stripTags(bm[2]);
    const snipMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(bm[3]);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : '';
    if (link && title) results.push({ url: link, title, snippet });
  }
  if (!results.length) throw new Error('ddg-html empty');
  return results;
}

// ---------------------------------------------------------------------------
// Provider 3 — 4get instance (GET /web?s=). Result markup:
// <a href="<url>" class="hover"><div class="title">…</div>
//   <div class="description">…</div></a>
// ---------------------------------------------------------------------------
async function search4get(query: string, count: number): Promise<WebSearchResult[]> {
  const url = `https://search.yonderly.org/web?s=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS['4get-yonderly']),
  });
  if (!res.ok) throw new Error(`4get HTTP ${res.status}`);
  const html = await res.text();

  const results: WebSearchResult[] = [];
  const blockRe =
    /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="hover"[^>]*>\s*<div class="title">([\s\S]*?)<\/div>\s*<div class="description">([\s\S]*?)<\/div>\s*<\/a>/gi;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html)) && results.length < count) {
    const link = bm[1];
    // skip internal 4get links
    if (/search\.yonderly\.org|\/favicon\?/.test(link)) continue;
    const title = stripTags(bm[2]);
    const snippet = stripTags(bm[3]);
    if (title) results.push({ url: link, title, snippet });
  }
  if (!results.length) throw new Error('4get empty');
  return results;
}

// ---------------------------------------------------------------------------
// Chain entry point
// ---------------------------------------------------------------------------
const CHAIN: Array<{ name: string; run: (q: string, n: number) => Promise<WebSearchResult[]> }> = [
  { name: 'duckduckgo-lite', run: searchDdgLite },
  { name: 'duckduckgo-html', run: searchDdgHtml },
  { name: '4get-yonderly', run: search4get },
];

/** Strip 4get result-title artifacts ("…Prix2nd Nov 26 @ 10:52am"). */
function normalizeResultTitle(title: string): string {
  return title
    .replace(/\s*\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]{2}\s+\d{2}\s*@\s*\d{1,2}:\d{2}\s*(?:am|pm)\s*$/i, '')
    .trim();
}

/**
 * Run the provider chain; the first provider that yields results wins.
 * The last successful provider is remembered (in-process) and tried first
 * on subsequent searches. Throws only when every provider failed.
 */
export async function searchWeb(query: string, count = 3): Promise<WebSearchSource> {
  const errors: string[] = [];
  const ordered = preferredProvider
    ? [...CHAIN.filter((p) => p.name === preferredProvider), ...CHAIN.filter((p) => p.name !== preferredProvider)]
    : CHAIN;
  for (const p of ordered) {
    const t0 = Date.now();
    try {
      const results = (await p.run(query, count)).map((r) => ({
        ...r,
        title: normalizeResultTitle(r.title) || r.title,
      }));
      preferredProvider = p.name;
      console.log(`[web-search] ${p.name} OK en ${Date.now() - t0}ms (${results.length} résultats)`);
      return { provider: p.name, results };
    } catch (e) {
      errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
      console.log(`[web-search] ${p.name} ÉCHEC après ${Date.now() - t0}ms: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`Aucun moteur de recherche disponible (${errors.join(' | ')})`);
}

/** Context block injected into the LLM prompt (Open WebUI web search shape).
 *  Sources are numbered — the model cites them with [N] markers (see the
 *  citation instructions in v12-flow). When page texts were loaded (web
 *  loader), the real page content replaces the thin search snippet. */
export function webResultsToContext(
  results: WebSearchResult[],
  pageTexts?: Map<string, string>
): string {
  return results
    .map((r, i) => {
      const body = pageTexts?.get(r.url) || r.snippet;
      return `<source number="${i + 1}" title="${r.title.replace(/"/g, '&quot;')}" url="${r.url}">\n${body}\n</source>`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Web loader — fetch the top result pages and extract their readable text
// (Python web loader parity; activation controlled by
// `web.search.bypass_web_loader`, false = pages ARE loaded).
// ---------------------------------------------------------------------------

/** Fetch one result page → readable text (best effort, null on any failure). */
async function loadWebPage(url: string, timeoutMs: number, maxChars: number): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'fr,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      return null;
    }
    const html = await res.text();
    if (!html) return null;
    const { extractHtmlText } = await import('./loaders');
    const { text } = extractHtmlText(html);
    const squashed = text.replace(/\s+/g, ' ').trim();
    // JS-only or empty pages carry no value — drop them (snippet stays).
    if (squashed.length < 250) return null;
    return squashed.slice(0, maxChars);
  } catch {
    return null;
  }
}

/**
 * Fetch the top result pages concurrently (bounded) → url → page text.
 * Duplicate pages (same origin+path) are fetched only once; per-page failures
 * fail soft (the caller falls back to the search snippet for that source).
 */
export async function loadWebPages(
  results: WebSearchResult[],
  opts: { maxPages?: number; maxCharsPerPage?: number; timeoutMs?: number; concurrent?: number } = {}
): Promise<Map<string, string>> {
  const maxPages = Math.max(1, Math.min(6, opts.maxPages ?? 3));
  const maxChars = Math.max(500, opts.maxCharsPerPage ?? 3000);
  const timeoutMs = Math.max(3000, opts.timeoutMs ?? 10_000);
  const concurrent = Math.max(1, Math.min(6, opts.concurrent ?? 3));

  const seen = new Set<string>();
  const targets = results
    .filter((r) => {
      try {
        const u = new URL(r.url);
        const key = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, maxPages);

  const out = new Map<string, string>();
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(concurrent, queue.length) || 1 }, async () => {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      const text = await loadWebPage(r.url, timeoutMs, maxChars);
      if (text) out.set(r.url, text);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Page images — extract each result's social/OG image (og:image /
// twitter:image) for the ChatGPT-style source-card thumbnails shown in the
// Sources panel. Only the first bytes of each page are read (meta tags live
// in <head>): the stream is aborted as soon as </head> is seen or a small
// cap is reached, so a 10-result search costs a handful of cheap HEAD-ish
// fetches that run in parallel with the full page loader.
// ---------------------------------------------------------------------------

/** Read the first bytes of one page and extract its og/twitter image URL.
 * Best effort — null on any failure. */
async function loadPageImage(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let head = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      head += dec.decode(value, { stream: true });
      // Stop as soon as the data is usable: </head> seen, or an image meta
      // is already in hand (some news sites ship 250KB+ <head>s — waiting
      // for </head> there only burns time), or a generous byte cap.
      if (
        /<\/head>/i.test(head) ||
        /<(?:meta|link)[^>]+(?:og:image|twitter:image)/i.test(head) ||
        head.length > 524_288
      )
        break;
    }
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
    const m =
      /<meta[^>]+(?:property|name)=["'](?:og:image|og:image:secure_url|twitter:image|twitter:image:src)["'][^>]*content=["']([^"']+)["']/i.exec(
        head
      ) ||
      /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|og:image:secure_url|twitter:image|twitter:image:src)["']/i.exec(
        head
      );
    if (!m) return null;
    const raw = decodeEntities(m[1].trim());
    try {
      const abs = new URL(raw, url); // resolves relative & protocol-relative
      if (!/^https?:$/.test(abs.protocol)) return null;
      return abs.toString();
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** Fetch every result's og/twitter image concurrently (bounded) → url →
 * image URL. Per-page failures fail soft (that source simply renders
 * without a thumbnail). */
export async function loadWebImages(
  results: WebSearchResult[],
  opts: { timeoutMs?: number; concurrent?: number } = {}
): Promise<Map<string, string>> {
  const timeoutMs = Math.max(2000, opts.timeoutMs ?? 6000);
  const concurrent = Math.max(1, Math.min(8, opts.concurrent ?? 6));

  const out = new Map<string, string>();
  const queue = results.filter((r) => /^https?:\/\//i.test(r.url));
  const workers = Array.from({ length: Math.min(concurrent, queue.length) || 1 }, async () => {
    for (;;) {
      const r = queue.shift();
      if (!r) return;
      const image = await loadPageImage(r.url, timeoutMs);
      if (image) out.set(r.url, image);
    }
  });
  await Promise.all(workers);
  return out;
}
