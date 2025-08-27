import { UserId } from './identifiers';

// Ephemeral awareness data - NEVER persisted
export interface Awareness {
  userId: UserId;
  name: string;
  color: string; // User's cursor/badge color
  cursor?: {
    // Optional cursor position
    x: number; // world coordinates (always)
    y: number; // world coordinates (always)
  };
  activity: 'idle' | 'drawing' | 'typing';
  seq: number; // monotonic sequence per-sender
  ts: number; // send time ms epoch
  aw_v?: number; // awareness version for evolution
}

// Presence view derived from awareness
export interface PresenceView {
  users: Map<
    UserId,
    {
      name: string;
      color: string;
      cursor?: { x: number; y: number };
      activity: string;
      lastSeen: number;
    }
  >;
  localUserId: UserId;
}
