import crypto from 'crypto';
import { db } from '@/lib/db';
import { configGet, configSet } from '@/lib/config';
import { env, DEFAULT_USER_PERMISSIONS } from '@/lib/constants';
import { createToken, parseDuration, getSecretKey } from '@/lib/auth';
import { getPermissions } from '@/lib/access-control';
import { Users, UserModel, validateImageUrl } from '@/lib/models/users';
import { HttpError } from '@/server/http';

/**
 * Port of open_webui/models/auths.py (AuthsTable) + open_webui/utils/mfa.py
 * + the create_signin_response / create_session_response helpers from
 * open_webui/utils/auth.py (placed here because lib/auth.ts is frozen and the
 * mfa router shares these primitives).
 */

// ---------------------------------------------------------------------------
// MFA data shapes (auth.mfa JSON column)
// ---------------------------------------------------------------------------

export type MfaLimit = { count: number; expires_at: number };

export type MfaResetTicket = { token_hash: string; expires_at: number };

export type MfaChallenge = {
  token_hash: string;
  type: 'enroll' | 'verify' | 'replace' | 'recover';
  expires_at: number;
  attempts: number;
  auth_method: 'password' | 'ldap' | 'oauth' | 'trusted_header' | 'system' | 'api';
  auth_time: number;
  session_stamp?: string | null;
  secret?: string | null;
  oauth_session_id?: string | null;
  provider?: string | null;
};

export type MfaData = {
  revision: string;
  secret?: string | null;
  last_step: number;
  recovery_hashes: string[];
  login_challenge?: MfaChallenge | null;
  manage_challenge?: MfaChallenge | null;
  reset_required: boolean;
  reset_ticket?: MfaResetTicket | null;
  limits: Record<string, MfaLimit>;
};

export type AuthModel = {
  id: string;
  email: string;
  password: string;
  active: boolean;
  mfa: MfaData | null;
  session_stamp: string | null;
};

export type SigninResultData = Record<string, unknown>;

const nowSec = () => Math.floor(Date.now() / 1000);

const CHALLENGE_SECONDS = 300;
const LIMIT_SECONDS = 900;

function defaultMfaData(): MfaData {
  return {
    revision: crypto.randomUUID(),
    secret: null,
    last_step: -1,
    recovery_hashes: [],
    login_challenge: null,
    manage_challenge: null,
    reset_required: false,
    reset_ticket: null,
    limits: {},
  };
}

function parseMfa(value: string | null | undefined): MfaData | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value);
    if (!raw || typeof raw !== 'object') return null;
    return { ...defaultMfaData(), ...raw } as MfaData;
  } catch {
    return null;
  }
}

type AuthRow = {
  id: string;
  email: string | null;
  password: string | null;
  active: boolean | null;
  mfa: string | null;
  session_stamp: string | null;
};

function toAuthModel(row: AuthRow): AuthModel {
  return {
    id: row.id,
    email: row.email ?? '',
    password: row.password ?? '',
    active: row.active ?? true,
    mfa: parseMfa(row.mfa),
    session_stamp: row.session_stamp ?? null,
  };
}

// ---------------------------------------------------------------------------
// MFA crypto (Fernet-equivalent: HKDF(WEBUI_SECRET_KEY) → AES-256-GCM)
// ---------------------------------------------------------------------------

function mfaKey(): Buffer {
  const secret = getSecretKey();
  const derived = crypto.hkdfSync('sha256', Buffer.from(secret, 'utf-8'), Buffer.alloc(0), Buffer.from('open-webui/mfa-encryption/v1', 'utf-8'), 32);
  return Buffer.from(derived);
}

function encryptSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', mfaKey(), iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
}

function decryptSecret(secret: string): string {
  try {
    const parts = secret.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('bad format');
    const iv = Buffer.from(parts[1], 'base64url');
    const ct = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', mfaKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
  } catch {
    throw new HttpError(503, 'Authenticator configuration is unavailable. Contact the operator.');
  }
}

export function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf-8').digest('hex');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// TOTP (otplib — pyotp equivalent)
// ---------------------------------------------------------------------------

