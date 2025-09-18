/**
 * Phase 9: RoomPage Component with Modern UI
 *
 * Complete redesign with floating tools, collapsible panels, and smooth interactions.
 * High-performance draggable elements and responsive design.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ViewTransformProvider } from '../canvas/ViewTransformContext';
import { ErrorBoundary } from '../components/ErrorBoundary';

// Phase 9 Components
import { Header } from './components/Header';
import { Canvas } from '../canvas/Canvas';
import { ToolPanel } from './components/ToolPanel';
import { ColorSizeDock } from './components/ColorSizeDock';
import { ZoomControls } from './components/ZoomControls';
import { EditorPanel } from './components/EditorPanel';
import { UsersModal } from './components/UsersModal';
import { ToastProvider, useToast } from './components/Toast';

// Hooks
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useClearScene } from '../hooks/useRoomIntegration';

// CSS
import './RoomPage.css';

interface RoomCanvasProps {
  roomId: string;
}

function RoomCanvas({ roomId }: RoomCanvasProps) {
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const { showToast } = useToast();
  const clearScene = useClearScene(roomId);

  // Theme management
  useEffect(() => {
    const savedTheme = (localStorage.getItem('theme') as 'light' | 'dark') || 'light';
    setTheme(savedTheme);
    document.documentElement.setAttribute('data-theme', savedTheme);
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
  };

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

  const handleUndo = () => {
    showToast('UNDO');
  };

  const handleRedo = () => {
    showToast('REDO');
  };

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onClear: handleClear,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onToast: showToast,
  });

  return (
    <div className="app-container">
      {/* Header */}
      <Header
        roomId={roomId}
        onThemeToggle={toggleTheme}
        onUsersClick={() => setUsersModalOpen(true)}
        onToast={showToast}
      />

      {/* Workspace */}
      <div className="workspace">
        {/* Canvas Container */}
        <div className="canvas-container">
          {/* Grid Background */}
          <div className="canvas-grid" />

          {/* Main Canvas */}
          <Canvas roomId={roomId} className="canvas" />

          {/* Floating UI elements */}
          <ToolPanel onToast={showToast} />
          <ColorSizeDock />
          <ZoomControls />
        </div>

        {/* Editor Panel (30% width) */}
        <EditorPanel />
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
        <ViewTransformProvider>
          <RoomCanvas roomId={roomId} />
        </ViewTransformProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
