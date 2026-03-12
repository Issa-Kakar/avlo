/**
 * InputManager - Dumb DOM Event Forwarder
 *
 * This class is responsible ONLY for:
 * - Attaching event listeners to the canvas element
 * - Forwarding RAW PointerEvents and WheelEvents to CanvasRuntime
 * - Detaching listeners on destroy
 *
 * It does NOT:
 * - Convert coordinates
 * - Make tool decisions
 * - Track state
 * - Handle gesture blocking logic
 *
 * All intelligence lives in CanvasRuntime. InputManager is deliberately dumb.
 *
 * @module canvas/InputManager
 */

import { getCanvasElement } from '@/stores/camera-store';
import type { CanvasRuntime } from './CanvasRuntime';

export class InputManager {
  private canvas: HTMLCanvasElement | null = null;

  constructor(private runtime: CanvasRuntime) {}

  /**
   * Attach event listeners to the canvas element.
   * Canvas element is read from camera-store module registry.
   */
  attach(): void {
    this.canvas = getCanvasElement();
    if (!this.canvas) return;

    this.canvas.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    this.canvas.addEventListener('pointermove', this.onPointerMove, { passive: false });
    this.canvas.addEventListener('pointerup', this.onPointerUp, { passive: false });
    this.canvas.addEventListener('pointercancel', this.onPointerCancel, { passive: false });
    this.canvas.addEventListener('pointerleave', this.onPointerLeave, { passive: false });
    this.canvas.addEventListener('lostpointercapture', this.onLostCapture, { passive: false });
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dragover', this.onDragOver, { passive: false });
    this.canvas.addEventListener('drop', this.onDrop, { passive: false });
  }

  /**
   * Detach all event listeners.
   */
  detach(): void {
    if (!this.canvas) return;

    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dragover', this.onDragOver);
    this.canvas.removeEventListener('drop', this.onDrop);

    this.canvas = null;
  }

  // Just forward raw events - that's it!
  private onPointerDown = (e: PointerEvent) => this.runtime.handlePointerDown(e);
  private onPointerMove = (e: PointerEvent) => this.runtime.handlePointerMove(e);
  private onPointerUp = (e: PointerEvent) => this.runtime.handlePointerUp(e);
  private onPointerCancel = (e: PointerEvent) => this.runtime.handlePointerCancel(e);
  private onPointerLeave = (e: PointerEvent) => this.runtime.handlePointerLeave(e);
  private onLostCapture = (e: PointerEvent) => this.runtime.handleLostPointerCapture(e);
  private onWheel = (e: WheelEvent) => this.runtime.handleWheel(e);
  private onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  private onDrop = (e: DragEvent) => this.runtime.handleDrop(e);
}
