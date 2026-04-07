import { ObjectHandle } from './objects';
import { ObjectSpatialIndex } from '../spatial';

// Forward declare the ObjectSpatialIndex interface
export interface ObjectSpatialIndexShape {
  insert(id: string, bbox: [number, number, number, number], kind: string): void;
  update(id: string, oldBBox: [number, number, number, number], newBBox: [number, number, number, number], kind: string): void;
  remove(id: string, bbox: [number, number, number, number]): void;
  query(bounds: { minX: number; minY: number; maxX: number; maxY: number }): any[];
  bulkLoad(handles: ObjectHandle[]): void;
  clear(): void;
}

// Snapshot - immutable view of Y.Doc state (no presence, no view)
// This is the event-driven snapshot type - published immediately on Y.Doc changes
export interface Snapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>; // Live references
  spatialIndex: ObjectSpatialIndexShape;
}

// View transform for coordinate conversion
export interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number; // world px → canvas px
  pan: { x: number; y: number }; // world offset
}

// Helper to create empty snapshot
export function createEmptySnapshot(): Snapshot {
  return {
    docVersion: 0,
    objectsById: new Map<string, ObjectHandle>(),
    spatialIndex: new ObjectSpatialIndex(),
  };
}
