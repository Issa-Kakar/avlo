/**
 * Identity as a query — `GET /me`, the single server-side identity resolver (§2).
 *
 * TanStack Query owns the fetch: dedup (one in-flight `/me` regardless of how many routes
 * call `ensureIdentity`), retry, offline-first networkMode (client default), and — the
 * point of this refactor — the cookie-slide throttle. The anon cookie has a 400-day
 * sliding Max-Age; re-bumping it on visit keeps it effectively permanent, but we must NOT
 * hit `/me` on every navigation. The me query's `staleTime` IS that throttle: query-cache
 * `dataUpdatedAt` (persisted to IDB) is the clock, so there is no `lastValidatedAt`
 * bookkeeping in any store.
 *
 * The `queryFn` is the sole writer of the auth-store (`setIdentity`) — the synchronous
 * read mirror the rest of the app reads via `getUserId` / `getUserProfile`.
 */
import { authClient } from '@avlo/api-client';
import { queryOptions } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth-store';
import { queryClient } from './client';

export const ME_QUERY_KEY = ['me'] as const;

// 24h — at most one /me per day slides the cookie + revalidates identity. Comfortably
// inside the 400-day cookie ceiling, and long enough that intra-session navigation
// (home ⇄ room) never refetches.
const SLIDE_THROTTLE_MS = 86_400_000;

export function meQueryOptions() {
  return queryOptions({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      const res = await authClient.me.$get();
      if (!res.ok) throw new Error(`/me ${res.status}`);
      const me = await res.json();
      // The query owns the fetch; the auth-store is its synchronous mirror.
      useAuthStore.getState().setIdentity(me);
      return me;
    },
    staleTime: SLIDE_THROTTLE_MS,
  });
}

/**
 * Resolve identity before the rest of the app reads it. The await decision is DECOUPLED
 * from the `/me` firing:
 *
 *   • Returning visitor (userId already in the persisted auth-store) — identity is
 *     synchronous, so we DON'T await. `prefetchQuery` warms `/me` in the background to
 *     slide the cookie; it never throws and is a no-op while the me query is fresh (the
 *     throttle), so it's truly fire-and-forget.
 *   • First-ever visitor (no userId; necessarily online — the SPA just downloaded) — block
 *     on the cold mint via `ensureQueryData` so a signed cookie + userId exist BEFORE
 *     connectRoom reads `getUserId()`. A hard `/me` failure rejects loudly (no fabricated
 *     id is ever substituted).
 */
export async function ensureIdentity(): Promise<void> {
  if (useAuthStore.getState().userId) {
    void queryClient.prefetchQuery(meQueryOptions());
    return;
  }
  // ensureQueryData returns persisted cache without running the queryFn on a hit, so the
  // explicit setIdentity is what guarantees the store is populated when we return.
  useAuthStore.getState().setIdentity(await queryClient.ensureQueryData(meQueryOptions()));
}
