/**
 * The `?auth=` marker boot path. OAuth ends with a top-level redirect back into the app
 * (`…?auth=ok|denied|error`, minted by the auth worker's callback) and sign-out reloads
 * with `?auth=out` — both land BEFORE the router exists, so `main.tsx` consumes the
 * marker synchronously and, for the identity-changing markers, forces one clean `/me`
 * round-trip before anything renders or connects.
 */
import { queryClient } from './client';
import { ME_QUERY_KEY, meQueryOptions } from './me';
import { ROOMS_QUERY_KEY } from './rooms';

export type AuthMarker = 'ok' | 'out' | 'denied' | 'error';

/**
 * Synchronously read AND strip the `?auth=` marker. Raw `history.replaceState` with the
 * CURRENT state object preserves TanStack's `__TSR_index`/`__TSR_key`; the router's
 * patched global updates its cached location and the mount-time `router.load()` re-parses
 * — the router never sees the marker, so it can't leak into a room URL or a copied link.
 * `denied`/`error` are warn-only (no identity change happened server-side).
 * Marker-less boots: one `URLSearchParams` parse, zero behavior change.
 */
export function consumeAuthMarker(): AuthMarker | null {
  const params = new URLSearchParams(window.location.search);
  const marker = params.get('auth');
  if (marker !== 'ok' && marker !== 'out' && marker !== 'denied' && marker !== 'error') return null;
  params.delete('auth');
  const qs = params.toString();
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
  if (marker === 'denied' || marker === 'error') console.warn(`[auth] sign-in ${marker}`);
  return marker;
}

/**
 * Identity changed server-side (`ok` after sign-in, `out` after sign-out) — re-resolve it
 * before first render. REMOVAL, not invalidation, of the identity-keyed caches: stale
 * cross-account data must not flash (the dashboard falls back to local room facts while
 * `/rooms` refetches). The forced `/me` is raced against 4 s because `offlineFirst`
 * PAUSES (rather than rejects) when offline — on timeout we proceed on the persisted
 * identity and the still-in-flight `/me` self-corrects the stores when it lands. The
 * queryFn is the sole auth-store writer, so a resolved fetch means the store already
 * mirrors the new identity.
 */
export async function refreshIdentityForAuthChange(): Promise<void> {
  queryClient.removeQueries({ queryKey: ME_QUERY_KEY });
  queryClient.removeQueries({ queryKey: ROOMS_QUERY_KEY });
  try {
    await Promise.race([
      queryClient.fetchQuery(meQueryOptions()),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('identity refresh timeout')), 4000);
      }),
    ]);
  } catch (err) {
    console.warn('[auth] identity refresh did not complete — proceeding on persisted identity:', err);
  }
}
