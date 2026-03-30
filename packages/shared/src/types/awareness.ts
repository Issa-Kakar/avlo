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
  seq: number; // monotonic sequence per-sender
}

// Presence view derived from awareness
export interface PresenceView {
  users: Map<
    UserId,
    {
      name: string;
      color: string;
      cursor?: { x: number; y: number };
    }
  >;
  localUserId: UserId;
}
