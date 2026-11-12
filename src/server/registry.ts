import { Route, Ctx, matchRoute, applyAuth, buildCtx, errorResponse, HttpError } from './http';

/**
 * Central dispatch — mirrors the router mounting in open_webui/main.py.
 *
 *   /api/v1/<router>/...  → routers/<router>.ts
 *   /openai/...           → routers/openai.ts
 *
 *   /ollama/* — Ollama proxy REMOVED (2026-11): answers FastAPI-style JSON
 *   404 from src/app/ollama/[…path]/route.ts. Nelth-AI serves models via
 *   OpenAI-compatible connections only; see the route file for details.
 */

import { routes as authsRoutes } from './routers/auths';
import { routes as mfaRoutes } from './routers/mfa';
import { routes as usersRoutes } from './routers/users';
import { routes as utilsRoutes } from './routers/utils';
import { routes as chatsRoutes } from './routers/chats';
import { routes as foldersRoutes } from './routers/folders';
import { routes as modelsRoutes } from './routers/models';
import { routes as openaiRoutes } from './routers/openai';
import { routes as filesRoutes } from './routers/files';
import { routes as documentsRoutes } from './routers/documents';
import { routes as knowledgeRoutes } from './routers/knowledge';
import { routes as retrievalRoutes } from './routers/retrieval';
import { routes as tasksRoutes } from './routers/tasks';
import { routes as toolsRoutes } from './routers/tools';
import { routes as functionsRoutes } from './routers/functions';
import { routes as skillsRoutes } from './routers/skills';
import { routes as promptsRoutes } from './routers/prompts';
import { routes as notesRoutes } from './routers/notes';
import { routes as memoriesRoutes } from './routers/memories';
import { routes as groupsRoutes } from './routers/groups';
import { routes as evaluationsRoutes } from './routers/evaluations';
import { routes as searchRoutes } from './routers/search';
import { routes as configsRoutes } from './routers/configs';
import { routes as channelsRoutes } from './routers/channels';
import { routes as appsRoutes } from './routers/apps';
import { routes as notificationsRoutes } from './routers/notifications';
import { routes as audioRoutes } from './routers/audio';
import { routes as imagesRoutes } from './routers/images';
import { routes as imagineRoutes } from './routers/imagine';
import { routes as oauthRoutes } from './routers/oauth';
import { routes as pipelinesRoutes } from './routers/pipelines';
import { routes as analyticsRoutes } from './routers/analytics';
import { routes as scimRoutes } from './routers/scim';
import { routes as automationsRoutes } from './routers/automations';
import { routes as calendarsRoutes } from './routers/calendars';
import { routes as terminalsRoutes } from './routers/terminals';
import { routes as connectorsRoutes } from './routers/connectors';

// Special app-level endpoints under /api/v1 (main.py decorators)
import { handleChatCompletions, handleEmbeddings } from './root-handlers';

export type Mount = { name: string; routes: Route[] };

export const V1_MOUNTS: Mount[] = [
  { name: 'pipelines', routes: pipelinesRoutes },
  { name: 'tasks', routes: tasksRoutes },
  { name: 'images', routes: imagesRoutes },
  { name: 'imagine', routes: imagineRoutes }, // Nelth-IA Images studio (/api/v1/imagine/*)
  { name: 'audio', routes: audioRoutes },
  { name: 'retrieval', routes: retrievalRoutes },
  { name: 'configs', routes: configsRoutes },
  { name: 'auths', routes: authsRoutes },
  { name: 'mfa', routes: mfaRoutes }, // mounted at /api/v1/auths/mfa — see dispatch special-case
  { name: 'users', routes: usersRoutes },
  { name: 'apps', routes: appsRoutes },
  { name: 'channels', routes: channelsRoutes },
  { name: 'chats', routes: chatsRoutes },
  { name: 'notes', routes: notesRoutes },
  { name: 'search', routes: searchRoutes },
  { name: 'models', routes: modelsRoutes },
  { name: 'notifications', routes: notificationsRoutes },
  { name: 'knowledge', routes: knowledgeRoutes },
  { name: 'prompts', routes: promptsRoutes },
  { name: 'tools', routes: toolsRoutes },
  { name: 'skills', routes: skillsRoutes },
  { name: 'memories', routes: memoriesRoutes },
  { name: 'folders', routes: foldersRoutes },
  { name: 'groups', routes: groupsRoutes },
  { name: 'files', routes: filesRoutes },
  { name: 'documents', routes: documentsRoutes }, // Nelth-AI documents workspace (/api/v1/documents/*)
  { name: 'functions', routes: functionsRoutes },
  { name: 'evaluations', routes: evaluationsRoutes },
  { name: 'analytics', routes: analyticsRoutes },
  { name: 'utils', routes: utilsRoutes },
  { name: 'terminals', routes: terminalsRoutes },
  { name: 'automations', routes: automationsRoutes },
  { name: 'calendars', routes: calendarsRoutes },
  { name: 'scim', routes: scimRoutes },
  { name: 'connectors', routes: connectorsRoutes },
];

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('access-control-allow-origin', headers.get('access-control-allow-origin') || '*');
  headers.set('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  headers.set('access-control-allow-headers', 'Authorization,Content-Type,x-api-key');
  return new Response(res.body, { status: res.status, headers });
}

