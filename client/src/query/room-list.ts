/**
 * Read-time merge of the D1 server projection (TanStack Query) with the local facts
 * store (localStorage) into the dashboard's `Canvas[]` display shape.
 *
 * Union by roomId. A locally-created/visited room is NEVER dropped when the server
 * list lands (the offline-created-room correctness bug); `openedTs = max(local,
 * server)`, `createdTs = local ?? server`, `starred` is local-only. Private rooms
 * someone else owns are never displayed — their server rows are collected into a
 * hidden set BEFORE the facts loop so the local-only fallback can't resurrect one as
 * owned-by-me. Owner display: self → "Me" (anon) or the account name; other → their
 * account name, "Anonymous" for anon owners. Memoized on its inputs (the projection,
 * the facts slice, and the auth name/isAnon pair — without the latter the owner
 * column would show a stale name until an unrelated re-render after `/me` resolves).
 */
import type { RoomListEntry } from '@avlo/api-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Canvas } from '@/components/dashboard/data';
import { useAuthStore } from '@/stores/auth-store';
import { type RoomFacts, useRoomListStore } from '@/stores/room-list-store';
import { roomsQueryOptions } from './rooms';

export function mergeRooms(
  serverRooms: readonly RoomListEntry[] | undefined,
  facts: Record<string, RoomFacts>,
  authName: string,
  isAnon: boolean,
): Canvas[] {
  const byId = new Map<string, Canvas>();
  const selfName = isAnon ? 'Me' : authName;
  const hidden = new Set<string>();

  if (serverRooms) {
    for (const r of serverRooms) {
      if (r.permission === 'private' && !r.isOwner) {
        hidden.add(r.roomId); // never displayed; the queryFn's absorb prunes its facts
        continue;
      }
      const f = facts[r.roomId];
      byId.set(r.roomId, {
        id: r.roomId,
        name: r.title, // NOT NULL server-side; owner renames land here via the D1 projection
        owner: r.isOwner ? selfName : (r.ownerName ?? 'Anonymous'),
        isOwner: r.isOwner,
        permission: r.permission,
        starred: f?.starred ?? false,
        openedTs: f ? Math.max(r.lastVisitedAt, f.lastVisitedAt) : r.lastVisitedAt,
        createdTs: f?.createdAt ?? r.lastVisitedAt, // no createdAt in the projection — fall back to the visit
      });
    }
  }

  // Local-only rooms (created/visited on this device, not yet projected to D1) — never
  // dropped. The creator owns it until the DO mints meta + the queue projects to D1.
  // `f.title` is the locally-given name (offline rename); server title wins once
  // projected. The server-fact mirrors (`isOwner`/`permission`/`ownerName`) cover an
  // offline dashboard for previously-absorbed rooms.
  for (const id in facts) {
    if (byId.has(id) || hidden.has(id)) continue;
    const f = facts[id];
    const isOwner = f.isOwner ?? true;
    byId.set(id, {
      id,
      name: f.title ?? 'Untitled',
      owner: isOwner ? selfName : (f.ownerName ?? 'Anonymous'),
      isOwner,
      permission: f.permission ?? 'public',
      starred: f.starred,
      openedTs: f.lastVisitedAt,
      createdTs: f.createdAt,
    });
  }

  return [...byId.values()];
}

/** The merged room list for the dashboard. */
export function useRoomList(): Canvas[] {
  const server = useQuery(roomsQueryOptions()).data;
  const facts = useRoomListStore((s) => s.rooms);
  const authName = useAuthStore((s) => s.name);
  const isAnon = useAuthStore((s) => s.isAnon);
  return useMemo(() => mergeRooms(server?.rooms, facts, authName, isAnon), [server, facts, authName, isAnon]);
}
