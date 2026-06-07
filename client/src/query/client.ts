/**
 * TanStack Query client + IndexedDB cache persister.
 *
 * The QueryClient is the single in-memory cache for server-projection reads (today
 * the dashboard's `GET /rooms`). It is persisted to IndexedDB via idb-keyval so a
 * returning visitor sees their last room list instantly — restored once at boot by
 * `PersistQueryClientProvider` (routes/__root), never read synchronously by app
 * code. The async stays fully encapsulated in the persister, which is exactly why
 * the projection lives here and not in the synchronous localStorage facts store
 * (`stores/room-list-store.ts`) — the two halves are merged in `query/room-list.ts`.
 *
 * `gcTime` ≥ the persister's 24h default `maxAge` so a cached query survives in memory
 * long enough to be re-persisted. `networkMode: 'offlineFirst'` is a deliberate choice
 * for an offline-first app: run the queryFn once regardless of `navigator.onLine` (don't
 * sit 'paused'), and on failure fall back to durable local facts — the dashboard renders
 * from localStorage, identity from the persisted auth-store. Retries still back off and
 * resume on reconnect.
 */
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import { del, get, set } from 'idb-keyval';

const DAY_MS = 86_400_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: DAY_MS,
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
