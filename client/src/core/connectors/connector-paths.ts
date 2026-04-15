/**
 * Connector Path Building Utilities
 *
 * Pure functions for building Path2D objects from connector data.
 * Used by both object-cache (committed connectors) and connector-preview (ephemeral).
 *
 * These functions are context-free - they return Path2D objects that can be
 * rendered with any ctx.fill() or ctx.stroke() call.
 *
 * @module lib/connectors/connector-paths
 */

import type { Point } from '../types/geometry';
import { ROUTING_CONFIG, computeArrowLength } from './constants';

// ============================================================================
// Types
// ============================================================================

/**
 * Cached paths for connector rendering.
 * Separate paths allow correct multi-pass rendering:
 * - polyline: stroked with lineCap='round', lineJoin='round'
 * - arrows: filled + stroked for rounded corners
 */
export interface ConnectorPaths {
  /** Main polyline path (trimmed if arrows present) */
  polyline: Path2D;
  /** Start arrow triangle (if startCap === 'arrow') */
  startArrow: Path2D | null;
  /** End arrow triangle (if endCap === 'arrow') */
  endArrow: Path2D | null;
}

/**
 * Input parameters for building connector paths.
 * Extracted from Y.Map at cache build time.
 */
export interface ConnectorPathParams {
  points: Point[];
  strokeWidth: number;
  startCap: 'arrow' | 'none';
  endCap: 'arrow' | 'none';
}

/**
 * Trim info for ending the polyline before an arrow head.
 */
export interface EndTrimInfo {
  /** The point where the polyline should end (arrow base) */
  trimmedPoint: Point;
  /** Unit direction vector of the final segment */
  direction: Point;
}

/**
 * Scaled arrow dimensions for short segments.
 */
export interface ScaledArrowDimensions {
  /** Arrow length (tip to base) */
  scaledLength: number;
  /** Arrow half-width (center to vertex) */
  scaledHalfWidth: number;
}

/**
 * Arrow geometry with all vertices computed.
 */
export interface ArrowGeometry {
  /** Tip position (pulled back for stroke offset) */
  tip: Point;
  /** Left wing vertex */
  left: Point;
  /** Right wing vertex */
  right: Point;
  /** Arrow length (for reference) */
  length: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Fixed line width for arrow stroke rounding (~2.5 unit corner radius) */
export const ARROW_ROUNDING_LINE_WIDTH = 5;

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Build all paths for a connector.
 * Main entry point for cache and preview.
 */
export function buildConnectorPaths(params: ConnectorPathParams): ConnectorPaths {
  const { points, strokeWidth, startCap, endCap } = params;

  if (points.length < 2) {
    return { polyline: new Path2D(), startArrow: null, endArrow: null };
  }

  // Compute trim info before building polyline
  const endTrim = endCap === 'arrow' ? computeEndTrimInfo(points, strokeWidth, 'end') : null;
  const startTrim = startCap === 'arrow' ? computeEndTrimInfo(points, strokeWidth, 'start') : null;

  // Build paths
  const polyline = buildRoundedPolylinePath(points, startTrim, endTrim);
  const startArrow = startCap === 'arrow' ? buildArrowPath(points, strokeWidth, 'start') : null;
  const endArrow = endCap === 'arrow' ? buildArrowPath(points, strokeWidth, 'end') : null;

  return { polyline, startArrow, endArrow };
}

// ============================================================================
// Polyline Path Building
// ============================================================================

/**
 * Build rounded polyline Path2D using arcTo for corners.
 * Handles trimming at both ends for arrow caps.
 *
 * @param points - Full route points
 * @param startTrim - Trim info for start arrow (or null)
 * @param endTrim - Trim info for end arrow (or null)
 * @returns Path2D for the polyline
 */
export function buildRoundedPolylinePath(points: Point[], startTrim: EndTrimInfo | null, endTrim: EndTrimInfo | null): Path2D {
  const cornerRadius = ROUTING_CONFIG.CORNER_RADIUS_W;
  const path = new Path2D();

  if (points.length < 2) return path;

  // Start point (potentially trimmed for start arrow)
  const startPoint = startTrim?.trimmedPoint ?? points[0];
  path.moveTo(startPoint[0], startPoint[1]);

  // Handle 2-point case (straight line, no corners)
  if (points.length === 2) {
    const endPoint = endTrim?.trimmedPoint ?? points[1];
    path.lineTo(endPoint[0], endPoint[1]);
    return path;
  }

  // Middle points with arcTo corners
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    // Compute available segment lengths
    const lenIn = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    const lenOut = Math.hypot(next[0] - curr[0], next[1] - curr[1]);

    // Clamp radius to fit available space
    const maxR = Math.min(cornerRadius, lenIn / 2, lenOut / 2);

    if (maxR < 2) {
      // Too small for rounding - use sharp corner
      path.lineTo(curr[0], curr[1]);
    } else {
      // Use arcTo for smooth corner
      path.arcTo(curr[0], curr[1], next[0], next[1], maxR);
    }
  }

