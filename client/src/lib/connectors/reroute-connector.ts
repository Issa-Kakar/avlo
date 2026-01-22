/**
 * High-Level Connector Rerouting API for SelectTool
 *
 * Provides a simplified interface for rerouting connectors with optional overrides.
 * Reads connector data from Y.map and applies frame/endpoint overrides as needed.
 *
 * Two orthogonal override mechanisms:
 * 1. frameOverrides: Map of shapeId → new frame (for shapes being transformed)
 * 2. endpointOverrides: Direct endpoint override (SnapTarget or [x,y] position)
 *
 * @module lib/connectors/reroute-connector
 */

import { getCurrentSnapshot } from '@/canvas/room-runtime';
import { getStart, getEnd, getStartAnchor, getEndAnchor, getWidth, getFrame, type StoredAnchor, type FrameTuple } from '@avlo/shared';
import { computeAStarRoute } from './routing-astar';
import {
  applyAnchorToFrame,
  resolveFreeStartDir,
  computeFreeEndDir,
} from './connector-utils';
import type { Dir, AABB, SnapTarget, Frame } from './types';

/**
 * Reroute a connector with optional overrides.
 *
 * Two orthogonal override mechanisms:
 * 1. frameOverrides: Map of shapeId → new frame (for shapes being transformed)
 * 2. endpointOverrides: Direct endpoint override (SnapTarget or [x,y] position)
 *
 * Resolution per endpoint:
 *   1. endpointOverrides.start/end (if provided) - direct override wins
 *   2. frameOverrides.get(anchor.id) (if anchored) - shape is transforming
 *   3. Y.map data - default
 *
 * @param connectorId - Connector ID in Y.Doc
 * @param frameOverrides - Temporary frame overrides for shapes being transformed
 * @param endpointOverrides - Direct endpoint overrides (snap or free position)
 * @returns Routed points or null if connector not found
 */
export function rerouteConnector(
  connectorId: string,
  frameOverrides?: Map<string, Frame>,
  endpointOverrides?: {
    start?: SnapTarget | [number, number];
    end?: SnapTarget | [number, number];
  }
): [number, number][] | null {
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
    frameOverrides,
    endpointOverrides?.start,
    strokeWidth,
    snapshot
  );

  // Resolve end endpoint
  const endResolved = resolveEndpoint(
    'end',
    storedEnd,
    endAnchor,
    frameOverrides,
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

  return result.points;
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
 * 1. Direct override (SnapTarget or position array)
 * 2. Shape frame override (anchored endpoint with transforming shape)
 * 3. Stored Y.map data
 */
function resolveEndpoint(
  _which: 'start' | 'end',
  storedPosition: [number, number],
  anchor: StoredAnchor | undefined,
  frameOverrides: Map<string, Frame> | undefined,
  override: SnapTarget | [number, number] | undefined,
  _strokeWidth: number,
  snapshot: ReturnType<typeof getCurrentSnapshot>
): ResolvedEndpoint {
  // 1. Direct override wins
  if (override !== undefined) {
    // Discriminate: array = free position, object = SnapTarget
    if (Array.isArray(override)) {
      // Free position override
      return {
        position: override,
        dir: null, // Will be computed from spatial relationship
        shapeBounds: null,
        isAnchored: false,
      };
    } else {
      // SnapTarget override
      const snap = override as SnapTarget;
      const handle = snapshot.objectsById.get(snap.shapeId);
      const frame = handle && (handle.kind === 'shape' || handle.kind === 'text')
        ? getFrame(handle.y)
        : null;

      return {
        position: snap.position,
        dir: snap.side,
        shapeBounds: frame ? { x: frame[0], y: frame[1], w: frame[2], h: frame[3] } : null,
        isAnchored: true,
      };
    }
  }

  // 2. Check if anchored and shape has frame override
  if (anchor) {
    const overrideFrame = frameOverrides?.get(anchor.id);
    if (overrideFrame) {
      // Shape is being transformed - apply anchor to new frame (convert Frame to FrameTuple)
      const frameTuple: FrameTuple = [overrideFrame.x, overrideFrame.y, overrideFrame.w, overrideFrame.h];
      const position = applyAnchorToFrame(
        anchor.anchor,
        frameTuple,
        anchor.side
      );
      return {
        position,
        dir: anchor.side,
        shapeBounds: { x: overrideFrame.x, y: overrideFrame.y, w: overrideFrame.w, h: overrideFrame.h },
        isAnchored: true,
      };
    }

    // 3. Use stored anchor data with current shape frame
    const handle = snapshot.objectsById.get(anchor.id);
    const frame = handle && (handle.kind === 'shape' || handle.kind === 'text')
      ? getFrame(handle.y)
      : null;

    if (frame) {
      const position = applyAnchorToFrame(
        anchor.anchor,
        frame,
        anchor.side
      );
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

  // 4. Free endpoint - use stored position
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
