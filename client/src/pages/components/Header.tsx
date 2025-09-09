import React, { useState } from 'react';
import { useClearScene } from '../../hooks/useRoomIntegration';
import { usePresence } from '../../hooks/use-presence';

interface HeaderProps {
  roomId: string;
  onThemeToggle?: () => void;
  onShare?: () => void;
  onExport?: () => void;
  onUsersClick?: () => void;
  onToast?: (message: string) => void;
}

export function Header({
  roomId,
  onThemeToggle,
  onShare,
  onExport,
  onUsersClick,
  onToast,
}: HeaderProps) {
  const [roomTitle, setRoomTitle] = useState('Untitled Room');
  const clearScene = useClearScene(roomId);
  const presence = usePresence(roomId);
  const userCount = presence.users.size + 1; // +1 for self

  const handleClearBoard = () => {
    if (window.confirm('Clear the board for everyone? This cannot be undone.')) {
      try {
        clearScene?.();
        onToast?.('Board cleared');
      } catch (error) {
        console.error('Failed to clear board:', error);
        onToast?.('Failed to clear board');
      }
    }
  };

  const handleShare = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(window.location.href);
      onToast?.('Link copied to clipboard');
    }
    onShare?.();
  };

  const handleExport = () => {
    onToast?.('Exporting canvas...');
    // Simulate export process
    setTimeout(() => onToast?.('Export complete'), 1200);
    onExport?.();
  };

  return (
    <header className="header">
      <div className="header-left">
        <a href="#" className="logo">
          <img
            src="/avlo_logo_4k.png"
            alt="Avlo"
            className="logo-mark"
            style={{ width: 28, height: 28, objectFit: 'contain', display: 'block' }}
          />
        </a>
        <input
          type="text"
          className="room-title"
          value={roomTitle}
          onChange={(e) => setRoomTitle(e.target.value)}
          placeholder="Room title..."
        />
      </div>

      <div className="header-center">
        <div className="status-chip">
          <span className="status-dot"></span>
          <span>Connected</span>
        </div>
      </div>

      <div className="header-right">
        {/* Users Row */}
        <div
          className="users-row"
          onClick={onUsersClick}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 8px',
              backgroundColor: 'var(--bg-secondary)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '12px',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-light)',
            }}
          >
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor: '#10b981',
              }}
            />
            {userCount} {userCount === 1 ? 'user' : 'users'}
          </div>
          <div
            className="user-avatar"
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '999px',
              background: '#3B82F6',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontSize: '11px',
              fontWeight: '600',
              border: '2px solid var(--bg-primary)',
            }}
          >
            ME
          </div>
        </div>

        {/* Action Buttons */}
        <button className="btn btn-ghost" onClick={handleShare}>
          <svg className="icon icon-sm" viewBox="0 0 24 24">
            <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" />
          </svg>
          Share
        </button>

        <button className="btn btn-primary" onClick={handleExport}>
          <svg className="icon icon-sm" viewBox="0 0 24 24">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          Export
        </button>

        <button className="btn btn-clear" onClick={handleClearBoard}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            className="lucide lucide-trash2-icon lucide-trash-2"
          >
            <path d="M10 11v6" />
            <path d="M14 11v6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          Clear
        </button>

        <button className="icon-btn" onClick={onThemeToggle}>
          <svg className="icon" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="5" />
            <path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24" />
          </svg>
        </button>
      </div>
    </header>
  );
}