  // Final segment - use trimmed point if provided (for arrow caps)
  const endPoint = endTrim?.trimmedPoint ?? points[points.length - 1];
  path.lineTo(endPoint[0], endPoint[1]);

  return path;
}

// ============================================================================
// Arrow Path Building
// ============================================================================

/**
 * Build arrow triangle Path2D.
 * Triangle vertices are pulled back by stroke offset for visual alignment.
 *
 * The arrow is designed to be rendered with:
 * - ctx.fill(path) - solid interior
 * - ctx.stroke(path) with lineWidth=5, lineJoin='round' - rounded corners
 *
 * @param points - Full route points
 * @param strokeWidth - Connector stroke width
 * @param position - Which end ('start' or 'end')
 * @returns Path2D for the arrow triangle
 */
export function buildArrowPath(points: Point[], strokeWidth: number, position: 'start' | 'end'): Path2D {
  const geom = computeArrowGeometry(points, strokeWidth, position);
  if (!geom) return new Path2D();

  const path = new Path2D();
  path.moveTo(geom.tip[0], geom.tip[1]);
  path.lineTo(geom.left[0], geom.left[1]);
  path.lineTo(geom.right[0], geom.right[1]);
  path.closePath();

  return path;
}

/**
 * Compute arrow triangle geometry with stroke offset compensation.
 *
 * CRITICAL: Stroke extends outward by lineWidth/2, including at the tip.
 * We pull the path back so the VISIBLE tip (after stroke) lands at the endpoint.
 *
 * @param points - Full route points
 * @param strokeWidth - Connector stroke width
 * @param position - Which end ('start' or 'end')
 * @returns Arrow geometry or null if not enough points
 */
export function computeArrowGeometry(points: Point[], strokeWidth: number, position: 'start' | 'end'): ArrowGeometry | null {
  if (points.length < 2) return null;

  let tip: Point;
  let prev: Point;

  if (position === 'end') {
    tip = points[points.length - 1];
    prev = points[points.length - 2];
  } else {
    tip = points[0];
    prev = points[1];
  }

  const dx = tip[0] - prev[0];
  const dy = tip[1] - prev[1];
  const segLen = Math.hypot(dx, dy);
  if (segLen < 0.001) return null;

  // Unit and perpendicular vectors
  const ux = dx / segLen;
  const uy = dy / segLen;
  const px = -uy; // Perpendicular left
  const py = ux;

  // Scaled dimensions (arrow length capped at half segment)
  const { scaledLength, scaledHalfWidth } = computeScaledArrowDimensions(segLen, strokeWidth);

  // Stroke offset compensation (tip pulled back so visible tip lands at endpoint)
  const strokeOffset = ARROW_ROUNDING_LINE_WIDTH / 2;

  const tipX = tip[0] - ux * strokeOffset;
  const tipY = tip[1] - uy * strokeOffset;

  return {
    tip: [tipX, tipY],
    left: [tipX - ux * scaledLength + px * scaledHalfWidth, tipY - uy * scaledLength + py * scaledHalfWidth],
    right: [tipX - ux * scaledLength - px * scaledHalfWidth, tipY - uy * scaledLength - py * scaledHalfWidth],
    length: scaledLength,
  };
}

