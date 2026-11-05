import type { Skill } from '../types'

export const languageTranslation: Skill = {
  name: 'language-translation',
  description:
    'French-English translation and localization: fidelity vs transcreation decisions, register and formality preservation, the false friends list (actually/actuellement, library/librairie and 10+ more), locale typographic conventions (guillemets, espaces insecables, quotes), idiom handling, number and date localization, and a 3-pass QA method with glossary. Use when the user asks to translate or improve a translation, localize content FR/EN, or spots a suspicious or wrong translation.',
  keywords: [
    'traduction', 'translate', 'traduire', 'traducteur', 'translator',
    'anglais', 'english', 'francais', 'french', 'traduire en anglais',
    'traduire en francais', 'localize', 'localisation', 'langue', 'language',
    'faux amis', 'false friends', 'idiome', 'idioms', 'expression', 'registre',
    'formel', 'guillemets', 'typographie', 'relecture', 'proofreading',
    'revision', 'glossaire', 'transcreation', 'sous-titres'
  ],
  body: `# Translation (FR <-> EN)

## Fidelity vs transcreation — decide first, and say which you chose
- Fidelity (translate what is said): technical docs, legal, contracts, medical, error messages, API docs. Accuracy over style; preserve structure, numbering and emphasis.
- Transcreation (translate what it does): marketing, headlines, UI microcopy, app store text. Rewrite for the target culture keeping intent, image and impact — not the words.
- Never silently mix the two in one document.

## Register and formality preservation
- Map the source register before translating: formal/informal, technical/general, cold/warm — then match it consistently, including UI strings and error messages.
- French "vous" collapses into English "you": restore the lost formality through vocabulary ("we would be pleased" vs "we're happy"), never through archaic constructions.

## French-English false friends (verify every occurrence)
- actually (en realite) vs actuellement (currently)
- library (bibliotheque de code) vs librairie (bookshop)
- to assist (aider) vs assister a (attend)
- eventually (finalement) vs eventuellement (possibly)
- to expect (s'attendre a) vs esperer (to hope)
- sensible (raisonnable, wise) vs sensible (sensitive)
- to pretend (faire semblant) vs pretendre (to claim)
- opportun (bien choisi) vs opportunistic (unfair, unscrupulous)
- delai (timeframe) vs delay (retard)
- issue (probleme) vs une issue (an exit)
- caution (prudence) vs une caution (a deposit)
- fluent (aisance) vs fluent (qui coule): for languages use "courant" / "bilingual"

## Typographic conventions per locale
French:
- « guillemets » with non-breaking spaces inside; typographic apostrophe in print.
- Non-breaking space before : ; ! ? and around the guillemets.
- Non-breaking space as thousands separator (12 000), comma decimals (2,5), currency after the figure (25 €), space before % (75 %).
- Accents on capitals in careful typography: A Paris, Epoque.
English:
- Double quotes (US) or single quotes (UK); no space before punctuation.
- Period decimals (2.5), comma thousands (12,000), $ or £ before the number ($25), 75% attached.

## Idiom handling
- Translate the meaning, not the words: "cost an arm and a leg" -> "couter les yeux de la tete"; "a stone's throw" -> "a deux pas".
- If no equivalent exists, replace with plain meaning — never footnote an idiom in UI copy.
- Cultural references (TV shows, sports, brand names) get localized equivalents or neutral replacements.

## Numbers, dates, localization
- Dates: FR 12 mars 2025 / US March 12, 2025 / UK 12 March 2025. Never numeric-only across locales: 03/04 is March 4 in the US and April 3 in France.
- Phone formats localized (+33 with spaces vs (555) 123-4567); addresses follow the target country's postal format.
- Convert currency only when asked; otherwise keep the original amount and symbol placement per locale.

## 3-pass QA method
1. Accuracy pass, against the source, segment by segment: no omission, no addition, terminology verified.
2. Style pass, target text alone, read aloud: it must read as if originally written in the target language.
3. Consistency pass with a glossary built BEFORE translating (product names, feature names, formality decisions): verify every term, the capitalization of UI labels, and that identical source strings got identical translations.`
}

export default languageTranslation
