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

// Lightweight handle pointing to Y.Map. The handle IS the rbush spatial-index item —
// `minX/minY/maxX/maxY` mirror `bbox[0..3]` and are kept in sync by `applyHandleBBox`
// (the only legal post-creation bbox mutator). rbush reads its envelope via the default
// `toBBox(item) = item`, so passing the handle directly satisfies its item shape.
export interface ObjectHandle {
  id: string;
  // Mirror of `y.get('kind')`. Mutated ONLY by the deep observer's kind-keychange
  // branch (in-place cross-kind conversion: text ↔ note ↔ shape).
  kind: ObjectKind;
  y: Y.Map<unknown>; // Direct Y.Map reference
  bbox: BBoxTuple; // Computed locally, NOT stored in Y.Map
  // rbush envelope mirrors — written ONLY by createHandle / applyHandleBBox. Mirror bbox[0..3].
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  // Fractional z-key (mirror of y.get('z')). Mutated only by the deep observer's z-key-edit branch.
  z: ZKey;
  // Stable index into ZRankTable._ranks. Assigned at creation by acquireSlot(); never reassigned.
  // Returns to the free-list on delete; future objects may reuse it.
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
    minX: bbox[0],
    minY: bbox[1],
    maxX: bbox[2],
    maxY: bbox[3],
    z,
    slot,
  };
}

/**
 * Mutate `handle.bbox` and the four rbush mirror fields together.
 *
 * CONTRACT: ONLY callable from `ObjectSpatialIndex.updateHandleBBox` (which has already
 * removed the handle from the rbush tree using the OLD envelope). Direct external call
 * corrupts the spatial index: the tree leaf still carries the old envelope, but the
 * handle's mirror fields now say "new", so the next `spatialIndex.remove(handle)` silently
 * no-ops (rbush descends to the wrong leaf) and the entry leaks.
 */
export function applyHandleBBox(handle: ObjectHandle, src: Readonly<BBoxTuple>): void {
  const b = handle.bbox;
  b[0] = handle.minX = src[0];
  b[1] = handle.minY = src[1];
  b[2] = handle.maxX = src[2];
  b[3] = handle.maxY = src[3];
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

export type CodeLanguage = 'javascript' | 'typescript' | 'python' | 'html' | 'css' | 'json' | 'sql';

/** How the last run ended — drives output-panel tint. Written only by
 * `transactPyOutput` (never undo-tracked). Values = PyRunStatus. */
export type CodeOutputStatus = 'ok' | 'error' | 'cancelled' | 'timeout' | 'unavailable' | 'oom';

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
  outputStatus: CodeOutputStatus | undefined;
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
