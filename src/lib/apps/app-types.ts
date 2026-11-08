/**
 * @ App mention picker — shared types (frontend picker ↔ backend runtime).
 *
 * The registry itself lives in app-registry.ts; the HTTP surface lives in
 * server/routers/connectors.ts; the chat-flow routing lives in app-router.ts.
 */

/** Stable connector identifiers (URL-safe, used in the chat payload). */
export type ConnectorId =
  | 'gmail'
  | 'gdrive'
  | 'gcal'
  | 'slack'
  | 'github'
  | 'notion'
  | 'outlook'
  | 'onedrive'
  | 'web_search';

/** OAuth provider families reused from the login OAuth router env contract. */
export type OAuthProviderKey = 'google' | 'microsoft' | 'github' | 'slack' | 'notion';

/**
 * Connection status — NEVER invented: it comes from the connector_connection
 * table (per user, per connector). `ready` marks built-in connectors that need
 * no account at all (web search runs on the server's own engine).
 */
export type ConnectionStatus = 'connected' | 'disconnected' | 'ready';

/** A capability exposed by a connector (shown in the picker row). */
export interface ConnectorAction {
  id: string;
  label: string;
  description: string;
  /** Actions with side effects outside the chat (send, create, delete…) ask
   * for user confirmation before executing — flagged here. */
  sensitive: boolean;
}

/** Static app definition (single source of truth, backend-owned). */
export interface AppDefinition {
  id: ConnectorId;
  name: string;
  description: string;
  /** Official-style brand icon — inline SVG markup (no external fetch). */
  icon: string;
  /** Connector identifier used when routing a turn to its tools. */
  connector: string;
  /** OAuth provider whose credentials (login OAuth env contract) connect it,
   * or null for built-in connectors. */
  oauthProvider: OAuthProviderKey | null;
  /** Built-in connectors work with no connected account (always `ready`). */
  builtin: boolean;
  /** Search aliases for the picker filter (typing "mail" finds Gmail). */
  keywords: string[];
  actions: ConnectorAction[];
  /** OAuth scopes required to operate the connector. */
  permissions: string[];
}

/** Per-user live connection state, resolved from the database. */
export interface AppConnection {
  status: ConnectionStatus;
  /** Connected account label (email / login) — null when disconnected. */
  account: string | null;
  connected_at: number | null;
}

/** GET /api/v1/connectors row — definition + live per-user status. */
export interface ConnectorListItem extends AppDefinition {
  connection: AppConnection;
  /** Whether the OAuth provider credentials are configured on this instance
   * (same env vars as the login OAuth router). Drives the connect flow. */
  oauth_configured: boolean;
}

/** POST /api/v1/connectors/{id}/connect response. */
export type ConnectFlowResponse =
  | { status: 'redirect'; url: string }
  | { status: 'not_configured'; detail: string; env: string[] };
