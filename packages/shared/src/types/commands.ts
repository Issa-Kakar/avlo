import { StrokeId, TextId } from './identifiers';

// All possible commands that can be executed
export type Command =
  | DrawStrokeCommit
  | EraseObjects
  | AddText
  | ClearBoard
  | ExtendTTL
  | CodeUpdate
  | CodeRun;

// Draw stroke command
export interface DrawStrokeCommit {
  type: 'DrawStrokeCommit';
  id: StrokeId; // Also serves as idempotencyKey
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
  points: number[]; // Already simplified, world coordinates
  bbox: [number, number, number, number];
  startedAt: number;
  finishedAt: number;
}

// Erase multiple objects
export interface EraseObjects {
  type: 'EraseObjects';
  ids: (StrokeId | TextId)[];
  idempotencyKey: string; // Generated ULID
}

// Add text block
export interface AddText {
  type: 'AddText';
  id: TextId; // Also serves as idempotencyKey
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  color: string;
  size: number;
}

// Clear board (append scene tick)
export interface ClearBoard {
  type: 'ClearBoard';
  idempotencyKey: string; // Format: "scene_<beforeIdx>_<tsBucket>"
}

// Extend room TTL
export interface ExtendTTL {
  type: 'ExtendTTL';
  idempotencyKey: string; // Format: "ttl_<timestamp>"
}

// Update code cell
export interface CodeUpdate {
  type: 'CodeUpdate';
  lang: 'javascript' | 'python';
  body: string;
  version: number; // Expected current version
  idempotencyKey: string;
}

// Run code
export interface CodeRun {
  type: 'CodeRun';
  idempotencyKey: string;
}

// Validation results
export interface ValidationResult {
  valid: boolean;
  reason?: 'view_only' | 'read_only' | 'oversize' | 'rate_limited' | 'invalid_data';
  details?: string;
}
