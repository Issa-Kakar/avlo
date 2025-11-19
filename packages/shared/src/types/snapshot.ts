import { PresenceView } from './awareness';
import { ROOM_CONFIG } from '../config';
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

// Immutable snapshot - NEVER null
export interface Snapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;  // Live references
  spatialIndex: ObjectSpatialIndex | null;
  presence: PresenceView;
  view: ViewTransform;
  meta: SnapshotMeta;
  createdAt: number;
  dirtyPatch?: DirtyPatch | null;
}

// View transform for coordinate conversion
export interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number; // world px → canvas px
  pan: { x: number; y: number }; // world offset
}

// Snapshot metadata
export interface SnapshotMeta {
  bytes?: number; // Last persisted compressed size
  cap: number; // Hard cap (15MB)
  readOnly: boolean; // True when room is at/above cap
  expiresAt?: number; // ms epoch TTL expiry
}

// Empty snapshot constant shape
export function createEmptySnapshot(): Snapshot {
  const emptyMap = new Map<string, ObjectHandle>();

  const snapshot: Snapshot = {
    docVersion: 0, // Empty snapshot has version 0
    objectsById: emptyMap,
    presence: {
      users: new Map(),
      localUserId: '',
    },
    spatialIndex: null,
    view: {
      worldToCanvas: (x: number, y: number): [number, number] => [x, y],
      canvasToWorld: (x: number, y: number): [number, number] => [x, y],
      scale: 1,
      pan: { x: 0, y: 0 },
    },
    meta: {
      cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
      readOnly: false,
    },
    createdAt: Date.now(),
    dirtyPatch: null,
  };

  return snapshot;
}
