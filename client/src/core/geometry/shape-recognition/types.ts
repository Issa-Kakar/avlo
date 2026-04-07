/**
 * Common geometric types used across shape fitting and recognition
 */

export type Vec2 = [number, number];

export interface Edge {
  startIdx: number;
  endIdx: number;
  angle: number; // radians
  length: number;
}

export interface Corner {
  index: number;
  angle: number; // degrees
  strength: number; // 0-1
}