let hotpGenerate: ((opts: { secret: string; counter: number }) => string) | null = null;
async function totpAt(secret: string, step: number): Promise<string> {
  if (!hotpGenerate) {
    // lazy import keeps module load cheap and avoids bundler surprises
    const mod = (await import('otplib')) as unknown as {
      generateSync: (opts: { secret: string | Uint8Array; strategy?: string; counter?: number }) => string;
    };
    hotpGenerate = (opts) => mod.generateSync({ secret: opts.secret, strategy: 'hotp', counter: opts.counter });
  }
  return hotpGenerate({ secret, counter: step });
}

function randomBase32(length = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes)
    .map((b) => chars[b % 32])
    .join('');
}

async function provisioningUri(secret: string, email: string): Promise<string> {
  const mod = (await import('otplib')) as unknown as {
    generateURI: (opts: { issuer: string; label: string; secret: string }) => string;
  };
  return mod.generateURI({ issuer: 'Nelth-AI', label: email, secret });
}

/** Python: matching_step — returns the matched step, or null. */
export async function matchingStep(secret: string, code: string, lastStep = -1): Promise<number | null> {
  if (code.length !== 6 || !/^[0-9]+$/.test(code)) return null;
  const current = Math.floor(nowSec() / 30);
  for (const step of [current, current - 1, current + 1]) {
    if (step > lastStep) {
      const expected = await totpAt(secret, step);
      if (timingSafeEqualStr(expected, code)) return step;
    }
  }
  return null;
}

/** Python: recovery_codes → (codes, hashes). */
export function recoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(16).toString('hex'));
  return { codes, hashes: codes.map((c) => tokenHash(c)) };
}

// ---------------------------------------------------------------------------
// MFA configuration
// ---------------------------------------------------------------------------

export const MFA_CONFIG_KEYS: Record<string, string> = {
  ENABLE_MFA: 'auth.mfa.enable',
  MFA_ALLOW_OAUTH_BYPASS: 'auth.mfa.allow_oauth_bypass',
  MFA_ALLOW_TRUSTED_HEADER_BYPASS: 'auth.mfa.allow_trusted_header_bypass',
};

export type MfaConfig = {
  ENABLE_MFA: boolean;
  MFA_ALLOW_OAUTH_BYPASS: boolean;
  MFA_ALLOW_TRUSTED_HEADER_BYPASS: boolean;
};

export async function getMfaConfig(): Promise<MfaConfig> {
  const [enableMfa, oauthBypass, trustedHeaderBypass] = await Promise.all([
    configGet<boolean>('auth.mfa.enable', env.ENABLE_MFA),
    configGet<boolean>('auth.mfa.allow_oauth_bypass', false),
    configGet<boolean>('auth.mfa.allow_trusted_header_bypass', false),
  ]);
  return {
    ENABLE_MFA: enableMfa === true,
    MFA_ALLOW_OAUTH_BYPASS: oauthBypass === true,
    MFA_ALLOW_TRUSTED_HEADER_BYPASS: trustedHeaderBypass === true,
  };
}

export function isMfaRequired(authMethod: string, config: MfaConfig): boolean {
  if (!config.ENABLE_MFA) return false;
  if (authMethod === 'oauth' && config.MFA_ALLOW_OAUTH_BYPASS) return false;
  return !(authMethod === 'trusted_header' && config.MFA_ALLOW_TRUSTED_HEADER_BYPASS);
}

// ---------------------------------------------------------------------------
// Challenge helpers
// ---------------------------------------------------------------------------

