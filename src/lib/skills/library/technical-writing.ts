import type { Skill } from '../types'

export const technicalWriting: Skill = {
  name: 'technical-writing',
  description:
    'Technical documentation craft: choosing between quickstart, how-to, reference and explanation (and never mixing them), README anatomy in order, rules for runnable code examples, plain-language editing, versioned docs and table-of-contents discipline. Use when the user asks to write or improve a README, documentation, a guide, tutorial, manual, onboarding doc, or API docs for a product or library.',
  keywords: [
    'documentation', 'docs', 'technical writing', 'redaction technique',
    'readme', 'guide', 'tutoriel', 'tutorial', 'quickstart',
    'demarrage rapide', 'how to', 'comment faire', 'reference', 'manuel',
    'notice', 'documentation technique', 'documentation api', 'api docs',
    'exemples de code', 'code example', 'procedure', 'instructions',
    'guide utilisateur', 'changelog', 'versionnage', 'langue claire',
    'plain language', 'clarte', 'ecrire une doc'
  ],
  body: `# Technical Writing

## The 4 doc types — pick the right one
- Quickstart (tutorial): one happy path, 5-10 minutes, copy-paste commands, ends with something visibly working. For newcomers evaluating the tool.
- How-to guide: task-oriented, answers one goal ("rotate the API keys"), assumes familiarity, one numbered step per action with the expected result shown after each.
- Reference: exhaustive and neutral, organized by object (endpoint, option, flag); states types, defaults and constraints; no narrative.
- Explanation: why it works that way — tradeoffs, history, alternatives, when not to use it.
Hard rule: never blend types on one page. A page that teaches cannot also be the reference; link between them instead.

## README anatomy, in order
1. Project name + one-line description: what it is and for whom.
2. Badges (CI, version, license) — only ones that are real.
3. Requirements + install commands, copy-pasteable and pinned.
4. Minimal usage example within the first screen — before any configuration detail.
5. Configuration table: name, type, default, description.
6. Common tasks: the 3-5 scripts people actually run.
7. Troubleshooting: error message -> cause -> fix.
8. Contributing + license.

## Runnable code example rules
- Every example is complete and copy-pasteable: imports included, no "..." elisions, no pseudo-code standing in for real calls.
- Comment the non-obvious line, never the obvious one; comments explain why.
- Show the expected output immediately after the block.
- Test each example against the current version and mark the version it targets.

## Plain language rules
- Average sentence <= 25 words; one idea per paragraph; paragraphs <= 5 lines.
- Active voice, present tense, second person: "Run the command", never "The command should be run by the user".
- Define a term at first use or link to the reference; one concept carries exactly one name across the whole doc set.
- Prefer lists over inline enumerations when there are 3 or more items.

## Versioned docs
- Docs version with the product: /docs/2.x lives beside /docs/3.x, with a "you are reading an old version" banner and a link to the current page.
- The changelog feeds the "what changed" sections; breaking changes ship with a migration snippet.
- Every deprecation note states: since which version, the replacement, and the removal date.

## Table-of-contents discipline
- A TOC only when the page exceeds ~3 screens; entries match heading text exactly.
- Maximum 2 heading levels in the TOC; test every anchor link.
- Pages beyond ~1500 words get split, with an overview page linking the parts.`
}

export default technicalWriting
