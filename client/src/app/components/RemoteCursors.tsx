import React from 'react';
import { UserPresence } from '../../collaboration/RoomSnapshot.js';
import './RemoteCursors.css';

interface RemoteCursorsProps {
  users: ReadonlyMap<string, UserPresence>;
  mobileViewOnly: boolean;
}

export function RemoteCursors({ users, mobileViewOnly }: RemoteCursorsProps) {
  if (mobileViewOnly) return null;

  // Cap at 20 remote cursors as per spec
  const maxCursors = 20;
  let cursorCount = 0;

  return (
    <div className="remote-cursors">
      {Array.from(users.values()).map((user) => {
        if (!user.cursor || cursorCount >= maxCursors) return null;
        cursorCount++;

        return (
          <div
            key={user.id}
            className="remote-cursor"
            style={
              {
                transform: `translate(${user.cursor.x}px, ${user.cursor.y}px)`,
                '--cursor-color': user.color,
              } as React.CSSProperties
            }
          >
            <div className="cursor-pointer" />
            <div className="cursor-name">{user.name}</div>
          </div>
        );
      })}
    </div>
  );
}
