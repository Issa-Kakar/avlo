import { useMemo, useEffect, useCallback } from 'react';
import { usePresence } from '@/hooks/use-presence';

interface UsersModalProps {
  roomId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function UsersModal({ roomId, isOpen, onClose }: UsersModalProps) {
  const presence = usePresence(roomId);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Memoize user entries for stable rendering
  const { userEntries, activeCount, typingCount } = useMemo(() => {
    // Get entries (userId, user) for stable React keys
    const entries = Array.from(presence.users.entries());
    const drawing = entries.filter(([_, u]) => u.activity === 'drawing').length;
    const typing = entries.filter(([_, u]) => u.activity === 'typing').length;

    return {
      userEntries: entries,
      activeCount: drawing,
      typingCount: typing,
    };
  }, [presence.users]);

  // Format last seen time
  const formatLastSeen = useCallback((lastSeen: number): string => {
    const now = Date.now();
    const diff = now - lastSeen;

    if (diff < 5000) return 'now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return 'inactive';
  }, []);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg-primary)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-lg)',
          maxWidth: '400px',
          width: '90%',
          border: '1px solid var(--border-light)',
          boxShadow: 'var(--shadow-xl)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 'var(--space-md)',
          }}
        >
          <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>
            Active Users ({userEntries.length})
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close modal">
            <svg className="icon" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            gap: '8px',
            marginBottom: '16px',
          }}
        >
          {activeCount > 0 && (
            <span
              style={{
                padding: '4px 8px',
                backgroundColor: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '12px',
                color: 'var(--text-secondary)',
              }}
            >
              ✏️ Drawing {activeCount}
            </span>
          )}
          {typingCount > 0 && (
            <span
              style={{
                padding: '4px 8px',
                backgroundColor: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '12px',
                color: 'var(--text-secondary)',
              }}
            >
              ⌨️ Typing {typingCount}
            </span>
          )}
        </div>

        <div
          style={{
            maxHeight: '384px',
            overflowY: 'auto',
          }}
        >
          {userEntries.map(([userId, user]) => (
            <div
              key={userId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '8px',
                borderRadius: 'var(--radius-sm)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <div
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  backgroundColor: user.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, color: 'var(--text-primary)' }}>{user.name}</span>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginRight: '8px' }}>
                {user.activity}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--text-weak)', opacity: 0.7 }}>
                {formatLastSeen(user.lastSeen)}
              </span>
            </div>
          ))}
        </div>

        {userEntries.length === 0 && (
          <p
            style={{
              color: 'var(--text-secondary)',
              textAlign: 'center',
              padding: '32px 0',
            }}
          >
            No other users connected
          </p>
        )}
      </div>
    </div>
  );
}
