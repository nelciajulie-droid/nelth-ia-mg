/**
 * Port of open_webui/constants.py (subset used by the API surface)
 * + env resolution mirroring open_webui/env.py.
 */

export const VERSION = '0.13.0';

export const ROLE = {
  ADMIN: 'admin',
  USER: 'user',
  PENDING: 'pending',
} as const;

export type Role = 'admin' | 'user' | 'pending';

export const ERROR_MESSAGES = {
  NOT_FOUND: 'We could not find what you were looking for.',
  ACCESS_PROHIBITED:
    'You do not have permission to access this resource. Please contact your administrator for assistance.',
  ACTION_PROHIBITED:
    'The requested action has been prohibited as a security measure. Please contact your administrator for assistance.',
  INVALID_CRED: 'Incorrect email or password',
  EMAIL_TAKEN: 'Someone is already using this email address.',
  INVALID_EMAIL_FORMAT: 'Invalid email format',
  INVALID_PASSWORD: (hint?: string) =>
    hint
      ? `The password provided does not meet the requirements. ${hint}`
      : 'The password provided does not meet the requirements.',
  PASSWORD_TOO_LONG: 'The password provided is too long. The maximum length is 72 bytes.',
  EXISTING_USERS: 'Cannot create admin account when users already exist.',
  CREATE_USER_ERROR: 'Failed to create user account due to an internal error.',
  USER_NOT_FOUND: 'Could not find the user.',
  MALICIOUS_FILE: 'Potential malicious file detected.',
  NAME_TAG_TAKEN: 'Name tag is already in use.',
  INVALID_TOKEN: 'Your session has expired. Please sign in again.',
  INVALID_FILE: 'The file you provided is invalid.',
  RATE_LIMIT_EXCEEDED: 'The requested action has been rate limited. Please try again later.',
  MODEL_NOT_FOUND: 'The model requested does not exist.',
  API_KEY_NOT_FOUND: 'The API key requested could not be found.',
  INVALID_URL: 'The URL provided is invalid.',
  INSUFFICIENT_PERMISSIONS:
    'You do not have the necessary permissions to perform this action.',
  UNAUTHORIZED: 'Unauthorized',
  NOT_AUTHENTICATED: 'Not authenticated',
} as const;

// ---------------------------------------------------------------------------
// Env (subset of open_webui/env.py defaults that drive feature gating)
// ---------------------------------------------------------------------------

const envBool = (key: string, def: string) =>
  (process.env[key] ?? def).toLowerCase() === 'true';

