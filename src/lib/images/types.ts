/**
 * Nelth-IA Images — shared types (server DTOs + client view models).
 *
 * The studio talks to the existing Open WebUI-style API surface through a
 * dedicated router mount (/api/v1/imagine/*) backed by the SAME image
 * engines the chat pipeline already uses (built-in Nelthai metaai gateway,
 * or the configured OpenAI Images engine when a key exists).
 */

/** Lifecycle of one library item (server-side truth, polled by the UI). */
export type ImagineStatus = 'generating' | 'processing' | 'completed' | 'failed';

/** Live phase of the underlying provider job (Nelthai metaai gateway). */
export type ImaginePhase = 'sending' | 'generating' | 'image';

/** How the item was born. */
export type ImagineSource = 'generate' | 'edit' | 'variation' | 'upload';

/** One persistent image record (Prisma model ImageItem, table image_item). */
export interface ImagineItem {
  id: string;
  user_id: string;
  name: string | null;
  prompt: string | null;
  file_id: string | null;
  /** Served bytes URL (/api/v1/files/{id}/content) — completed items only. */
  url: string | null;
  provider: string | null;
  model: string | null;
  status: ImagineStatus;
  /** Current live phase while status is generating/processing. */
  phase: ImaginePhase | null;
  aspect_ratio: string | null;
  width: number | null;
  height: number | null;
  favorite: boolean;
  source: ImagineSource;
  parent_id: string | null;
  meta: Record<string, unknown>;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** Which engine is active and what it honestly supports. */
export interface ImagineCapabilities {
  /** 'builtin' = built-in Nelthai engine (no key), 'openai' = configured key. */
  engine: 'builtin' | 'openai';
  engineLabel: string;
  features: {
    textToImage: boolean;
    /** Image + prompt → new image (edits, variations from an image). */
    imageToImage: boolean;
    variations: boolean;
    editing: boolean;
    uploads: boolean;
  };
  /**
   * How aspect ratio reaches the provider:
   *  - 'exact'        : real size parameter (OpenAI Images API),
   *  - 'creative-hint': composition guidance folded into the prompt
   *                     (built-in engine picks its own output size),
   *  - 'none'         : not controllable at all.
   * The UI displays exactly what this says — never fakes support.
   */
  aspectRatioMode: 'exact' | 'creative-hint' | 'none';
  aspectRatios: string[];
  /** Quality tiers actually forwarded to the provider (null = unsupported). */
  qualities: string[] | null;
  maxCount: number;
}

export const IMAGINE_DEFAULT_CAPABILITIES: ImagineCapabilities = {
  engine: 'builtin',
  engineLabel: 'Moteur intégré Nelth',
  features: { textToImage: true, imageToImage: true, variations: true, editing: true, uploads: true },
  aspectRatioMode: 'creative-hint',
  aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
  qualities: null,
  maxCount: 4,
};

/** Generation request → immediately returns the queued items. */
export interface ImagineGenerateInput {
  prompt: string;
  aspectRatio?: string;
  style?: string;
  n?: number;
  /** Reference images (file ids, /api/v1/files URLs, or data: URLs). */
  sourceImages?: Array<{ id?: string; url?: string; name?: string; type?: string }>;
}

export interface ImagineEditInput {
  itemId: string;
  prompt: string;
}

export interface ImagineVariationInput {
  itemId: string;
}
