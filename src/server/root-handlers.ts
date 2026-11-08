import { Ctx, jsonResponse } from './http';
import { db } from '@/lib/db';
import { VERSION, env, DEFAULT_USER_PERMISSIONS } from '@/lib/constants';
import { configGet } from '@/lib/config';
import { getPermissions } from '@/lib/access-control';
import { publicOAuthProviders } from './routers/oauth';

/**
 * App-level endpoints defined directly on the FastAPI app in main.py
 * (ported): /api/config, /api/models, /api/chat/completions, /api/embeddings.
 */

// ---------------------------------------------------------------------------
// GET /api/config  (get_app_config)
// ---------------------------------------------------------------------------

const envBool = (key: string, def: string) => (process.env[key] ?? def).toLowerCase() === 'true';

export async function handleGetAppConfig(ctx: Ctx): Promise<Response> {
  const user = ctx.user;
  const [enableSignup, enableLoginForm, auth] = await Promise.all([
    configGet<boolean>('ui.enable_signup', env.ENABLE_SIGNUP),
    configGet<boolean>('ui.enable_login_form', env.ENABLE_LOGIN_FORM),
    configGet<boolean>('auth', env.WEBUI_AUTH),
  ]);

  const config: Record<string, unknown> = {
    status: true,
    name: env.WEBUI_NAME,
    version: VERSION,
    default_locale: await configGet<string>('ui.default_locale', env.DEFAULT_LOCALE),
    default_models: await configGet<string>('ui.default_models', env.DEFAULT_MODELS),
    default_pinned_models: await configGet<string>('ui.default_pinned_models', env.DEFAULT_PINNED_MODELS),
    features: {
      slim: envBool('USE_SLIM', 'False'),
      // --- Public: required by login/signup page pre-auth ---
      auth: auth !== false,
      auth_trusted_header: false,
      enable_signup_password_confirmation: envBool('ENABLE_SIGNUP_PASSWORD_CONFIRMATION', 'False'),
      enable_ldap: await configGet<boolean>('ldap.enable', false),
      enable_signup: enableSignup,
      enable_login_form: enableLoginForm,
      enable_websocket: env.ENABLE_WEBSOCKET_SUPPORT,
      ...(env.WEBSOCKET_HEARTBEAT_INTERVAL !== null
        ? { websocket_heartbeat_interval: env.WEBSOCKET_HEARTBEAT_INTERVAL }
        : {}),
      // --- Authenticated: only consumed by logged-in frontend ---
      ...(user && (user.role === 'admin' || user.role === 'user')
        ? {
            enable_api_keys: await configGet<boolean>('auth.enable_api_keys', env.ENABLE_API_KEY),
            enable_password_change_form: await configGet<boolean>('ui.enable_password_change_form', true),
            enable_version_update_check: envBool('ENABLE_VERSION_UPDATE_CHECK', 'True'),
            enable_pyodide_file_persistence: envBool('ENABLE_PYODIDE_FILE_PERSISTENCE', 'False'),
            enable_public_active_users_count: envBool('ENABLE_PUBLIC_ACTIVE_USERS_COUNT', 'False'),
            enable_easter_eggs: envBool('ENABLE_EASTER_EGGS', 'True'),
            enable_direct_connections: await configGet<boolean>('direct.enable', false),
            // Direct integrations: users (not just admins) may attach their own
            // OpenAPI connectors (personal Gmail/Calendar endpoints + keys) from
            // the chat's connect action — they ride the request's tool_servers
            // array and run through the same connectors phase.
            enable_direct_integrations:
              envBool('ENABLE_TOOL_SERVERS', 'True') &&
              (await configGet<boolean>('direct.integrations.enable', true)),
            enable_plugins: envBool('ENABLE_PLUGINS', 'False'),
            enable_tools: envBool('ENABLE_TOOLS', 'True'),
            enable_functions: envBool('ENABLE_FUNCTIONS', 'True'),
            // Tool servers (OpenAPI connectors — Gmail, Calendar, …) are ON by
            // default: the workspace Connectors tab + the @ quick action list
            // them, and the chat pipeline (v12-flow connectors phase) executes
            // their calls server-side. Set ENABLE_TOOL_SERVERS=False to hide.
            enable_tool_servers: envBool('ENABLE_TOOL_SERVERS', 'True'),
            enable_terminal_servers: false,
            enable_folders: await configGet<boolean>('folders.enable', env.ENABLE_FOLDERS),
            folder_max_file_count: await configGet<number | null>('folders.max_file_count', null),
            enable_channels: await configGet<boolean>('channels.enable', env.ENABLE_CHANNELS),
            enable_encrypted_channels: await configGet<boolean>('channels.encryption.enable', false),
            enable_apps: await configGet<boolean>('apps.enable', env.ENABLE_APPS),
            enable_calendar: await configGet<boolean>('calendar.enable', false),
            enable_automations: await configGet<boolean>('automations.enable', false),
            enable_notes: await configGet<boolean>('notes.enable', env.ENABLE_NOTES),
            enable_context_compaction: await configGet<boolean>('chat.context_compaction.enable', false),
            enable_tool_permissions: await configGet<boolean>('chat.tool_permissions.enable', false),
            enable_web_search: await configGet<boolean>('web.search.enable', true),
            enable_web_search_confirmation: await configGet<boolean>('web.search.confirmation.enable', false),
            web_search_confirmation_content: await configGet<string | null>(
              'web.search.confirmation.content',
              null
            ),
            enable_code_execution: await configGet<boolean>('code_execution.enable', false),
            enable_code_interpreter: await configGet<boolean>('code_interpreter.enable', false),
            enable_image_generation: await configGet<boolean>('image_generation.enable', true),
            enable_autocomplete_generation: await configGet<boolean>('task.autocomplete.enable', true),
            enable_title_generation: await configGet<boolean>('task.title.enable', true),
            enable_follow_up_generation: await configGet<boolean>('task.follow_up.enable', true),
            enable_tags_generation: await configGet<boolean>('task.tags.enable', true),
            enable_community_sharing: await configGet<boolean>('ui.enable_community_sharing', true),
            enable_message_rating: await configGet<boolean>('ui.enable_message_rating', true),
            enable_user_webhooks: await configGet<boolean>('ui.enable_user_webhooks', true),
            enable_user_status: await configGet<boolean>('users.enable_status', true),
            enable_admin_export: envBool('ENABLE_ADMIN_EXPORT', 'True'),
            enable_admin_chat_access: envBool('ENABLE_ADMIN_CHAT_ACCESS', 'True'),
            enable_admin_analytics: envBool('ENABLE_ADMIN_ANALYTICS', 'True'),
            enable_google_drive_integration: await configGet<boolean>('google_drive.enable', false),
            enable_onedrive_integration: await configGet<boolean>('onedrive.enable', false),
            enable_memories: await configGet<boolean>('memories.enable', env.ENABLE_MEMORIES),
            enable_subagents: await configGet<boolean>('subagents.enable', false),
          }
        : {}),
    },
    oauth: {
      enable: await configGet<boolean>('oauth.enable', env.ENABLE_OAUTH),
      enable_signup: await configGet<boolean>('oauth.enable_signup', true),
      auto_redirect: await configGet<boolean>('oauth.auto_redirect', false),
      // Google is always advertised so the official Google button (with the
      // multi-colour G logo) renders on /auth; other providers appear only
      // once their credentials are configured (publicOAuthProviders()).
      providers: publicOAuthProviders(),
    },
    // UI metadata consumed pre-auth by the login page (Python: ui metadata config).
    // auth_logo_position 'center' renders the large brand logo above the auth card.
    metadata: {
      auth_logo_position: 'center',
    },
  };

  if (user && (user.role === 'admin' || user.role === 'user')) {
    config.permissions = await getPermissions(user.id, DEFAULT_USER_PERMISSIONS);
  }

  return jsonResponse(config);
}

