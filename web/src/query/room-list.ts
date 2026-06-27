/**
 * Read-time merge of the D1 server projection (TanStack Query) with the local facts
 * store (localStorage) into the dashboard's `Canvas[]` display shape.
 *
 * Union by roomId. A locally-created/visited room is NEVER dropped when the server
 * list lands (the offline-created-room correctness bug); `openedTs = max(local,
 * server)`. `createdTs` prefers the EARLIEST known creation — `min(server FWW,
 * local createdAt)` when both exist (an offline-created room's local time can predate
 * the DO's meta mint), else whichever is present, falling back to the visit time for a
 * visit-/rename-born local row that has no creation yet. `starred` is read from the separate
 * `starredIds` overlay (a preference, never a fact — it lives outside `RoomFacts`, so
 * it touches no timestamp and a projection-only room still stars). Private rooms someone
 * else owns are never displayed — their server rows are collected into a hidden set
 * BEFORE the facts loop so the local-only fallback can't resurrect one as owned-by-me.
 * Owner display: self → "Me" (anon) or the account name; other → their account name,
 * "Anonymous" for anon owners. Memoized on its inputs (projection + facts + stars + the
 * auth name/isAnon pair — without the last the owner column would show a stale name until
 * an unrelated re-render after `/me` resolves).
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
  starredIds: Record<string, true>,
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
        starred: !!starredIds[r.roomId],
        openedTs: f ? Math.max(r.lastVisitedAt, f.lastVisitedAt) : r.lastVisitedAt,
        // Server `createdAt` is FWW truth; an offline-created local time may be earlier (the
        // device knew the real creation before the DO minted meta) — prefer the earliest.
        createdTs: f?.createdAt != null ? Math.min(r.createdAt, f.createdAt) : r.createdAt,
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
      starred: !!starredIds[id],
      openedTs: f.lastVisitedAt,
      // Local-only (not yet projected): genuine create stamped `createdAt`; a visit-/rename-born
      // row has none yet, so fall back to the visit time until the server FWW value absorbs in.
      createdTs: f.createdAt ?? f.lastVisitedAt,
    });
  }

  return [...byId.values()];
}

/** The merged room list for the dashboard. */
export function useRoomList(): Canvas[] {
  const server = useQuery(roomsQueryOptions()).data;
  const facts = useRoomListStore((s) => s.rooms);
  const starredIds = useRoomListStore((s) => s.starredIds);
  const authName = useAuthStore((s) => s.name);
  const isAnon = useAuthStore((s) => s.isAnon);
  return useMemo(() => mergeRooms(server?.rooms, facts, starredIds, authName, isAnon), [server, facts, starredIds, authName, isAnon]);
}
