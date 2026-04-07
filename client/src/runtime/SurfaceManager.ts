/**
 * SurfaceManager - DOM refs, resize/DPR handling for canvas system
 *
 * Manages:
 * - Base and overlay canvas 2D contexts
 * - Editor host div for TextTool
 * - Canvas element registration for coordinate transforms
 * - Resize/DPR observation with deferred backing-store resize
 *
 * Does NOT manage input events — that's InputManager's job.
 *
 * @module runtime/SurfaceManager
 */

import { useCameraStore, setCanvasElement } from '@/stores/camera-store';
import { applyCursor } from '@/stores/device-ui-store';

const MAX_CANVAS_DIMENSION = 16384;

// ============================================
// MODULE-LEVEL DOM REFS
// ============================================

let baseCtx: CanvasRenderingContext2D | null = null;
let overlayCtx: CanvasRenderingContext2D | null = null;
let editorHost: HTMLDivElement | null = null;

// Deferred resize state - applied at start of next render frame
let pendingPixelW = 0;
let pendingPixelH = 0;
let hasPendingResize = false;

/** Get base canvas 2D context. Returns null if not mounted. */
export function getBaseContext(): CanvasRenderingContext2D | null {
  return baseCtx;
}

/** Get overlay canvas 2D context. Returns null if not mounted. */
export function getOverlayContext(): CanvasRenderingContext2D | null {
  return overlayCtx;
}

/** Get editor host div. Returns null if not mounted. */
export function getEditorHost(): HTMLDivElement | null {
  return editorHost;
}

/** Set editor host div. Called by CanvasRuntime.start(). */
export function setEditorHost(el: HTMLDivElement | null): void {
  editorHost = el;
}

/**
 * Apply pending canvas resize. Called at the start of each render frame.
 * Sets backing store (device pixels) only — CSS sizing is handled by
 * `position: absolute; inset: 0` on the canvas elements.
 */
export function applyPendingResize(): boolean {
  if (!hasPendingResize) return false;
  hasPendingResize = false;
  const bCanvas = baseCtx?.canvas;
  const oCanvas = overlayCtx?.canvas;
  if (!bCanvas || !oCanvas) return false;
  if (bCanvas.width === pendingPixelW && bCanvas.height === pendingPixelH) return false;
  bCanvas.width = pendingPixelW;
  bCanvas.height = pendingPixelH;
  oCanvas.width = pendingPixelW;
  oCanvas.height = pendingPixelH;
  return true;
}

// ============================================
// CLASS
// ============================================

export class SurfaceManager {
  private container: HTMLElement;
  private baseCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private editorHostEl: HTMLDivElement;
  private resizeObserver: ResizeObserver | null = null;
  private dprCleanup: (() => void) | null = null;
  private currentDpr = window.devicePixelRatio || 1;

  constructor(
    container: HTMLElement,
    baseCanvas: HTMLCanvasElement,
    overlayCanvas: HTMLCanvasElement,
    editorHostEl: HTMLDivElement,
  ) {
    this.container = container;
    this.baseCanvas = baseCanvas;
    this.overlayCanvas = overlayCanvas;
    this.editorHostEl = editorHostEl;
  }

  start(): void {
    const base = this.baseCanvas.getContext('2d', { willReadFrequently: false });
    const overlay = this.overlayCanvas.getContext('2d', { willReadFrequently: false });
    if (!base || !overlay) throw new Error('Failed to get 2D contexts');
    baseCtx = base;
    overlayCtx = overlay;

    editorHost = this.editorHostEl;
    setCanvasElement(this.baseCanvas);
    applyCursor();

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      this.updateCanvasSize(width, height, this.currentDpr);
    });
    this.resizeObserver.observe(this.container);

    this.dprCleanup = this.setupDprListener();

    const rect = this.container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.updateCanvasSize(rect.width, rect.height, this.currentDpr);
      applyPendingResize();
    }
  }

  stop(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.dprCleanup?.();
    this.dprCleanup = null;

    hasPendingResize = false;

    baseCtx = null;
    overlayCtx = null;
    editorHost = null;
    setCanvasElement(null);
  }

  private updateCanvasSize(cssWidth: number, cssHeight: number, dpr: number): void {
    const maxDim = MAX_CANVAS_DIMENSION;

    const roundedCssW = Math.round(cssWidth);
    const roundedCssH = Math.round(cssHeight);
    if (roundedCssW <= 0 || roundedCssH <= 0) return;

    const rawPixelW = roundedCssW * dpr;
    const rawPixelH = roundedCssH * dpr;
    const pixelW = Math.min(Math.round(rawPixelW), maxDim);
    const pixelH = Math.min(Math.round(rawPixelH), maxDim);

    const effectiveDpr = Math.min(pixelW / roundedCssW, pixelH / roundedCssH);

    pendingPixelW = pixelW;
    pendingPixelH = pixelH;
    hasPendingResize = true;

    useCameraStore.getState().setViewport(roundedCssW, roundedCssH, effectiveDpr);
  }

  private setupDprListener(): () => void {
    this.currentDpr = window.devicePixelRatio || 1;
    const mediaQuery = window.matchMedia(`(resolution: ${this.currentDpr}dppx)`);

    const handleChange = () => {
      this.currentDpr = window.devicePixelRatio || 1;
      const rect = this.container.getBoundingClientRect();
      this.updateCanvasSize(rect.width, rect.height, this.currentDpr);

      mediaQuery.removeEventListener('change', handleChange);
      this.dprCleanup = this.setupDprListener();
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }
}
