/**
 * RoomPage — full-viewport canvas with top-left micro cluster (menu, users, invite),
 * fixed top toolbar at 48px with Inspector extension, and zoom controls.
 */

import { useEffect } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { disconnectRoom } from '../canvas/room-runtime';
import { ErrorBoundary } from './ErrorBoundary';

// Components
import { Canvas } from '../canvas/Canvas';
import { TopBar } from './TopBar';
import { ToolPanel } from './ToolPanel';
import { ZoomControls } from './ZoomControls';
import { UserAvatarCluster } from './UserAvatarCluster';
import { ToastProvider, useToast } from './Toast';

// CSS
import './RoomPage.css';

const route = getRouteApi('/room/$roomId');

function RoomCanvas() {
  const { showToast } = useToast();

  const handleInvite = async () => {
    try {
      await navigator.clipboard?.writeText(window.location.href);
      showToast('Link copied to clipboard!');
    } catch (error) {
      console.error('Failed to copy link:', error);
      showToast('Failed to copy link');
    }
  };

  return (
    <div className="app-container">
      {/* Workspace - now full height without header */}
      <div className="workspace">
        {/* Canvas Container */}
        <div className="canvas-container">
          {/* Grid Background */}
          <div className="canvas-grid" />

          {/* Main Canvas */}
          <Canvas className="canvas" />

          {/* Top-left panel — logo, sidebar toggle, board name, settings */}
          <TopBar />

          {/* Top-right micro cluster */}
          <div className="micro-cluster-right">
            {/* Users avatars cluster */}
            <UserAvatarCluster />

            {/* Invite button */}
            <button className="micro micro-invite" onClick={handleInvite} title="Copy invite link">
              Invite
            </button>
          </div>

          {/* Floating UI elements */}
          <ToolPanel />
          <ZoomControls />
        </div>
      </div>
    </div>
  );
}

export default function RoomPage() {
  const { roomId } = route.useParams();

  useEffect(() => {
    return () => disconnectRoom(roomId);
  }, [roomId]);

  return (
    <ErrorBoundary>
      <ToastProvider>
        <RoomCanvas key={roomId} />
      </ToastProvider>
    </ErrorBoundary>
  );
}
