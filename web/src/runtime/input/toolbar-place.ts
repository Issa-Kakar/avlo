/**
 * Toolbar drag-place entry points — pointerdown on an inspector button starts a
 * placing gesture on the tool singleton, then captures the pointer to the canvas
 * so every subsequent move/up retargets through the existing InputManager →
 * CanvasRuntime → tool dispatch. The selection (variant / fill) is applied up
 * front, so a sub-threshold release degrades to today's click semantics — the
 * captured `click` event never reaches the button's onClick (kept as fallback
 * for the guard-refused paths below, where no capture happens).
 */

import type { PointerEvent as ReactPointerEvent } from 'react';
import { capturePointer, screenToWorld } from '@/stores/camera-store';
import { type ShapeVariant, setActiveTool, setCursorOverride, setNoteFillColor, setShapeVariant } from '@/stores/device-ui-store';
import { drawingTool, textTool } from '../tool-registry';
import { isSpacebarPanMode } from './keyboard-manager';

export function beginShapePlace(e: ReactPointerEvent, variant: ShapeVariant): void {
  if (e.button !== 0) return;
  setShapeVariant(variant); // click semantics, applied up front
  if (isSpacebarPanMode() || !drawingTool.canBegin()) return;
  const world = screenToWorld(e.clientX, e.clientY);
  if (!world) return;
  e.preventDefault();
  setActiveTool('shape'); // idempotent hardening — same-value write fires no subscribers
  drawingTool.beginPlace(e.pointerId, world[0], world[1]);
  capturePointer(e.pointerId);
  setCursorOverride('grabbing');
}

export function beginNotePlace(e: ReactPointerEvent, fill: string): void {
  if (e.button !== 0) return;
  setNoteFillColor(fill);
  if (isSpacebarPanMode() || !textTool.canBegin()) return;
  const world = screenToWorld(e.clientX, e.clientY);
  if (!world) return;
  e.preventDefault();
  setActiveTool('note');
  textTool.beginPlace(e.pointerId, world[0], world[1]);
  capturePointer(e.pointerId);
  setCursorOverride('grabbing');
}
