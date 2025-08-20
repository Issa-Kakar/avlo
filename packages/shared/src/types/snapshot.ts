import { SceneIdx, StrokeId, TextId } from './identifiers';
import { PresenceView } from './awareness';

// Immutable snapshot - NEVER null
export interface Snapshot {
  svKey: string; // base64 of Yjs state vector - keys IDB render snapshot
  scene: SceneIdx; // Current scene index
  strokes: ReadonlyArray<StrokeView>;
  texts: ReadonlyArray<TextView>;
  presence: PresenceView; // Derived + smoothed presence
  spatialIndex: RBushIndexView; // Read-only spatial index for hit-testing
  view: ViewTransform; // World-to-canvas transform
  meta: SnapshotMeta;
  createdAt: number; // ms epoch when snapshot was frozen
}

// Stroke view for rendering
export interface StrokeView {
  id: StrokeId;
  polyline: Float32Array | null; // Built at RENDER time ONLY from stored number[]
  // Will be null in snapshot, created during canvas render
  style: {
    color: string;
    size: number;
    opacity: number;
    tool: 'pen' | 'highlighter';
  };
  bbox: [number, number, number, number];
}

// Text view for rendering
export interface TextView {
  id: TextId;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  style: {
    color: string;
    size: number;
  };
}

// Spatial index view
export interface RBushIndexView {
  // Opaque structure - implementation detail
  // Will be populated by RBush library
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _tree?: any; // RBush internal structure
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
  cap: number; // Hard cap (10MB)
  readOnly: boolean; // True when room is at/above cap
  expiresAt?: number; // ms epoch TTL expiry
}

// Empty snapshot constant shape
export function createEmptySnapshot(): Snapshot {
  return Object.freeze({
    svKey: 'empty',
    scene: 0,
    strokes: Object.freeze([]),
    texts: Object.freeze([]),
    presence: {
      users: new Map(),
      localUserId: '',
    },
    spatialIndex: { _tree: null },
    view: {
      worldToCanvas: (x: number, y: number) => [x, y],
      canvasToWorld: (x: number, y: number) => [x, y],
      scale: 1,
      pan: { x: 0, y: 0 },
    },
    meta: {
      cap: 10 * 1024 * 1024, // 10MB
      readOnly: false,
    },
    createdAt: Date.now(),
  });
}
