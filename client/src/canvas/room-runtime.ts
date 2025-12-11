/**
 * Room Runtime - Module-level room context
 *
 * Provides imperative access to the active room context for tools,
 * render loops, and other non-React code.
 *
 * Key principles:
 * - Single active room at a time (one Canvas mounted)
 * - Fail-fast on missing room (throws, not returns null)
 * - Matches camera-store.ts pattern (module-level state + pure getters)
 *
 * @module canvas/room-runtime
 */

import type { RoomId } from '@avlo/shared';
import type { IRoomDocManager } from '@/lib/room-doc-manager';

interface RoomContext {
  roomId: RoomId;
  roomDoc: IRoomDocManager;
}

let activeRoom: RoomContext | null = null;

/**
 * Set the active room context. Called by Canvas.tsx in useLayoutEffect.
 * @param context - Room context or null when unmounting
 */
export function setActiveRoom(context: RoomContext | null): void {
  activeRoom = context;
}

/**
 * Get the active room context. Throws if no room is active.
 * Safe to call from tools, render loops, event handlers - any imperative code.
 */
export function getActiveRoom(): RoomContext {
  if (!activeRoom) {
    throw new Error('getActiveRoom(): no active room - ensure Canvas mounted and setActiveRoom called');
  }
  return activeRoom;
}

/**
 * Get the active room's IRoomDocManager.
 * Convenience wrapper for getActiveRoom().roomDoc
 */
export function getActiveRoomDoc(): IRoomDocManager {
  return getActiveRoom().roomDoc;
}

/**
 * Get the active room's ID.
 * Convenience wrapper for getActiveRoom().roomId
 */
export function getActiveRoomId(): RoomId {
  return getActiveRoom().roomId;
}

/**
 * Check if a room is currently active (for guards/conditionals).
 */
export function hasActiveRoom(): boolean {
  return activeRoom !== null;
}
