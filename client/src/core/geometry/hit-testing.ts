/**
 * Hit Testing — object-aware layer over hit-primitives.ts + frameOf.
 *
 * Atoms compose into per-kind hit tests via mapped dispatch. Adding a new
 * ObjectKind = one table entry + one function; the mapped table makes it a
 * compile error until both are added.
 *
 * - testObjectHit: HitCandidate dispatch for point-based picking
 * - objectIntersectsRect: geometry-vs-bbox for marquee
 * - hitTestHandle: resize-handle hit test
 * - hitTestEndpointDots: connector endpoint dots (keeps Snapshot — downstream needs it)
 * - hitTestVisibleText/Code/Note: one-liners via scanTopmost
 */

import type { BBoxTuple } from '../types/geometry';
import type { ObjectHandle, ObjectKind, BindableKind } from '../types/objects';
import type { Snapshot } from '../types/snapshot';
import { getFrame, getPoints, getShapeType, getWidth, getFillColor } from '../accessors';
import { INTERIOR_PAINT } from '../types/objects';
import { useCameraStore } from '@/stores/camera-store';
import { queryHitCandidates } from '../spatial/object-query';
import { scanTopmost } from './object-pick';
import {
  getDiamondVertices,
  strokeHitTest,
  bboxesIntersect,
  polylineIntersectsBBox,
  ellipseIntersectsBBox,
  diamondIntersectsBBox,
  shapeHitTest,
  rectFrameHit,
  computePolylineArea,
} from './hit-primitives';
import { frameOf } from './frame-of';
import { getEndpointEdgePosition } from '../connectors/connector-utils';
import type { HandleId } from '@/tools/types';
import { computeHandles } from '@/stores/selection-store';

// ============================================================================
// HitCandidate — point hit result with Z-order classification fields
// ============================================================================

/**
 * Hit test result with classification for Z-order-aware selection.
 *
 * Carries the live handle so consumers can read kind/id/y without a registry
 * round-trip. Kind narrowing flows from `queryHitCandidates(kinds)` overload
 * through the `K` parameter into `accept`/`onSeeThrough` callbacks.
 *
 * Key behavior: An unfilled shape interior (handle.kind='shape', isFilled=false,
 * insideInterior=true) is treated as see-through — SelectTool scans through
 * to find paint underneath. Everything else with INTERIOR_PAINT[kind]=true
 * is treated as opaque throughout its bbox.
 */
export interface HitCandidate<K extends ObjectKind = ObjectKind> {
  readonly handle: ObjectHandle & { kind: K };
  readonly distance: number; // 0 if inside/on stroke
  readonly insideInterior: boolean; // Hit inside shape/text bounds (not edge)
  readonly area: number; // Bounding area — smaller = more nested = higher priority
  readonly isFilled: boolean; // Shape: !!fillColor. Others: INTERIOR_PAINT[kind].
}

// ============================================================================
// Per-kind hit functions — each consumes atoms from hit-primitives + frameOf
// ============================================================================

type HitFn<K extends ObjectKind> = (handle: ObjectHandle & { kind: K }, wx: number, wy: number, r: number) => HitCandidate | null;

/** Stroke and connector share the same polyline hit test. */
const hitTestStrokeLike: HitFn<'stroke' | 'connector'> = (handle, wx, wy, r) => {
  const points = getPoints(handle.y);
  if (points.length === 0) return null;
  const strokeWidth = getWidth(handle.y);
  const tolerance = r + strokeWidth / 2;
  if (!strokeHitTest([wx, wy], points, tolerance)) return null;
  return {
    handle,
    distance: 0,
    insideInterior: false,
    area: computePolylineArea(points),
    isFilled: true,
  };
};

const hitTestShape: HitFn<'shape'> = (handle, wx, wy, r) => {
  const frame = getFrame(handle.y);
  if (!frame) return null;
  const shapeType = getShapeType(handle.y);
  const strokeWidth = getWidth(handle.y, 1);
  const isFilled = !!getFillColor(handle.y);

  const result = shapeHitTest([wx, wy], r, frame, shapeType, strokeWidth);
  if (!result) return null;

  return {
    handle,
    distance: result.distance,
    insideInterior: result.insideInterior,
    area: frame[2] * frame[3],
    isFilled,
  };
};

/** Framed-rect hit test — text/note/code/image/bookmark. Uses frameOf. */
function hitTestFramed<K extends Exclude<BindableKind, 'shape'>>(
  handle: ObjectHandle & { kind: K },
  wx: number,
  wy: number,
  r: number,
): HitCandidate<K> | null {
  const frame = frameOf(handle);
  if (!frame) return null;
  const result = rectFrameHit([wx, wy], r, frame);
  if (!result) return null;

  // Text is the only framed kind with a conditional fill — every other bindable
  // framed kind is always "filled" per INTERIOR_PAINT.
  const isFilled = handle.kind === 'text' ? !!getFillColor(handle.y) : INTERIOR_PAINT[handle.kind];

  return {
    handle,
    distance: result.distance,
    insideInterior: result.insideInterior,
    area: frame[2] * frame[3],
    isFilled,
  };
}

const HIT_BY_KIND: { [K in ObjectKind]: HitFn<K> } = {
  stroke: hitTestStrokeLike as HitFn<'stroke'>,
  connector: hitTestStrokeLike as HitFn<'connector'>,
  shape: hitTestShape,
  text: hitTestFramed,
  note: hitTestFramed,
  code: hitTestFramed,
  image: hitTestFramed,
  bookmark: hitTestFramed,
};