// ---------------------------------------------------------------------------
// GET /api/models  (get_models — merged list from connections + workspace)
// ---------------------------------------------------------------------------

export async function handleGetModels(ctx: Ctx): Promise<Response> {
  const user = ctx.user;
  if (!user) {
    return jsonResponse({ data: [] });
  }
  const { getModelsForUser } = await import('@/lib/models-registry');
  const models = await getModelsForUser(user);
  return jsonResponse({ data: models });
}

// ---------------------------------------------------------------------------
// POST /api/chat/completions  (generate_chat_completions)
// ---------------------------------------------------------------------------

export async function handleChatCompletions(ctx: Ctx): Promise<Response> {
  if (!ctx.user) {
    return jsonResponse({ detail: 'Not authenticated' }, 401);
  }
  const form = await ctx.body<any>();
  // v0.12.5 flow: user_message / message_ids bookkeeping, stream → socket.io
  // events, persistence + title generation (main.py chat_completion port).
  const { handleChatCompletionV12 } = await import('@/lib/chat/v12-flow');
  return handleChatCompletionV12(ctx.user, form);
}

// ---------------------------------------------------------------------------
// POST /api/embeddings
// ---------------------------------------------------------------------------

export async function handleEmbeddings(ctx: Ctx): Promise<Response> {
  if (!ctx.user) {
    return jsonResponse({ detail: 'Not authenticated' }, 401);
  }
  const form = await ctx.body<{ model: string; input: string | string[] }>();
  const { generateEmbeddings } = await import('@/lib/retrieval/embeddings');
  const input = Array.isArray(form.input) ? form.input : [form.input];
  const vectors = await generateEmbeddings(form.model, input);
  return jsonResponse({
    object: 'list',
    data: vectors.map((embedding, i) => ({ object: 'embedding', index: i, embedding })),
    model: form.model,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  });
}

// ---------------------------------------------------------------------------
// GET /api/version
// ---------------------------------------------------------------------------

export async function handleVersion(): Promise<Response> {
  return jsonResponse({ version: VERSION });
}
