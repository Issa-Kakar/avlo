/**
 * RoomPage — full-viewport canvas app shell. Renders the canvas surface plus
 * floating chrome: the left TopBar, the right TopBarRight (avatars + Share),
 * the vertical left tool rail (Toolbar), and zoom controls.
 */

import { normalizeRoomId } from '@avlo/shared';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect } from 'react';
import { disconnectRoom } from '@/runtime/room-runtime';
import { Canvas } from './Canvas';
import { Toolbar } from './toolbar';
import { TopBar, TopBarRight } from './topbar';
import { ZoomControls } from './ZoomControls';

const route = getRouteApi('/room/$roomId');

function RoomCanvas() {
  return (
    <div className="relative h-screen w-full overflow-hidden bg-white font-ui antialiased">
      <Canvas />
      <TopBar />
      <TopBarRight />
      <Toolbar />
      <ZoomControls />
    </div>
  );
}

export default function RoomPage() {
  const { roomId } = route.useParams();
  useEffect(() => {
    return () => disconnectRoom(normalizeRoomId(roomId) ?? undefined);
  }, [roomId]);
  return <RoomCanvas key={roomId} />;
}
