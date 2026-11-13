import type { ApiUser } from '@/lib/auth';

/**
 * Mode Invité (ChatGPT parity) — server-side guest detection.
 *
 * A guest is an anonymous throwaway account provisioned by
 * POST /api/v1/auths/guest (see the handshake in public/index.html): no
 * credentials, no profile, purged by scripts/cleanup-guests.ts. ChatGPT's
 * logged-out experience lets visitors chat with the default model only, with
 * advanced features locked — this module is the single source of truth for
 * "who is a guest" across the API surface.
 *
 * NOT a message quota: there is no budget and no counter. The guest is
 * anonymous and ephemeral — his discussions are never presented as saved
 * history (the frontend shows the sign-up card instead of a chat list), and
 * the throwaway account row is purged by scripts/cleanup-guests.ts.
 */

/** Email suffix of throwaway guest accounts. */
export const GUEST_EMAIL_SUFFIX = '@guests.nelth-ia.local';

/** True when the session belongs to an anonymous guest account. */
export function isGuestUser(user: ApiUser | null | undefined): boolean {
  if (!user) return false;
  if (typeof user.email === 'string' && user.email.toLowerCase().endsWith(GUEST_EMAIL_SUFFIX)) {
    return true;
  }
  const info = user.info as Record<string, unknown> | null | undefined;
  return !!info && typeof info === 'object' && (info as Record<string, unknown>).is_guest === true;
}
