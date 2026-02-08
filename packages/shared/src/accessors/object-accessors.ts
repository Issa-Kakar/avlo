/**
 * Typed Y.Map Accessor Functions
 *
 * These functions provide type-safe access to Y.Map object properties,
 * eliminating repetitive casting throughout the codebase.
 *
 * Getter names match Y.Map keys exactly for clarity:
 * - getColor → y.get('color')
 * - getPoints → y.get('points')
 * - getFrame → y.get('frame')
 *
 * @module accessors/object-accessors
 */

import type * as Y from 'yjs';
import type { FrameTuple, Frame } from '../types/geometry';

// ============================================================================
// DIRECTION TYPE (shared with connectors)
// ============================================================================

/** Cardinal direction type (North, East, South, West) */
export type Dir = 'N' | 'E' | 'S' | 'W';

// ============================================================================
// ANCHOR TYPE (for connectors)
// ============================================================================

/**
 * Anchor data stored in Y.map for connected endpoints.
 * Used by connectors to track attachment to shapes.
 */
export interface StoredAnchor {
  /** Target shape ID */
  id: string;
  /** Edge direction (N/E/S/W) */
  side: Dir;
  /** Normalized position within shape frame [0-1, 0-1] */
  anchor: [number, number];
}

// ============================================================================
// COMMON ACCESSORS (all object kinds)
// ============================================================================

/**
 * Get color from Y.Map with fallback.
 */
export function getColor(y: Y.Map<unknown>, fallback = '#000'): string {
  return (y.get('color') as string | undefined) ?? fallback;
}

/**
 * Get opacity from Y.Map with fallback.
 */
export function getOpacity(y: Y.Map<unknown>, fallback = 1): number {
  return (y.get('opacity') as number | undefined) ?? fallback;
}

/**
 * Get stroke width from Y.Map with fallback.
 * Handles both 'width' and legacy 'strokeWidth' field names.
 */
export function getWidth(y: Y.Map<unknown>, fallback = 2): number {
  const width = y.get('width') as number | undefined;
  if (width !== undefined) return width;
  // Legacy fallback
  return (y.get('strokeWidth') as number | undefined) ?? fallback;
}

// ============================================================================
// GEOMETRY ACCESSORS
// ============================================================================

/**
 * Get points array from Y.Map.
 * Returns empty array if not found.
 */
export function getPoints(y: Y.Map<unknown>): [number, number][] {
  return (y.get('points') as [number, number][] | undefined) ?? [];
}

/**
 * Get frame tuple from Y.Map.
 * Returns null if not found.
 */
export function getFrame(y: Y.Map<unknown>): FrameTuple | null {
  return (y.get('frame') as FrameTuple | undefined) ?? null;
}

/**
 * Get frame as Frame object from Y.Map.
 * Returns null if not found.
 */
export function getFrameObject(y: Y.Map<unknown>): Frame | null {
  const frame = getFrame(y);
  if (!frame) return null;
  return { x: frame[0], y: frame[1], w: frame[2], h: frame[3] };
}

// ============================================================================
// SHAPE-SPECIFIC ACCESSORS
// ============================================================================

/**
 * Get shape type from Y.Map.
 * Returns 'rect' as default if not found.
 */
export function getShapeType(y: Y.Map<unknown>): string {
  return (y.get('shapeType') as string | undefined) ?? 'rect';
}

/**
 * Get fill color from Y.Map.
 * Returns undefined if no fill.
 */
export function getFillColor(y: Y.Map<unknown>): string | undefined {
  return y.get('fillColor') as string | undefined;
}

// ============================================================================
// CONNECTOR-SPECIFIC ACCESSORS
// ============================================================================

/**
 * Get start position from Y.Map.
 */
export function getStart(y: Y.Map<unknown>): [number, number] | undefined {
  return y.get('start') as [number, number] | undefined;
}

/**
 * Get end position from Y.Map.
 */
export function getEnd(y: Y.Map<unknown>): [number, number] | undefined {
  return y.get('end') as [number, number] | undefined;
}

/**
 * Get start anchor from Y.Map.
 */
export function getStartAnchor(y: Y.Map<unknown>): StoredAnchor | undefined {
  return y.get('startAnchor') as StoredAnchor | undefined;
}

/**
 * Get end anchor from Y.Map.
 */
export function getEndAnchor(y: Y.Map<unknown>): StoredAnchor | undefined {
  return y.get('endAnchor') as StoredAnchor | undefined;
}

/**
 * Get start cap from Y.Map.
 * Returns 'none' as default.
 */
export function getStartCap(y: Y.Map<unknown>): 'arrow' | 'none' {
  const cap = y.get('startCap') as string | undefined;
  return cap === 'arrow' ? 'arrow' : 'none';
}

/**
 * Get end cap from Y.Map.
 * Returns 'none' as default.
 */
export function getEndCap(y: Y.Map<unknown>): 'arrow' | 'none' {
  const cap = y.get('endCap') as string | undefined;
  return cap === 'arrow' ? 'arrow' : 'none';
}

// ============================================================================
// TEXT-SPECIFIC ACCESSORS
// ============================================================================

/**
 * Get font size from Y.Map with fallback.
 */
export function getFontSize(y: Y.Map<unknown>, fallback = 20): number {
  return (y.get('fontSize') as number | undefined) ?? fallback;
}

/**
 * Get origin (anchor point + baseline) from Y.Map.
 */
export function getOrigin(y: Y.Map<unknown>): [number, number] | null {
  return (y.get('origin') as [number, number] | undefined) ?? null;
}

/**
 * Get text alignment from Y.Map with fallback.
 */
export function getAlign(y: Y.Map<unknown>, fallback = 'left'): string {
  return (y.get('align') as string | undefined) ?? fallback;
}

/**
 * Get width mode from Y.Map with fallback.
 */
export function getWidthMode(y: Y.Map<unknown>, fallback = 'auto'): string {
  return (y.get('widthMode') as string | undefined) ?? fallback;
}

/**
 * Get Y.XmlFragment content from Y.Map.
 */
export function getContent(y: Y.Map<unknown>): Y.XmlFragment | null {
  return (y.get('content') as Y.XmlFragment | undefined) ?? null;
}

// ============================================================================
// STROKE-SPECIFIC ACCESSORS
// ============================================================================

/**
 * Get stroke tool type from Y.Map.
 * Returns 'pen' as default.
 */
export function getStrokeTool(y: Y.Map<unknown>): 'pen' | 'highlighter' {
  const tool = y.get('tool') as string | undefined;
  return tool === 'highlighter' ? 'highlighter' : 'pen';
}
