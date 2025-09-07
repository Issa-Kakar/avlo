import React from 'react';

interface UsersModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function UsersModal({ isOpen, onClose }: UsersModalProps) {
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
          <h3 style={{ margin: 0, color: 'var(--text-primary)' }}>Users in Room</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close modal">
            <svg className="icon" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div
          style={{
            color: 'var(--text-secondary)',
            textAlign: 'center',
            padding: 'var(--space-xl) 0',
          }}
        >
          Users list will be available in Phase 7 (Presence System)
        </div>
      </div>
    </div>
  );
}
