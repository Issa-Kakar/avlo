import { useEffect, useRef } from 'react';

interface User {
  id: string;
  name: string;
  color: string;
  initials: string;
  activity?: 'idle' | 'drawing' | 'typing';
}

interface UsersModalProps {
  users: User[];
  onClose: () => void;
}

export function UsersModal({ users, onClose }: UsersModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    closeButtonRef.current?.focus();

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEsc);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.removeEventListener('mousedown', handleClickOutside);
      previousFocus.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      id="usersModal"
      className="modal-overlay active"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-labelledby="modal-title"
        style={{
          background: 'var(--surface)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
          maxWidth: '480px',
          width: '90%',
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          className="modal-header"
          style={{
            padding: 'var(--space-4)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div
            id="modal-title"
            className="modal-title"
            style={{ fontSize: '18px', fontWeight: 700, color: 'var(--ink)' }}
          >
            Active Users
          </div>
          <button
            ref={closeButtonRef}
            id="closeUsersModal"
            className="modal-close"
            aria-label="Close modal"
            onClick={onClose}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--ink-secondary)',
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <div
          className="modal-body"
          style={{
            padding: 'var(--space-4)',
            overflowY: 'auto',
            flex: 1,
          }}
        >
          <div
            className="users-list"
            style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
          >
            {users.map((user) => (
              <div
                key={user.id}
                className="user-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px',
                  background: 'var(--panel)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <div
                  className="user-avatar"
                  style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '999px',
                    background: user.color,
                    display: 'grid',
                    placeItems: 'center',
                    fontWeight: 700,
                    color: '#fff',
                    fontSize: '14px',
                    flexShrink: 0,
                  }}
                >
                  {user.initials}
                </div>
                <div className="user-info" style={{ flex: 1 }}>
                  <div
                    className="user-name"
                    style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '14px' }}
                  >
                    {user.name}
                  </div>
                  <div
                    className="user-status"
                    style={{
                      fontSize: '12px',
                      color: 'var(--ink-tertiary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      marginTop: '2px',
                    }}
                  >
                    <span
                      className={`status-dot ${user.activity === 'idle' ? 'idle' : ''}`}
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: user.activity === 'idle' ? '#FCD34D' : '#10B981',
                      }}
                    />
                    {user.activity === 'idle'
                      ? 'Idle'
                      : user.activity === 'drawing'
                        ? 'Currently drawing'
                        : user.activity === 'typing'
                          ? 'Typing code'
                          : 'Active'}
                  </div>
                </div>
                <button
                  id="searchUsersBtn"
                  className="search-btn"
                  aria-label="Search users"
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    color: 'var(--ink-secondary)',
                    display: 'grid',
                    placeItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="10" cy="8" r="5" />
                    <path d="M2 21a8 8 0 0 1 10.434-7.62" />
                    <circle cx="18" cy="18" r="3" />
                    <path d="m22 22-1.9-1.9" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
