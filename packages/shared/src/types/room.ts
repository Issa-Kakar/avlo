import { StrokeId, TextId, UserId } from './identifiers';

// Individual stroke point with world coordinates
export interface StrokePoint {
  x: number;
  y: number;
}

// Complete stroke data structure
export interface Stroke {
  id: StrokeId;
  tool: 'pen' | 'highlighter';
  color: string; // #RRGGBB format
  size: number; // world units (px at scale=1)
  opacity: number; // 0..1; highlighter default 0.25
  points: number[]; // CRITICAL: flattened [x0,y0, x1,y1, ...]
  // NEVER Float32Array in storage
  pointsTuples?: [number, number][]; // NEW: Add this line
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY] world units
  createdAt: number; // ms epoch timestamp
  userId: UserId; // awareness id at commit
  /**
   * Semantic origin of the geometry:
   *  - 'freehand' => renderer builds a Perfect Freehand polygon and fills it
   *  - 'shape'    => renderer strokes the polyline as-is (perfect/snap shapes)
   */
  kind: 'freehand' | 'shape';
}

// Text block structure
export interface TextBlock {
  id: TextId;
  x: number; // world units (anchor point)
  y: number; // world units (anchor point)
  w: number; // layout box width
  h: number; // layout box height
  content: string; // committed once, immutable (max 500 chars)
  color: string; // #RRGGBB format
  size: number; // font px at scale=1
  createdAt: number; // ms epoch
  userId: UserId; // creator id
}

// Code cell for execution
export interface CodeCell {
  lang: 'javascript' | 'python';
  body: string; // ≤ 200 KB
  version: number; // increments per commit
}

// Execution output
export interface Output {
  ts: number; // ms epoch
  text: string; // ≤ 10 KB per output
}

// Document metadata
export interface Meta {
  canvas?: {
    // doc-level reference size (optional)
    baseW: number;
    baseH: number;
  };
}

// Constants for validation
export const MAX_POINTS_PER_STROKE = 10_000;
export const MAX_TOTAL_STROKES = 5_000;
export const MAX_TEXT_LENGTH = 500;
export const MAX_CODE_BODY_SIZE = 200 * 1024; // 200KB
export const MAX_OUTPUT_SIZE = 10 * 1024; // 10KB
export const MAX_OUTPUTS_COUNT = 10;
export const MAX_TOTAL_OUTPUT_SIZE = 128 * 1024; // 128KB
