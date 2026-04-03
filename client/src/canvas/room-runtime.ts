/**
 * Room Runtime - Module-level room context
 *
 * Provides imperative access to the active room context for tools,
 * render loops, and other non-React code.
 *
 * Key principles:
 * - Single active room at a time (one Canvas mounted)
 * - Fail-fast on missing room (throws, not returns null)
 * - connectRoom() / disconnectRoom() controlled by route lifecycle
 *
 * @module canvas/room-runtime
 */

import type { RoomId } from '@avlo/shared';
import type { Snapshot } from '@/types/snapshot';
import type { PresenceView } from '@/types/awareness';
import type { IRoomDocManager } from '@/lib/room-doc-manager';
import { RoomDocManagerImpl } from '@/lib/room-doc-manager';

interface RoomContext {
  roomId: RoomId;
  roomDoc: IRoomDocManager;
}

let activeRoom: RoomContext | null = null;

/**
 * Connect to a room. Idempotent — same roomId is a no-op.
 * Different roomId auto-disconnects the previous room first.
 * Called from route beforeLoad.
 */
export function connectRoom(roomId: RoomId): void {
  if (activeRoom?.roomId === roomId) return;
  if (activeRoom) {
    activeRoom.roomDoc.destroy();
  }
  const roomDoc = new RoomDocManagerImpl(roomId);
  activeRoom = { roomId, roomDoc };
}

/**
 * Disconnect the active room. Optional roomId guard prevents stale cleanup.
 * Called from RoomPage cleanup effect.
 */
export function disconnectRoom(roomId?: RoomId): void {
  if (!activeRoom) return;
  if (roomId !== undefined && activeRoom.roomId !== roomId) return;
  activeRoom.roomDoc.destroy();
  activeRoom = null;
}

/**
 * Get the active room context. Throws if no room is active.
 * Safe to call from tools, render loops, event handlers - any imperative code.
 */
export function getActiveRoom(): RoomContext {
  if (!activeRoom) {
    throw new Error(
      'getActiveRoom(): no active room - ensure connectRoom() was called from route beforeLoad',
    );
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

/**
 * Get the current snapshot from the active room.
 * Convenience wrapper for getActiveRoomDoc().currentSnapshot
 * Use this in render loops and tools to avoid prop drilling.
 */
export function getCurrentSnapshot(): Snapshot {
  return getActiveRoomDoc().currentSnapshot;
}

/**
 * Get the current presence view from the active room.
 * Convenience wrapper for getActiveRoomDoc().currentPresence
 * Use this in overlay rendering for cursor positions.
 */
export function getCurrentPresence(): PresenceView {
  return getActiveRoomDoc().currentPresence;
}

// ============================================
// PRESENCE CURSOR HELPERS
// ============================================

/**
 * Update the presence cursor position.
 * Called from CanvasRuntime on pointer move.
 */
export function updatePresenceCursor(worldX: number, worldY: number): void {
  getActiveRoomDoc().updateCursor(worldX, worldY);
}

/**
 * Clear the presence cursor (pointer left canvas).
 * Called from CanvasRuntime on pointer leave.
 */
export function clearPresenceCursor(): void {
  getActiveRoomDoc().updateCursor(undefined, undefined);
}

// ============================================
// OBJECTS MAP CONVENIENCE GETTER
// ============================================

/**
 * Get the top-level objects Y.Map from the active room.
 * Convenience wrapper for getActiveRoomDoc().objects
 */
export function getObjects(): ReturnType<typeof getActiveRoomDoc>['objects'] {
  return getActiveRoomDoc().objects;
}

// ============================================
// CONNECTOR LOOKUP RE-EXPORTS
// ============================================

// Re-export connector lookup for imperative access (SelectTool, EraserTool)
export { getConnectorsForShape, hasConnectorLookup } from '../lib/connectors';
