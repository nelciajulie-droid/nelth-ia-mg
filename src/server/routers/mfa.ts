import type { Route, Ctx } from '../http';
import { HttpError, jsonResponse } from '../http';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { configGet } from '@/lib/config';
import { decodeToken, parseDuration } from '@/lib/auth';
import {
  Auths,
  getAuthOrThrow,
  getMfaConfig,
  isMfaRequired,
  loadChallenge,
  saveMfa,
  startMfaEnrollment,
  confirmMfaEnrollment,
  verifyMfaChallenge,
  manageMfa,
  createSessionResponse,
  tokenHash,
  WEBUI_AUTH_COOKIE_SAME_SITE,
  WEBUI_AUTH_COOKIE_SECURE,
  type MfaChallenge,
  type MfaData,
  type AuthModel,
} from '@/lib/models/auths';
import type { UserModel } from '@/lib/models/users';

/**
 * Port of open_webui/routers/mfa.py (/api/v1/auths/mfa).
 *
 * Deviations (documented):
 *  - The MfaRoute wrapper's IP rate limiter (100 req / 15 min, Redis-backed)
 *    is an in-memory rolling window (same limits) — no Redis runtime here.
 *  - disconnect_user_sessions (socket runtime) is a no-op; session revocation
 *    is already handled by saveMfa({revoke:true}) inside the MFA lib.
 *  - Response `Cache-Control: no-store` is applied by the wrapper below.
 */

const CHALLENGE_SECONDS = 300;
const CHALLENGE_COOKIE = 'mfa_challenge';

// ---------------------------------------------------------------------------
// In-memory IP limiter (Python: RateLimiter(limit=100, window=900))
// ---------------------------------------------------------------------------

const nowSec = () => Math.floor(Date.now() / 1000);

class RateLimiter {
  private buckets = new Map<number, Map<string, number>>();
  constructor(
    public limit: number,
    public window: number,
    private bucketSize = 60
  ) {}
  isLimited(key: string): boolean {
    const nowBucket = Math.floor(nowSec() / this.bucketSize);
    const numBuckets = Math.floor(this.window / this.bucketSize);
    for (const bucketIndex of [...this.buckets.keys()]) {
      if (bucketIndex < nowBucket - numBuckets) this.buckets.delete(bucketIndex);
    }
    const current = this.buckets.get(nowBucket) ?? new Map<string, number>();
    current.set(key, (current.get(key) ?? 0) + 1);
    this.buckets.set(nowBucket, current);
    let total = 0;
    for (const bucketCounts of this.buckets.values()) total += bucketCounts.get(key) ?? 0;
    return total > this.limit;
  }
}

const ipLimiter = new RateLimiter(100, 900);

// ---------------------------------------------------------------------------
// Response helpers (MfaRoute wrapper parity: no-store, Retry-After on 429)
// ---------------------------------------------------------------------------

function buildResponse(data: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponseMfa(status: number, detail: string | unknown[]): Response {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('cache-control', 'no-store');
  if (status === 429) headers.set('retry-after', '900');
  return new Response(JSON.stringify({ detail }), { status, headers });
}

function clearChallengeCookie(): string {
  let cookie = `${CHALLENGE_COOKIE}=; Path=/api/v1/auths/mfa; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=${WEBUI_AUTH_COOKIE_SAME_SITE}`;
  if (WEBUI_AUTH_COOKIE_SECURE) cookie += '; Secure';
  return cookie;
}

/** Wraps a handler with the MfaRoute protected() semantics. */
function protectedRoute(handler: (ctx: Ctx) => Promise<Response>): (ctx: Ctx) => Promise<Response> {
  return async (ctx: Ctx) => {
    try {
      if (ctx.method === 'POST' && (await getMfaConfig()).ENABLE_MFA) {
        const ip = ctx.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
        if (ipLimiter.isLimited(`mfa:ip:${tokenHash(ip)}`)) {
          return errorResponseMfa(429, 'Too many attempts. Please try again later.');
        }
      }
      return await handler(ctx);
    } catch (e) {
      if (e instanceof HttpError) return errorResponseMfa(e.status, e.detail);
      console.error('[mfa]', e);
      // SQLAlchemyError/ValidationError → 503 parity
      return errorResponseMfa(503, 'Authentication is temporarily unavailable.');
    }
  };
}

// ---------------------------------------------------------------------------
// Form validation (pydantic SecretStr forms, extra='forbid')
// ---------------------------------------------------------------------------

class InvalidAuthRequest extends Error {}

function requireFields(
  body: Record<string, unknown>,
  fields: Array<{ name: string; kind: 'secret' | 'bool'; min?: number; max?: number; optional?: boolean; def?: boolean }>
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const allowed = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new InvalidAuthRequest();
  }
  for (const f of fields) {
    const raw = body[f.name];
    if (f.kind === 'bool') {
      if (raw === undefined) {
        out[f.name] = f.def ?? false;
      } else if (typeof raw === 'boolean') {
        out[f.name] = raw;
      } else {
        throw new InvalidAuthRequest();
      }
      continue;
    }
    if (raw === undefined || raw === null) {
      if (f.optional) continue;
      throw new InvalidAuthRequest();
    }
    if (typeof raw !== 'string') throw new InvalidAuthRequest();
    if (f.min !== undefined && raw.length < f.min) throw new InvalidAuthRequest();
    if (f.max !== undefined && raw.length > f.max) throw new InvalidAuthRequest();
    out[f.name] = raw;
  }
  return out;
}

