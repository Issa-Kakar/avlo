import { createFileRoute } from '@tanstack/react-router';
import { connectRoom } from '@/runtime/room-runtime';
import RoomPage from '@/components/RoomPage';

export const Route = createFileRoute('/room/$roomId')({
  beforeLoad: ({ params }) => {
    connectRoom(params.roomId);
  },
  component: RoomPage,
});
