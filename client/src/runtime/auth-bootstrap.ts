/**
 * Identity bootstrap — the `/me` resolver.
 *
 * Identity comes ONLY from the auth worker's `/me`; there is no client-side mint (the
 * optimistic provisional-ULID seed is deleted — handoff §9). A returning visitor
 * resolves instantly from the persisted auth-store (offline-safe); a cold visitor —
 * necessarily online, the SPA can't load otherwise — awaits one `/me` round-trip.
 * `ensureIdentity()` is awaited at the room route beforeLoad (and the dashboard loader)
 * before any code reads identity; on a hard `/me` failure it rejects (a loud failure —
 * the app never fabricates an id to paper over it).
 */
import { authClient } from '@avlo/api-client';
import { useAuthStore } from '@/stores/auth-store';

let inflight: Promise<void> | null = null;

/**
 * Fire `/me` (one in-flight at a time). On success writes the resolved identity into
 * the store. Rejects on a hard `/me` failure — there is no fallback identity to keep.
 */
export function refreshIdentity(): Promise<void> {
  if (!inflight) {
    inflight = fetchMe().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Resolves instantly when identity is already present (returning / persisted visitor) —
 * kicking a background refresh to re-validate + re-bump the cookie, errors swallowed —
 * else awaits the cold `/me` mint so a cookie + `userId` exist BEFORE the room route's
 * DO upgrade (no `4401`-then-reconnect round-trip).
 */
export function ensureIdentity(): Promise<void> {
  if (useAuthStore.getState().userId) {
    void refreshIdentity().catch(() => {});
    return Promise.resolve();
  }
  return refreshIdentity();
}

async function fetchMe(): Promise<void> {
  const res = await authClient.me.$get();
  if (!res.ok) {
    throw new Error(`/me ${res.status}`);
  }
  const me = await res.json();
  useAuthStore.setState({ userId: me.userId, isAnon: me.isAnon, name: me.name, color: me.color });
}
