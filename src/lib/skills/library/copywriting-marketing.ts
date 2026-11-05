import type { Skill } from '../types'

export const copywritingMarketing: Skill = {
  name: 'copywriting-marketing',
  description:
    'Persuasive copywriting for marketing: AIDA and PAS frameworks with formulas, the benefits-over-features transformation technique, headline and CTA formulas, social proof placement, tone-of-voice adaptation, and French copywriting conventions (vouvoiement, guillemets, espaces insecables, number formatting). Use when the user asks for marketing copy, headlines, ad text, sales pages, product descriptions, emails, or any texte commercial, accroche or slogan.',
  keywords: [
    'copywriting', 'redaction', 'texte marketing', 'texte publicitaire',
    'ecrire un texte', 'headline', 'titre accrocheur', 'accroche',
    'accroche publicitaire', 'cta', "appel a l'action", 'aida',
    'probleme agitation solution', 'marketing', 'publicite', 'page de vente',
    'sales page', 'email marketing', 'newsletter', 'guillemets',
    'typographie francaise', 'vouvoiement', 'benefits', 'benefices',
    'avantages', 'persuasif', 'slogan'
  ],
  body: `# Copywriting and Marketing

## Frameworks
- AIDA (ads, landing sections): Attention (headline) -> Interest (problem or mechanism) -> Desire (proof + outcomes) -> Action (CTA).
- PAS (emails, cold outreach): Problem (in their words) -> Agitate (cost of inaction) -> Solution (the product as the bridge).
- Selection rule: PAS when the reader does not know you; AIDA when they arrived with intent.

## Benefits over features — the transformation technique
For each feature ask "so what?" three times: feature -> advantage -> outcome -> emotion. Then write the last line, not the first.
- Feature "256-bit encryption" -> advantage "files stay private" -> outcome "sleep well knowing client data is safe".
- A spec list convinces engineers; outcomes convince buyers.

## Headline formulas
- Number + benefit + timeframe: "Double your leads in 30 days."
- How-to without the word how: "Write proposals clients sign."
- Negative hook: "Stop losing 20% of carts to a slow checkout."
- Question only when the answer is genuinely unknown and desired.
- Rules: <= 10 words, one idea, the strongest word first or last — never buried mid-sentence.

## CTA wording
- Verb + value: "Start my free trial" beats "Submit"; "Get my refund analysis" beats "Learn more".
- Never a bare "Click here"; name the outcome the user receives.
- One primary CTA per view; the secondary option is a quiet text link.

## Social proof placement
- Under the hero CTA (logos or a customer count), inside pricing (one testimonial per tier), next to the final CTA (the strongest quote).
- Specific beats generic: "cut onboarding from 3 weeks to 4 days", never "great product".
- Format: quote + full name + role + company + face photo.

## French copywriting conventions
- Vouvoiement always in professional copy; tutoiement only for an explicitly casual/Gen-Z brand voice — and then consistently everywhere.
- Typography: « guillemets » with non-breaking spaces inside; non-breaking space before : ; ! ?; accents on capitals (À, É) in careful text.
- Numbers: space as thousands separator (12 000), comma decimals (2,5), currency after the figure with a non-breaking space (25 €), percentages with a space (75 %).
- English texts: straight quotes, $ or £ before the number, 75% with no space.

## Tone-of-voice adaptation table
- B2B SaaS: precise, calm, numbers first, no exclamation marks.
- E-commerce: benefit-led, sensory words, honest urgency (real deadlines only).
- Luxury: short sentences, restraint, zero exclamation marks, no discount vocabulary.
- Public sector, health, finance: plain, reassuring, zero hype, sources cited.
- Developer tools: technically credible, no marketing adjectives, show code or benchmarks.

## Editing pass (mandatory on every draft)
Cut 20%: delete adjectives that add no information, "very/really/truly", passive verbs, and any sentence whose removal changes nothing. Read aloud; what you stumble on gets rewritten.`
}

export default copywritingMarketing
