/**
 * RoomPage — full-viewport canvas with top-left micro cluster (menu, users, invite),
 * fixed top toolbar at 48px with Inspector extension, and zoom controls.
 */

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';

// Components
import { Canvas } from '../canvas/Canvas';
import { TopBar } from './TopBar';
import { ToolPanel } from './ToolPanel';
import { ZoomControls } from './ZoomControls';
import { UsersModal } from './UsersModal';
import { UserAvatarCluster } from './UserAvatarCluster';
import { ToastProvider, useToast } from './Toast';

// CSS
import './RoomPage.css';

interface RoomCanvasProps {
  roomId: string;
}

function RoomCanvas({ roomId }: RoomCanvasProps) {
  const [usersModalOpen, setUsersModalOpen] = useState(false);
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
          <Canvas roomId={roomId} className="canvas" />

          {/* Top-left panel — logo, sidebar toggle, board name, settings */}
          <TopBar />

          {/* Top-right micro cluster */}
          <div className="micro-cluster-right">
            {/* Users avatars cluster */}
            <UserAvatarCluster roomId={roomId} onShowModal={() => setUsersModalOpen(true)} />

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

      {/* Users Modal */}
      <UsersModal
        roomId={roomId}
        isOpen={usersModalOpen}
        onClose={() => setUsersModalOpen(false)}
      />
    </div>
  );
}

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();

  if (!roomId) {
    return (
      <div className="app-container" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <h1
            style={{
              fontSize: '2rem',
              fontWeight: '600',
              color: 'var(--text-primary)',
              marginBottom: '1rem',
            }}
          >
            Invalid Room
          </h1>
          <p style={{ color: 'var(--text-secondary)' }}>No room ID provided</p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
        <RoomCanvas roomId={roomId} />
      </ToastProvider>
    </ErrorBoundary>
  );
}
