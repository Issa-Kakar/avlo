import { normalizeRoomId } from '@avlo/shared';
import { createFileRoute, redirect } from '@tanstack/react-router';
import RoomPage from '@/components/RoomPage';
import { ensureIdentity } from '@/query/me';
import { connectRoom } from '@/runtime/room-runtime';
import { recordVisit } from '@/stores/room-list-store';

export const Route = createFileRoute('/room/$roomId')({
  beforeLoad: async ({ params }) => {
    const roomId = normalizeRoomId(params.roomId);
    if (!roomId) {
      throw redirect({ to: '/home' });
    }
    // Canonicalize case so the URL, the local-facts key, and connectRoom all agree on
    // the uppercase id (re-runs once; then roomId === params.roomId — no loop).
    if (roomId !== params.roomId) {
      throw redirect({ to: '/room/$roomId', params: { roomId } });
    }
    // Cold visitor: a server-signed cookie + userId must exist BEFORE connectRoom —
    // RoomDocManagerImpl's constructor reads getUserId() synchronously, which now
    // throws when identity is unresolved (there is no client-side mint). A returning
    // visitor resolves instantly from the persisted auth-store.
    await ensureIdentity();
    connectRoom(roomId);
    // Record the visit AFTER connecting. recordVisit re-sorts the dashboard's room list,
    // and the dashboard is still mounted during this beforeLoad — stamping it first would
    // flash that re-sort on the way out. Connect first, then update local facts.
    recordVisit(roomId);
  },
  component: RoomPage,
});
