import { normalizeRoomId } from '@avlo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import RoomPage from '@/components/RoomPage';
import { queryClient } from '@/query/client';
import { ensureIdentity } from '@/query/me';
import { ROOMS_QUERY_KEY, type RoomsQueryData } from '@/query/rooms';
import { connectRoom, getActiveRoomId, hasActiveRoom } from '@/runtime/room-runtime';
import { recordVisit, useRoomListStore } from '@/stores/room-list-store';
import { setRoomIsOwner, setRoomPermission, setRoomTitle, useRoomSessionStore } from '@/stores/room-session-store';

export const Route = createFileRoute('/room/$roomId')({
  beforeLoad: async ({ params }) => {
    // Validate-only (base62 ids are case-sensitive — no canonicalization rewrite).
    const roomId = normalizeRoomId(params.roomId);
    if (!roomId) {
      throw redirect({ to: '/home' });
    }
    // Same-room re-nav: connectRoom no-ops (no session reset), so the store already holds
    // WS-delivered truth — seeding from the (possibly stale) cache would clobber it.
    const sameRoomRenav = hasActiveRoom() && getActiveRoomId() === roomId;
    // Cold visitor: a server-signed cookie + userId must exist BEFORE connectRoom —
    // RoomDocManagerImpl's constructor reads getUserId() synchronously, which now
    // throws when identity is unresolved (there is no client-side mint). A returning
    // visitor resolves instantly from the persisted auth-store.
    await ensureIdentity();
    connectRoom(roomId);
    if (!sameRoomRenav) {
      // Seed title/isOwner/permission from the dashboard projection + local facts so the
      // TopBar, tab title and Share modal paint instantly (and stay correct on an offline
      // reload — the optimistic rename lives in the persisted rooms cache). The DO's
      // `title:`/`owner:`/`perm:` pushes overwrite with live truth on connect; the
      // facts-based isOwner is the same local-only approximation mergeRooms uses.
      const entry = queryClient.getQueryData<RoomsQueryData>(ROOMS_QUERY_KEY)?.rooms.find((r) => r.roomId === roomId);
      const facts = useRoomListStore.getState().rooms[roomId];
      setRoomTitle(entry?.title ?? facts?.title ?? null);
      setRoomIsOwner(entry?.isOwner ?? facts?.isOwner ?? facts !== undefined);
      setRoomPermission(entry?.permission ?? facts?.permission ?? null);
    }
    // Record the visit AFTER connecting. recordVisit re-sorts the dashboard's room list,
    // and the dashboard is still mounted during this beforeLoad — stamping it first would
    // flash that re-sort on the way out. Connect first, then update local facts. Skipped
    // on a re-nav to a DENIED room: the 4403 path just pruned the facts row, and
    // recordVisit would recreate it (connectRoom no-ops on same-room, so no second 4403
    // would ever fire to re-prune).
    if (!(sameRoomRenav && useRoomSessionStore.getState().access === 'forbidden')) recordVisit(roomId);
  },
  component: RoomPage,
});