function newChallenge(
  auth: AuthModel,
  kind: 'enroll' | 'verify' | 'replace' | 'recover',
  authMethod: string,
  authTime: number,
  context: { oauth_session_id?: string | null; provider?: string | null } = {}
): { token: string; challenge: MfaChallenge } {
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

function challengeResponse(token: string, challenge: MfaChallenge): SigninResultData {
  return {
    next_step: challenge.type === 'replace' ? 'enroll' : challenge.type,
    challenge_token: token,
    expires_in: Math.max(0, challenge.expires_at - nowSec()),
  };
}

// ---------------------------------------------------------------------------
// AuthsTable port
// ---------------------------------------------------------------------------

/** Pre-computed hash burned on failed lookups so response timing cannot
 * reveal whether an account exists (CWE-208). */
const PLACEHOLDER_HASH = '$2b$10$xhgrR5bePrhjGSpM/t5xUe8f.Lm47QRMaCZPzFRLQhBqzvv42HUz2';

export const Auths = {
  async getAuthById(userId: string): Promise<AuthModel | null> {
    const row = await db.auth.findFirst({ where: { id: userId } });
    return row ? toAuthModel(row) : null;
  },

  clearMfaChallenges(value: MfaData | null): MfaData | null {
    if (value === null) return null;
    return {
      ...value,
      login_challenge: null,
      manage_challenge: null,
      reset_ticket: null,
      revision: crypto.randomUUID(),
    };
  },

  /** Compare-and-swap the complete credential state (mfa + session_stamp). */
  async updateMfaById(auth: AuthModel, mfa: MfaData, opts: { revoke?: boolean } = {}): Promise<AuthModel | null> {
    const revoke = opts.revoke ?? false;
    const next: MfaData = { ...structuredClone(mfa), revision: crypto.randomUUID() };
    const stamp = revoke ? crypto.randomUUID() : auth.session_stamp;
    const row = await db.auth.findFirst({ where: { id: auth.id } });
    if (!row) return null;
    const current = toAuthModel(row);
    if (current.active !== true) return null;
    if (current.password !== auth.password) return null;
    if ((current.session_stamp ?? null) !== (auth.session_stamp ?? null)) return null;
    const currentRevision = current.mfa?.revision ?? null;
    const expectedRevision = auth.mfa?.revision ?? null;
    if (currentRevision !== expectedRevision) return null;
    const updated = await db.auth
      .update({
        where: { id: auth.id },
        data: { mfa: JSON.stringify(next), session_stamp: stamp },
      })
      .catch(() => null);
    if (!updated) return null;
    return { ...auth, mfa: next, session_stamp: stamp };
  },

  async revokeSessionsByUserId(userId: string): Promise<boolean> {
    const row = await db.auth.findFirst({ where: { id: userId } });
    if (!row) return false;
    const auth = toAuthModel(row);
    const cleared = this.clearMfaChallenges(auth.mfa);
    const updated = await db.auth
      .update({
        where: { id: userId },
        data: {
          session_stamp: crypto.randomUUID(),
          mfa: cleared ? JSON.stringify(cleared) : null,
        },
      })
      .catch(() => null);
    if (!updated) {
      throw new Error('Authentication changed in another request. Please try again.');
    }
    return true;
  },

  async revokeAllSessions(): Promise<string[]> {
    const rows = await db.auth.findMany({ select: { id: true } });
    const userIds = rows.map((r) => r.id);
    for (const userId of userIds) {
      try {
        await this.revokeSessionsByUserId(userId);
      } catch {
        // retry semantics collapse to a single pass here
      }
    }
    return userIds;
  },

  async insertNewAuth(
    email: string,
    password: string,
    name: string,
    profileImageUrl = '/user.png',
    role = 'pending',
    oauth: Record<string, any> | null = null,
    userId?: string
  ): Promise<UserModel | null> {
    // Firebase-bridged accounts pass their Firebase UID so the account keeps
    // its provider identity end-to-end (data keyed by the same ID).
    const newId = userId ?? crypto.randomUUID();
    try {
      await db.auth.create({
        data: {
          id: newId,
          email,
          password,
          active: true,
          session_stamp: crypto.randomUUID(),
        },
      });
      const createdUser = await Users.insertNewUser(newId, name, email, profileImageUrl, role, null, oauth);
      if (!createdUser) {
        await db.auth.delete({ where: { id: newId } }).catch(() => undefined);
        return null;
      }
      return createdUser;
    } catch {
      return null;
    }
  },

  /** Python: authenticate_user — verifies email + password, timing-safe. */
  async authenticateUser(
    email: string,
    verify: (hashedPassword: string) => Promise<boolean>
  ): Promise<{ user: UserModel; auth: AuthModel } | null> {
    const resolved = await Users.getUserByEmail(email);
    if (!resolved) {
      await verify(PLACEHOLDER_HASH);
      return null;
    }
    const row = await db.auth.findFirst({ where: { id: resolved.id } });
    if (!row || !(row.active ?? true)) {
      await verify(PLACEHOLDER_HASH);
      return null;
    }
    if (!(await verify(row.password ?? ''))) return null;
    return { user: resolved, auth: toAuthModel(row) };
  },

  async authenticateUserByApiKey(apiKey: string): Promise<UserModel | null> {
    if (!apiKey) return null;
    return Users.getUserByApiKey(apiKey);
  },

  /** Python: authenticate_user_by_email — auth JOIN user, active only. */
  async authenticateUserByEmail(email: string): Promise<UserModel | null> {
    const row = await db.auth.findFirst({ where: { email } });
    if (!row || !(row.active ?? true)) return null;
    return Users.getUserById(row.id);
  },

  async updateEmailById(userId: string, email: string): Promise<boolean> {
    const row = await db.auth.findFirst({ where: { id: userId } });
    if (!row) return false;
    await db.auth.update({ where: { id: userId }, data: { email } }).catch(() => undefined);
    await Users.updateUserById(userId, { email });
    return true;
  },

  /**
   * Python: update_user_password_by_id — sets a new hash, clears challenges
   * and rotates the session stamp (revokes other sessions).
   */
  async updateUserPasswordById(
    userId: string,
    newPassword: string,
    currentAuth: AuthModel | null = null
  ): Promise<boolean> {
    const auth = currentAuth ?? (await this.getAuthById(userId));
    if (!auth) return false;
    const state: MfaData = auth.mfa ? structuredClone(auth.mfa) : defaultMfaData();
    state.login_challenge = null;
    state.manage_challenge = null;
    state.reset_ticket = null;
    const updated = await this.updateMfaById(auth, state, { revoke: true });
    if (updated === null) {
      throw new Error('Authentication changed in another request. Please try again.');
    }
    await db.auth.update({ where: { id: userId }, data: { password: newPassword } });
    return true;
  },

  async deleteAuthById(id: string): Promise<boolean> {
    if (!(await Users.deleteUserById(id))) return false;
    await db.auth.delete({ where: { id } }).catch(() => undefined);
    return true;
  },
};

// ---------------------------------------------------------------------------
// utils/mfa.py essentials (shared by the signin challenge flow and the
// /api/v1/auths/mfa router)
// ---------------------------------------------------------------------------

/** Python: get_auth — 503 on storage failure, 401 on missing/inactive. */
export async function getAuthOrThrow(userId: string): Promise<AuthModel> {
  let auth: AuthModel | null = null;
  try {
    auth = await Auths.getAuthById(userId);
  } catch {
    throw new HttpError(503, 'Authentication is temporarily unavailable.');
  }
  if (auth === null || !auth.active) {
    throw new HttpError(401, 'Invalid authentication request.');
  }
  return auth;
}

/** Python: save_mfa — CAS write with 409 retry signal. */
export async function saveMfa(auth: AuthModel, mfa: MfaData, opts: { revoke?: boolean } = {}): Promise<AuthModel> {
  const updated = await Auths.updateMfaById(auth, mfa, opts);
  if (updated === null) {
    throw new HttpError(409, 'Authentication changed in another request. Please start again.');
  }
  return updated;
}

/** Python: limit_account — per-account throttle stored on the credential row. */
export async function limitAccount(userId: string, kind: string): Promise<AuthModel> {
  for (let i = 0; i < 5; i++) {
    const auth = await getAuthOrThrow(userId);
    const mfa: MfaData = auth.mfa ? structuredClone(auth.mfa) : defaultMfaData();
    const now = nowSec();
    let limit = mfa.limits[kind];
    if (!limit || limit.expires_at <= now) {
      limit = { count: 0, expires_at: now + LIMIT_SECONDS };
    }
    if (limit.count >= 10) {
      throw new HttpError(429, 'Too many attempts. Please try again later.');
    }
    limit.count += 1;
    mfa.limits[kind] = limit;
    try {
      return await saveMfa(auth, mfa);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) continue;
      throw e;
    }
  }
  throw new HttpError(409, 'Authentication is busy. Please try again.');
}

