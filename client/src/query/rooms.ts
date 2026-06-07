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
import { queryClient } from './client';

export interface RoomsQueryData {
  rooms: RoomListEntry[];
  bookmark: string;
}

export const ROOMS_QUERY_KEY = ['rooms'] as const;

export function roomsQueryOptions() {
  return queryOptions({
    queryKey: ROOMS_QUERY_KEY,
    queryFn: async (): Promise<RoomsQueryData> => {
      const prev = queryClient.getQueryData<RoomsQueryData>(ROOMS_QUERY_KEY);
      const res = await usersClient.rooms.$get({}, prev?.bookmark ? { headers: { 'x-d1-bookmark': prev.bookmark } } : undefined);
      if (!res.ok) throw new Error(`GET /rooms ${res.status}`);
      const body = await res.json();
      return { rooms: body.rooms, bookmark: body.bookmark };
    },
  });
}
