/**
 * High-Level Connector Rerouting API for SelectTool
 *
 * Provides a simplified interface for rerouting connectors with optional overrides.
 * Reads connector data from Y.map and applies per-endpoint overrides as needed.
 *
 * Override types per endpoint:
 * - SnapTarget: snap to shape edge (has shapeId property)
 * - [x, y]: free position override
 * - { frame: FrameTuple }: apply anchor to a transformed frame
 *
 * @module lib/connectors/reroute-connector
 */

import { getCurrentSnapshot } from '@/canvas/room-runtime';
import { getStart, getEnd, getStartAnchor, getEndAnchor, getWidth, getFrame, computeConnectorBBoxFromPoints, bboxToBounds, type StoredAnchor, type FrameTuple, type WorldBounds } from '@avlo/shared';
import { getTextFrame } from '@/lib/text/text-system';
import { computeAStarRoute } from './routing-astar';
import {
  applyAnchorToFrame,
  resolveFreeStartDir,
  computeFreeEndDir,
} from './connector-utils';
import type { Dir, AABB, SnapTarget } from './types';

/**
 * Endpoint override value for rerouteConnector.
 * - SnapTarget: snap to shape edge (has shapeId property)
 * - [x, y]: free position override
 * - { frame: FrameTuple }: apply anchor to a transformed frame
 */
export type EndpointOverrideValue = SnapTarget | [number, number] | { frame: FrameTuple };

/**
 * Result of a connector reroute operation.
 */
export interface RerouteResult {
  /** Routed path points */
  points: [number, number][];
  /** Bounding box of the routed path (with arrow/stroke padding) */
  bbox: WorldBounds;
}

/**
 * Reroute a connector with optional per-endpoint overrides.
 *
 * Resolution per endpoint:
 *   1. endpointOverrides.start/end (if provided) - override wins
 *   2. Y.map stored anchor data - default
 *
 * @param connectorId - Connector ID in Y.Doc
 * @param endpointOverrides - Per-endpoint overrides (snap, free position, or frame)
 * @returns RerouteResult with points and bbox, or null if connector not found
 */
export function rerouteConnector(
  connectorId: string,
  endpointOverrides?: {
    start?: EndpointOverrideValue;
    end?: EndpointOverrideValue;
  }
): RerouteResult | null {
  const snapshot = getCurrentSnapshot();
  const handle = snapshot.objectsById.get(connectorId);

  if (!handle || handle.kind !== 'connector') {
    return null;
  }

  const yMap = handle.y;

  // Read connector properties from Y.map
  const storedStart = getStart(yMap) ?? [0, 0];
  const storedEnd = getEnd(yMap) ?? [0, 0];
  const startAnchor = getStartAnchor(yMap);
  const endAnchor = getEndAnchor(yMap);
  const strokeWidth = getWidth(yMap, 2);

  // Resolve start endpoint
  const startResolved = resolveEndpoint(
    'start',
    storedStart,
    startAnchor,
    endpointOverrides?.start,
    strokeWidth,
    snapshot
  );

  // Resolve end endpoint
  const endResolved = resolveEndpoint(
    'end',
    storedEnd,
    endAnchor,
    endpointOverrides?.end,
    strokeWidth,
    snapshot
  );

  // Resolve directions based on endpoint configuration
  const { startDir, endDir } = resolveDirections(
    startResolved,
    endResolved,
    strokeWidth
  );

  // Call primitives-based A* routing
  const result = computeAStarRoute(
    startResolved.position,
    startDir,
    endResolved.position,
    endDir,
    startResolved.shapeBounds,
    endResolved.shapeBounds,
    strokeWidth
  );

  // Compute bbox from routed points (reads width/cap from Y.map)
  const bboxTuple = computeConnectorBBoxFromPoints(result.points, yMap);
  const bbox = bboxToBounds(bboxTuple);

  return { points: result.points, bbox };
}

/**
 * Resolved endpoint with position, direction, and bounds.
 */
interface ResolvedEndpoint {
  position: [number, number];
  dir: Dir | null; // null means needs to be computed from spatial relationship
  shapeBounds: AABB | null;
  isAnchored: boolean;
}