/** Python: start_mfa_login — issues a login challenge and stores it. */
export async function startMfaLogin(
  auth: AuthModel,
  authMethod: string,
  context: { oauth_session_id?: string | null; provider?: string | null } = {}
): Promise<SigninResultData> {
  const mfa: MfaData = auth.mfa ? structuredClone(auth.mfa) : defaultMfaData();
  const kind: MfaChallenge['type'] = mfa.reset_required
    ? 'recover'
    : mfa.secret
      ? 'verify'
      : 'enroll';
  const { token, challenge } = newChallenge(auth, kind, authMethod, nowSec(), context);
  mfa.login_challenge = challenge;
  await saveMfa(auth, mfa);
  return challengeResponse(token, challenge);
}

export type LoadedChallenge = {
  user: UserModel;
  auth: AuthModel;
  mfa: MfaData;
  challenge: MfaChallenge;
  slot: 'login_challenge' | 'manage_challenge';
};

/** Python: load_challenge — validates and (optionally) consumes an attempt. */
export async function loadChallenge(token: string, kinds: Set<string>, opts: { attempt?: boolean } = {}): Promise<LoadedChallenge> {
  const attempt = opts.attempt ?? false;
  const separatorIndex = token.indexOf('.');
  const userId = separatorIndex >= 0 ? token.slice(0, separatorIndex) : '';
  if (!separatorIndex || userId.length > 64) {
    throw new HttpError(401, 'This authentication step expired. Please start again.');
  }
  let auth = await getAuthOrThrow(userId);
  for (let i = 0; i < 5; i++) {
    const mfa: MfaData = auth.mfa ? structuredClone(auth.mfa) : defaultMfaData();
    let slot: 'login_challenge' | 'manage_challenge' =
      kinds.size === 1 && kinds.has('replace') ? 'manage_challenge' : 'login_challenge';
    if (kinds.has('replace') && mfa.manage_challenge && timingSafeEqualStr(mfa.manage_challenge.token_hash, tokenHash(token))) {
      slot = 'manage_challenge';
    }
    const challenge = mfa[slot];
    if (
      !challenge ||
      !kinds.has(challenge.type) ||
      challenge.expires_at <= nowSec() ||
      (challenge.session_stamp ?? null) !== (auth.session_stamp ?? null) ||
      !timingSafeEqualStr(challenge.token_hash, tokenHash(token))
    ) {
      throw new HttpError(401, 'This authentication step expired. Please start again.');
    }
    const user = await Users.getUserById(userId);
    if (!user || !['admin', 'user'].includes(user.role)) {
      throw new HttpError(403, 'Account is awaiting approval.');
    }
    if (!(await getMfaConfig()).ENABLE_MFA) {
      throw new HttpError(403, 'MFA is disabled. Please sign in again.');
    }
    if (!attempt) {
      return { user, auth, mfa, challenge, slot };
    }
    if (challenge.attempts >= 5) {
      throw new HttpError(429, 'Too many codes. Please sign in again.');
    }
    let limit = mfa.limits['factor'];
    const now = nowSec();
    if (!limit || limit.expires_at <= now) {
      limit = { count: 0, expires_at: now + LIMIT_SECONDS };
    }
    if (limit.count >= 10) {
      throw new HttpError(429, 'Too many attempts. Please try again later.');
    }
    limit.count += 1;
    mfa.limits['factor'] = limit;
    challenge.attempts += 1;
    try {
      const updated = await saveMfa(auth, mfa);
      return { user, auth: updated, mfa: structuredClone(updated.mfa ?? defaultMfaData()), challenge, slot };
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        auth = await getAuthOrThrow(userId);
        continue;
      }
      throw e;
    }
  }
  throw new HttpError(409, 'Authentication is busy. Please try again.');
}

