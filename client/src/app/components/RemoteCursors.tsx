import { useEffect, useState, useRef } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import './RemoteCursors.css';

interface CursorPosition {
  x: number;
  y: number;
}

interface RemoteUser {
  id: string;
  name: string;
  color: string;
  cursor: CursorPosition | null;
}

interface CursorTrail {
  userId: string;
  points: CursorPosition[];
}

export function RemoteCursors({
  awareness,
  maxCursors = 20,
  showTrails = true,
}: {
  awareness: Awareness | undefined;
  maxCursors?: number;
  showTrails?: boolean;
}) {
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([]);
  const trailsRef = useRef<Map<string, CursorPosition[]>>(new Map());
  const [trails, setTrails] = useState<CursorTrail[]>([]);

  useEffect(() => {
    if (!awareness) return;

    const updateUsers = () => {
      const states = awareness.getStates();
      const users: RemoteUser[] = [];
      const clientId = awareness.clientID;

      states.forEach((state, id) => {
        // Skip local user
        if (id === clientId) return;

        const user = state.user;
        if (user && user.cursor) {
          users.push({
            id: id.toString(),
            name: user.name || 'Anonymous',
            color: user.color || '#94A3B8',
            cursor: user.cursor,
          });
        }
      });

      // Limit to maxCursors
      const limitedUsers = users.slice(0, maxCursors);
      setRemoteUsers(limitedUsers);

      // Update trails for desktop only
      if (showTrails) {
        const newTrails: CursorTrail[] = [];
        limitedUsers.forEach((user) => {
          if (!user.cursor) return;

          // Get or create trail for this user
          let trail = trailsRef.current.get(user.id);
          if (!trail) {
            trail = [];
            trailsRef.current.set(user.id, trail);
          }

          // Add new point to trail
          trail.push({ x: user.cursor.x, y: user.cursor.y });

          // Keep only last 24 points
          if (trail.length > 24) {
            trail.shift();
          }

          newTrails.push({
            userId: user.id,
            points: [...trail],
          });
        });

        // Clean up trails for users who left
        const activeUserIds = new Set(limitedUsers.map((u) => u.id));
        trailsRef.current.forEach((_, userId) => {
          if (!activeUserIds.has(userId)) {
            trailsRef.current.delete(userId);
          }
        });

        setTrails(newTrails);
      }
    };

    updateUsers();
    awareness.on('change', updateUsers);

    return () => {
      awareness.off('change', updateUsers);
    };
  }, [awareness, maxCursors, showTrails]);

  return (
    <div className="remote-cursors" aria-hidden="true">
      {/* Render trails (desktop only) */}
      {showTrails &&
        trails.map((trail) => {
          const user = remoteUsers.find((u) => u.id === trail.userId);
          if (!user) return null;

          return (
            <svg
              key={`trail-${trail.userId}`}
              className="cursor-trail"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
              }}
            >
              <polyline
                points={trail.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={user.color}
                strokeWidth="2"
                strokeOpacity="0.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          );
        })}

      {/* Render cursors */}
      {remoteUsers.map((user) => {
        if (!user.cursor) return null;

        return (
          <div
            key={`cursor-${user.id}`}
            className="remote-cursor"
            style={{
              position: 'absolute',
              left: user.cursor.x,
              top: user.cursor.y,
              transform: 'translate(-4px, -4px)',
              pointerEvents: 'none',
              zIndex: 100,
            }}
          >
            {/* Cursor arrow */}
            <svg width="24" height="24" viewBox="0 0 24 24" style={{ display: 'block' }}>
              <path
                d="M5.65 5.53l9.95 7.14-3.86.88-.88 3.86z"
                fill={user.color}
                stroke="white"
                strokeWidth="1"
              />
            </svg>
            {/* User name label */}
            <div
              className="cursor-label"
              style={{
                position: 'absolute',
                top: '20px',
                left: '12px',
                background: user.color,
                color: 'white',
                padding: '2px 6px',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: '600',
                whiteSpace: 'nowrap',
                userSelect: 'none',
              }}
            >
              {user.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}
