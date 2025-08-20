import { MAX_POINTS_PER_STROKE, MAX_TEXT_LENGTH, MAX_CODE_BODY_SIZE } from './room';
import { Command, DrawStrokeCommit, EraseObjects, AddText } from './commands';

// Type guards
export function isStrokeCommand(cmd: Command): cmd is DrawStrokeCommit {
  return cmd.type === 'DrawStrokeCommit';
}

export function isEraseCommand(cmd: Command): cmd is EraseObjects {
  return cmd.type === 'EraseObjects';
}

export function isTextCommand(cmd: Command): cmd is AddText {
  return cmd.type === 'AddText';
}

// Validation functions
export function validateStrokePoints(points: number[]): boolean {
  if (!points || !Array.isArray(points)) return false;
  if (points.length === 0) return false;
  if (points.length / 2 > MAX_POINTS_PER_STROKE) return false;

  // Check all values are finite numbers
  return points.every((p) => typeof p === 'number' && isFinite(p));
}

export function validateTextContent(content: string): boolean {
  if (typeof content !== 'string') return false;
  if (content.length === 0) return false;
  if (content.length > MAX_TEXT_LENGTH) return false;
  return true;
}

export function validateCodeBody(body: string): boolean {
  if (typeof body !== 'string') return false;
  if (body.length > MAX_CODE_BODY_SIZE) return false;
  return true;
}

// Size estimation for frame size validation
export function estimateEncodedSize(cmd: Command): number {
  // Rough estimation of JSON-encoded size
  const json = JSON.stringify(cmd);
  return new TextEncoder().encode(json).length;
}

// Frame size limit
export const MAX_FRAME_SIZE = 2 * 1024 * 1024; // 2MB
