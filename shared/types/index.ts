/**
 * Shared type definitions for Avlo
 * This file will be expanded in Phase 2 with full data models
 */

// Re-export config for convenience
export * from '../config';
export { default as CONFIG } from '../config';

// Placeholder for Phase 2 types
// These will be properly implemented in Phase 2: Core Data Layer & Models

export type StrokeId = string;
export type TextId = string;
export type SceneIdx = number;

// Basic room type for Phase 1 validation
export interface Room {
  id: string;
  title?: string;
  createdAt?: Date;
  lastWriteAt?: Date;
  size_bytes?: number;
}

// Placeholder interfaces - will be expanded in Phase 2
export interface StrokePoint {
  x: number;
  y: number;
  p?: number; // pressure 0..1
}

export interface Stroke {
  id: StrokeId;
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  points: number[];
  bbox: [number, number, number, number];
  scene: SceneIdx;
  createdAt: number;
  userId: string;
}

export interface TextBlock {
  id: TextId;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  color: string;
  size: number;
  scene: SceneIdx;
  createdAt: number;
  userId: string;
}

export interface CodeCell {
  lang: 'javascript' | 'python';
  body: string;
  version: number;
}

export interface Output {
  ts: number;
  text: string;
}

export interface Meta {
  scene_ticks: number[];
  canvas?: { baseW: number; baseH: number };
}

export interface Awareness {
  userId: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number };
  activity: 'idle' | 'drawing' | 'typing';
  seq: number;
  ts: number;
  aw_v?: number;
}
