/**
 * Minimal RFC 6238 TOTP generator (SHA-1, 30s period, 6 digits) that runs
 * entirely in the browser using the Web Crypto API.
 *
 * Used only as a DEMO convenience ("Autofill code") so testers can complete
 * MFA enrollment / verification without installing an authenticator app.
 * Real deployments should use Google Authenticator etc.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decode an RFC 4648 base32 string (padding optional) into bytes. */
export function base32Decode(input: string): Uint8Array {
  const clean = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function counterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  // Big-endian 64-bit counter (JS numbers are safe up to 2^53).
  let remaining = counter;
  for (let i = 7; i >= 0; i--) {
    bytes[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return bytes;
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<ArrayBuffer> {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error("Web Crypto (crypto.subtle) is not available in this context");
  }
  const cryptoKey = await cryptoObj.subtle.importKey(
    "raw",
    key as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  return cryptoObj.subtle.sign("HMAC", cryptoKey, message as unknown as ArrayBuffer);
}

/**
 * Generate a TOTP code for a base32 secret.
 * @param secret  base32 encoded shared secret (the `manual_key` from enroll)
 * @param atMs    timestamp in milliseconds (defaults to now)
 * @param step    time step in seconds (default 30)
 * @param digits  code length (default 6)
 */
export async function generateTotp(
  secret: string,
  atMs: number = Date.now(),
  step: number = 30,
  digits: number = 6
): Promise<string> {
  const keyBytes = base32Decode(secret);
  const counter = Math.floor(atMs / 1000 / step);
  const digest = new Uint8Array(await hmacSha1(keyBytes, counterBytes(counter)));

  // Dynamic truncation (RFC 4226 §5.3)
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

/** Remaining seconds in the current TOTP window (for a live countdown UI). */
export function totpSecondsRemaining(step: number = 30): number {
  return step - (Math.floor(Date.now() / 1000) % step);
}

/**
 * Demo helper: remember the last secret enrolled through this browser so the
 * signin "Autofill code" button can fill a valid code on later logins.
 * (Never do this in production — the whole point of TOTP is that the secret
 * lives only in the user's authenticator device.)
 */
const DEMO_SECRET_KEY = "owu_demo_totp_secret";
export function rememberDemoSecret(secret: string): void {
  try {
    window.localStorage.setItem(DEMO_SECRET_KEY, secret);
  } catch {
    /* ignore quota/privacy errors */
  }
}
export function getDemoSecret(): string | null {
  try {
    return window.localStorage.getItem(DEMO_SECRET_KEY);
  } catch {
    return null;
  }
}
