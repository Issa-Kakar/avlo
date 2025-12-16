import { PresenceView } from './awareness';
import { ObjectHandle, DirtyPatch } from './objects';

// Forward declare the ObjectSpatialIndex interface
export interface ObjectSpatialIndex {
  insert(id: string, bbox: [number, number, number, number], kind: string): void;
  update(id: string, oldBBox: [number, number, number, number], newBBox: [number, number, number, number], kind: string): void;
  remove(id: string, bbox: [number, number, number, number]): void;
  query(bounds: { minX: number; minY: number; maxX: number; maxY: number }): any[];
  bulkLoad(handles: ObjectHandle[]): void;
  clear(): void;
}

// NEW: Doc-only snapshot (no presence, no view)
// This is the event-driven snapshot type - published immediately on Y.Doc changes
export interface DocSnapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;  // Live references
  spatialIndex: ObjectSpatialIndex | null;
  createdAt: number;
  dirtyPatch?: DirtyPatch | null;
}

// LEGACY: Full snapshot with presence (for backward compatibility)
// Will be deprecated once all consumers migrate to DocSnapshot + subscribePresence
export interface Snapshot extends DocSnapshot {
  presence: PresenceView;
  view: ViewTransform;  // DEAD CODE - camera-store is source of truth
}

// View transform for coordinate conversion
export interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number; // world px → canvas px
  pan: { x: number; y: number }; // world offset
}

// Helper to create empty doc snapshot (new event-driven type)
export function createEmptyDocSnapshot(): DocSnapshot {
  return {
    docVersion: 0,
    objectsById: new Map<string, ObjectHandle>(),
    spatialIndex: null,
    createdAt: Date.now(),
    dirtyPatch: null,
  };
}

// Empty snapshot constant shape (legacy - includes presence and view)
export function createEmptySnapshot(): Snapshot {
  return {
    ...createEmptyDocSnapshot(),
    presence: {
      users: new Map(),
      localUserId: '',
    },
    view: {
      worldToCanvas: (x: number, y: number): [number, number] => [x, y],
      canvasToWorld: (x: number, y: number): [number, number] => [x, y],
      scale: 1,
      pan: { x: 0, y: 0 },
    },
  };
}
