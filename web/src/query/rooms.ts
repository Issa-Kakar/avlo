/**
 * The dashboard's server projection — `GET /rooms` (the §4 D1 query: the caller's
 * `room_visits` JOIN `rooms`, recency-ordered, `isOwner` derived). Wrapped in
 * `queryOptions` so one descriptor drives both the route loader's `ensureQueryData`
 * and the component's `useQuery`.
 *
 * D1 Sessions bookmark: the last bookmark is stashed IN the query data so it rides
 * the persisted IndexedDB cache across sessions; each fetch threads it back via the
 * `x-d1-bookmark` request header (read-your-writes across D1 read replicas). `/rooms`
 * has no header zValidator, so `hc` doesn't type a header param — it goes through the
 * request-options arg. `credentials:'include'` is baked into `usersClient`.
 */
import { type RoomListEntry, usersClient } from '@avlo/api-client';
import { queryOptions } from '@tanstack/react-query';
import { getActiveRoomId, hasActiveRoom } from '@/runtime/room-runtime';
import { absorbServerRooms } from '@/stores/room-list-store';
import { deleteRoomDocDB } from '@/utils/room-local-data';
import { queryClient } from './client';
import { ensureIdentity } from './me';

export interface RoomsQueryData {
  rooms: RoomListEntry[];
  bookmark: string;
}

export const ROOMS_QUERY_KEY = ['rooms'] as const;

/**
 * One-shot stash for the adopt-migration D1 read-your-writes bookmark. `main.tsx` sets it from
 * the `?auth=ok&rbm=` redirect param (a module `let` survives the page lifetime); the first
 * SUCCESSFUL `/rooms` read burns it. Load-bearing for the post-sign-in dashboard: sign-in returns
 * to the ROOM route (never calls `roomsQueryOptions`), so the stash waits untouched until the user
 * opens `/home` and the prefetch threads it — the dashboard never reads stale pre-migration
 * ownership (which would prune + delete a just-migrated local board). The queryFn reads it WITHOUT
 * consuming and clears it only after a successful parse, so a transient first-read failure (TanStack
 * auto-retries) still threads the bookmark on the retry rather than reading a stale replica.
 */
let pendingRoomsBookmark: string | null = null;
export function setPendingRoomsBookmark(bookmark: string): void {
  pendingRoomsBookmark = bookmark;
}

export function roomsQueryOptions() {
  return queryOptions({
    queryKey: ROOMS_QUERY_KEY,
    queryFn: async (): Promise<RoomsQueryData> => {
      // The signed cookie /rooms authenticates with must exist first. Identity is
      // resolved HERE, not in the /home loader, so the dashboard shell paints
      // instantly even for a cold visitor; deduped with the root beforeLoad warm-up
      // via the shared me query key. Instant for a returning visitor.
      await ensureIdentity();
      const prev = queryClient.getQueryData<RoomsQueryData>(ROOMS_QUERY_KEY);
      // Prefer the cached bookmark; on the first read after an adopt sign-in the cache was removed
      // (refreshIdentityForAuthChange), so fall back to the one-shot migration stash — read WITHOUT
      // consuming so a transient retry can still thread it (burned only after the successful parse).
      const bookmark = prev?.bookmark ?? pendingRoomsBookmark ?? undefined;
      const res = await usersClient.rooms.$get({}, bookmark ? { headers: { 'x-d1-bookmark': bookmark } } : undefined);
      if (!res.ok) throw new Error(`GET /rooms ${res.status}`);
      const body = await res.json();
      pendingRoomsBookmark = null; // success → burn the one-shot stash (its bookmark now rides the query cache)
      // Absorb the server facts into the persisted local mirror (precedent: the me
      // queryFn writes auth-store). Pruned = private rooms we don't own — drop their
      // local doc DBs too, EXCEPT the active room's: its open y-indexeddb connection
      // would block deleteDatabase forever, and its own 4403 close path handles cleanup.
      // (Known accepted race: an in-flight absorb can briefly overwrite an optimistic
      // permission fact; the mutation's onSettled invalidate converges.)
      for (const id of absorbServerRooms(body.rooms)) {
        if (hasActiveRoom() && getActiveRoomId() === id) continue;
        deleteRoomDocDB(id);
      }
      return { rooms: body.rooms, bookmark: body.bookmark };
    },
  });
}