/** Python: consume_factor — TOTP or recovery code, in place on the mfa state. */
export async function consumeFactor(mfa: MfaData, code: string, recovery: boolean): Promise<void> {
  if (recovery) {
    const digest = tokenHash(code.trim().toLowerCase());
    const idx = mfa.recovery_hashes.indexOf(digest);
    if (idx >= 0) {
      mfa.recovery_hashes.splice(idx, 1);
      return;
    }
  } else if (mfa.secret) {
    const step = await matchingStep(decryptSecret(mfa.secret), code.trim(), mfa.last_step);
    if (step !== null) {
      mfa.last_step = step;
      return;
    }
  }
  throw new HttpError(401, 'Invalid or already used code.');
}

/** Python: verify_mfa_challenge — returns the user + refreshed auth. */
export async function verifyMfaChallenge(
  token: string,
  code: string,
  recovery: boolean
): Promise<{ user: UserModel; auth: AuthModel; challenge: MfaChallenge }> {
  const { user, auth, mfa, challenge } = await loadChallenge(token, new Set(['verify']), { attempt: true });
  await consumeFactor(mfa, code, recovery);
  mfa.login_challenge = null;
  const updated = await saveMfa(auth, mfa);
  return { user, auth: updated, challenge };
}

/** Python: setup_details — manual key + QR code data-uri. */
export async function setupDetails(secret: string, email: string): Promise<{ manual_key: string; qr_code: string }> {
  const uri = await provisioningUri(secret, email);
  const QRCode = (await import('qrcode')).default;
  const qrCode = await QRCode.toDataURL(uri);
  return { manual_key: secret, qr_code: qrCode };
}

