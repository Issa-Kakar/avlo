/**
 * TanStack Query client + IndexedDB cache persister.
 *
 * The QueryClient is the single in-memory cache for server-projection reads (today
 * the dashboard's `GET /rooms`) plus the `/me` identity query. It is persisted to
 * IndexedDB via idb-keyval and restored ONCE, BEFORE the router renders —
 * `main.tsx` awaits `restoreQueryCache()` ahead of `<RouterProvider/>`. That
 * ordering is load-bearing: route `beforeLoad`/loaders fire during router mount,
 * and the me query's restored `dataUpdatedAt` is the cookie-slide throttle clock.
 * Restoring inside the React tree (the old `PersistQueryClientProvider`) ran AFTER
 * `beforeLoad`, so every boot saw an empty cache and refetched `/me`.
 *
 * `maxAge`/`gcTime` are 21d so the offline-first rooms list survives a multi-day
 * absence (`gcTime` ≥ `maxAge`, else a restored-but-idle query is GC'd before it
 * can re-persist). `networkMode: 'offlineFirst'` is a deliberate choice for an
 * offline-first app: run the queryFn once regardless of `navigator.onLine` (don't
 * sit 'paused'), and on failure fall back to durable local facts — the dashboard
 * renders from localStorage, identity from the persisted auth-store. Retries still
 * back off and resume on reconnect.
 */
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import { persistQueryClient } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

const DAY_MS = 86_400_000;
// HARD CEILING: must stay < 2^31−1 ms (~24.8 days). `gcTime` feeds a raw setTimeout;
// an overflowed delay fires at ~1ms and instantly GCs every observerless query — the
// prefetch-only /me entry first — silently breaking the slide throttle (30d WAS that
// bug: /me refired on every refresh and navigation).
const PERSIST_MAX_AGE = 21 * DAY_MS;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: PERSIST_MAX_AGE,
      staleTime: 30_000,
      retry: 2,
      networkMode: 'offlineFirst',
    },
  },
});

// idb-keyval's default store — a dedicated `keyval-store` IDB, independent of the
// per-room y-indexeddb docs. The whole dehydrated cache is one JSON string under one
// key; throttle persistence to ≤1/s so rapid query churn doesn't hammer IDB.
export const persister = createAsyncStoragePersister({
  key: 'avlo.rq.v1',
  throttleTime: 1000,
  storage: {
    getItem: (key) => get<string>(key),
    setItem: (key, value) => set(key, value),
    removeItem: (key) => del(key),
  },
});

/**
 * Restore the persisted cache into the QueryClient and install the save
 * subscription. Awaited by `main.tsx` before the router renders (one IDB get +
 * JSON.parse — milliseconds, concurrent with the font await that already gates
 * first paint). Never rejects: a corrupt/failed restore boots with a cold cache.
 *
 * Hydrated PAUSED mutations are NOT resumed here — `main.tsx`'s `init()` fires
 * `resumePausedMutations()` (void, not awaited: a still-offline mutation pends
 * until reconnect) as the last step before mount, AFTER the `?auth=` marker
 * branch. Resuming inside restore would replay a pre-logout offline mutation
 * under the new identity, 403, and its persisted onError context would
 * resurrect purged state.
 */
export function restoreQueryCache(): Promise<void> {
  const [, restored] = persistQueryClient({ queryClient, persister, buster: 'v1', maxAge: PERSIST_MAX_AGE });
  return restored.catch((err) => console.error('[query] cache restore failed:', err));
}
