import type { ApiUser } from '@/lib/auth';
import { configGet } from '@/lib/config';
import { Users } from '@/lib/models/users';

/**
 * Mode Invité (ChatGPT parity) — server-side guest detection + usage budget.
 *
 * A guest is an anonymous throwaway account provisioned by
 * POST /api/v1/auths/guest (see the handshake in public/index.html): no
 * credentials, no profile, purged by scripts/cleanup-guests.ts. ChatGPT's
 * logged-out experience lets visitors chat with the default model only, for a
 * limited number of messages, with advanced features locked — this module is
 * the single source of truth for "who is a guest" and "how many messages a
 * guest has left" across the API surface.
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

/**
 * Message budget for one guest session (ChatGPT gives logged-out visitors a
 * small number of messages before the sign-up wall). Configurable through
 * the admin config key `guest.max_messages` (default 10).
 */
export async function guestMessageLimit(): Promise<number> {
  const raw = await configGet<number>('guest.max_messages', 10);
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 10;
}

export type GuestUsage = {
  /** messages already used by this guest */
  used: number;
  /** configured budget */
  limit: number;
  /** max(0, limit - used) */
  remaining: number;
};

async function readInfo(user: ApiUser): Promise<Record<string, unknown>> {
  try {
    const row = await Users.getUserById(user.id);
    const info = row?.info ?? user.info ?? null;
    if (info && typeof info === 'object' && !Array.isArray(info)) {
      return info as Record<string, unknown>;
    }
  } catch (e) {
    console.error('[guests] usage read failed', e);
  }
  return {};
}

/** Current usage snapshot (no write). */
export async function getGuestUsage(user: ApiUser): Promise<GuestUsage> {
  const limit = await guestMessageLimit();
  const info = await readInfo(user);
  const used = Math.max(0, Math.floor(Number(info.guest_msg_count)) || 0);
  return { used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Count ONE guest message (called on every non-continuation chat completion).
 * The counter lives in the guest row's `info` JSON (guest_msg_count) so it
 * survives serverless cold starts. Returns the usage AFTER the increment —
 * `exceeded` is true when the guest has spent the whole budget (the caller
 * must surface the sign-up wall instead of running the model).
 *
 * Concurrency note: two parallel turns can read the same count and both write
 * N+1 (undercount by one). Acceptable for a soft funnel — guest ACCOUNT
 * creation itself is already IP-rate-limited (30/h) in routers/auths.ts.
 */
export async function incrementGuestUsage(user: ApiUser): Promise<GuestUsage & { exceeded: boolean }> {
  const limit = await guestMessageLimit();
  const info = await readInfo(user);
  const current = Math.max(0, Math.floor(Number(info.guest_msg_count)) || 0);
  // Cap the stored counter at limit+1 so an idle-but-abusive guest cannot
  // grow it unboundedly through direct API calls.
  const used = Math.min(limit + 1, current + 1);
  try {
    await Users.updateUserById(user.id, { info: { ...info, guest_msg_count: used } });
  } catch (e) {
    console.error('[guests] usage write failed', e);
  }
  return { used, limit, remaining: Math.max(0, limit - used), exceeded: used > limit };
}