/** Python: start_mfa_enrollment — ensures a challenge secret exists. */
export async function startMfaEnrollment(token: string): Promise<{ manual_key: string; qr_code: string }> {
  const { user, auth, mfa, challenge, slot } = await loadChallenge(token, new Set(['enroll', 'replace']));
  let secret: string;
  if (challenge.secret) {
    secret = decryptSecret(challenge.secret);
  } else {
    secret = randomBase32(32);
    challenge.secret = encryptSecret(secret);
    mfa[slot] = challenge;
    await saveMfa(auth, mfa);
  }
  return setupDetails(secret, user.email);
}

/** Python: confirm_mfa_enrollment — finishes enrollment, returns recovery codes. */
export async function confirmMfaEnrollment(
  token: string,
  code: string
): Promise<{ user: UserModel; auth: AuthModel; codes: string[] }> {
  const { user, auth, mfa, challenge } = await loadChallenge(token, new Set(['enroll', 'replace']), { attempt: true });
  const step = challenge.secret ? await matchingStep(decryptSecret(challenge.secret), code.trim()) : null;
  if (step === null) {
    throw new HttpError(401, 'Invalid code. Check your authenticator and try again.');
  }
  const { codes, hashes } = recoveryCodes();
  mfa.secret = challenge.secret;
  mfa.last_step = step;
  mfa.recovery_hashes = hashes;
  mfa.login_challenge = null;
  mfa.manage_challenge = null;
  mfa.reset_ticket = null;
  mfa.reset_required = false;
  const updated = await saveMfa(auth, mfa, { revoke: true });
  return { user, auth: updated, codes };
}

/** Python: manage_mfa — replace-secret challenge or recovery-code regen. */
export async function manageMfa(
  userId: string,
  claims: Record<string, unknown>,
  code: string,
  recovery: boolean,
  opts: { replace: boolean }
): Promise<SigninResultData> {
  if (nowSec() - Number(claims.auth_time ?? 0) > CHALLENGE_SECONDS) {
    throw new HttpError(403, 'reauthentication_required');
  }
  if (!(await getMfaConfig()).ENABLE_MFA) {
    throw new HttpError(403, 'MFA is disabled.');
  }
  const auth = await limitAccount(userId, 'factor');
  const mfa: MfaData = auth.mfa ? structuredClone(auth.mfa) : defaultMfaData();
  await consumeFactor(mfa, code, recovery);
  if (opts.replace) {
    const { token, challenge } = newChallenge(auth, 'replace', String(claims.auth_method ?? 'api'), Number(claims.auth_time ?? 0));
    mfa.manage_challenge = challenge;
    await saveMfa(auth, mfa);
    return challengeResponse(token, challenge);
  }
  const { codes, hashes } = recoveryCodes();
  mfa.recovery_hashes = hashes;
  mfa.login_challenge = null;
  mfa.manage_challenge = null;
  mfa.reset_ticket = null;
  await saveMfa(auth, mfa, { revoke: true });
  return { recovery_codes: codes };
}

