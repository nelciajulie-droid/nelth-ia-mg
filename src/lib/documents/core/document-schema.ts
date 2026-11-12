import { z } from 'zod';

/**
 * Nelth-AI Documents — Structured Document Representation (SDR).
 *
 * ONE canonical, validated document model shared by EVERY consumer:
 *   • the chat pipeline (```document blocks → SDR → real files)
 *   • the documents API (list / read / edit / export / AI-improve)
 *   • the workspace preview (SDR + template → paginated HTML pages)
 *   • every format generator (PDF / DOCX / XLSX / PPTX / CSV / MD / TXT / HTML)
 *
 * Text-first blocks: inline emphasis stays as Markdown (**bold**, *italic*,
 * `code`) inside block text — the same inline grammar the PDF/DOCX renderers
 * already parse. That keeps blocks trivially editable (the workspace edits
 * strings, not run arrays) while preserving real typographic emphasis in
 * every export format.
 */

// ---------------------------------------------------------------------------
// Block schemas
// ---------------------------------------------------------------------------

export const DocHeadingSchema = z.object({
  t: z.literal('heading'),
  /** 1 = document title, 2 = section, 3 = sub-section, 4 = minor. */
  level: z.number().int().min(1).max(4),
  text: z.string().min(1).max(400),
});

export const DocParaSchema = z.object({
  t: z.literal('para'),
  text: z.string().min(1).max(20_000),
});

export const DocListItemSchema = z.object({
  text: z.string().min(1).max(4_000),
  /** 0 = flush, 1 = nested once, 2 = nested deep. */
  level: z.number().int().min(0).max(2).default(0),
});

export const DocListSchema = z.object({
  t: z.literal('list'),
  style: z.enum(['bullet', 'number', 'check']).default('bullet'),
  items: z.array(DocListItemSchema).min(1),
});

export const DocTableSchema = z.object({
  t: z.literal('table'),
  header: z.array(z.string()).min(1).max(24),
  rows: z.array(z.array(z.string())).max(2_000),
  caption: z.string().max(400).optional(),
});

export const DocQuoteSchema = z.object({
  t: z.literal('quote'),
  text: z.string().min(1).max(4_000),
  author: z.string().max(200).optional(),
});

export const DocCalloutSchema = z.object({
  t: z.literal('callout'),
  variant: z.enum(['info', 'warning', 'success', 'danger']).default('info'),
  title: z.string().max(200).optional(),
  text: z.string().min(1).max(4_000),
});

export const DocCodeSchema = z.object({
  t: z.literal('code'),
  text: z.string().min(1).max(30_000),
  lang: z.string().max(40).optional(),
});

export const DocDividerSchema = z.object({ t: z.literal('divider') });

export const DocPageBreakSchema = z.object({ t: z.literal('pagebreak') });

export const DocImageSchema = z.object({
  t: z.literal('image'),
  url: z.string().min(1).max(2_000),
  alt: z.string().max(400).optional(),
});

export const DocBlockSchema = z.discriminatedUnion('t', [
  DocHeadingSchema,
  DocParaSchema,
  DocListSchema,
  DocTableSchema,
  DocQuoteSchema,
  DocCalloutSchema,
  DocCodeSchema,
  DocDividerSchema,
  DocPageBreakSchema,
  DocImageSchema,
]);

// ---------------------------------------------------------------------------
// Spreadsheet / presentation payloads (XLSX / PPTX documents)
// ---------------------------------------------------------------------------

export const DocSheetSchema = z.object({
  name: z.string().min(1).max(31),
  header: z.array(z.string()).min(1).max(60),
  rows: z.array(z.array(z.string())).max(5_000),
});

export const DocSlideSchema = z.object({
  title: z.string().max(200).default(''),
  /** Paragraphs shown under the title (kept as separate bullets when short). */
  bullets: z.array(z.string()).max(20).default([]),
  /** 'title' = section opener, 'content' = normal, 'closing' = final. */
  layout: z.enum(['title', 'content', 'section', 'closing']).default('content'),
  /** Speaker notes (PPTX notes pane). */
  notes: z.string().max(4_000).optional(),
});

// ---------------------------------------------------------------------------
// Document kinds
// ---------------------------------------------------------------------------

export const DOC_TYPES = [
  'report',
  'cv',
  'invoice',
  'proposal',
  'letter',
  'presentation',
  'spreadsheet',
  'plan',
  'contract',
  'research',
  'other',
] as const;
export const DocTypeSchema = z.enum(DOC_TYPES);

export const DocumentDocSchema = z.object({
  /** SDR version — future migrations branch on this. */
  v: z.literal(1).default(1),
  title: z.string().min(1).max(300),
  docType: DocTypeSchema.default('other'),
  /** BCP-47-ish tag: 'fr', 'en', … (rendering hints only). */
  language: z.string().min(2).max(8).default('fr'),
  /** Template id — see templates registry. */
  template: z.string().min(2).max(40).default('corporate'),
  blocks: z.array(DocBlockSchema).max(4_000),
  /** Present ONLY for spreadsheet-shaped documents (XLSX/CSV). */
  sheets: z.array(DocSheetSchema).max(30).optional(),
  /** Present ONLY for presentation-shaped documents (PPTX). */
  slides: z.array(DocSlideSchema).max(100).optional(),
  createdAt: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type DocHeading = z.infer<typeof DocHeadingSchema>;
export type DocPara = z.infer<typeof DocParaSchema>;
export type DocList = z.infer<typeof DocListSchema>;
export type DocTable = z.infer<typeof DocTableSchema>;
export type DocQuote = z.infer<typeof DocQuoteSchema>;
export type DocCallout = z.infer<typeof DocCalloutSchema>;
export type DocCode = z.infer<typeof DocCodeSchema>;
export type DocImage = z.infer<typeof DocImageSchema>;
export type DocBlock = z.infer<typeof DocBlockSchema>;
export type DocSheet = z.infer<typeof DocSheetSchema>;
export type DocSlide = z.infer<typeof DocSlideSchema>;
export type DocType = z.infer<typeof DocTypeSchema>;
export type DocumentDoc = z.infer<typeof DocumentDocSchema>;

/** One saved revision (autosave / AI edit history). */
export type DocumentRevision = {
  at: number;
  /** 'human' = workspace edit, 'ai' = improve pass, 'create' = initial. */
  by: 'human' | 'ai' | 'create';
  title?: string;
  blocks?: DocBlock[];
  sheets?: DocSheet[];
  slides?: DocSlide[];
  note?: string;
};
