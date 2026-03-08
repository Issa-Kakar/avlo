/**
 * UI Redesign: RoomPage Component without Header
 *
 * Implements new top-left micro cluster with trash, users, and invite buttons.
 * Fixed top toolbar at 48px with Inspector extension.
 */

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';

// Components
import { Canvas } from '../canvas/Canvas';
import { ToolPanel } from './ToolPanel';
import { ZoomControls } from './ZoomControls';
import { UsersModal } from './UsersModal';
import { UserAvatarCluster } from './UserAvatarCluster';
import { ToastProvider, useToast } from './Toast';

// Hooks
import { useClearScene } from '../hooks/useRoomIntegration';

// CSS
import './RoomPage.css';

interface RoomCanvasProps {
  roomId: string;
}

function RoomCanvas({ roomId }: RoomCanvasProps) {
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const { showToast } = useToast();
  const clearScene = useClearScene(roomId);

  const handleClear = () => {
    if (window.confirm('Clear the board for everyone? This cannot be undone.')) {
      try {
        clearScene?.();
        showToast('Board cleared');
      } catch (error) {
        console.error('Failed to clear board:', error);
        showToast('Failed to clear board');
      }
    }
  };

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

          {/* Top-left micro cluster */}
          <div className="micro-cluster">
            {/* Kebab menu (placeholder for future features) */}
            <button className="micro micro-kebab" aria-label="More options">
              <span className="dot"></span>
              <span className="dot"></span>
              <span className="dot"></span>
            </button>

            {/* Trash (Clear board) */}
            <button
              className="micro micro-trash"
              onClick={handleClear}
              aria-label="Clear board"
              title="Clear board"
            >
              <svg viewBox="0 0 24 24" className="icon-16">
                <path
                  d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
          </div>

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
          <ToolPanel onToast={showToast} />
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
