import type { Skill } from '../types'

export const seoOptimization: Skill = {
  name: 'seo-optimization',
  description:
    'On-page and technical SEO: title and meta description rules, heading structure, alt text, JSON-LD structured data, Core Web Vitals targets (LCP < 2.5s, INP < 200ms, CLS < 0.1), sitemap.xml and robots.txt, canonical URLs, E-E-A-T content strategy and local SEO. Use when the user wants to improve Google ranking or referencement naturel, grow organic traffic, fix search visibility, or asks why their site does not appear in search results.',
  keywords: [
    'seo', 'referencement', 'referencement naturel', 'referencement google',
    'google', 'moteur de recherche', 'search engine', 'ranking', 'position google',
    'balise title', 'meta description', 'titre seo', 'mots cles', 'keywords',
    'mot cle', 'backlinks', 'core web vitals', 'lcp', 'performance site',
    'vitesse site', 'sitemap', 'robots.txt', 'donnees structurees', 'json-ld',
    'schema.org', 'rich snippet', 'serp', 'trafic', 'traffic', 'local seo'
  ],
  body: `# SEO Optimization

## On-page SEO (every indexable page)
- Unique title <= 60 chars: primary keyword + qualifier + brand, keyword front-loaded.
- Meta description <= 155 chars: active verb + concrete benefit + implicit promise. It does not rank but drives the click.
- Exactly one H1 per page; H2/H3 in logical order, never skipped just for styling.
- Descriptive alt text on meaningful images; dash-separated filenames (portrait-client-paris.jpg).
- Internal links with descriptive anchor text (never "click here"), 3-8 per page.
- Clean URLs: /services/tarifs rather than /page?id=2.

## Structured data (JSON-LD)
- One script tag per page with @context https://schema.org and the matching type: Organization + WebSite on the homepage, Article or BlogPosting on posts, Product + Offer + AggregateRating on product pages, FAQPage on FAQs, LocalBusiness with address and openingHoursSpecification for local businesses.
- Only mark up content that is visible on the page; validate with Google's Rich Results Test.

## Core Web Vitals targets
- LCP < 2.5s: preload the hero image, serve responsive images with srcset/sizes, set width and height to stop layout shifts, ship AVIF/WebP.
- INP < 200ms: split long tasks, defer third-party scripts, trim hydration work.
- CLS < 0.1: reserve space for images, ads and embeds; never insert content above existing content.
- Supporting targets: TTFB < 800ms via cache/CDN, brotli compression, preconnect to font origins, font-display: swap.

## Crawlability
- sitemap.xml listing canonical URLs with lastmod, referenced from robots.txt.
- robots.txt blocks only what must be blocked (admin, internal search results); never block CSS or JS.
- Canonical link on every indexable page (self-referencing included), especially with URL parameters.
- 301 redirects for moved pages, no chains longer than one hop; a custom 404 with navigation links.
- Multilingual sites: one language per URL + hreflang annotations, including x-default.

## Content strategy — E-E-A-T
- Experience and Expertise: named authors with bios and credentials, first-hand details, original data, screenshots and methodology.
- Trust: HTTPS, contact information, clear pricing, cited sources, visible published and updated dates.
- Depth: one page = one search intent, covered more completely than the competing results; refresh stale pages instead of spawning near-duplicates (which causes keyword cannibalization).

## Local SEO
- Complete the Google Business Profile: exact category, hours, photos, regular posts; keep Name-Address-Phone identical everywhere it appears.
- LocalBusiness JSON-LD on the site; one genuinely local landing page per city (local references, cases, photos), not templated duplicates.
- Request reviews systematically and answer every one, positive or negative.`
}

export default seoOptimization