/** Python: reset_mfa (operator recovery). Returns the reset ticket token. */
export async function resetMfa(email: string, reason: string): Promise<string> {
  const user = await Users.getUserByEmail(email.trim().toLowerCase());
  if (!user) throw new Error('User not found.');
  if (!reason.trim()) throw new Error('A nonempty reason is required.');
  const auth = await getAuthOrThrow(user.id);
  const mfa: MfaData = auth.mfa ? structuredClone(auth.mfa) : defaultMfaData();
  const ticket = crypto.randomBytes(32).toString('base64url');
  mfa.secret = null;
  mfa.last_step = -1;
  mfa.recovery_hashes = [];
  mfa.login_challenge = null;
  mfa.manage_challenge = null;
  mfa.reset_required = true;
  mfa.reset_ticket = { token_hash: tokenHash(ticket), expires_at: nowSec() + 1800 };
  await saveMfa(auth, mfa, { revoke: true });
  return ticket;
}

// ---------------------------------------------------------------------------
// create_signin_response / create_session_response (utils/auth.py port)
// ---------------------------------------------------------------------------

export const WEBUI_AUTH_COOKIE_SAME_SITE = process.env.WEBUI_AUTH_COOKIE_SAME_SITE || 'lax';
export const WEBUI_AUTH_COOKIE_SECURE = (process.env.WEBUI_AUTH_COOKIE_SECURE || 'false').toLowerCase() === 'true';

export type SessionResponse = { data: Record<string, unknown>; cookies: string[] };

/** Python: create_session_response. */
export async function createSessionResponse(
  user: UserModel,
  opts: {
    setCookie?: boolean;
    source?: string;
    auth: AuthModel;
    mfaVerified?: boolean;
    authTime?: number | null;
    /** Explicit session lifetime override (seconds; null = never). Guest
     *  sessions use this to stay bounded regardless of auth.jwt_expiry. */
    expiresDeltaSec?: number | null;
  }
): Promise<SessionResponse> {
  const source = opts.source ?? 'password';
  const mfaVerified = opts.mfaVerified ?? false;
  const current = await getAuthOrThrow(user.id);
  if ((current.session_stamp ?? null) !== (opts.auth.session_stamp ?? null)) {
    throw new HttpError(409, 'Authentication changed. Please sign in again.');
  }
  if (isMfaRequired(source, await getMfaConfig()) && !mfaVerified) {
    throw new HttpError(401, 'Authenticator verification is required.');
  }
  const expiresDeltaSec =
    opts.expiresDeltaSec !== undefined && opts.expiresDeltaSec !== null
      ? opts.expiresDeltaSec
      : parseDuration(await configGet<string>('auth.jwt_expiry', '-1'));
  const now = nowSec();
  const expiresAt = expiresDeltaSec ? now + Math.floor(expiresDeltaSec) : null;
  const token = createToken(
    {
      id: user.id,
      typ: 'session',
      auth_method: source,
      auth_time: opts.authTime ?? now,
      session_stamp: opts.auth.session_stamp,
      mfa_verified: mfaVerified,
    },
    expiresDeltaSec
  );
  const cookies: string[] = [];
  if (opts.setCookie) {
    let cookie = `token=${token}; Path=/; HttpOnly; SameSite=${WEBUI_AUTH_COOKIE_SAME_SITE}`;
    if (WEBUI_AUTH_COOKIE_SECURE) cookie += '; Secure';
    if (expiresDeltaSec) cookie += `; Max-Age=${Math.floor(expiresDeltaSec)}`;
    cookies.push(cookie);
  }
  return {
    data: {
      token,
      token_type: 'Bearer',
      expires_at: expiresAt,
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      profile_image_url: `/api/v1/users/${user.id}/profile/image`,
      permissions: await getPermissions(
        user.id,
        await configGet<Record<string, any> | null>('user.permissions', DEFAULT_USER_PERMISSIONS as unknown as Record<string, any>)
      ),
    },
    cookies,
  };
}

