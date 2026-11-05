import type { Skill } from '../types'

export const uiUxBestPractices: Skill = {
  name: 'ui-ux-best-practices',
  description:
    'UX heuristics and accessibility essentials for digital products: Nielsen principles as a review checklist, WCAG 2.2 AA requirements, form UX, touch targets, information hierarchy, progressive disclosure and empty/loading/error state design. Use when the user asks to improve usability or accessibility, reports that an app, screen or form is confusing or frustrating, or wants interface feedback before shipping.',
  keywords: [
    'ux', 'ui', 'ergonomie', 'ergonomie web', 'accessibilite', 'a11y', 'wcag',
    'utilisabilite', 'usability', 'experience utilisateur', 'interface utilisateur',
    'formulaire', 'form', 'validation', 'champ obligatoire', "message d'erreur",
    'error state', 'empty state', 'loading', 'etat vide', 'heuristique', 'nielsen',
    'contraste', 'contrast', 'clavier', 'keyboard', 'focus', 'aria',
    'touch target', 'mobile first'
  ],
  body: `# UX and Accessibility Essentials

## Nielsen heuristics as a review checklist
1. Visibility of system status: every async action shows progress; every save confirms.
2. Match between system and real world: labels use the user's vocabulary, never internal jargon or raw error codes.
3. User control and freedom: undo for destructive actions, back always works, form drafts preserved.
4. Consistency: the same action gets the same button style and position on every screen.
5. Error prevention over error messages: confirm dangerous actions, disable invalid submits early.
6. Recognition over recall: show options and defaults instead of forcing users to remember earlier steps.
7. Flexibility: keyboard shortcuts for experts, sensible defaults for novices.
8. Minimalist aesthetic: remove any element that does not serve the current task.
9. Error recovery: every message states what happened and the next step to fix it.
10. Help in context: hints at the point of need, not a separate manual.

## WCAG 2.2 AA essentials
- Contrast 4.5:1 for normal text, 3:1 for large text (>= 24px, or 19px bold) and UI components; check disabled and placeholder states too.
- Full keyboard operability: Tab order follows visual order; no focus traps; Escape closes dialogs.
- Visible focus: never remove outlines; style \`:focus-visible\` with a 2px ring and 2px offset.
- Alt text on informative images, empty alt on decorative ones; captions or transcripts for media.
- ARIA only when semantic HTML cannot do the job: prefer native button, a href, label, fieldset, dialog elements.
- Touch targets >= 44x44px with >= 8px spacing between them; true for icon buttons too.
- Support 200% zoom and \`prefers-reduced-motion\` without losing content or causing nausea.

## Form UX protocol
1. Persistent visible labels above inputs; placeholders show format examples only, never replace labels.
2. Group related fields with fieldset/legend; mark optional fields — required is the default assumption.
3. Validate on blur and on submit, never on each keystroke while the user is still typing.
4. Errors: next to the field, linked via aria-describedby, plain language with the fix ("Enter a date like 12/03/2025"); never wipe what the user typed.
5. One primary action per form; destructive actions placed apart and requiring confirmation or undo.

## Information hierarchy
- One primary action per screen; guide the eye with size, weight and position — never color alone.
- Progressive disclosure: 3-5 core options visible, the rest behind an expander or an "Advanced" panel.
- Key message top-left (F-pattern) or on the diagonal (Z-pattern); avoid centered walls of text.

## Mobile-first
- Design at 360px first; primary actions reachable in the bottom half for one-hand use.
- Sticky bars must not consume more than ~15% of viewport height.

## Design the missing states
- Empty: what will appear here + one primary action to create the first item; no dead ends.
- Loading: under 300ms no indicator; 300ms-1s a spinner; over 1s skeletons matching the final layout or a determinate progress bar.
- Error: what failed, why if known, one retry action — human-readable, never a raw code.
- Partial/offline: show stale data with a timestamp badge rather than a blank screen.`
}

export default uiUxBestPractices
