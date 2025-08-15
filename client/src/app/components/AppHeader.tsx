import { ThemeToggle } from './ThemeToggle.js';
import { ConnectionChip, ConnectionState } from './ConnectionChip.js';
import { UsersAvatarStack } from './UsersAvatarStack.js';
import { CopyLinkButton } from './CopyLinkButton.js';

interface AppHeaderProps {
  connectionState?: ConnectionState;
  users?: Array<{
    id: string;
    name: string;
    color: string;
    initials: string;
    activity?: 'idle' | 'drawing' | 'typing';
  }>;
  roomTitle?: string;
}

export function AppHeader({
  connectionState = 'Online',
  users = [],
  roomTitle = 'Untitled Room',
}: AppHeaderProps) {
  return (
    <header
      className="workspace-header"
      style={{
        height: '64px',
        position: 'sticky',
        top: 0,
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 var(--space-3)',
        background: 'var(--header-bg)',
        WebkitBackdropFilter: 'blur(12px)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        className="header-left"
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}
      >
        <a
          className="logo"
          href="/"
          aria-label="Avlo Home"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            textDecoration: 'none',
            color: 'var(--ink)',
          }}
        >
          <div
            className="logo-icon"
            style={{
              width: '36px',
              height: '36px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--button-grad)',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 800,
              boxShadow: 'var(--shadow-md)',
            }}
          >
            ao
          </div>
          <div className="logo-text" style={{ fontWeight: 700, letterSpacing: '-0.02em' }}>
            Avlo
          </div>
        </a>
        <input
          className="room-title"
          value={roomTitle}
          aria-label="Room title (editable)"
          readOnly
          style={{
            background: 'transparent',
            border: '1px solid transparent',
            padding: '8px 10px',
            borderRadius: 'var(--radius-sm)',
            fontWeight: 600,
            width: '240px',
            color: 'var(--ink)',
          }}
        />
      </div>

      <div className="header-center" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <ConnectionChip state={connectionState} />
      </div>

      <div className="header-right" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <UsersAvatarStack users={users} />
        <CopyLinkButton />
        <button
          className="btn btn-secondary"
          id="export"
          data-testid="export"
          aria-disabled="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            opacity: 0.5,
            cursor: 'not-allowed',
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
            <path d="M12 3v12" />
            <path d="m17 8-5-5-5 5" />
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          </svg>
          Export
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}