/** Python: create_signin_response — MFA gate before issuing a session. */
export async function createSigninResponse(
  user: UserModel,
  opts: { setCookie?: boolean; source?: string; auth?: AuthModel | null } = {}
): Promise<SessionResponse> {
  const current = await getAuthOrThrow(user.id);
  const auth = opts.auth ?? current;
  if ((current.session_stamp ?? null) !== (auth.session_stamp ?? null) || current.password !== auth.password) {
    throw new HttpError(409, 'Authentication changed. Please sign in again.');
  }
  const config = await getMfaConfig();
  if (config.ENABLE_MFA && !['admin', 'user'].includes(user.role)) {
    return { data: { next_step: 'pending' }, cookies: [] };
  }
  if (isMfaRequired(opts.source ?? 'password', config)) {
    const data = await startMfaLogin(current, opts.source ?? 'password');
    return { data, cookies: [] };
  }
  return createSessionResponse(user, { setCookie: opts.setCookie, source: opts.source, auth: current });
}

/** Python: update_mfa_config — applies MFA policy, revoking sessions on change. */
export async function updateMfaConfig(
  isHumanAdminSession: boolean,
  updates: Record<string, unknown>
): Promise<boolean> {
  const relevant: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(MFA_CONFIG_KEYS)) {
    if (key in updates) relevant[key] = updates[key];
  }
  if (!Object.keys(relevant).length) {
    for (const [key, value] of Object.entries(updates)) await configSet(key, value);
    return false;
  }
  if (!isHumanAdminSession) {
    throw new HttpError(403, 'A human administrator session is required to change MFA settings.');
  }
  const keys = Object.values(MFA_CONFIG_KEYS);
  const rows = await db.config.findMany({ where: { key: { in: keys } } });
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      stored[row.key] = row.value;
    }
  }
  const current: MfaConfig = {
    ENABLE_MFA: stored['auth.mfa.enable'] === true,
    MFA_ALLOW_OAUTH_BYPASS: stored['auth.mfa.allow_oauth_bypass'] === true,
    MFA_ALLOW_TRUSTED_HEADER_BYPASS: stored['auth.mfa.allow_trusted_header_bypass'] === true,
  };
  const desired: MfaConfig = {
    ENABLE_MFA: 'auth.mfa.enable' in relevant ? relevant['auth.mfa.enable'] === true : current.ENABLE_MFA,
    MFA_ALLOW_OAUTH_BYPASS:
      'auth.mfa.allow_oauth_bypass' in relevant
        ? relevant['auth.mfa.allow_oauth_bypass'] === true
        : current.MFA_ALLOW_OAUTH_BYPASS,
    MFA_ALLOW_TRUSTED_HEADER_BYPASS:
      'auth.mfa.allow_trusted_header_bypass' in relevant
        ? relevant['auth.mfa.allow_trusted_header_bypass'] === true
        : current.MFA_ALLOW_TRUSTED_HEADER_BYPASS,
  };
  const changed =
    desired.ENABLE_MFA !== current.ENABLE_MFA ||
    desired.MFA_ALLOW_OAUTH_BYPASS !== current.MFA_ALLOW_OAUTH_BYPASS ||
    desired.MFA_ALLOW_TRUSTED_HEADER_BYPASS !== current.MFA_ALLOW_TRUSTED_HEADER_BYPASS;
  for (const [key, value] of Object.entries(updates)) await configSet(key, value);
  if (changed) await Auths.revokeAllSessions();
  return changed;
}

// re-exported for routers
export { validateImageUrl };
