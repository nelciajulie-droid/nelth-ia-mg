/**
 * Firebase Authentication bridge (REST, zero SDK dependency).
 *
 * The Nelth-AI TypeScript port keeps the Open WebUI session model (local JWT
 * + auth table) but delegates credential verification to Firebase Auth when
 * FIREBASE_API_KEY is configured. Every Firebase-backed account is linked to
 * its Firebase UID (stored in user.oauth.firebase.uid) so each account keeps
 * its own stable identity, and its data (chats, files, memories…) is keyed by
 * that ID in the database (SQLite locally / Supabase Postgres in production).
 *
 * Endpoints used (Identity Toolkit REST API, Email/Password provider):
 *   POST /v1/accounts:signInWithPassword  — verify credentials, returns uid
 *   POST /v1/accounts:signUp              — provision a new account
 *
 * Errors are normalised to a small discriminated union so routers can fall
 * back to local password auth when Firebase does not know the account
 * (EMAIL_NOT_FOUND-style) or when the service is unreachable.
 */

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY ?? '';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'ethan-nairah';
const IDENTITY_ENDPOINT = 'https://identitytoolkit.googleapis.com/v1';

/** Bridge enabled only when an API key is present in the environment. */
export const FIREBASE_AUTH_ENABLED = FIREBASE_API_KEY.length > 0;

export interface FirebaseAccount {
  uid: string;
  email: string;
  displayName: string | null;
  idToken: string;
  refreshToken: string;
  expiresIn: string;
}

export type FirebaseAuthFailure =
  | { kind: 'invalid_credentials' } // wrong email/password → try local auth
  | { kind: 'email_exists' }
  | { kind: 'email_not_found' }
  | { kind: 'weak_password' }
  | { kind: 'network' }
  | { kind: 'unknown'; message: string };

const TIMEOUT_MS = 8000;

function classify(message: string): FirebaseAuthFailure {
  const m = message.toUpperCase();
  if (m.includes('INVALID_LOGIN_CREDENTIALS') || m.includes('INVALID_PASSWORD') || m.includes('WRONG_PASSWORD')) {
    return { kind: 'invalid_credentials' };
  }
  if (m.includes('EMAIL_EXISTS')) return { kind: 'email_exists' };
  if (m.includes('EMAIL_NOT_FOUND')) return { kind: 'email_not_found' };
  if (m.includes('WEAK_PASSWORD')) return { kind: 'weak_password' };
  return { kind: 'unknown', message };
}

