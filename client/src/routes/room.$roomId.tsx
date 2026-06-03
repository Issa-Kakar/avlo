import { createFileRoute, redirect } from '@tanstack/react-router';
import { normalizeRoomId } from '@avlo/shared';
import RoomPage from '@/components/RoomPage';
import { ensureIdentity } from '@/runtime/auth-bootstrap';
import { connectRoom } from '@/runtime/room-runtime';

export const Route = createFileRoute('/room/$roomId')({
  beforeLoad: async ({ params }) => {
    const roomId = normalizeRoomId(params.roomId);
    if (!roomId) {
      throw redirect({ to: '/home' });
    }
    // Cold visitor: a server-signed cookie + userId must exist BEFORE connectRoom —
    // RoomDocManagerImpl's constructor reads getUserId() synchronously, which now
    // throws when identity is unresolved (there is no client-side mint). A returning
    // visitor resolves instantly from the persisted auth-store.
    await ensureIdentity();
    connectRoom(roomId);
  },
  component: RoomPage,
});
