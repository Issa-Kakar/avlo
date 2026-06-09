/**
 * Read-time merge of the D1 server projection (TanStack Query) with the local facts
 * store (localStorage) into the dashboard's `Canvas[]` display shape.
 *
 * Union by roomId. A locally-created/visited room is NEVER dropped when the server
 * list lands (the offline-created-room correctness bug); `openedTs = max(local,
 * server)`, `createdTs = local ?? server`, `starred` is local-only, `owner`/`name`
 * are server display fields. Memoized on its two inputs so it recomputes only when
 * the projection or the facts change — both are referentially stable otherwise
 * (Query returns the same data object; Zustand the same `rooms` slice).
 */
import type { RoomListEntry } from '@avlo/api-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type Canvas, OWNER_OTHER, OWNER_SELF } from '@/components/dashboard/data';
import { type RoomFacts, useRoomListStore } from '@/stores/room-list-store';
import { roomsQueryOptions } from './rooms';

export function mergeRooms(serverRooms: readonly RoomListEntry[] | undefined, facts: Record<string, RoomFacts>): Canvas[] {
  const byId = new Map<string, Canvas>();

  if (serverRooms) {
    for (const r of serverRooms) {
      const f = facts[r.roomId];
      byId.set(r.roomId, {
        id: r.roomId,
        name: r.title, // NOT NULL server-side ('Untitled' until a rename UI exists)
        owner: r.isOwner ? OWNER_SELF : OWNER_OTHER,
        starred: f?.starred ?? false,
        openedTs: f ? Math.max(r.lastVisitedAt, f.lastVisitedAt) : r.lastVisitedAt,
        createdTs: f?.createdAt ?? r.lastVisitedAt, // no createdAt in the projection — fall back to the visit
      });
    }
  }

  // Local-only rooms (created/visited on this device, not yet projected to D1) — never
  // dropped. The creator owns it until the DO mints meta + the queue projects to D1.
  for (const id in facts) {
    if (byId.has(id)) continue;
    const f = facts[id];
    byId.set(id, { id, name: 'Untitled', owner: OWNER_SELF, starred: f.starred, openedTs: f.lastVisitedAt, createdTs: f.createdAt });
  }

  return [...byId.values()];
}

/** The merged room list for the dashboard. */
export function useRoomList(): Canvas[] {
  const server = useQuery(roomsQueryOptions()).data;
  const facts = useRoomListStore((s) => s.rooms);
  return useMemo(() => mergeRooms(server?.rooms, facts), [server, facts]);
}