// ============================================================================
// Arrow Sizing
// ============================================================================

/**
 * Compute scaled arrow dimensions based on segment length.
 *
 * CRITICAL: Arrow length never exceeds half the segment (Excalidraw approach).
 * This prevents arrows from dominating short segments.
 *
 * Width is proportional to length via fixed aspect ratio, ensuring
 * consistent arrow shape at all sizes.
 *
 * @param segmentLength - Length of the final segment (tip to corner)
 * @param strokeWidth - Connector stroke width
 * @returns Scaled arrow dimensions
 */
export function computeScaledArrowDimensions(segmentLength: number, strokeWidth: number): ScaledArrowDimensions {
  const fullLength = computeArrowLength(strokeWidth);

  // Arrow never exceeds half the segment (Excalidraw approach)
  const scaledLength = Math.min(fullLength, segmentLength / 2);

  // Width proportional to length via fixed aspect ratio
  const scaledHalfWidth = (scaledLength * ROUTING_CONFIG.ARROW_ASPECT_RATIO) / 2;

  return { scaledLength, scaledHalfWidth };
}

// ============================================================================
// Trim Calculation
// ============================================================================

/**
 * Compute where to trim the polyline for an arrow cap.
 *
 * This accounts for the arc corner geometry - we can only trim from the
 * "straight" portion of the final segment after the arc tangent point.
 *
 * For orthogonal connectors with 90 degree corners:
 * - The arc tangent point is at distance `cornerRadius` from the corner
 * - We can trim at most `segmentLength - cornerRadius` from the final segment
 * - This ensures the polyline ends smoothly after the arc
 *
 * @param points - Full route points
 * @param strokeWidth - Connector stroke width (for arrow sizing)
 * @param position - Which end to trim ('start' or 'end')
 * @returns Trim info or null if not enough points
 */
export function computeEndTrimInfo(points: Point[], strokeWidth: number, position: 'start' | 'end'): EndTrimInfo | null {
  if (points.length < 2) return null;

  const cornerRadius = ROUTING_CONFIG.CORNER_RADIUS_W;

  let tip: Point;
  let prev: Point;
  let cornerPrev: Point | null = null; // The point before the corner

  if (position === 'end') {
    tip = points[points.length - 1];
    prev = points[points.length - 2];
    if (points.length >= 3) {
      cornerPrev = points[points.length - 3];
    }
  } else {
    tip = points[0];
    prev = points[1];
    if (points.length >= 3) {
      cornerPrev = points[2];
    }
  }

  // Final segment direction and length
  const dx = tip[0] - prev[0];
  const dy = tip[1] - prev[1];
  const segLen = Math.hypot(dx, dy);

  if (segLen < 0.001) return null;

  const ux = dx / segLen;
  const uy = dy / segLen;

  // Calculate the arc radius that would be used at the corner (prev)
  // This matches the logic in buildRoundedPolylinePath
  let actualCornerRadius = 0;
  if (cornerPrev) {
    const lenIn = Math.hypot(prev[0] - cornerPrev[0], prev[1] - cornerPrev[1]);
    const lenOut = segLen;
    actualCornerRadius = Math.min(cornerRadius, lenIn / 2, lenOut / 2);
    if (actualCornerRadius < 2) actualCornerRadius = 0; // Sharp corner
  }

  // Get scaled arrow length based on segment length
  const { scaledLength } = computeScaledArrowDimensions(segLen, strokeWidth);

  // The arc consumes `actualCornerRadius` of the final segment
  // Available for trimming is the rest of the segment
  const availableForTrim = Math.max(0, segLen - actualCornerRadius);

  // Round cap extends strokeWidth/2 beyond the trim point, so we need
  // extra trim to prevent the polyline from poking through small arrows
  const neededTrim = scaledLength + strokeWidth / 2;
  const actualTrim = Math.min(neededTrim, availableForTrim);

  const trimmedPoint: Point = [tip[0] - ux * actualTrim, tip[1] - uy * actualTrim];

  return {
    trimmedPoint,
    direction: [ux, uy],
  };
}
