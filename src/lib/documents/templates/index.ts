/**
 * Nelth-AI Documents — template registry.
 *
 * Each template is a complete visual system (palette + typography + page
 * setup + layout engine) applied to EVERY export format and to the live
 * workspace preview, so the preview always matches the exported file.
 *
 * Two LAYOUT ENGINES exist (the PDF/DOCX/HTML "design" of the chat pipeline):
 *   • 'editorial' — clean professional documents (reports, letters, invoices)
 *   • 'bold'      — gradient hero, ultra-modern magazine energy (CVs, pitches)
 * A template picks one and paints it with its palette + fonts.
 */

export type TemplateLayout = 'editorial' | 'bold';

export type TemplatePalette = {
  /** Primary accent (headings, table headers, rules). */
  accent: string;
  /** Secondary accent (gradients, highlights) — equals accent when mono. */
  accent2: string;
  /** Darker accent for hover / strong text on tints. */
  accentDark: string;
  /** 8-12% tint of the accent (callout/table-header backgrounds). */
  tint: string;
  /** Body text. */
  ink: string;
  /** Slightly softened body text. */
  body: string;
  /** Muted metadata / captions. */
  muted: string;
  /** Table zebra row. */
  zebra: string;
  /** Hairline rules. */
  hairline: string;
};

export type TemplateTypography = {
  /** 'sans' | 'serif' families, resolved per format. */
  family: 'sans' | 'serif';
  /** Base body size (pt) — PDF/print reference. */
  size: number;
  /** Heading scale multipliers for levels 2..4 (level 1 = document title). */
  headingScale: [number, number, number];
  /** Extra line-height looseness (1 = default). */
  leading: number;
};

export type TemplatePageSetup = {
  /** Margins in pt (A4 portrait reference). */
  top: number;
  bottom: number;
  side: number;
};

export type DocumentTemplate = {
  id: string;
  /** Display name (workspace picker). */
  name: string;
  /** One-line description (workspace picker). */
  description: string;
  layout: TemplateLayout;
  palette: TemplatePalette;
  typography: TemplateTypography;
  page: TemplatePageSetup;
  /** Doc types this template is a natural default for. */
  bestFor: string[];
};

// ---------------------------------------------------------------------------
// The ten templates
// ---------------------------------------------------------------------------

function palette(
  accent: string,
  accent2: string,
  accentDark: string,
  ink: string,
  body: string,
  muted: string
): TemplatePalette {
  // tints/zebra/hairline derived from the accent family for visual cohesion.
  const tint = lighten(accent, 0.9);
  const zebra = lighten(ink, 0.94);
  const hairline = lighten(ink, 0.82);
  return { accent, accent2, accentDark, tint, ink, body, muted, zebra, hairline };
}

