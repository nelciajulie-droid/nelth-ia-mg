/** Shared API types for the Open WebUI (TS port) frontend. */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SessionUser {
  token: string;
  token_type?: string;
  expires_at?: number | null;
  id: string;
  email: string;
  name: string;
  role: "admin" | "user" | "pending";
  profile_image_url: string;
  permissions?: Record<string, unknown>;
}

/** Response of signin/signup when MFA is required for the account. */
export interface MfaChallengeResponse {
  next_step: "verify" | "enroll" | "pending";
  challenge_token: string;
  expires_in: number;
}

export interface MfaEnrollStartResponse {
  manual_key: string;
  qr_code: string; // data:image/png;base64,...
}

export interface RecoveryCodesResponse {
  recovery_codes: string[];
}

export type SigninResponse = SessionUser | MfaChallengeResponse;

export function isSessionUser(res: SigninResponse): res is SessionUser {
  return typeof (res as SessionUser).token === "string" && (res as SessionUser).token.length > 0;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelItem {
  id: string;
  name: string;
  object?: string;
  created?: number;
  owned_by?: string;
  info?: Record<string, unknown>;
}

export interface ModelsResponse {
  data: ModelItem[];
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export interface ChatSummary {
  id: string;
  title: string;
  updated_at: number;
  created_at: number;
  last_read_at?: number | null;
  snippet?: string | null;
  active?: boolean;
  archived?: boolean;
}

export interface MessageFile {
  /** File-row id — present for knowledge attachments, absent for inline
 *  image-generation results (those carry the served `url` instead). */
  id?: string;
  type: "file" | "image" | "collection";
  name?: string;
  url?: string;
}

/** Live image-generation state attached to an assistant message. */
export interface ImageGenerationState {
  /** True from the first status event until the image (or error) lands. */
  active: boolean;
  /** Live Nelthai job phase: "sending" | "generating" | "image". */
  phase: string | null;
  /** Set when the flow errored — the card shows the failure instead. */
  error?: string;
  /** Epoch ms of the image arrival (freezes the card's second counter). */
  completedAt?: number;
}

/** Message shape used by the UI (kept close to the wire format). */
export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  files?: MessageFile[];
  /** Assistant-only: live image-generation card state (Nelthai job). */
  imageGeneration?: ImageGenerationState;
  /** User-only: apps pinned through the @ mention picker for this turn
   * (chips + connector_ids metadata — id/name/icon from the registry). */
  apps?: Array<{ id: string; name: string; icon: string }>;
  /** Assistant-only: visible status rows emitted by the flow — skills
   * loaded, connector states, web-search funnel (same protocol). */
  statusNotes?: string[];
}

export interface ChatDetail {
  id: string;
  user_id: string;
  title: string;
  chat: {
    title?: string;
    messages?: Array<{ role: string; content: string; files?: MessageFile[] }>;
    [key: string]: unknown;
  };
  updated_at: number;
  created_at: number;
  archived?: boolean;
  pinned?: boolean;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Files & Knowledge
// ---------------------------------------------------------------------------

export interface FileItem {
  id: string;
  user_id?: string;
  filename: string;
  data?: { status?: string; content?: string } | null;
  meta?: Record<string, unknown>;
  created_at?: number;
}

export interface KnowledgeItem {
  id: string;
  name: string;
  description: string | null;
  meta?: Record<string, unknown>;
  created_at?: number;
  file_count?: number;
  write_access?: boolean;
  user?: { id: string; name: string; email: string; role: string };
}

export interface RetrievalSource {
  source: { name?: string; type?: string } | string;
  document: Array<string | Record<string, unknown>>;
  metadata: Array<Record<string, unknown>>;
  distances?: number[];
}

export interface RetrievalQueryResponse {
  status: boolean;
  sources: RetrievalSource[];
  collection_names?: string[];
}

export interface AttachedFile {
  id: string;
  name: string;
  uploading?: boolean;
}
