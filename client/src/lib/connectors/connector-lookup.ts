/**
 * Connector Lookup - Reverse map from shapes to their anchored connectors.
 *
 * Maintained incrementally via Y.js observer hooks from RoomDocManager.
 * Provides O(1) lookup for SelectTool transforms and EraserTool deletions.
 */

import type { ObjectHandle } from '@/types/objects';
import { getStartAnchor, getEndAnchor } from '@/lib/object-accessors';
import type * as Y from 'yjs';

// ============================================================
// Module-Level State
// ============================================================

/** Map from shapeId → Set of connectorIds anchored to that shape */
let shapeToConnectors: Map<string, Set<string>> | null = null;

/** Track current anchor state per connector for delta computation */
let connectorAnchors: Map<string, { startId: string | null; endId: string | null }> | null = null;

// ============================================================
// Lifecycle Functions (called by RoomDocManager)
// ============================================================

/** Initialize empty maps. Called once before first hydration. */
export function initConnectorLookup(): void {
  shapeToConnectors = new Map();
  connectorAnchors = new Map();
}

/**
 * Populate maps from current objectsById during rebuild epoch.
 * Called by hydrateObjectsFromY() after handles are built.
 */
export function hydrateConnectorLookup(objectsById: ReadonlyMap<string, ObjectHandle>): void {
  if (!shapeToConnectors || !connectorAnchors) {
    initConnectorLookup();
  }
  shapeToConnectors!.clear();
  connectorAnchors!.clear();

  for (const handle of objectsById.values()) {
    if (handle.kind === 'connector') {
      registerConnectorAnchors(handle.id, handle.y);
    }
  }
}

/** Clear all state. Called by destroy(). */
export function clearConnectorLookup(): void {
  shapeToConnectors?.clear();
  connectorAnchors?.clear();
  shapeToConnectors = null;
  connectorAnchors = null;
}

// ============================================================
// Incremental Updates (called by applyObjectChanges)
// ============================================================

/** Handle new connector added to document. */
export function processConnectorAdded(connectorId: string, yObj: Y.Map<unknown>): void {
  if (!shapeToConnectors || !connectorAnchors) return;
  registerConnectorAnchors(connectorId, yObj);
}

/** Handle connector update (anchor may have changed). */
export function processConnectorUpdated(connectorId: string, yObj: Y.Map<unknown>): void {
  if (!shapeToConnectors || !connectorAnchors) return;

  const startAnchor = getStartAnchor(yObj);
  const endAnchor = getEndAnchor(yObj);

  const newStartId = startAnchor?.id ?? null;
  const newEndId = endAnchor?.id ?? null;

  const old = connectorAnchors.get(connectorId);
  const oldStartId = old?.startId ?? null;
  const oldEndId = old?.endId ?? null;

  // Compute unique shape sets (handles self-loop: both anchors → same shape)
  const oldShapes = uniqueShapeIds(oldStartId, oldEndId);
  const newShapes = uniqueShapeIds(newStartId, newEndId);

  // Remove from shapes no longer referenced
  for (const shapeId of oldShapes) {
    if (!newShapes.has(shapeId)) {
      removeConnectorFromShape(shapeId, connectorId);
    }
  }

  // Add to newly referenced shapes
  for (const shapeId of newShapes) {
    if (!oldShapes.has(shapeId)) {
      addConnectorToShape(shapeId, connectorId);
    }
  }

  // Update tracking state
  connectorAnchors.set(connectorId, { startId: newStartId, endId: newEndId });
}

/** Handle connector deleted from document. */
export function processConnectorDeleted(connectorId: string): void {
  if (!shapeToConnectors || !connectorAnchors) return;

  const state = connectorAnchors.get(connectorId);
  if (state) {
    if (state.startId) removeConnectorFromShape(state.startId, connectorId);
    if (state.endId) removeConnectorFromShape(state.endId, connectorId);
    connectorAnchors.delete(connectorId);
  }
}

/** Handle shape deleted - just remove the map entry. */
export function processShapeDeleted(shapeId: string): void {
  // Just clean up the lookup entry. The connectors themselves are updated
  // elsewhere (in the same transaction that deletes the shape).
  shapeToConnectors?.delete(shapeId);
}

// ============================================================
// Internal Helpers
// ============================================================

function registerConnectorAnchors(connectorId: string, yObj: Y.Map<unknown>): void {
  const startAnchor = getStartAnchor(yObj);
  const endAnchor = getEndAnchor(yObj);

  const startId = startAnchor?.id ?? null;
  const endId = endAnchor?.id ?? null;

  connectorAnchors!.set(connectorId, { startId, endId });

  if (startId) addConnectorToShape(startId, connectorId);
  if (endId) addConnectorToShape(endId, connectorId);
}

/** Deduplicate anchor IDs into a unique set (handles self-loop correctly). */
function uniqueShapeIds(startId: string | null, endId: string | null): Set<string> {
  const set = new Set<string>();
  if (startId) set.add(startId);
  if (endId) set.add(endId);
  return set;
}

function addConnectorToShape(shapeId: string, connectorId: string): void {
  let set = shapeToConnectors!.get(shapeId);
  if (!set) {
    set = new Set();
    shapeToConnectors!.set(shapeId, set);
  }
  set.add(connectorId);
}

function removeConnectorFromShape(shapeId: string, connectorId: string): void {
  const set = shapeToConnectors!.get(shapeId);
  if (set) {
    set.delete(connectorId);
    if (set.size === 0) {
      shapeToConnectors!.delete(shapeId);
    }
  }
}

// ============================================================
// Public Getter API (for SelectTool, EraserTool, etc.)
// ============================================================

/**
 * Get connector IDs anchored to a shape. Returns undefined if no connectors
 * or lookup not initialized.
 */
export function getConnectorsForShape(shapeId: string): ReadonlySet<string> | undefined {
  return shapeToConnectors?.get(shapeId);
}

/** Check if connector lookup is initialized and ready. */
export function hasConnectorLookup(): boolean {
  return shapeToConnectors !== null;
}
