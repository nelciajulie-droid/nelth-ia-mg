import type { Skill } from '../types'

export const businessStrategy: Skill = {
  name: 'business-strategy',
  description:
    'Startup and business strategy: business model canvas walkthrough, pricing strategies (cost-plus, value-based, competitive) and 3-tier offer design, unit economics (CAC, LTV, LTV/CAC >= 3, payback period), go-to-market phases, competitive analysis framework and the lean validation loop. Use when the user works on a business model or business plan, pricing or tarifs, unit economics, positioning, go-to-market, or validating a startup idea.',
  keywords: [
    'business', 'business model', 'business plan', 'strategie', 'strategy',
    'strategie entreprise', 'business model canvas', 'pricing',
    'tarification', 'prix', 'tarifs', 'offres', 'abonnement', 'subscription',
    'cac', 'ltv', 'marge', 'margin', 'rentabilite', 'rentable',
    'unit economics', 'etude de marche', 'part de marche', 'marche cible',
    'market', 'go to market', 'lancement produit', 'startup',
    'creer une entreprise', 'concurrence'
  ],
  body: `# Business Strategy

## Business Model Canvas — walk all 9 blocks, in order
1. Customer segments: who exactly (a named persona, never "everyone").
2. Value proposition: the one job you do better; a painkiller, not a vitamin.
3. Channels: how they discover and buy.
4. Customer relationships: self-serve or assisted.
5. Revenue streams: what they pay for and how (one-time, subscription, usage).
6. Key resources, 7. Key activities, 8. Key partners.
9. Cost structure: fixed vs variable; name the three biggest costs.
Fill segments and value proposition first; every other block must trace back to them or it gets cut.

## Pricing strategies
- Cost-plus: price = cost x target margin. A floor for viability, never the whole strategy.
- Value-based: price relative to the customer's gain (hours saved x their cost per hour, or a share of revenue generated). Aim here.
- Competitive: anchor against alternatives and position deliberately — premium (justify with service/quality) or disruption (80% of the value at 30% of the price).
- 3-tier setup: entry (self-serve, limited, exists to make the middle look safe), middle (the target tier, labeled "most popular", the profit center), premium/enterprise (high anchor, concierge onboarding). The entry tier is mostly a decoy that sells the middle.

## Unit economics
- CAC = total acquisition spend / new customers, computed per channel when possible.
- LTV = average revenue per customer x gross margin x average lifetime (or ARPA x margin / churn rate).
- Health rules: LTV/CAC >= 3 — below 3, growth burns money; CAC payback <= 12 months for SaaS.
- Gross margin targets: 70-80% for software; below 40% the model itself is the problem.
- E-commerce: track contribution margin per order = price - COGS - shipping - payment fees - returns.

## Go-to-market phases
1. Beachhead: one narrow segment, one channel, one message; dominate it (target 20-40% of a niche you can name).
2. Expand: adjacent segments sharing the same job-to-be-done; add a second channel only after the first is measured and saturated.
3. Scale: multi-channel, brand spend, partnerships — only once unit economics are proven.

## Competitive analysis framework
- For each of the top 3-5 competitors: positioning sentence, pricing, target segment, strongest moat, weakest point.
- Read 10 real customer reviews per competitor: the recurring complaints are your roadmap.
- Draw the market on the two axes customers actually use to decide; claim the empty, defensible quadrant and say it in one sentence.

## Lean validation loop
Hypothesis (falsifiable and quantified) -> cheapest experiment (landing page, concierge MVP, pre-sales, 10 interviews) -> measure against a threshold written BEFORE the experiment -> pivot (change exactly one core assumption) or persevere (double down on the channel).
Instrument matching: interviews measure problem intensity, landing pages measure intent, pre-sales measure willingness to pay — pick the instrument that tests the actual assumption, and never treat politeness as demand.`
}

export default businessStrategy
