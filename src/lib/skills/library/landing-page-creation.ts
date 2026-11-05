import type { Skill } from '../types'

export const landingPageCreation: Skill = {
  name: 'landing-page-creation',
  description:
    'Complete landing-page creation protocol: section-by-section page anatomy (hero to footer), 2024-2025 visual trends (bento grids, subtle glassmorphism, fluid typography, dark-mode palettes), color, typography and 8px spacing systems, plus the accessible self-contained single-file HTML deliverable contract with a pre-delivery checklist. Use when the user asks to create, redesign, modernize or polish a landing page, one-page site, homepage, portfolio or "page ultra moderne". Pairs with frontend-design (aesthetics).',
  keywords: [
    'landing page', 'landing', "page d'accueil", 'page accueil', 'site web', 'site vitrine',
    'creer un site', 'creer une page', 'page moderne', 'ultra moderne', 'webdesign',
    'redesign', 'moderniser', 'portfolio', 'one page', 'page unique',
    'hero', 'bento', 'glassmorphism', 'section', 'cta', 'maquette',
    'vitrine', 'accueil', 'homepage', 'onepager'
  ],
  body: `# Modern Landing Page Design Protocol

## Deliverable format (non-negotiable)
When the user asks for a page or a site, output ONE complete self-contained HTML file:
- All CSS inside an inline <style> block driven by CSS custom properties; zero external CSS/JS dependencies (a Google Fonts link is the only allowed exception).
- Semantic landmarks: <header>, <nav>, <main>, <section> with aria-labelledby, <footer>.
- Skip-link as the first focusable element; visible \`:focus-visible\` styles on every interactive element.
- Respect \`prefers-reduced-motion\`: disable reveals and parallax. Lazy-load images with \`loading="lazy"\` and meaningful alt attributes.

## Landing page anatomy, in order
1. Hero — one strong H1 (6-12 words stating the concrete value), a 1-2 sentence subhead, ONE primary CTA button plus at most one secondary text link. Never two competing primary buttons.
2. Social-proof bar — client logos or a "trusted by N teams" line directly under the hero.
3. Features — a bento grid (asymmetric spans: one wide cell, one tall cell) instead of uniform 3-column cards; one idea per cell with icon + 3-5 word title + 1 sentence.
4. Testimonials — 2-3 quotes with name, role, company, avatar; include one metric quote ("cut onboarding from 3 weeks to 4 days").
5. Pricing — 3 tiers maximum, middle tier visually elevated and labeled "Most popular", features as short bullet lists.
6. FAQ — 5-8 real objections answered inside <details> elements.
7. Final CTA — repeat the offer + single button, zero navigation clutter around it.
8. Footer — 3-4 link columns, legal links, social icons, one-line copyright.

## 2024-2025 trends, used with taste
- Bento grids for features; subtle glassmorphism (\`backdrop-filter: blur(12px)\`, 60-70% surface opacity) on sticky nav and cards over mesh backgrounds — never on dense text blocks.
- Mesh or radial gradient accents as background atmosphere, never full purple-blue gradient washes.
- Generous whitespace: section padding 96-128px desktop, 56-64px mobile.
- Oversized fluid display type; micro-interactions (2-4px hover lift, 150-250ms ease transitions); scroll-reveal via IntersectionObserver toggling a class (opacity + 16px translateY).
- Dark-mode-first palette as the base design, light variant as adaptation.

## Typography
- Fluid sizes: H1 \`clamp(2.5rem, 6vw, 4.5rem)\`, H2 \`clamp(1.75rem, 3.5vw, 2.5rem)\`, body \`clamp(1rem, 1.1vw, 1.125rem)\`.
- Pair a characterful display font (Sora, Space Grotesk, Bricolage) with a neutral body font (Inter or the system stack: system-ui, -apple-system, sans-serif).
- Line-height 1.5-1.7 body, 1.05-1.2 display; body measure 65-75ch; letter-spacing -0.02em on large display text only.

## Color
- 60-30-10 rule: 60% neutral background, 30% surfaces/secondary, 10% accent.
- Token system as custom properties: \`--bg\`, \`--surface\`, \`--text\`, \`--text-muted\`, \`--accent\`, \`--border\`, plus \`--radius\` and spacing tokens.
- Dark-mode-first: deep neutral base (#0A0A12 to #14141F range), never pure #000; light variant via a \`prefers-color-scheme\` block.
- Ban default Tailwind blue #3B82F6 and the blue-to-purple gradient cliche; pick a distinctive accent (lime #C8F135, amber, teal, coral).
- Contrast >= 4.5:1 for text (3:1 for large text), including muted text, button text on accent, and focus rings.

## Spacing and layout
- 8px scale only: 8 / 16 / 24 / 32 / 48 / 64 / 96 / 128. Container 1152-1280px max-width, side padding 24px mobile / 48-64px desktop.
- Mobile-first breakpoints: base 360px, then min-width 768px, 1024px, 1280px.

## Pre-delivery checklist (run every time)
- One H1 only; all 8 sections present; landmarks and skip-link in place.
- 360px check: no horizontal scroll, single column, tap targets >= 44px.
- Contrast verified on all text and buttons; every image has alt; any form field has a label.
- Reduced motion respected; focus visible; fonts load with fallbacks; no console errors.`
}

export default landingPageCreation