async function runMatched(match: { route: Route; params: Record<string, string> }, req: Request, path: string): Promise<Response> {
  const ctx = await buildCtx(req, path, match.params);
  applyAuth(match.route, ctx.user);
  return await match.route.handler(ctx);
}

export async function dispatch(req: Request, segments: string[], prefix: string): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 200 }));
  }
  try {
    // ---- app-level special endpoints (main.py decorators) ----
    // /api/v1/chat/completions
    if (segments.join('/') === 'chat/completions' && (req.method === 'POST' || req.method === 'GET')) {
      if (req.method === 'POST') {
        const ctx = await buildCtx(req, 'chat/completions', {});
        return handleChatCompletions(ctx);
      }
    }
    // /api/v1/embeddings
    if (segments.join('/') === 'embeddings' && req.method === 'POST') {
      const ctx = await buildCtx(req, 'embeddings', {});
      return handleEmbeddings(ctx);
    }
    // mfa router mounted at /api/v1/auths/mfa
    if (segments[0] === 'auths' && segments[1] === 'mfa') {
      const match = matchRoute(mfaRoutes, req.method, segments.slice(2));
      if (match) return withCors(await runMatched(match, req, segments.slice(2).join('/')));
      return withCors(errorResponse(404, 'Not Found'));
    }

    const routerName = segments[0];
    const mount = V1_MOUNTS.find((m) => m.name === routerName);
    if (!mount) return withCors(errorResponse(404, 'Not Found'));
    const rest = segments.slice(1);
    const match = matchRoute(mount.routes, req.method, rest);
    if (!match) {
      // 405 when path exists under another method
      const pathExists = mount.routes.some(
        (r) =>
          r.path.split('/').filter(Boolean).length === rest.length &&
          r.path
            .split('/')
            .filter(Boolean)
            .every((seg, i) => seg.startsWith(':') || seg === rest[i])
      );
      return withCors(errorResponse(pathExists ? 405 : 404, pathExists ? 'Method Not Allowed' : 'Not Found'));
    }
    return withCors(await runMatched(match, req, rest.join('/')));
  } catch (e) {
    if (e instanceof HttpError) return withCors(errorResponse(e.status, e.detail));
    console.error(`[api:${prefix}] ${req.method} /${segments.join('/')}`, e);
    return withCors(errorResponse(500, e instanceof Error ? e.message : 'Internal Server Error'));
  }
}

/** /openai/* app-level dispatch (routers/openai.ts — port of open_webui/routers/openai.py).
 *  The former 'ollama' prefix was removed with the Ollama proxy. */
export async function dispatchPrefixed(req: Request, prefix: 'openai'): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean).slice(1); // strip the prefix
  const routes = prefix === 'openai' ? openaiRoutes : openaiRoutes;
  if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 200 }));
  try {
    const match = matchRoute(routes, req.method, segments);
    if (!match) return withCors(errorResponse(404, 'Not Found'));
    return withCors(await runMatched(match, req, segments.join('/')));
  } catch (e) {
    if (e instanceof HttpError) return withCors(errorResponse(e.status, e.detail));
    console.error(`[${prefix}] ${req.method} ${url.pathname}`, e);
    return withCors(errorResponse(500, e instanceof Error ? e.message : 'Internal Server Error'));
  }
}

/** /oauth/* app-level router (main.py OAuthManager routes: /oauth/{provider}/login, ...). */
export async function dispatchOauth(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean).slice(1); // strip 'oauth'
  if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 200 }));
  try {
    const match = matchRoute(oauthRoutes, req.method, segments);
    if (!match) return withCors(errorResponse(404, 'Not Found'));
    return withCors(await runMatched(match, req, segments.join('/')));
  } catch (e) {
    if (e instanceof HttpError) return withCors(errorResponse(e.status, e.detail));
    console.error(`[oauth] ${req.method} ${url.pathname}`, e);
    return withCors(errorResponse(500, e instanceof Error ? e.message : 'Internal Server Error'));
  }
}

export { buildCtx };
export type { Ctx, Route };
