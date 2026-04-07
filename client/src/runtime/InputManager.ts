/**
 * InputManager - Single owner of ALL DOM event registration
 *
 * Attaches: pointer/wheel/drag on canvas, keyboard/paste on document, blur on window.
 * Forwards pointer events → CanvasRuntime, keyboard events → keyboard-manager.
 *
 * Owns modifier key state (module-level). Updated from both pointer AND keyboard
 * events — always fresh regardless of input source. Tools read via exported getters.
 *
 * `liveCtrl` tracks ctrlKey only (not metaKey) for connector snap suppression,
 * because Cmd conflicts with clipboard shortcuts on macOS.
 *
 * @module runtime/InputManager
 */

import type { CanvasRuntime } from './CanvasRuntime';
import { handleKeyDown, handleKeyUp, handlePaste, handleBlur } from './keyboard-manager';

// ============================================
// MODIFIER STATE
// ============================================

let shiftHeld = false;
let ctrlOrMetaHeld = false;
let liveCtrl = false;

export function isShiftHeld(): boolean {
  return shiftHeld;
}

export function isCtrlOrMetaHeld(): boolean {
  return ctrlOrMetaHeld;
}

/** Ctrl only (not Meta) — for connector snap suppression on macOS */
export function isCtrlHeld(): boolean {
  return liveCtrl;
}

function updateModifiers(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void {
  shiftHeld = e.shiftKey;
  ctrlOrMetaHeld = e.ctrlKey || e.metaKey;
  liveCtrl = e.ctrlKey;
}

function clearModifiers(): void {
  shiftHeld = false;
  ctrlOrMetaHeld = false;
  liveCtrl = false;
}

// ============================================
// CLASS
// ============================================

export class InputManager {
  private canvas: HTMLCanvasElement;
  private container: HTMLElement;
  private runtime: CanvasRuntime;

  constructor(runtime: CanvasRuntime, canvas: HTMLCanvasElement, container: HTMLElement) {
    this.runtime = runtime;
    this.canvas = canvas;
    this.container = container;
  }

  attach(): void {
    // Pointer events (canvas)
    this.canvas.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    this.canvas.addEventListener('pointermove', this.onPointerMove, { passive: false });
    this.canvas.addEventListener('pointerup', this.onPointerUp, { passive: false });
    this.canvas.addEventListener('pointercancel', this.onPointerCancel, { passive: false });
    this.canvas.addEventListener('pointerleave', this.onPointerLeave, { passive: false });
    this.canvas.addEventListener('lostpointercapture', this.onLostCapture, { passive: false });
    this.container.addEventListener('wheel', this.onWheel, { passive: false });
    this.container.addEventListener('pointerdown', this.onOverlayPointerDown, { passive: false });
    this.canvas.addEventListener('dragover', this.onDragOver, { passive: false });
    this.canvas.addEventListener('drop', this.onDrop, { passive: false });

    // Keyboard events (document/window)
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('paste', this.onPaste);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('lostpointercapture', this.onLostCapture);
    this.container.removeEventListener('wheel', this.onWheel);
    this.container.removeEventListener('pointerdown', this.onOverlayPointerDown);
    this.canvas.removeEventListener('dragover', this.onDragOver);
    this.canvas.removeEventListener('drop', this.onDrop);

    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('paste', this.onPaste);
    window.removeEventListener('blur', this.onBlur);

    clearModifiers();
  }

  // === Pointer events — update modifiers, forward to runtime ===

  private onPointerDown = (e: PointerEvent) => {
    updateModifiers(e);
    this.runtime.handlePointerDown(e);
  };
  private onPointerMove = (e: PointerEvent) => {
    updateModifiers(e);
    this.runtime.handlePointerMove(e);
  };
  private onPointerUp = (e: PointerEvent) => {
    updateModifiers(e);
    this.runtime.handlePointerUp(e);
  };
  private onPointerCancel = (e: PointerEvent) => this.runtime.handlePointerCancel(e);
  private onPointerLeave = (e: PointerEvent) => this.runtime.handlePointerLeave(e);
  private onLostCapture = (e: PointerEvent) => this.runtime.handleLostPointerCapture(e);
  private onWheel = (e: WheelEvent) => this.runtime.handleWheel(e);
  private onOverlayPointerDown = (e: PointerEvent) => {
    if (e.button !== 1) return;
    if (!(e.target as HTMLElement).closest?.('.dom-overlay-root')) return;
    e.preventDefault();
    updateModifiers(e);
    this.runtime.handlePointerDown(e);
  };
  private onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  private onDrop = (e: DragEvent) => this.runtime.handleDrop(e);

  // === Keyboard events — update modifiers, forward to keyboard-manager ===

  private onKeyDown = (e: KeyboardEvent) => {
    updateModifiers(e);
    handleKeyDown(e);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    updateModifiers(e);
    handleKeyUp(e);
  };
  private onPaste = (e: ClipboardEvent) => {
    handlePaste(e);
  };
  private onBlur = () => {
    clearModifiers();
    handleBlur();
  };
}