export const env = {
  DATA_DIR: process.env.DATA_DIR || './data',
  WEBUI_AUTH: envBool('WEBUI_AUTH', 'True'),
  WEBUI_SECRET_KEY: process.env.WEBUI_SECRET_KEY || '',
  ENABLE_SIGNUP: envBool('ENABLE_SIGNUP', 'True'),
  ENABLE_LOGIN_FORM: envBool('ENABLE_LOGIN_FORM', 'True'),
  ENABLE_INITIAL_ADMIN_SIGNUP: envBool('ENABLE_INITIAL_ADMIN_SIGNUP', 'True'),
  // Public-app mode (chatgpt-like): every new account is a full, active member
  // immediately — no pending state, no admin approval step.
  DEFAULT_USER_ROLE: process.env.DEFAULT_USER_ROLE || 'user',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '-1',
  ENABLE_API_KEY: envBool('ENABLE_API_KEY', 'True'),
  ENABLE_MFA: envBool('ENABLE_MFA', 'False'),
  // Websocket transport for the realtime socket. The app origin proxies
  // /ws/* through a Next.js route handler (src/app/ws/[...path]/route.ts),
  // which cannot perform HTTP → WebSocket upgrades — not on `next dev`,
  // not on Vercel, not behind Caddy/nginx pointing at the app port. A
  // websocket-only client therefore NEVER connects (socket.io retries
  // forever, and the UI toasts “Connexion perdue. Reconnexion…” every time
  // the user returns to the tab). Polling is the transport that actually
  // works through this topology end-to-end: natively where the socket
  // service is reachable, and via the loader's serverless bridge elsewhere.
  // Self-hosters routing /ws directly to the socket service at the edge
  // (bypassing the app) may re-enable it.
  ENABLE_WEBSOCKET_SUPPORT: envBool('ENABLE_WEBSOCKET_SUPPORT', 'False'),
  WEBSOCKET_HEARTBEAT_INTERVAL: (() => {
    const raw = process.env.WEBSOCKET_HEARTBEAT_INTERVAL ?? '';
    if (raw === '') return null;
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return null;
    return Math.min(Math.max(n, 5), 90);
  })(),
  ENABLE_CHANNELS: envBool('ENABLE_CHANNELS', 'False'),
  ENABLE_APPS: envBool('ENABLE_APPS', 'False'),
  ENABLE_NOTES: envBool('ENABLE_NOTES', 'True'),
  ENABLE_MEMORIES: envBool('ENABLE_MEMORIES', 'True'),
  ENABLE_EVALUATION: envBool('ENABLE_EVALUATION', 'True'),
  ENABLE_FOLDERS: envBool('ENABLE_FOLDERS', 'True'),
  ENABLE_SEARCH_ENGINE: envBool('ENABLE_SEARCH_ENGINE', 'False'),
  ENABLE_RAG_LOCAL_WEB_FETCH: envBool('ENABLE_LOCAL_WEB_FETCH', 'False'),
  RAG_EMBEDDING_ENGINE: process.env.RAG_EMBEDDING_ENGINE || '',
  RAG_EMBEDDING_MODEL: process.env.RAG_EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2',
  RAG_OPENAI_API_BASE_URL: process.env.RAG_OPENAI_API_BASE_URL || '',
  RAG_TEXT_SPLITTER: process.env.RAG_TEXT_SPLITTER || '',
  WEBUI_NAME: process.env.WEBUI_NAME || 'Nelth-AI',
  DEFAULT_LOCALE: process.env.DEFAULT_LOCALE || '',
  DEFAULT_MODELS: process.env.DEFAULT_MODELS || '',
  DEFAULT_PINNED_MODELS: process.env.DEFAULT_PINNED_MODELS || '',
  // OpenAI-compatible connections
  OPENAI_API_BASE_URL: process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ENABLE_OPENAI_API: envBool('ENABLE_OPENAI_API', 'True'),
  // Kilo AI Gateway (built-in chat models)
  KILO_GATEWAY_API_KEY: process.env.KILO_GATEWAY_API_KEY || '',
  KILO_GATEWAY_BASE_URL: process.env.KILO_GATEWAY_BASE_URL || 'https://ai-gateway.kilo.ai/api/v1',
  // Ollama
  OLLAMA_API_BASE_URL: process.env.OLLAMA_API_BASE_URL || 'http://localhost:11434',
  ENABLE_OLLAMA_API: envBool('ENABLE_OLLAMA_API', 'True'),
  // Audio / images (default engine = openai when configured)
  AUDIO_STT_ENGINE: process.env.AUDIO_STT_ENGINE || '',
  AUDIO_TTS_ENGINE: process.env.AUDIO_TTS_ENGINE || '',
  IMAGE_ENGINE: process.env.IMAGE_ENGINE || '',
  IMAGE_OPENAI_API_BASE_URL: process.env.IMAGE_OPENAI_API_BASE_URL || '',
  // OAuth
  ENABLE_OAUTH: envBool('ENABLE_OAUTH', 'False'),
  // User permissions defaults (all False unless env override)
  USER_PERMISSIONS_WORKSPACE_ACCESS: envBool('USER_PERMISSIONS_WORKSPACE_ACCESS', 'False'),
};

/**
 * Default user permissions.
 *
 * PUBLIC-APP MODE (chatgpt-like): this deployment is a public application, not
 * a self-hosted instance with an privileged administrator. The admin role is
 * removed — every account receives the full, admin-equivalent capability set
 * (workspace access, sharing, TTS/STT, API keys, …). Personal data (chats,
 * files, notes, folders, memories) remains private to its owner; workspace
 * content without access restrictions is public to all members.
 *
 * Shape mirrors the complete Python v0.12.5 DEFAULT_USER_PERMISSIONS; values
 * are flipped to the admin-equivalent defaults.
 */
export const DEFAULT_USER_PERMISSIONS = {
  workspace: {
    models: true,
    knowledge: true,
    prompts: true,
    tools: true,
    skills: true,
    models_import: true,
    models_export: true,
    models_hidden: true,
    prompts_import: true,
    prompts_export: true,
    tools_import: true,
    tools_export: true,
    skills_import: true,
    skills_export: true,
  },
  sharing: {
    models: true,
    public_models: true,
    knowledge: true,
    public_knowledge: true,
    prompts: true,
    public_prompts: true,
    tools: true,
    public_tools: true,
    skills: true,
    public_skills: true,
    notes: true,
    public_notes: true,
    folders: true,
    public_folders: true,
    public_chats: true,
    open_chats: true,
  },
  access_grants: {
    allow_users: true,
    allow_groups: true,
  },
  chat: {
    controls: true,
    valves: true,
    system_prompt: true,
    params: true,
    file_upload: true,
    web_upload: true,
    delete: true,
    delete_message: true,
    continue_response: true,
    regenerate_response: true,
    rate_response: true,
    edit: true,
    rename: true,
    pin: true,
    share: true,
    export: true,
    import: true,
    stt: true,
    tts: true,
    call: true,
    multiple_models: true,
    temporary: true,
    temporary_enforced: false,
    stat: true,
  },
  features: {
    api_keys: true,
    notes: true,
    folders: true,
    channels: true,
    direct_tool_servers: true,
    web_search: true,
    image_generation: true,
    code_interpreter: true,
    code_execution: true,
    web_loader: true,
    memory: true,
    automations: true,
    calendar: true,
    webhooks: true,
  },
  settings: {
    interface: true,
  },
};
