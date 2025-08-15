import { useState } from 'react';
import { UsersModal } from './UsersModal.js';

interface User {
  id: string;
  name: string;
  color: string;
  initials: string;
  activity?: 'idle' | 'drawing' | 'typing';
}

interface UsersAvatarStackProps {
  users?: User[];
}

export function UsersAvatarStack({ users = [] }: UsersAvatarStackProps) {
  const [showModal, setShowModal] = useState(false);

  const displayUsers = users.slice(0, 4);
  const remainingCount = users.length - displayUsers.length;

  return (
    <>
      <div
        id="usersBtn"
        data-testid="users-avatar-stack"
        onClick={() => setShowModal(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          gap: '8px',
        }}
      >
        <span style={{ fontSize: '14px', color: 'var(--ink-secondary)' }}>{users.length}</span>
        {displayUsers.map((user, index) => (
          <div
            key={user.id}
            className="avatar"
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '999px',
              background: user.color,
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 700,
              fontSize: '12px',
              marginLeft: index > 0 ? '-8px' : '0',
              border: '2px solid var(--surface)',
              zIndex: displayUsers.length - index,
            }}
          >
            {user.initials}
          </div>
        ))}
        {remainingCount > 0 && (
          <div
            className="avatar"
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '999px',
              background: 'var(--ink-tertiary)',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 700,
              fontSize: '12px',
              marginLeft: '-8px',
              border: '2px solid var(--surface)',
            }}
          >
            +{remainingCount}
          </div>
        )}
      </div>

      {showModal && <UsersModal users={users} onClose={() => setShowModal(false)} />}
    </>
  );
}