async function readForm(ctx: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await ctx.body<Record<string, unknown>>();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InvalidAuthRequest();
    return body;
  } catch (e) {
    if (e instanceof InvalidAuthRequest) throw e;
    throw new InvalidAuthRequest();
  }
}

// ---------------------------------------------------------------------------
// challenge_response / new_challenge / redeem_mfa_reset_token ports
// ---------------------------------------------------------------------------

function challengeResponseData(token: string, challenge: MfaChallenge): Record<string, unknown> {
  return {
    next_step: challenge.type === 'replace' ? 'enroll' : challenge.type,
    challenge_token: token,
    expires_in: Math.max(0, challenge.expires_at - nowSec()),
  };
}

function newChallengeToken(
  auth: AuthModel,
  kind: 'enroll' | 'verify' | 'replace' | 'recover',
  authMethod: string,
  authTime: number,
  context: { oauth_session_id?: string | null; provider?: string | null } = {}
): { token: string; challenge: MfaChallenge } {
  // Python: token = f'{auth.id}.{secrets.token_urlsafe(32)}'
  const token = `${auth.id}.${crypto.randomBytes(32).toString('base64url')}`;
  const challenge: MfaChallenge = {
    token_hash: tokenHash(token),
    type: kind,
    expires_at: nowSec() + CHALLENGE_SECONDS,
    attempts: 0,
    auth_method: authMethod as MfaChallenge['auth_method'],
    auth_time: authTime,
    session_stamp: auth.session_stamp,
    secret: null,
    oauth_session_id: context.oauth_session_id ?? null,
    provider: context.provider ?? null,
  };
  return { token, challenge };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Python: redeem_mfa_reset_token. */
async function redeemMfaResetToken(token: string, resetToken: string): Promise<Record<string, unknown>> {
  const { user: _user, auth, mfa, challenge } = await loadChallenge(token, new Set(['recover']), { attempt: true });
  void _user;
  const ticket = mfa.reset_ticket;
  if (
    !mfa.reset_required ||
    ticket === null ||
    ticket === undefined ||
    ticket.expires_at <= nowSec() ||
    !timingSafeEqualStr(ticket.token_hash, tokenHash(resetToken))
  ) {
    throw new HttpError(401, 'Invalid or expired operator recovery token.');
  }
  const { token: newToken, challenge: enroll } = newChallengeToken(auth, 'enroll', challenge.auth_method, challenge.auth_time, {
    oauth_session_id: challenge.oauth_session_id,
    provider: challenge.provider,
  });
  mfa.reset_ticket = null;
  mfa.login_challenge = enroll;
  await saveMfa(auth, mfa);
  return challengeResponseData(newToken, enroll);
}

// ---------------------------------------------------------------------------
// get_human_user (utils/auth.py) — session-token (non-API-key) users only
// ---------------------------------------------------------------------------

function requireHumanUser(ctx: Ctx) {
  const user = ctx.user;
  if (!user) throw new HttpError(401, 'Not authenticated');
  if (!['admin', 'user'].includes(user.role)) {
    throw new HttpError(403, 'A human session is required.');
  }
  const claims = ctx.token ? decodeToken(ctx.token) : null;
  const typ = claims ? String((claims as Record<string, unknown>).typ ?? 'session') : null;
  if (!ctx.token || !claims || (typ !== 'session' && typ !== null)) {
    throw new HttpError(403, 'A human session is required.');
  }
  return { user, claims: claims as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// finish_login (utils/auth.py create_session_response + oauth cookie)
// ---------------------------------------------------------------------------

async function finishLogin(
  user: UserModel,
  auth: AuthModel,
  challenge: MfaChallenge
): Promise<{ data: Record<string, unknown>; cookies: string[] }> {
  const result = await createSessionResponse(user, {
    setCookie: true,
    source: challenge.auth_method,
    auth,
    mfaVerified: true,
    authTime: challenge.auth_time,
  });
  const cookies = [...result.cookies];
  if (challenge.oauth_session_id) {
    const session = await db.oAuthSession.findUnique({ where: { id: challenge.oauth_session_id } });
    if (session && session.user_id === user.id) {
      const expiresDeltaSec = parseDuration(await configGet<string>('auth.jwt_expiry', '-1'));
      let cookie = `oauth_session_id=${session.id}; Path=/; HttpOnly; SameSite=${WEBUI_AUTH_COOKIE_SAME_SITE}`;
      if (WEBUI_AUTH_COOKIE_SECURE) cookie += '; Secure';
      if (expiresDeltaSec) cookie += `; Max-Age=${Math.floor(expiresDeltaSec)}`;
      cookies.push(cookie);
    }
  }
  cookies.push(clearChallengeCookie());
  return { data: result.data, cookies };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const routes: Route[] = [
  // ------------------- GET /status -------------------
  {
    method: 'GET',
    path: 'status',
    auth: 'user',
    handler: protectedRoute(async (ctx) => {
      const { user, claims } = requireHumanUser(ctx);
      const auth = await getAuthOrThrow(user.id);
      const state: MfaData | null = auth.mfa ?? null;
      return buildResponse({
        enabled: Boolean(state && state.secret),
        required: isMfaRequired(String(claims.auth_method ?? ''), await getMfaConfig()),
        recovery_codes_remaining: state ? state.recovery_hashes.length : 0,
      });
    }),
  },

  // ------------------- POST /challenge (cookie bootstrap) -------------------
  {
    method: 'POST',
    path: 'challenge',
    auth: 'none',
    handler: protectedRoute(async (ctx) => {
      // Cookie-only bootstrap is browser-only and must not be driven cross-origin.
      const origin = ctx.req.headers.get('origin');
      const configured = await configGet<string | null>('webui.url', null);
      let expected: URL;
      try {
        expected = new URL(configured || ctx.req.url);
      } catch {
        try {
          expected = new URL(ctx.req.url);
        } catch {
          throw new HttpError(403, 'Invalid request origin.');
        }
      }
      if (origin !== `${expected.protocol}//${expected.host}`) {
        throw new HttpError(403, 'Invalid request origin.');
      }
      const cookieHeader = ctx.req.headers.get('cookie') ?? '';
      const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${CHALLENGE_COOKIE}=([^;]*)`));
      const token = match ? decodeURIComponent(match[1]) : '';
      try {
        const { challenge } = await loadChallenge(token, new Set(['enroll', 'verify', 'recover']));
        return buildResponse(challengeResponseData(token, challenge));
      } catch {
        return buildResponse({ detail: 'This authentication step expired. Please start again.' }, 401, [
          clearChallengeCookie(),
        ]);
      }
    }),
  },

  // ------------------- POST /enroll/start -------------------
  {
    method: 'POST',
    path: 'enroll/start',
    auth: 'none',
    handler: protectedRoute(async (ctx) => {
      const body = await readForm(ctx);
      let form: Record<string, string | boolean>;
      try {
        form = requireFields(body, [{ name: 'challenge_token', kind: 'secret', min: 20, max: 160 }]);
      } catch {
        return errorResponseMfa(422, 'Invalid authentication request.');
      }
      const result = await startMfaEnrollment(String(form.challenge_token));
      return buildResponse(result);
    }),
  },

  // ------------------- POST /enroll/confirm -------------------
  {
    method: 'POST',
    path: 'enroll/confirm',
    auth: 'none',
    handler: protectedRoute(async (ctx) => {
      const body = await readForm(ctx);
      let form: Record<string, string | boolean>;
      try {
        form = requireFields(body, [
          { name: 'challenge_token', kind: 'secret', min: 20, max: 160 },
          { name: 'code', kind: 'secret', min: 1, max: 128 },
          { name: 'recovery', kind: 'bool', def: false },
        ]);
      } catch {
        return errorResponseMfa(422, 'Invalid authentication request.');
      }
      // Pre-load the challenge (non-attempting) to learn its type for the
      // response shape; confirmMfaEnrollment re-validates with an attempt.
      const { challenge } = await loadChallenge(String(form.challenge_token), new Set(['enroll', 'replace']));
      const { user, auth, codes } = await confirmMfaEnrollment(String(form.challenge_token), String(form.code));
      if (challenge.type === 'replace') {
        return buildResponse({ recovery_codes: codes });
      }
      const finished = await finishLogin(user, auth, challenge);
      return buildResponse({ ...finished.data, recovery_codes: codes }, 200, finished.cookies);
    }),
  },

  // ------------------- POST /verify -------------------
  {
    method: 'POST',
    path: 'verify',
    auth: 'none',
    handler: protectedRoute(async (ctx) => {
      const body = await readForm(ctx);
      let form: Record<string, string | boolean>;
      try {
        form = requireFields(body, [
          { name: 'challenge_token', kind: 'secret', min: 20, max: 160 },
          { name: 'code', kind: 'secret', min: 1, max: 128 },
          { name: 'recovery', kind: 'bool', def: false },
        ]);
      } catch {
        return errorResponseMfa(422, 'Invalid authentication request.');
      }
      const { user, auth, challenge } = await verifyMfaChallenge(
        String(form.challenge_token),
        String(form.code),
        Boolean(form.recovery)
      );
      const finished = await finishLogin(user, auth, challenge);
      return buildResponse(finished.data, 200, finished.cookies);
    }),
  },

  // ------------------- POST /replace -------------------
  {
    method: 'POST',
    path: 'replace',
    auth: 'user',
    handler: protectedRoute(async (ctx) => {
      const { user, claims } = requireHumanUser(ctx);
      const body = await readForm(ctx);
      let form: Record<string, string | boolean>;
      try {
        form = requireFields(body, [
          { name: 'code', kind: 'secret', min: 1, max: 128 },
          { name: 'recovery', kind: 'bool', def: false },
        ]);
      } catch {
        return errorResponseMfa(422, 'Invalid authentication request.');
      }
      const result = await manageMfa(user.id, claims, String(form.code), Boolean(form.recovery), { replace: true });
      return buildResponse(result);
    }),
  },

  // ------------------- POST /recovery/codes -------------------
  {
    method: 'POST',
    path: 'recovery/codes',
    auth: 'user',
    handler: protectedRoute(async (ctx) => {
      const { user, claims } = requireHumanUser(ctx);
      const body = await readForm(ctx);
      let form: Record<string, string | boolean>;
      try {
        form = requireFields(body, [
          { name: 'code', kind: 'secret', min: 1, max: 128 },
          { name: 'recovery', kind: 'bool', def: false },
        ]);
      } catch {
        return errorResponseMfa(422, 'Invalid authentication request.');
      }
      const result = await manageMfa(user.id, claims, String(form.code), Boolean(form.recovery), { replace: false });
      return buildResponse(result);
    }),
  },

  // ------------------- POST /recover -------------------
  {
    method: 'POST',
    path: 'recover',
    auth: 'none',
    handler: protectedRoute(async (ctx) => {
      const body = await readForm(ctx);
      let form: Record<string, string | boolean>;
      try {
        form = requireFields(body, [
          { name: 'challenge_token', kind: 'secret', min: 20, max: 160 },
          { name: 'reset_token', kind: 'secret', min: 20, max: 160 },
        ]);
      } catch {
        return errorResponseMfa(422, 'Invalid authentication request.');
      }
      const result = await redeemMfaResetToken(String(form.challenge_token), String(form.reset_token));
      return buildResponse(result);
    }),
  },
];

// re-exported for potential reuse by the auths router
export { Auths, jsonResponse };
