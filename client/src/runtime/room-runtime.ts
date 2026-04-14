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
import type { ObjectHandle, ObjectKind } from '@/core/types/objects';
import type { BBoxTuple } from '@/core/types/geometry';
import type { ObjectSpatialIndex } from '@/core/spatial';
import type { IRoomDocManager } from './room-doc-manager';
import { RoomDocManagerImpl } from './room-doc-manager';
import { useCameraStore } from '@/stores/camera-store';

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
  useCameraStore.getState().setRoom(roomId);
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
    throw new Error('getActiveRoom(): no active room - ensure connectRoom() was called from route beforeLoad');
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
// DIRECT DATA ACCESS HELPERS
// ============================================

export function getObjectsById(): ReadonlyMap<string, ObjectHandle> {
  return getActiveRoomDoc().objectsById;
}

export function getSpatialIndex(): ObjectSpatialIndex {
  return getActiveRoomDoc().spatialIndex;
}

export function getHandle(id: string): ObjectHandle | undefined {
  return getActiveRoomDoc().objectsById.get(id);
}

export function getHandleKind(id: string): ObjectKind | undefined {
  return getActiveRoomDoc().objectsById.get(id)?.kind;
}

export function getBbox(id: string): BBoxTuple | undefined {
  return getActiveRoomDoc().objectsById.get(id)?.bbox;
}

// ============================================
// MUTATION HELPERS
// ============================================

export function transact(fn: () => void): void {
  getActiveRoomDoc().mutate(fn);
}

export function undo(): void {
  getActiveRoomDoc().undo();
}

export function redo(): void {
  getActiveRoomDoc().redo();
}

// ============================================
// CONNECTOR LOOKUP RE-EXPORTS
// ============================================

// Re-export connector lookup for imperative access (SelectTool, EraserTool)
export { getConnectorsForShape, hasConnectorLookup } from '@/core/connectors';
