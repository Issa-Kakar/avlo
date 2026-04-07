import { useMemo } from 'react';
import { usePresenceStore } from '@/stores/presence-store';

export function UserAvatarCluster() {
  const peerIdentities = usePresenceStore((s) => s.peerIdentities);

  const usersWithIds = useMemo(() => {
    return Array.from(peerIdentities.entries()).map(([userId, identity]) => ({
      userId,
      ...identity,
    }));
  }, [peerIdentities]);

  const totalCount = usersWithIds.length + 1; // +1 for self
  const displayCount = Math.min(4, usersWithIds.length);
  const overflow = totalCount > 5;

  const getInitials = (name: string): string => {
    if (!name) return '?';
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  return (
    <div className="user-avatar-cluster">
      {usersWithIds.slice(0, displayCount).map((user) => (
        <div key={user.userId} className="micro-avatar" style={{ backgroundColor: user.color }} title={user.name}>
          <span className="micro-avatar-initials">{getInitials(user.name)}</span>
        </div>
      ))}

      <div className="micro-avatar micro-avatar-me" title="You">
        <span className="micro-avatar-initials">ME</span>
      </div>

      {overflow && (
        <span className="user-overflow" title={`${totalCount - 5} more users`}>
          +{totalCount - 5}
        </span>
      )}
    </div>
  );
}
