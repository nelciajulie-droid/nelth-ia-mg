import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { env, ERROR_MESSAGES, DEFAULT_USER_PERMISSIONS } from '@/lib/constants';

/**
 * Port of open_webui/utils/auth.py (JWT + password + request user resolution)
 * using HS256 tokens fully compatible with the Python implementation.
 */

const ALGORITHM = 'HS256' as const;
const PASSWORD_BCRYPT_MAX_BYTES = 72;

// ---------------------------------------------------------------------------
// Secret key resolution (env.py behaviour):
//   1. WEBUI_SECRET_KEY env var
//   2. .webui_secret_key file next to the DB (persistent across restarts locally)
//   3. generated (serverless / ephemeral FS — set WEBUI_SECRET_KEY in production!)
// ---------------------------------------------------------------------------

let cachedSecret: string | null = null;

export function getSecretKey(): string {
  if (cachedSecret) return cachedSecret;

  if (env.WEBUI_SECRET_KEY) {
    cachedSecret = env.WEBUI_SECRET_KEY;
    return cachedSecret;
  }

  const keyPath = path.join(process.env.DATA_DIR || './data', '.webui_secret_key');
  try {
    if (fs.existsSync(keyPath)) {
      cachedSecret = fs.readFileSync(keyPath, 'utf-8').trim();
      if (cachedSecret) return cachedSecret;
    }
    const dir = path.dirname(keyPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const generated = crypto.randomUUID().replace(/-/g, '');
    fs.writeFileSync(keyPath, generated, { mode: 0o600 });
    cachedSecret = generated;
    return cachedSecret;
  } catch {
    // Ephemeral filesystem (serverless): fall back to a per-instance secret.
    cachedSecret = process.env.WEBUI_SECRET_KEY || crypto.randomUUID().replace(/-/g, '');
    return cachedSecret;
  }
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export async function getPasswordHash(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  if (!hashed) return false;
  if (hashed.startsWith('$argon2')) {
    // argon2 hashes cannot be verified without the argon2 runtime; fail closed.
    return false;
  }
  const bytes = Buffer.from(plain, 'utf-8').slice(0, PASSWORD_BCRYPT_MAX_BYTES);
  try {
    return bcrypt.compareSync(bytes.toString('utf-8'), hashed);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tokens (claim shape mirrors Python create_token)
// ---------------------------------------------------------------------------

export function parseDuration(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === '-1' || s === 'none' || s === 'never') return null;
  const m = s.match(/^(\d+)\s*(s|m|h|d|w|y)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
  return n * mult[unit];
}

export function createToken(data: Record<string, unknown>, expiresDeltaSec?: number | null): string {
  const payload: Record<string, unknown> = { ...data };
  const now = Math.floor(Date.now() / 1000);
  if (expiresDeltaSec) {
    payload.exp = now + Math.floor(expiresDeltaSec);
  }
  payload.jti = crypto.randomUUID();
  payload.iat = now;
  return jwt.sign(payload, getSecretKey(), { algorithm: ALGORITHM });
}

export function decodeToken(token: string): Record<string, unknown> | null {
  try {
    return jwt.verify(token, getSecretKey(), { algorithms: [ALGORITHM] }) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request user resolution (get_current_user port)
// ---------------------------------------------------------------------------

export type ApiUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  profile_image_url: string;
  settings: unknown;
  info?: unknown;
  oauth_sub?: string | null;
};

function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const parts = header.split(' ');
  if (parts.length !== 2) return null;
  return parts[1];
}

async function userByApiKey(key: string): Promise<ApiUser | null> {
  if (!env.ENABLE_API_KEY) return null;
  const row = await db.apiKey.findFirst({ where: { key } });
  if (!row) return null;
  const user = await db.user.findFirst({ where: { id: row.user_id } });
  if (!user) return null;
  return rowToApiUser(user);
}

function rowToApiUser(u: {
  id: string;
  email: string | null;
  name: string;
  role: string | null;
  profile_image_url: string | null;
  settings: string | null;
  info: string | null;
  oauth: string | null;
}): ApiUser {
  return {
    id: u.id,
    email: u.email ?? '',
    name: u.name,
    role: u.role ?? 'pending',
    profile_image_url: u.profile_image_url ?? '/user.png',
    settings: safeJson(u.settings),
    info: safeJson(u.info),
    oauth_sub: (safeJson(u.oauth) as any)?.sub ?? null,
  };
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Extracts the raw token (Bearer header > cookie > x-api-key). */
export function tokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const cred = extractBearer(authHeader);
    if (cred) return cred;
  }
  const apiKeyHeader = req.headers.get('x-api-key');
  if (apiKeyHeader) return apiKeyHeader;
  const cookie = req.headers.get('cookie');
  if (cookie) {
    const m = cookie.match(/(?:^|;\s*)token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/** Port of is_valid_token (session_stamp check, typ allow-list, MFA gating). */
async function isValidToken(decoded: Record<string, unknown>): Promise<boolean> {
  const auth = await db.auth.findFirst({ where: { id: String(decoded.id ?? '') } });
  if (!auth) return false;
  // Python: if decoded.get('session_stamp') != auth.session_stamp: return False
  // (None == None passes; missing stamp on stamped auth is rejected.)
  const tokenStamp = decoded.session_stamp ?? null;
  const authStamp = auth.session_stamp ?? null;
  if (tokenStamp !== authStamp) return false;
  const typ = decoded.typ ?? 'session';
  if (!['session', 'automation', 'subagent'].includes(String(typ))) return false;
  if (typ === 'session') {
    const mfaEnabled = await db.config
      .findUnique({ where: { key: 'auth.mfa.enable' } })
      .then((r) => {
        if (!r) return false; // get_mfa_config() default: ENABLE_MFA = False
        try {
          return JSON.parse(r.value) === true;
        } catch {
          return false;
        }
      })
      .catch(() => false);
    if (mfaEnabled) {
      const mfaRequired = ['password', 'ldap'].includes(String(decoded.auth_method ?? ''));
      if (mfaRequired) {
        if (decoded.mfa_verified !== true) return false;
        const mfaData = auth.mfa ? (safeJson(auth.mfa) as Record<string, unknown> | null) : null;
        if (!mfaData || !mfaData.secret || mfaData.reset_required) return false;
      }
    }
  }
  return true;
}

/**
 * Resolve the current user from a request. Returns null when unauthenticated.
 * Mirrors get_current_user / get_current_user_by_api_key.
 */
export async function getCurrentUser(req: Request): Promise<ApiUser | null> {
  const token = tokenFromRequest(req);
  if (!token) return null;

  if (token.startsWith('sk-')) {
    return userByApiKey(token);
  }

  const decoded = decodeToken(token);
  if (!decoded || !decoded.id) return null;
  if (!(await isValidToken(decoded))) return null;

  const user = await db.user.findFirst({ where: { id: String(decoded.id) } });
  if (!user) return null;
  return rowToApiUser(user);
}

export async function getUserById(id: string): Promise<ApiUser | null> {
  const user = await db.user.findFirst({ where: { id } });
  return user ? rowToApiUser(user) : null;
}

export function createApiKey(): string {
  return `sk-${crypto.randomUUID().replace(/-/g, '')}`;
}

export { ERROR_MESSAGES, DEFAULT_USER_PERMISSIONS };
