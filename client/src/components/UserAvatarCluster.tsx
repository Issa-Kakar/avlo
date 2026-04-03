import { useMemo } from 'react';
import { usePresence } from '@/hooks/use-presence';

export function UserAvatarCluster() {
  const presence = usePresence();

  // Get stable array of users with proper key tracking using Map entries
  const usersWithIds = useMemo(() => {
    // Convert Map entries to array, keeping userId as stable key
    const entries = Array.from(presence.users.entries());
    return entries.map(([userId, user]) => ({
      userId, // Stable React key from Map key
      ...user,
    }));
  }, [presence.users]);

  // Calculate counts
  const totalCount = usersWithIds.length + 1; // +1 for self
  const displayCount = Math.min(4, usersWithIds.length); // Show up to 4 others + ME
  const overflow = totalCount > 5;

  // Get initials from name for better display
  const getInitials = (name: string): string => {
    if (!name) return '?';
    const parts = name.split(' ');
    if (parts.length >= 2) {
      // Use first letter of first and last word
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  };

  return (
    <div className="user-avatar-cluster">
      {/* Show up to 4 other users with stable keys */}
      {usersWithIds.slice(0, displayCount).map((user) => (
        <div
          key={user.userId} // Use stable userId from Map key
          className="micro-avatar"
          style={{ backgroundColor: user.color }}
          title={user.name}
        >
          <span className="micro-avatar-initials">{getInitials(user.name)}</span>
        </div>
      ))}

      {/* Always show ME avatar last */}
      <div className="micro-avatar micro-avatar-me" title="You">
        <span className="micro-avatar-initials">ME</span>
      </div>

      {/* Show overflow count if more than 5 total users */}
      {overflow && (
        <span className="user-overflow" title={`${totalCount - 5} more users`}>
          +{totalCount - 5}
        </span>
      )}
    </div>
  );
}