/**
 * Test if a point hits an object, with full classification.
 *
 * SAFETY: mapped type proves per-kind correctness; one cast per dispatch.
 */
export function testObjectHit(wx: number, wy: number, r: number, handle: ObjectHandle): HitCandidate | null {
  return (HIT_BY_KIND[handle.kind] as HitFn<ObjectKind>)(handle, wx, wy, r);
}

// ============================================================================
// Marquee geometry intersection
// ============================================================================

/**
 * Check if an object's geometry intersects a bbox (marquee selection).
 * Tuple-first — callers convert WorldBounds once at entry.
 */
export function objectIntersectsRect(handle: ObjectHandle, bbox: BBoxTuple): boolean {
  switch (handle.kind) {
    case 'stroke':
    case 'connector': {
      const points = getPoints(handle.y);
      if (points.length === 0) return false;
      return polylineIntersectsBBox(points, bbox);
    }

    case 'shape': {
      const frame = getFrame(handle.y);
      if (!frame) return false;
      const shapeType = getShapeType(handle.y);
      const [x, y, w, h] = frame;
      switch (shapeType) {
        case 'ellipse':
          return ellipseIntersectsBBox(x + w / 2, y + h / 2, w / 2, h / 2, bbox);
        case 'diamond':
          return diamondIntersectsBBox(getDiamondVertices(frame), bbox);
        default: {
          const shapeBBox: BBoxTuple = [x, y, x + w, y + h];
          return bboxesIntersect(shapeBBox, bbox);
        }
      }
    }

    default: {
      // All remaining bindable kinds use their frame as an axis-aligned rect.
      const frame = frameOf(handle);
      if (!frame) return false;
      const [x, y, w, h] = frame;
      const frameBBox: BBoxTuple = [x, y, x + w, y + h];
      return bboxesIntersect(frameBBox, bbox);
    }
  }
}

// ============================================================================
// Handle hit testing (resize handles)
// ============================================================================

/** Screen-space hit radius for resize handles */
export const HANDLE_HIT_PX = 10;

export function hitTestHandle(worldX: number, worldY: number, bbox: BBoxTuple, scale: number): HandleId | null {
  const handleRadius = HANDLE_HIT_PX / scale;

  const corners = computeHandles(bbox);

  for (const h of corners) {
    const dx = worldX - h.x;
    const dy = worldY - h.y;
    if (dx * dx + dy * dy <= handleRadius * handleRadius) {
      return h.id;
    }
  }

  const edgeTolerance = handleRadius;

  if (Math.abs(worldY - bbox[1]) <= edgeTolerance && worldX > bbox[0] + handleRadius && worldX < bbox[2] - handleRadius) {
    return 'n';
  }
  if (Math.abs(worldY - bbox[3]) <= edgeTolerance && worldX > bbox[0] + handleRadius && worldX < bbox[2] - handleRadius) {
    return 's';
  }
  if (Math.abs(worldX - bbox[0]) <= edgeTolerance && worldY > bbox[1] + handleRadius && worldY < bbox[3] - handleRadius) {
    return 'w';
  }
  if (Math.abs(worldX - bbox[2]) <= edgeTolerance && worldY > bbox[1] + handleRadius && worldY < bbox[3] - handleRadius) {
    return 'e';
  }

  return null;
}

// ============================================================================
// Visible hit testing for TextTool / CodeTool click-to-edit
// ============================================================================

function hitTestVisibleKind(worldX: number, worldY: number, kind: ObjectKind): string | null {
  const { scale } = useCameraStore.getState();
  const radiusWorld = 8 / scale;
  const cands = queryHitCandidates(worldX, worldY, radiusWorld);
  return scanTopmost(cands, { accept: (c) => (c.handle.kind === kind ? c.handle.id : null) });
}

export function hitTestVisibleText(worldX: number, worldY: number): string | null {
  return hitTestVisibleKind(worldX, worldY, 'text');
}

export function hitTestVisibleNote(worldX: number, worldY: number): string | null {
  return hitTestVisibleKind(worldX, worldY, 'note');
}

export function hitTestVisibleCode(worldX: number, worldY: number): string | null {
  return hitTestVisibleKind(worldX, worldY, 'code');
}

// ============================================================================
// Endpoint dot hit testing (keeps Snapshot — downstream anchor resolution needs it)
// ============================================================================

/** Screen-space hit radius for connector endpoint dots */
export const ENDPOINT_DOT_HIT_PX = 10;

export interface EndpointHit {
  connectorId: string;
  endpoint: 'start' | 'end';
}

export function hitTestEndpointDots(
  worldX: number,
  worldY: number,
  selectedIds: string[],
  snapshot: Snapshot,
  scale: number,
): EndpointHit | null {
  const radiusWorld = ENDPOINT_DOT_HIT_PX / scale;
  const radiusSq = radiusWorld * radiusWorld;

  for (const id of selectedIds) {
    const handle = snapshot.objectsById.get(id);
    if (!handle || handle.kind !== 'connector') continue;

    const startEdge = getEndpointEdgePosition(handle, 'start', snapshot);
    const endEdge = getEndpointEdgePosition(handle, 'end', snapshot);

    const dxStart = worldX - startEdge[0];
    const dyStart = worldY - startEdge[1];
    if (dxStart * dxStart + dyStart * dyStart <= radiusSq) {
      return { connectorId: id, endpoint: 'start' };
    }

    const dxEnd = worldX - endEdge[0];
    const dyEnd = worldY - endEdge[1];
    if (dxEnd * dxEnd + dyEnd * dyEnd <= radiusSq) {
      return { connectorId: id, endpoint: 'end' };
    }
  }

  return null;
}
