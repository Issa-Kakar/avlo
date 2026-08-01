import type { ZKey } from '@avlo/shared';
import type * as Y from 'yjs';
import type { BBoxTuple, FrameTuple } from './geometry';

// Object types - STRICT SEMANTIC SEPARATION
// stroke = pen/highlighter (ALWAYS Perfect Freehand polygon)
// shape = geometric shapes (ALWAYS polyline: rect/ellipse/line)
// text = text blocks (frame-based positioning)
// connector = connection lines/arrows (ALWAYS polyline)
export const OBJECT_KINDS = ['stroke', 'shape', 'text', 'connector', 'code', 'image', 'note', 'bookmark'] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

// Lightweight handle pointing to Y.Map. The handle is NOT the spatial-index entry —
// the FlatRTree (`core/spatial/spatial-tree.ts`) is keyed by `slot`, and queries
// recover handles via the slot table's reverse map. `bbox` + `slot` are the geometry
// links: the tuple for in-place object readers, the global bbox column
// (`getBBoxColumn()`, `slot * 4`) for typed-array paths — kept identical by
// RoomDocManager's tripartite write (tuple + column + tree, `upsertHandle` only).
export interface ObjectHandle {
  id: string;
  // Mirror of `y.get('kind')`. Mutated ONLY by the deep observer's kind-keychange
  // branch (in-place cross-kind conversion: text ↔ note ↔ shape).
  kind: ObjectKind;
  y: Y.Map<unknown>; // Direct Y.Map reference
  bbox: BBoxTuple; // Computed locally, NOT stored in Y.Map
  // Fractional z-key (mirror of y.get('z')). Mutated only by the deep observer's z-key-edit branch.
  z: ZKey;
  // Index into the slot-table columns (`core/slots/slot-table.ts`) — the app-wide dense id
  // space (rank table, lock columns, reverse map, global bbox column, spatial tree all key
  // off it). Acquired once at creation, never reassigned; returned to the pool on delete
  // (LIFO reuse).
  slot: number;
}

export function createHandle(
  id: string,
  kind: ObjectKind,
  y: Y.Map<unknown>,
  bbox: Readonly<BBoxTuple>,
  z: ZKey,
  slot: number,
): ObjectHandle {
  return {
    id,
    kind,
    y,
    bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
    z,
    slot,
  };
}

// ============================================================================
// BINDABLE KINDS — connectable targets (everything except stroke/connector)
// ============================================================================

export type BindableKind = Extract<ObjectKind, 'shape' | 'text' | 'code' | 'image' | 'note' | 'bookmark'>;
export type UnbindableKind = Exclude<ObjectKind, BindableKind>;

export const BINDABLE_KINDS: readonly BindableKind[] = ['shape', 'text', 'code', 'image', 'note', 'bookmark'] as const;

const BINDABLE_SET: ReadonlySet<ObjectKind> = new Set(BINDABLE_KINDS);
export const isBindableKind = (k: ObjectKind): k is BindableKind => BINDABLE_SET.has(k);

/** Two `===` checks beat the 6-element Set lookup `isBindableKind` does in propagation hot loops. */
export const isUnbindableKind = (k: ObjectKind): k is UnbindableKind => k === 'stroke' || k === 'connector';

export type BindableHandle = ObjectHandle & { kind: BindableKind };
export const isBindableHandle = (h: ObjectHandle | null | undefined): h is BindableHandle => !!h && isBindableKind(h.kind);

// ============================================================================
// COMMON TYPES
// ============================================================================

/** Cardinal direction type */
export type Dir = 'N' | 'E' | 'S' | 'W';

/**
 * Anchor data stored in Y.map for connected endpoints.
 *
 * Discriminated by the parent connector's `connectorType`:
 * - Elbow stores `{ id, anchor }` only. `side` is derived at route time from
 *   `(anchor + live frame + shapeType)` via `projectAnchorToEdge` — never persisted.
 *   Old Y.Maps may still carry a `side` field on elbow anchors; readers ignore it,
 *   writers omit it.
 * - Straight stores `{ id, interior, anchor }`. `interior` is committed at snap
 *   time (committed user intent — center vs edge); not derivable from coords alone.
 *
 * Narrow with `'interior' in anchor`, or cast via the parent's `connectorType`.
 */
export interface StoredElbowAnchor {
  id: string;
  anchor: [number, number];
}
export interface StoredStraightAnchor {
  id: string;
  interior: boolean;
  anchor: [number, number];
}
export type StoredAnchor = StoredElbowAnchor | StoredStraightAnchor;

/**
 * Connector endpoint stored in Y.Map. Discriminated by `Array.isArray`:
 * - `[number, number]` — free Point
 * - `StoredAnchor`     — bound to a shape (StoredElbowAnchor | StoredStraightAnchor by parent connectorType)
 */
export type ConnectorEndpoint = [number, number] | StoredAnchor;

/** Connector routing style */
export type ConnectorType = 'elbow' | 'straight';

/** Connector endpoint cap style */
export type ConnectorCap = 'arrow' | 'none';

// ============================================================================
// TEXT TYPES
// ============================================================================

export type TextAlign = 'left' | 'center' | 'right';
export type TextAlignV = 'top' | 'middle' | 'bottom';
export type TextWidth = 'auto' | number;
export type FontFamily = 'Grandstander' | 'Inter' | 'Lora' | 'JetBrains Mono';

export interface TextProps {
  content: Y.XmlFragment;
  origin: [number, number];
  fontSize: number;
  fontFamily: FontFamily;
  align: TextAlign;
  width: TextWidth;
}

// ============================================================================
// CODE TYPES
// ============================================================================

export type CodeLanguage = 'javascript' | 'typescript' | 'python';

export interface CodeProps {
  content: Y.Text;
  origin: [number, number];
  fontSize: number;
  width: number;
  language: CodeLanguage;
  lineNumbers: boolean;
  title: string | undefined;
  headerVisible: boolean;
  outputVisible: boolean;
  output: string | undefined;
}

// ============================================================================
// STROKE TYPES
// ============================================================================

export interface StrokeProps {
  points: [number, number][];
  color: string;
  width: number;
  opacity: number;
  tool: 'pen' | 'highlighter';
}

// ============================================================================
// SHAPE TYPES
// ============================================================================

export interface ShapeProps {
  shapeType: string;
  frame: FrameTuple;
  color: string;
  width: number;
  opacity: number;
  fillColor: string | undefined;
}

// ============================================================================
// NOTE TYPES
// ============================================================================

export interface NoteProps {
  content: Y.XmlFragment;
  origin: [number, number];
  scale: number;
  fontFamily: FontFamily;
  align: TextAlign;
  alignV: TextAlignV;
  fillColor: string;
}

// ============================================================================
// IMAGE TYPES
// ============================================================================

export interface ImageProps {
  assetId: string;
  frame: FrameTuple;
  naturalWidth: number;
  naturalHeight: number;
  mimeType: string;
}

// ============================================================================
// BOOKMARK TYPES
// ============================================================================

export interface BookmarkProps {
  url: string;
  domain: string;
  origin: [number, number];
  scale: number;
  height: number;
  title?: string;
  description?: string;
  ogImageAssetId?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  faviconAssetId?: string;
}
