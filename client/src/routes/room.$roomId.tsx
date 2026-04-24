import { createFileRoute } from '@tanstack/react-router';
import RoomPage from '@/components/RoomPage';
import { connectRoom } from '@/runtime/room-runtime';

export const Route = createFileRoute('/room/$roomId')({
  beforeLoad: ({ params }) => {
    connectRoom(params.roomId);
  },
  component: RoomPage,
});
