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
 *   • DETERMINISTIC ENGAGEMENT NETS for the plain image and video routings
 *     too (mirror of the GIF/search nets): when the classifier call fails,
 *     times out (free-gateway queues routinely exceed the 6.5s budget → fail
 *     open) or answers conservatively, an explicit creation/draw/WANT verb +
 *     media noun ("dessine-moi un chat", "crée une vidéo de…", "fais-moi un
 *     logo", "je voudrais une photo de…", "veux un avatar"), a bare draw
 *     verb, or an inherently-visual hypothetical ("à quoi ressemblerait…",
 *     "montre-moi à quoi ressemble…") still engages the right engine —
 *     reported as the production bug "les autos décident mal" : the
 *     image/video paths had NO backstop, only the search and GIF did;
 *   • FEW-SHOT examples in the classifier prompt — the free-gateway model
 *     follows worked examples far better than rules alone; the examples pin
 *     the two confusion zones (volatile-vs-stable facts, media-vs-code /
 *     imagine-visual vs creative-writing) so its raw accuracy rises on
 *     exactly the turns the nets cannot decide;
 *   • TRUNCATION-TOLERANT parsing: the free gateway model sometimes prefixes
 *     prose or cuts the JSON mid-way — the known keys are recovered by regex
 *     instead of discarding the whole answer;
 *   • the high-confidence lexical VOLATILE-FACT net from auto-web-search.ts
 *     (identity/ranking/news questions force the search on regardless of a
 *     conservative classifier answer or a failed call), EXTENDED to the
 *     other volatile-fact families the same failure mode hits: weather
 *     forecasts, prices & currency conversion, match results/scores,
 *     release dates & latest releases, person life/relationship status —
 *     plus a query backfill — search=true with an empty query keeps the
 *     search alive on the raw target text instead of silently dropping it;
 *   • EXPLICIT search-command net (production: "je dis recherche au web
 *     billy" → plain-chat refusal "Je ne peux pas effectuer de recherche
 *     web"): a literal search command ("recherche au web X", "google X",
 *     "fais une recherche sur X", "cherche X sur internet", "search the
 *     web", "vérifie en ligne", imperative "cherche X") forces the search
 *     deterministically — the classifier gets NO veto, a failed/timed-out
 *     call loses nothing, and the command boilerplate is stripped from the
 *     query ("recherche au web billy" searches "billy"); the search-NOUN
 *     tier also VETOES the media nets ("fais une recherche d'images" →
 *     search, never a generation);
 *   • transcript isolation: only user/assistant turns ride the decision call —
 *     system prompts (capability blocks, misspell hints) never pollute it;
 *   • cheap call: no thinking, temperature 0, ~300 max tokens (headroom
 *     for a chatty preamble before the JSON), last 6 turns only, any failure
 *     fails open (all false — the turn proceeds as chat, the nets above
 *     catching the unambiguous cases).
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
// Deterministic ENGAGEMENT nets (image & video) — the production backstop.
// The classifier call fails open whenever the free gateway queues past the
// 6.5s budget or emits an unparsable answer; until now ONLY the search and
// GIF paths had lexical backstops, so an image/video request missed by the
// classifier fell through to a plain text turn — the exact "les autos
// décident toujours mal" report. The nets below engage the right engine on
// UNAMBIGUOUS phrasings only: an explicit creation/draw/want verb + an
// explicit media noun (or a bare draw verb, or an inherently-visual
// hypothetical). Nouns WITHOUT such a verb ("j'ai vu une image drôle",
// "recommande-moi un anime") never fire — the classifier keeps those.
// ---------------------------------------------------------------------------

/** Image engagement net — explicit static-visual creation phrasing. */
const IMAGE_ENGAGE_RE = new RegExp(
  [
    // bare imperative draw verbs (fr + common misspellings + en)
    '\\b(?:dessine(?:-moi)?|dessin(?:e|er|ez)|desine(?:-moi)?|draw|draws|paint|paints|peins?|peign)\\b',
    // creation/want verb + explicit static-media noun (within 40 chars —
    // "fais-moi un logo", "génère une image de…", "je voudrais une photo
    // de…", "create a poster of…"). "cré" carries an OPTIONAL suffix so the
    // phonetic typo "cre une image" routes like "crée une image".
    '\\b(?:g[ée]n[èe]r(?:e|er|ez)|cr[ée]{1,2}(?:e|er|ez|-moi)?|fais(?:-moi|-en|-le|-la|-un|-une)?|faire|make|making|create|creating|generate|generating|montre(?:-moi)?|show|donn(?:e|es|ez|-moi)?|veux|voudrais|aimerais|d[eé]sir(?:e|erait)?)\\b[^\\n]{0,40}?\\b(?:images?|photos?|photographie?s?|dessins?|illustrations?|logos?|ic[ôo]nes?|avatars?|affiches?|posters?|banni[èe]res?|fonds?\\s+d[’\']?[ée]cran|wallpapers?|visuels?|rendus?|renders?|mockups?|maquettes?|concept\\s+arts?|miniatures?|thumbnails?)\\b',
    // inherently-visual hypotheticals — "montre-moi à quoi ressemble un
    // blobfish", "imagine à quoi ressemblerait une ville flottante"; the
    // bare conditional "à quoi ressemblerait X ?" is a visual-render request.
    // NO \b before the accented "à" — JS \b only sees [A-Za-z0-9_], so
    // \bà never matches (space→à is not a word boundary); a plain literal
    // (or ^|\s anchor) is the correct boundary for accented French.
    '\\b(?:montre(?:-moi)?|imagine(?:r|-moi)?|dessine(?:-moi)?)\\b[^\\n]{0,30}?[àa]\\s+quoi\\s+ressembl(?:e|erait|era|ait)\\b',
    '(?:^|\\s)[àa]\\s+quoi\\s+ressemblerait\\b',
  ].join('|'),
  'i'
);

/** Video engagement net — explicit moving-artifact creation phrasing. */
const VIDEO_ENGAGE_RE = new RegExp(
  [
    // creation/want verb + explicit moving-media noun ("crée une vidéo",
    // "fais un clip", "je voudrais un court-métrage", "generate an
    // animation", "une bande-annonce de…"). Same optional-suffix "cré".
    '\\b(?:g[ée]n[èe]r(?:e|er|ez)|cr[ée]{1,2}(?:e|er|ez|-moi)?|fais(?:-moi|-en|-le|-la|-un|-une)?|faire|make|making|create|creating|generate|generating|produis(?:-moi)?|produce|producing|donn(?:e|es|ez|-moi)?|veux|voudrais|aimerais|d[eé]sir(?:e|erait)?)\\b[^\\n]{0,40}?\\b(?:vid[ée]os?|clips?|animations?|court[ -]?m[ée]trages?|reels?|stories?|tiktoks?|shorts?|film(?:s|ettes?)?|trailer?s?|bandes?[ -]?annonces?|gifs?)\\b',
    // explicit animate-an-existing-visual phrasings ("anime cette image",
    // "fais bouger cette photo", "animate this image") — BOTH word orders:
    // "fais ça bouger" and the reversed "fais bouger ça" are correct French.
    '\\banime(?:r|z|-moi|\\s+(?:cette?|cet|ce|la|le|l[’\']|ça|ca|moi|image|photo|dessin))\\b|\\banimates?|animate\\b|\\banimated\\b',
    '\\b(?:fais|fait|mets|met)\\s+(?:[çc]a|ceci|cela|la|le|l[’\']|cette?)\\s+(?:bouger|en\\s+mouvement|en\\s+vid[ée]o)\\b',
    '\\b(?:fais|fait|mets|met)\\s+(?:bouger|en\\s+mouvement|en\\s+vid[ée]o)\\b[^\\n]{0,20}?\\s(?:[çc]a|ceci|cela|cette?|la|le|l[’\'])\\b',
    '\\b(?:make|put)\\s+(?:it|this|that)\\s+(?:move|in\\s+motion)\\b',
  ].join('|'),
  'i'
);

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
  // Weather forecasts — unambiguous forms only (bare "quel temps de cuisson"
  // is a duration; the "quel temps" alternative REQUIRES a place/time/verb
  // marker so it never matches).
  /\b(?:m[eé]t[eé]o\b|quel\s+temps\b[^.?!]{0,40}\b(?:[àa]\s|au\s|en\s|demain|aujourd|fait|fera|il\b)|le\s+temps\s+qu['’]il\s+fera|va[-\s]t[-\s]il\s+pleuvoir|il\s+va\s+pleuvoir|pleuvra\b|neigera\b|weather\s+(?:in|at|for|today|tomorrow|tonight|this\s+week))/i,
  // Prices & currency conversion — current market data is always volatile
  // ("combien coûte l'iPhone 15", "le prix du riz", "1 euro en fcfa",
  // "taux de change"). Duration senses ("combien de temps", "how much
  // time", "c'est combien de temps") are explicitly excluded.
  /(?:\bcombien\s+(?:[çc]a\s+)?co[uû]t(?:e|ent)\b|co[uû]t(?:e|ent)\s+combien\b|c['’]est\s+combien\b(?!\s+de\s+temps)|\bquel(?:le)?s?\s+(?:est|sont)\b[^.?!]{0,40}\bprix\b|\bprix\s+(?:de|du|des|d['’])[^.?!]{0,30}\b(?:essence|riz|p[eé]trole|gaz|ciment|pain|sucre|billet|ticket|pass|abonnement|t[eé]l[eé]phone|iphone|ordinateur|voiture|moto|maison|dollar|euro|fcfa)\b|\bprix\b[^.?!]{0,30}\b(?:aujourd|actuel|ce\s+mois|en\s+20\d\d)\b|\btaux\s+de\s+change\b|\b(?:euros?|dollars?|fcfa|francs?|nairas?|yens?)\s+en\s+(?:euros?|dollars?|fcfa|francs?|nairas?|yens?)\b|\bhow\s+much\b(?!\s+time))/i,
  // Match/game results & scores — yesterday's game is not in training data.
  /(?:\bqui\s+a\s+gagn[eé]\b|\ba\s+gagn[eé]\s+(?:le\s+|la\s+|les\s+|un[e]?\s+)?(?:match|finale|coupe|championnat|ligue|[ée]lection|concours|d[eé]bat|combat|tournoi)\b|gagn[eé]\s+(?:hier|ce\s+matin|hier\s+soir|ce\s+soir|aujourd|\bce\s+week-end\b)|\ble\s+score\b|r[eé]sultats?\s+(?:du\s+|de\s+|des\s+)?(?:match|jeu|concours|finale|[ée]lection)\b|\bwho\s+won\b|\bwho\s+is\s+winning\b)/i,
  // Release dates & upcoming/latest releases ("quand sort le prochain
  // album de X", "date de sortie", "le dernier épisode de la série").
  /(?:\bquand\s+(?:est-ce\s+que\s+)?(?:[çc]a\s+)?(?:sort|sortira|va\s+sortir|est\s+sorti|sont\s+sortis)\b|[çc]a\s+sort\s+quand\b|\bsort\s+quand\b|\bdate\s+de\s+sortie\b|\brelease\s+date\b|\bsortie\s+(?:du|de\s+la|des)\s+(?:film|album|jeu|s[ée]rie|[ée]pisode|mod[eè]le|t[eé]l[eé]phone)\b|\bprochain(?:e|s)?\s+(?:album|film|[ée]pisode|saison|tome|opus|jeu|livre|single|clip|mod[eè]le|t[eé]l[eé]phone|iphone|version|update|samsung|playstation|xbox)\b|\bderni[eè]re?s?\s+(?:album|film|[ée]pisode|saison|tome|opus|jeu|livre|single|clip|version|iphone|samsung)\b)/i,
  // Current status of a real person (alive/dead/married/what happened) —
  // people die and relationships change; training data goes stale silently
  // and a wrong "il est vivant" costs the user's trust. "que?\b" covers both
  // "est-ce que le pape est vivant" and "est-ce qu'il est mort".
  /(?:\best[-\s]ce\s+que?\b[^.?!]{0,60}\b(?:mort|morte|d[eé]c[eé]d[eé]|vivant|vivante|en\s+vie|mari[eé]e?|divorc[eé]e?|libre)\b|\best-(?:il|elle)\s+(?:mort|morte|d[eé]c[eé]d[eé]|vivant|vivante|en\s+vie)\b|\b(?:il|elle)\s+(?:est\s+)?(?:mort|morte|d[eé]c[eé]d[eé])\s*\?|\btoujours\s+(?:en\s+vie|vivant|vivante|mari[eé]e?|ensemble|en\s+couple|divorc[eé]e?)\b|\bwhat\s+happened\s+to\b|\bqu['’]est[-\s]ce\s+qui\s+(?:s['’]\s*)?est\s+(?:pass[eé]|arriv[eé])\s+(?:[àa]\s+|avec\s))/i,
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
// EXPLICIT search-command net — the strongest routing signal the platform
// gets. The reported production miss: "je dis recherche au web billy" → the
// assistant answered "Je ne peux pas effectuer de recherche web en temps
// réel". That message carried NO interrogative and NO volatile-fact keyword,
// so the v12 pre-gate skipped the whole machinery; and even when the
// classifier DID run, a conservative answer ("prefer everything false") or
// a failed/timed-out free-gateway call left no backstop — the identity/
// ranking/news nets above matched nothing, and a plain chat turn can never
// produce search results. When the user LITERALLY commands a search, the
// search engages deterministically (same philosophy as the GIF net): the
// classifier cannot veto it, a dropped classifier call cannot lose it.
// ---------------------------------------------------------------------------

/** Tier C — an explicit search-NOUN request ("fais une recherche sur X",
 *  "faites des recherches", "peux-tu faire une recherche", "do a search").
 *  Standalone because it also VETOES the media engagement nets downstream:
 *  in "fais une recherche d'images de chats" the IMAGE net would otherwise
 *  see "fais … images" and generate instead of searching — the search noun
 *  is the object of the verb, so the search wins. Bare "fais"/"faites"
 *  imperatives only — the past participle "fait" is deliberately absent so
 *  "j'ai fait une recherche" (the user reporting their own research) does
 *  not force a search. */
const SEARCH_TIER_C =
  '\\b(?:fais(?:-moi|-en|-le|-la|-un|-une)?|faites|faire|peux-tu|peut-on|pouvez-vous|veux-tu|make|making|do|doing|can|could|would|will)\\b[^\\n]{0,40}?\\b(?:une?\\s+|des\\s+|quelques\\s+|some\\s+|a\\s+)?(?:recherches?|research|search)\\b';

const SEARCH_COMMAND_RE = new RegExp(
  [
    // A) a search verb AND a bare web-sphere noun, ANY order, close together
    //    — the literal "web search" command ("recherche au web billy",
    //    "cherche sur internet", "vérifie en ligne", "search the web",
    //    "renseigne-toi sur le net"). "web" is matched as a BARE word so
    //    "website/webpage" (code deliverables) never count as web-sphere.
    '\\b(?:recherch\\w*|cherch\\w*|search(?:ing|er)?|v[eé]rif\\w*|verif\\w*|renseign\\w*|trouv\\w*|find\\w*|look\\w*|consult\\w*)\\b[^\\n]{0,60}?\\b(?:web|internets?|net|en\\s+ligne|en\\s+direct|online|google)\\b',
    '\\b(?:web|internets?|net|en\\s+ligne|en\\s+direct|online|google)\\b[^\\n]{0,60}?\\b(?:recherch\\w*|cherch\\w*|search(?:ing|er)?|v[eé]rif\\w*|verif\\w*|renseign\\w*|trouv\\w*|find\\w*|look\\w*)\\b',
    // B) the googling verb — "google billy", "google-le", "google it",
    //    "googler le prix de l'essence". A bare "google" command is never
    //    anything but a web search.
    '\\bgoo?gle[rz]?\\b',
    // C) → SEARCH_TIER_C (see above — also the media-net veto).
    SEARCH_TIER_C,
    // D) imperative search verb at MESSAGE START (politeness/modal prefix
    //    allowed) — "cherche billy", "recherche-moi ça", "search for X",
    //    "look it up", "peux-tu chercher…". Start-anchoring keeps
    //    declarative false positives out ("je cherche un cadeau" → the
    //    classifier keeps that one). "trouve/find" are deliberately NOT
    //    here: a bare "trouve l'erreur dans mon code" is a CODE turn —
    //    they only engage tier A (paired with a web word, "trouve X sur
    //    le web") or the classifier.
    '^\\s*(?:stp|please|s[\'’]il\\s+te\\s+pla[îi]t|peux-tu|peut-on|pouvez-vous|pourrais-tu|pourriez-vous|est-ce\\s+que\\s+(?:tu|vous|on)\\s+(?:peux|peut|pouvez|peuvent)|tu\\s+peux|vous\\s+pouvez|tu\\s+pourrais|vous\\s+pourriez|can\\s+you|could\\s+you|would\\s+you|will\\s+you)?\\s*(?:me\\s+|nous\\s+|moi\\s+|us\\s+)?(?:aller\\s+|essa(?:y|ie)r\\s+de\\s+|try\\s+to\\s+)?(?:me\\s+|nous\\s+)?(?:cherche(?:r|-moi|-nous)?|recherche(?:r|-moi|-nous)?|search|look\\s+(?:up|it\\s+up|that\\s+up|this\\s+up|him\\s+up|her\\s+up|them\\s+up)|renseigne(?:r|-toi)?|v[eé]rifi(?:e|er)(?:-moi)?|googl(?:e|er|ez)(?:-moi)?)\\b',
  ].join('|'),
  'i'
);

/** Standalone tier-C probe (the media-net veto — see SEARCH_TIER_C above). */
const SEARCH_NOUN_REQUEST_RE = new RegExp(SEARCH_TIER_C, 'i');

/** Tokens stripped when the explicit-command net builds its query — "recherche
 *  au web billy" must SEARCH "billy", not its own command sentence. Only
 *  function words, search verbs and web-sphere nouns are dropped; content
 *  words always survive. Lowercased for the search engine; when nothing
 *  survives the strip the raw text stands in. */
const SEARCH_COMMAND_STOPWORDS = new Set([
  // search verbs & imperatives (fr + en)
  'recherche', 'recherches', 'rechercher', 'cherche', 'cherches', 'chercher', 'cherchez',
  'search', 'searching', 'searcher', 'googler', 'google', 'trouve', 'trouves', 'trouver', 'trouvez',
  'find', 'finds', 'finding', 'look', 'looking', 'renseigne', 'renseigner',
  'verifie', 'vérifie', 'verifier', 'vérifier', 'verifies', 'verify', 'check',
  'fais', 'faites', 'faire', 'make', 'making', 'go', 'va', 'vas', 'allez', 'essaie', 'essaye',
  // web-sphere nouns
  'web', 'internets', 'internet', 'net', 'ligne', 'online', 'direct',
  // articles / prepositions / politeness (fr + en)
  'au', 'aux', 'dans', 'sur', 'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd',
  'pour', 'moi', 'nous', 'me', 'us', 'the', 'on', 'in', 'of', 'et', 'à', 'a', 'que',
  'tu', 'vous', 'peux', 'peut', 'pouvez', 'please', 'stp', 'plait', 'plaît', 'te',
  'ça', 'ca', 'ce', 'cet', 'cette', 'it', 'that', 'this', 'up', 'est-ce', 'quoi',
  'fait', 'for', 'to', 'and', 'or', 'about', 'with', 'into', 'can', 'could', 'would',
  'will', 'do', 'does', 'you', 'toi', 'vas-y', 'hey', 'salut',
]);

function stripSearchBoilerplate(text: string): string {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const kept = raw
    .toLowerCase()
    // elision/hyphen glue → plain tokens ("cherche-moi" → "cherche moi",
    // "l'essence" keeps its l' glued — accents normalized only for lookup)
    .replace(/[\u2019'’]/g, ' ')
    .split(/[\s\-\u2013\u2014,.!?;:()]+/)
    .filter((tok) => tok.length > 0)
    // content words only: stop words out, single/double pure-alpha fillers
    // out ("de", "à", "l", "d", "qu"), digits and longer words always kept
    .filter((tok) => !SEARCH_COMMAND_STOPWORDS.has(tok) && !(tok.length <= 2 && /^[a-z]+$/.test(tok)));
  const query = kept.join(' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  return query.length >= 3 ? query : raw.slice(0, 150);
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

IMAGE — image=true ONLY when video=false AND the user clearly wants a STATIC visual produced: a drawing, painting, illustration, picture/photo-style render, logo, icon, avatar, wallpaper/background image, banner, poster, thumbnail, meme, sticker, 3D render, concept art, character design. Typical phrasings: "dessine-moi…", "génère/crée une image de…", "fais-moi un logo…", "je voudrais une photo de…", "montre-moi … en image", "draw me…", "show me what … would look like". ALSO image=true for "imagine + a CONCRETE VISUAL THING" ("imagine un dragon", "imagine une ville flottante", "à quoi ressemblerait un lion en costume") — but "imagine une histoire / un poème / un récit / un scénario / une chanson" is CREATIVE WRITING → all false. ALSO image=true for ITERATION on an image the assistant previously generated ("fais-le en bleu", "même chose mais de nuit", "une autre version", "enlève le chapeau") — in that case ALSO set edit=true. edit=true ONLY when image=true AND it modifies or reiterates a visual ALREADY PRESENT; edit=false for every fresh creation.

CODE / SVG IS NEVER MEDIA — image=false AND video=false when the user asks for a WEB or SOFTWARE artifact: landing page, website, web page, site vitrine, app, application, dashboard, portfolio, blog, online store, game, API, script, HTML/CSS/JS/React/Python code — even with style adjectives like "ultra moderne" (those describe CODE quality). Also false for ANY SVG or vector-graphics request ("crée un SVG d'un chien", "dessine-moi le SVG", "convertis cette image en SVG"): an SVG is XML markup the assistant writes in its answer — this rule OVERRIDES any draw verb. EXCEPTION — explicit draw verbs win over code nouns for RASTER output: "dessine une maquette de landing page", "montre-moi un visuel du site" → image=true (the user wants a visual render). The exception NEVER covers SVG.

SEARCH — search=true ONLY when image=false AND video=false AND the answer depends on facts that change or the assistant cannot reliably know: CURRENT HOLDERS of a role/title ("qui est le président", "le PDG de Tesla", "le champion en titre" — time-sensitive EVEN WITHOUT "actuellement"); RANKINGS/SUPERLATIVES ("l'homme le plus puissant", "la star la plus célèbre", "l'entreprise la plus riche"); current situation of real people/stars/companies/teams; news & current events; WEATHER anywhere ("quel temps à Douala", "il va pleuvoir demain"); MATCH RESULTS & SCORES ("qui a gagné le match", "le score de la finale", "who won yesterday"); PRICES & MONEY ("combien coûte l'iPhone 15", "le prix de l'essence", "1 euro en fcfa", "taux de change", "how much is it"); RELEASES ("quand sort le prochain album de X", "date de sortie du film", "le dernier épisode de la série"); LIFE/RELATIONSHIP STATUS of real people ("est-ce que X est mort", "est-il toujours en vie", "what happened to X"); volatile data (schedules, recent releases); obscure facts. ALWAYS search=true — whatever the topic, even a STABLE one — when the user EXPLICITLY commands a search: "recherche (au/sur le) web", "cherche X", "cherche sur internet", "google X", "googler", "fais une recherche sur X", "faites des recherches", "vérifie en ligne", "search the web", "look it up", "find information about X". The user literally asking for a search can never be answered from memory — an explicit search command is the highest-confidence search signal that exists. search=false for greetings, small talk, math/logic, coding help, creative writing, translation, STABLE knowledge (history, science, definitions, "quelle est la capitale du Cameroun"), how-to questions, or when the answer is ALREADY present in the conversation history. query: an optimized keyword search query (max ~10 words) in the LANGUAGE of the user's message, CORRECTLY spelled (silently fix their mistakes), essential keywords only, no full sentence — and WITHOUT the command boilerplate ("recherche au web billy" queries "billy", not the command sentence). Empty string when search=false.

PRIORITY — exactly ONE engine per turn: video outranks image (a GIF/clip/animation request is video, NEVER image), image outranks search, and a media turn never searches (search=false when image or video is true). When genuinely uncertain, prefer everything false: wrongly generating media or a search interrupts a normal conversation far more than missing one does. Only choose true when you are CONFIDENT.

EXAMPLES — study the boundaries, then decide the LATEST message on its own:
"recherche au web billy" → search=true, query "billy"
"google le prix de l'essence au Cameroun" → search=true, query "prix essence Cameroun"
"qui a gagné le match hier soir ?" → search=true, query "résultat match hier soir"
"quel temps il fera demain à Douala ?" → search=true, query "météo Douala demain"
"quand sort le prochain album de Beyoncé ?" → search=true, query "nouvel album Beyoncé date sortie"
"est-ce que le pape est vivant ?" → search=true, query "pape santé"
"1 euro en fcfa ?" → search=true, query "taux de change euro fcfa"
"quelle est la capitale du Cameroun ?" → search=false (stable knowledge)
"comment faire un gâteau ?" → search=false (how-to, stable)
"dessine-moi un chat astronaute" → image=true, edit=false
"imagine un dragon cracheur de feu" → image=true (concrete visual thing)
"imagine une histoire de dragon" → all false (creative writing)
"fais-le en bleu" (the previous assistant turn generated an image) → image=true, edit=true
"génère un GIF de chat qui danse" → video=true
"crée une vidéo verticale de danse" → video=true, aspectRatio "9:16"
"crée une landing page ultra moderne" → all false (CODE)
"bonjour, ça va ?" → all false`;

// ---------------------------------------------------------------------------
// Decision call
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The three aspect ratios the vibes engine accepts — nothing else. */
const VIDEO_RATIOS = ['16:9', '1:1', '9:16'] as const;

/** Extract the first plausible JSON object from a raw LLM answer.
 *  TRUNCATION-TOLERANT — the free gateway model sometimes prefixes prose
 *  ("Here is my decision:") or cuts the JSON mid-way; when the strict parse
 *  fails, the known keys are recovered by regex so a nearly-good answer is
 *  still a usable decision (before: any prose prefix → unparsable → retries →
 *  fail open → the turn fell back to plain chat). */
function parseDecision(raw: string): AutoEngagementDecision | null {
  const content = String(raw ?? '').trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return normalizeParsed(JSON.parse(content.slice(start, end + 1)));
    } catch {
      /* fall through to loose extraction */
    }
  }
  // Loose extraction — any "key": true/false pair for the three booleans is
  // enough to route the turn; missing keys read as false.
  if (!/"(?:video|image|search)"\s*:/i.test(content)) return null;
  const bool = (key: string): boolean => {
    const m = content.match(new RegExp(`"${key}"\\s*:\\s*"?(true|false)"?`, 'i'));
    return m ? m[1].toLowerCase() === 'true' : false;
  };
  const loose: Record<string, unknown> = {
    video: bool('video'),
    image: bool('image'),
    search: bool('search'),
    animate: bool('animate'),
    edit: bool('edit'),
  };
  const ratioMatch = content.match(/"aspectRatio"\s*:\s*"(16:9|1:1|9:16)"/i);
  if (ratioMatch) loose.aspectRatio = ratioMatch[1];
  const queryMatch = content.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (queryMatch) loose.query = queryMatch[1];
  console.log('[auto-engage] loose key extraction recovered a truncated/prose answer');
  return normalizeParsed(loose);
}

/** Normalized decision object from any parsed shape (strict or loose). */
function normalizeParsed(parsed: any): AutoEngagementDecision | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const video = parsed.video === true || parsed.video === 'true';
  const image = parsed.image === true || parsed.image === 'true';
  const search = parsed.search === true || parsed.search === 'true';
  const rawRatio = String(parsed.aspectRatio ?? '').trim();
  const aspectRatio = (VIDEO_RATIOS as readonly string[]).includes(rawRatio)
    ? (rawRatio as AutoEngagementDecision['aspectRatio'])
    : undefined;
  // NOTE — search no longer requires a non-empty query here: a weak model
  // often answers {"search":true} and forgets the query, which used to drop
  // the search entirely; decideAutoEngagement backfills the query from the
  // target text instead.
  const query = typeof parsed.query === 'string' ? parsed.query.trim().slice(0, 200) : '';
  return {
    video,
    animate: video && (parsed.animate === true || parsed.animate === 'true'),
    aspectRatio: video ? aspectRatio : undefined,
    image: !video && image, // video outranks image — never both
    edit: !video && image && (parsed.edit === true || parsed.edit === 'true'),
    search: !video && !image && search,
    query,
  };
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
          max_tokens: 300,
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
  // "jeu vidéo" / "game" are CODE nouns (the assistant WRITES a game) — the
  // bare word "vidéo" they contain must not exempt the phrase from the code
  // guard ("crée un jeu vidéo de course" was hijacked into the video engine
  // because videoWords matched "vidéo" and skipped the guard). The exemption
  // survives only when a REAL moving-artifact signal (gif/clip/anim/reel…)
  // rides along ("anime ce jeu vidéo en gif") — those stay media turns.
  const jeuVideo = /\bjeux?\s+vid[ée]o\b/i.test(targetText);
  const otherVideoSignal =
    /\b(?:gifs?|jifs?|clips?|animations?|anim\w*|reels?|stories?|tiktoks?|court[ -]?m[ée]trages?|bandes?[ -]?annonces?|trailer?s?)\b/i.test(
      targetText
    );
  if (svg || (CODE_DELIVERABLE_RE.test(targetText) && !imageWords && (!videoWords || (jeuVideo && !otherVideoSignal)))) {
    console.log('[auto-engage] svg/code guard → image=false, video=false');
    result.image = false;
    result.edit = false;
    result.video = false;
    result.animate = false;
  } else {
    if (videoWords && !imageWords) result.image = false; // video engine owns it
    if (imageWords && !videoWords) result.video = false; // image engine owns it
    // Explicit search-command veto — a LITERAL search command ("recherche au
    // web X", "google X", "fais une recherche d'images de chats", "cherche X
    // sur le net") can never be answered by a generation: the veto zeroes the
    // media flags the classifier may itself have set (reproduced: the
    // classifier answered image=true on "fais une recherche d'images") AND
    // keeps the media engagement nets off — the search net below owns the
    // turn. The user asked for a recherche; they get a recherche.
    const searchCommand = SEARCH_COMMAND_RE.test(targetText);
    if (searchCommand) {
      console.log('[auto-engage] explicit search command → media engagement vetoed');
      result.image = false;
      result.edit = false;
      result.video = false;
      result.animate = false;
    }
    if (!searchCommand) {
      // GIF lexical net — a bare "gif" request deterministically routes to the
      // video engine (a GIF is animated); the animate flag stays as parsed so
      // "convertis cette image en gif" keeps its image→video animate source.
      if (!result.video && !result.image && GIF_REQUEST_RE.test(targetText)) {
        console.log('[auto-engage] gif net → video=true');
        result.video = true;
      }
      // ---- ENGAGEMENT nets (image & video) — the production backstop for the
      // ---- "les autos décident mal" report: an explicit creation phrasing
      // ---- engages the right engine EVEN when the classifier call failed,
      // ---- timed out (free-gateway queue) or answered conservatively. Until
      // ---- now only the search and GIF paths had backstops — an image/video
      // ---- request missed by the classifier fell through to a plain text
      // ---- turn (often with the "je ne peux pas générer…" refusal).
      // ---- Priority stays VIDEO > IMAGE; the nets never override an engine
      // ---- the classifier already engaged, and the SVG/code guard above has
      // ---- already vetoed code turns.
      if (!result.video && !result.image && VIDEO_ENGAGE_RE.test(targetText)) {
        console.log(
          '[auto-engage] video engagement net → video=true' + (decision ? ' (model said false)' : ' (model decision unavailable)')
        );
        result.video = true;
        result.image = false;
        result.edit = false;
      }
      if (!result.video && !result.image && IMAGE_ENGAGE_RE.test(targetText)) {
        console.log(
          '[auto-engage] image engagement net → image=true' + (decision ? ' (model said false)' : ' (model decision unavailable)')
        );
        result.image = true;
        result.video = false;
        result.animate = false;
      }
    }
  }

  // ---- Lexical search nets — fire AFTER the classifier: volatile-fact
  // ---- questions (identity holders, rankings, news, weather, prices,
  // ---- match results, releases, person status, currency) force the search
  // ---- even when the model answered false or the call failed entirely (a
  // ---- wasted search costs seconds; a stale "le président est X" or
  // ---- hallucinated price costs the user's trust). The EXPLICIT-command
  // ---- net adds the strongest signal of all: a literal search command
  // ---- ("recherche au web X", "google X", "fais une recherche") can NEVER
  // ---- be answered from memory — the classifier gets no veto over it.
  if (!result.search && !result.image && !result.video) {
    const commandHit = SEARCH_COMMAND_RE.test(targetText);
    const volatileHit = forcedSearchMatch(targetText);
    if (commandHit || volatileHit) {
      result.search = true;
      result.query =
        decision?.query?.trim() ||
        (commandHit ? stripSearchBoilerplate(targetText) : targetText.replace(/\s+/g, ' ').trim().slice(0, 150));
      console.log(
        '[auto-engage] lexical net forced search' + (decision ? ' (model said false)' : ' (model decision unavailable)'),
        commandHit ? '— explicit command — query:' : '— volatile facts — query:',
        result.query
      );
    }
  }

  // ---- Query backfill — search=true with an EMPTY query used to be dropped
  // ---- entirely by the caller (decision.search && decision.query); a weak
  // ---- model often forgets the query field, so the raw target text stands
  // ---- in and the search survives.
  if (result.search && !result.query) {
    result.query = targetText.replace(/\s+/g, ' ').trim().slice(0, 150);
    console.log('[auto-engage] search query backfilled from the target text');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Audit surface — every deterministic net + helper exposed in ONE aggregate
// for the offline test harness (bun can import this module top-level: the
// only import is kilo-llm, whose own imports are dynamic). Single source of
// truth: the harness can never drift from the production regexes.
// ---------------------------------------------------------------------------
export const AUTO_NETS = {
  IMAGE_ENGAGE_RE,
  VIDEO_ENGAGE_RE,
  GIF_REQUEST_RE,
  SEARCH_COMMAND_RE,
  SEARCH_NOUN_REQUEST_RE,
  CODE_DELIVERABLE_RE,
  SVG_REQUEST_RE,
  IMAGE_WORD_RE,
  VIDEO_WORD_RE,
  forcedSearchMatch,
  stripSearchBoilerplate,
};
