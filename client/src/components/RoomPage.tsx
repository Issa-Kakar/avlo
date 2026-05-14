/**
 * RoomPage — full-viewport canvas app shell. Renders the canvas surface plus
 * floating chrome: the TopBar, a top-right micro cluster (user avatars +
 * invite), the vertical left tool rail (Toolbar), and zoom controls.
 */
import { getRouteApi } from '@tanstack/react-router';
import { useEffect } from 'react';
import { disconnectRoom } from '@/runtime/room-runtime';
import { Canvas } from './Canvas';
import { TopBar } from './TopBar';
import { Toolbar } from './toolbar';
import { UserAvatarCluster } from './UserAvatarCluster';
import { ZoomControls } from './ZoomControls';
import './RoomPage.css';

const route = getRouteApi('/room/$roomId');

function RoomCanvas() {
  const handleInvite = async () => {
    try {
      await navigator.clipboard?.writeText(window.location.href);
    } catch (error) {
      console.error('Failed to copy link:', error);
    }
  };
  return (
    <div className="relative h-screen w-full overflow-hidden bg-white font-ui antialiased">
      <Canvas />
      <TopBar />
      <div className="micro-cluster-right">
        <UserAvatarCluster />
        <button className="micro micro-invite" onClick={handleInvite} title="Copy invite link">
          Invite
        </button>
      </div>
      <Toolbar />
      <ZoomControls />
    </div>
  );
}

export default function RoomPage() {
  const { roomId } = route.useParams();
  useEffect(() => {
    return () => disconnectRoom(roomId);
  }, [roomId]);
  return <RoomCanvas key={roomId} />;
}
