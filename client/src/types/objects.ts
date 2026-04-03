import type * as Y from 'yjs';
import type { BBoxTuple } from './geometry';

// Object types - STRICT SEMANTIC SEPARATION
// stroke = pen/highlighter (ALWAYS Perfect Freehand polygon)
// shape = geometric shapes (ALWAYS polyline: rect/ellipse/line)
// text = text blocks (frame-based positioning)
// connector = connection lines/arrows (ALWAYS polyline)
export type ObjectKind =
  | 'stroke'
  | 'shape'
  | 'text'
  | 'connector'
  | 'code'
  | 'image'
  | 'note'
  | 'bookmark';

// Lightweight handle pointing to Y.Map
export interface ObjectHandle {
  id: string;
  kind: ObjectKind;
  y: Y.Map<unknown>; // Direct Y.Map reference
  bbox: BBoxTuple; // Computed locally, NOT stored in Y.Map
}

// Spatial index entry (minimal)
export interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  kind: ObjectKind;
  // NO data field - lookup via objectsById
}