/**
 * Resolve a single endpoint with overrides applied.
 *
 * Resolution priority:
 * 1. Override (SnapTarget, [x,y] position, or { frame })
 * 2. Stored Y.map anchor/position data
 */
function resolveEndpoint(
  _which: 'start' | 'end',
  storedPosition: [number, number],
  anchor: StoredAnchor | undefined,
  override: EndpointOverrideValue | undefined,
  _strokeWidth: number,
  snapshot: ReturnType<typeof getCurrentSnapshot>
): ResolvedEndpoint {
  // 1. Override wins
  if (override !== undefined) {
    // Discriminate override type:
    if (Array.isArray(override)) {
      // [x, y] — free position override
      return {
        position: override,
        dir: null,
        shapeBounds: null,
        isAnchored: false,
      };
    }

    if ('frame' in override) {
      // { frame: FrameTuple } — apply anchor to given transformed frame
      if (!anchor) {
        // No anchor data → treat as canonical stored position
        return {
          position: storedPosition,
          dir: null,
          shapeBounds: null,
          isAnchored: false,
        };
      }
      const pos = applyAnchorToFrame(anchor.anchor, override.frame, anchor.side);
      return {
        position: pos,
        dir: anchor.side,
        shapeBounds: { x: override.frame[0], y: override.frame[1], w: override.frame[2], h: override.frame[3] },
        isAnchored: true,
      };
    }

    // SnapTarget (has shapeId property)
    const snap = override as SnapTarget;
    const handle = snapshot.objectsById.get(snap.shapeId);
    const frame = handle && (handle.kind === 'shape' || handle.kind === 'text')
      ? (handle.kind === 'text' ? getTextFrame(handle.id) : getFrame(handle.y))
      : null;

    return {
      position: snap.position,
      dir: snap.side,
      shapeBounds: frame ? { x: frame[0], y: frame[1], w: frame[2], h: frame[3] } : null,
      isAnchored: true,
    };
  }

  // 2. No override — use stored anchor/position data
  if (anchor) {
    const handle = snapshot.objectsById.get(anchor.id);
    const frame = handle && (handle.kind === 'shape' || handle.kind === 'text')
      ? (handle.kind === 'text' ? getTextFrame(handle.id) : getFrame(handle.y))
      : null;

    if (frame) {
      const position = applyAnchorToFrame(anchor.anchor, frame, anchor.side);
      return {
        position,
        dir: anchor.side,
        shapeBounds: { x: frame[0], y: frame[1], w: frame[2], h: frame[3] },
        isAnchored: true,
      };
    }

    // Anchored shape no longer exists - fall back to stored position
    return {
      position: storedPosition,
      dir: null,
      shapeBounds: null,
      isAnchored: false,
    };
  }

  // 3. Free endpoint - use stored position
  return {
    position: storedPosition,
    dir: null,
    shapeBounds: null,
    isAnchored: false,
  };
}

/**
 * Resolve directions for both endpoints based on configuration.
 *
 * - Anchored endpoints use their anchor side as direction
 * - Free endpoints compute direction from spatial relationship
 */
function resolveDirections(
  start: ResolvedEndpoint,
  end: ResolvedEndpoint,
  strokeWidth: number
): { startDir: Dir; endDir: Dir } {
  let startDir = start.dir;
  let endDir = end.dir;

  // Free→Anchored: compute start direction from spatial relationship
  if (!start.isAnchored && end.isAnchored && end.shapeBounds) {
    startDir = resolveFreeStartDir(
      start.position,
      { position: end.position, outwardDir: end.dir!, shapeBounds: end.shapeBounds },
      strokeWidth
    );
  } else if (!start.isAnchored && startDir === null) {
    // Both free or start is free without known direction
    startDir = computeFreeEndDir(start.position, end.position);
  }

  // Anchored→Free: compute end direction from primary axis
  if (start.isAnchored && !end.isAnchored) {
    endDir = computeFreeEndDir(start.position, end.position);
  } else if (!end.isAnchored && endDir === null) {
    // Use opposite of start direction as fallback
    const opposites: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };
    endDir = opposites[startDir!];
  }

  return { startDir: startDir!, endDir: endDir! };
}