async function identityRequest(
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: true; data: any } | { ok: false; failure: FirebaseAuthFailure }> {
  try {
    const res = await fetch(`${IDENTITY_ENDPOINT}/${path}?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message: string = data?.error?.message ?? `HTTP ${res.status}`;
      return { ok: false, failure: classify(message) };
    }
    return { ok: true, data };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const network = /timeout|fetch|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(reason);
    return { ok: false, failure: network ? { kind: 'network' } : { kind: 'unknown', message: reason } };
  }
}

/** Verify email + password against Firebase Auth. */
export async function firebaseSignInWithPassword(
  email: string,
  password: string
): Promise<{ ok: true; account: FirebaseAccount } | { ok: false; failure: FirebaseAuthFailure }> {
  if (!FIREBASE_AUTH_ENABLED) return { ok: false, failure: { kind: 'unknown', message: 'FIREBASE_API_KEY not set' } };
  const result = await identityRequest('accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  });
  if (!result.ok) return { ok: false, failure: result.failure };
  const d = result.data;
  return {
    ok: true,
    account: {
      uid: String(d.localId ?? ''),
      email: String(d.email ?? email),
      displayName: d.displayName ? String(d.displayName) : null,
      idToken: String(d.idToken ?? ''),
      refreshToken: String(d.refreshToken ?? ''),
      expiresIn: String(d.expiresIn ?? '3600'),
    },
  };
}

/** Sign in to Firebase with a Google OAuth access token (accounts:signInWithIdp).
 *
 * Used by the Google OAuth flow so Google accounts are minted in Firebase too
 * and keep the same identity lifecycle as email/password accounts: the Firebase
 * UID becomes the account ID (user.id) and the data is keyed by that ID.
 *
 * Best-effort bridge: returns null when the Google provider is disabled in the
 * Firebase console or the token is rejected — callers fall back to the
 * provider's own subject claim.
 */
export async function firebaseSignInWithIdpGoogle(
  accessToken: string
): Promise<{ uid: string; email: string; displayName: string | null } | null> {
  if (!FIREBASE_AUTH_ENABLED) return null;
  const result = await identityRequest('accounts:signInWithIdp', {
    postBody: `providerId=google.com&access_token=${encodeURIComponent(accessToken)}&returnSecureToken=true`,
    requestUri: 'http://localhost',
    returnSecureToken: true,
  });
  if (!result.ok) return null;
  const uid = String(result.data?.localId ?? '');
  if (!uid) return null;
  return {
    uid,
    email: String(result.data?.email ?? ''),
    displayName: result.data?.displayName ? String(result.data.displayName) : null,
  };
}

/** Verified Google identity decoded from a Firebase ID token (accounts:lookup).
 *
 * The Google popup bridge (signInWithPopup → idToken) ends here: Google itself
 * signed the token, so a successful lookup is cryptographic proof of the
 * identity — including the Google subject (providerUserInfo rawId) and the
 * Firebase UID (localId), the exact pair the OAuth code flow stores.
 */
export async function firebaseLookupGoogleIdentity(
  idToken: string
): Promise<{
  uid: string;
  googleSub: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
} | null> {
  if (!FIREBASE_AUTH_ENABLED) return null;
  if (!idToken || idToken.length > 4096 || idToken.split('.').length !== 3) return null;
  const result = await identityRequest('accounts:lookup', { idToken });
  if (!result.ok) return null;
  const user = result.data?.users?.[0];
  if (!user || !user.localId) return null;

  const providers: Array<{ providerId?: string; rawId?: string }> = Array.isArray(
    user.providerUserInfo
  )
    ? user.providerUserInfo
    : [];
  const google = providers.find((p) => p.providerId === 'google.com');
  if (!google || !google.rawId) return null; // only Google sign-ins on this bridge

  const email = String(user.email ?? '');
  if (!email) return null; // Google accounts always carry a verified email
  return {
    uid: String(user.localId),
    googleSub: String(google.rawId),
    email: email.toLowerCase(),
    displayName: user.displayName ? String(user.displayName) : null,
    photoUrl: user.photoUrl ? String(user.photoUrl) : null,
  };
}

/** Provision a new Firebase account (Email/Password provider). */
export async function firebaseSignUp(
  email: string,
  password: string,
  displayName?: string
): Promise<{ ok: true; account: FirebaseAccount } | { ok: false; failure: FirebaseAuthFailure }> {
  if (!FIREBASE_AUTH_ENABLED) return { ok: false, failure: { kind: 'unknown', message: 'FIREBASE_API_KEY not set' } };
  const payload: Record<string, unknown> = { email, password, returnSecureToken: true };
  if (displayName) payload.displayName = displayName;
  const result = await identityRequest('accounts:signUp', payload);
  if (!result.ok) return { ok: false, failure: result.failure };
  const d = result.data;
  return {
    ok: true,
    account: {
      uid: String(d.localId ?? ''),
      email: String(d.email ?? email),
      displayName: displayName ?? null,
      idToken: String(d.idToken ?? ''),
      refreshToken: String(d.refreshToken ?? ''),
      expiresIn: String(d.expiresIn ?? '3600'),
    },
  };
}

/** Shape stored in user.oauth for Firebase-linked accounts (Open WebUI keeps
 *  provider payloads there, e.g. oauth.google.sub — we follow the pattern). */
export interface FirebaseOauthLink {
  uid: string;
  email: string;
  linked_at: number;
}

export function firebaseOauthLink(account: { uid: string; email: string }): FirebaseOauthLink {
  return { uid: account.uid, email: account.email, linked_at: Math.floor(Date.now() / 1000) };
}

/** Read the Firebase UID previously linked to a user (user.oauth JSON). */
export function parseFirebaseUid(oauthJson: string | null | undefined): string | null {
  if (!oauthJson) return null;
  try {
    const parsed = JSON.parse(oauthJson);
    const uid = parsed?.firebase?.uid;
    return typeof uid === 'string' && uid.length > 0 ? uid : null;
  } catch {
    return null;
  }
}

/** Serialise user.oauth with the firebase block merged in (other providers preserved). */
export function mergeFirebaseOauth(oauthJson: string | null | undefined, link: FirebaseOauthLink): string {
  let base: Record<string, any> = {};
  if (oauthJson) {
    try {
      base = JSON.parse(oauthJson) ?? {};
    } catch {
      base = {};
    }
  }
  base.firebase = link;
  return JSON.stringify(base);
}

export const FIREBASE_PROJECT = FIREBASE_PROJECT_ID;