/** Mix a hex color toward white by `k` (0 = unchanged, 1 = white). */
function lighten(hex: string, k: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * k);
  return [mix(r), mix(g), mix(b)]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export const TEMPLATES: DocumentTemplate[] = [
  {
    id: 'corporate',
    name: 'Corporate',
    description: 'Deep-teal editorial system for business documents',
    layout: 'editorial',
    palette: palette('0F6B61', '0F6B61', '0B4A44', '1F2937', '29302F', '737A79'),
    typography: { family: 'sans', size: 10.5, headingScale: [1.6, 1.28, 1.1], leading: 1 },
    page: { top: 66, bottom: 62, side: 56 },
    bestFor: ['report', 'proposal', 'plan'],
  },
  {
    id: 'minimalist',
    name: 'Minimalist',
    description: 'Quiet graphite, generous whitespace, hairline rules',
    layout: 'editorial',
    palette: palette('37424A', '37424A', '232B30', '1A1D20', '26292C', '6B7280'),
    typography: { family: 'sans', size: 10.5, headingScale: [1.55, 1.25, 1.08], leading: 1.06 },
    page: { top: 76, bottom: 70, side: 68 },
    bestFor: ['letter', 'contract', 'other'],
  },
  {
    id: 'modern',
    name: 'Modern',
    description: 'Ultra-modern violet/fuchsia gradient system',
    layout: 'bold',
    palette: palette('7C3AED', 'C026D3', '6D28D9', '1E1B2E', '2B2740', '78728C'),
    typography: { family: 'sans', size: 10.5, headingScale: [1.7, 1.3, 1.12], leading: 1 },
    page: { top: 60, bottom: 58, side: 52 },
    bestFor: ['cv', 'plan', 'other'],
  },
  {
    id: 'academic',
    name: 'Academic',
    description: 'Serif scholarly layout with burgundy accents',
    layout: 'editorial',
    palette: palette('7A2E2E', '7A2E2E', '5E2323', '1F2328', '2A2E33', '6E7276'),
    typography: { family: 'serif', size: 11, headingScale: [1.5, 1.24, 1.08], leading: 1.1 },
    page: { top: 72, bottom: 66, side: 64 },
    bestFor: ['research', 'report'],
  },
  {
    id: 'executive',
    name: 'Executive',
    description: 'Charcoal and gold, serif headings, board-room tone',
    layout: 'editorial',
    palette: palette('8C6D1F', '8C6D1F', '6E5417', '14181C', '20262B', '79818A'),
    typography: { family: 'serif', size: 10.5, headingScale: [1.6, 1.26, 1.1], leading: 1.04 },
    page: { top: 70, bottom: 64, side: 58 },
    bestFor: ['report', 'proposal'],
  },
  {
    id: 'creative',
    name: 'Creative',
    description: 'Coral-to-amber energy for portfolios and pitches',
    layout: 'bold',
    palette: palette('E11D48', 'F59E0B', 'BE123C', '27221E', '322B26', '7D736C'),
    typography: { family: 'sans', size: 10.5, headingScale: [1.68, 1.3, 1.12], leading: 1.02 },
    page: { top: 62, bottom: 58, side: 54 },
    bestFor: ['cv', 'proposal'],
  },
  {
    id: 'financial',
    name: 'Financial',
    description: 'Ledger green, dense tables, number-first hierarchy',
    layout: 'editorial',
    palette: palette('166534', '166534', '11532B', '1A211B', '242B24', '6B756C'),
    typography: { family: 'sans', size: 10, headingScale: [1.55, 1.24, 1.08], leading: 0.98 },
    page: { top: 64, bottom: 60, side: 52 },
    bestFor: ['invoice', 'report', 'plan'],
  },
  {
    id: 'professional-cv',
    name: 'Professional CV',
    description: 'Teal-and-rose CV system with gradient hero',
    layout: 'bold',
    palette: palette('0D9488', 'E11D48', '0B7A70', '1B2422', '263230', '71807C'),
    typography: { family: 'sans', size: 10.5, headingScale: [1.62, 1.28, 1.1], leading: 1.02 },
    page: { top: 60, bottom: 56, side: 52 },
    bestFor: ['cv'],
  },
  {
    id: 'business-proposal',
    name: 'Business Proposal',
    description: 'Teal and amber, made to sell',
    layout: 'editorial',
    palette: palette('0F766E', 'D97706', '0C5F58', '1D2624', '27312F', '74817D'),
    typography: { family: 'sans', size: 10.5, headingScale: [1.62, 1.27, 1.1], leading: 1.02 },
    page: { top: 66, bottom: 62, side: 56 },
    bestFor: ['proposal', 'plan'],
  },
  {
    id: 'invoice',
    name: 'Invoice',
    description: 'Graphite billing document, slab tables',
    layout: 'editorial',
    palette: palette('334155', '0F6B61', '1E293B', '161A22', '212832', '69707E'),
    typography: { family: 'sans', size: 10, headingScale: [1.5, 1.22, 1.08], leading: 0.98 },
    page: { top: 60, bottom: 56, side: 50 },
    bestFor: ['invoice'],
  },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

/** Fallback for unknown ids — never null (edits must always resolve). */
export function getTemplate(id: string | null | undefined): DocumentTemplate {
  return (id && BY_ID.get(id)) || BY_ID.get('corporate')!;
}

export function isTemplateId(id: string | null | undefined): boolean {
  return !!id && BY_ID.has(id);
}

/** Default template for a document type (first bestFor hit). */
export function defaultTemplateForType(docType: string): string {
  const hit = TEMPLATES.find((t) => t.bestFor.includes(docType));
  return (hit ?? BY_ID.get('corporate')!).id;
}

/** Resolution shared by every consumer: explicit id → doc-type default. */
export function resolveTemplate(id: string | null | undefined, docType: string): DocumentTemplate {
  if (id && BY_ID.has(id)) return BY_ID.get(id)!;
  return getTemplate(defaultTemplateForType(docType));
}

// ---------------------------------------------------------------------------
// Font resolution per format (single source of truth)
// ---------------------------------------------------------------------------

/** PDF standard-font family per typography. */
export function pdfFontFamily(t: DocumentTemplate): 'helvetica' | 'times' {
  return t.typography.family === 'serif' ? 'times' : 'helvetica';
}

/** Word font names per typography. */
export function docxFonts(t: DocumentTemplate): { body: string; heading: string; mono: string } {
  return t.typography.family === 'serif'
    ? { body: 'Cambria', heading: 'Cambria', mono: 'Courier New' }
    : { body: 'Calibri', heading: 'Calibri', mono: 'Consolas' };
}

/** Excel font names per typography. */
export function xlsxFonts(t: DocumentTemplate): { body: string; heading: string } {
  return t.typography.family === 'serif'
    ? { body: 'Cambria', heading: 'Cambria' }
    : { body: 'Calibri', heading: 'Calibri' };
}

/** PowerPoint theme fonts per typography. */
export function pptxFonts(t: DocumentTemplate): { body: string; heading: string } {
  return t.typography.family === 'serif'
    ? { body: 'Cambria', heading: 'Cambria' }
    : { body: 'Calibri', heading: 'Calibri' };
}

/** CSS font stacks for the HTML/preview renderer. */
export function cssFonts(t: DocumentTemplate): { body: string; heading: string; mono: string } {
  return t.typography.family === 'serif'
    ? {
        body: "Georgia, 'Times New Roman', Cambria, serif",
        heading: "Georgia, 'Times New Roman', Cambria, serif",
        mono: "'Courier New', ui-monospace, monospace",
      }
    : {
        body: "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
        heading: "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
        mono: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      };
}
