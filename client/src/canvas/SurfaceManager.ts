/**
 * SurfaceManager - Imperative resize/DPR handling + DOM registry for canvas system
 *
 * Manages both base and overlay canvases atomically:
 * - Single ResizeObserver on container (not individual canvases)
 * - DPR change listener with recursive re-setup
 * - Computes effective DPR when dimensions are clamped to MAX_CANVAS_DIMENSION
 *
 * Also serves as the module-level registry for:
 * - Base/overlay 2D rendering contexts
 * - Editor host div for TextTool
 *
 * Owned by CanvasRuntime.
 *
 * @module canvas/SurfaceManager
 */

import { PERFORMANCE_CONFIG } from '@avlo/shared';
import { useCameraStore, setCanvasElement } from '@/stores/camera-store';
import { applyCursor } from '@/stores/device-ui-store';

// ============================================
// MODULE-LEVEL DOM REFS
// ============================================

let baseCtx: CanvasRenderingContext2D | null = null;
let overlayCtx: CanvasRenderingContext2D | null = null;
let editorHost: HTMLDivElement | null = null;

// Deferred resize state - applied at start of next render frame
let pendingCssW = 0;
let pendingCssH = 0;
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
 * Sets CSS display dimensions and backing store atomically so the browser
 * never CSS-scales stale content into a differently-sized box.
 */
export function applyPendingResize(): boolean {
  if (!hasPendingResize) return false;
  hasPendingResize = false;
  const bCanvas = baseCtx?.canvas;
  const oCanvas = overlayCtx?.canvas;
  if (!bCanvas || !oCanvas) return false;
  if (bCanvas.width === pendingPixelW && bCanvas.height === pendingPixelH) return false;
  // CSS display size (integer px) — set BEFORE backing store so layout is correct
  const cssW = pendingCssW + 'px';
  const cssH = pendingCssH + 'px';
  bCanvas.style.width = cssW;
  bCanvas.style.height = cssH;
  oCanvas.style.width = cssW;
  oCanvas.style.height = cssH;
  // Backing store (device pixels) — resets context state
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

  /**
   * Start observing resize and DPR changes.
   * Also sets up all DOM refs: contexts, canvas element, editor host.
   * Call after canvases are mounted.
   */
  start(): void {
    // 1. Get and store 2D contexts
    const base = this.baseCanvas.getContext('2d', { willReadFrequently: false });
    const overlay = this.overlayCanvas.getContext('2d', { willReadFrequently: false });
    if (!base || !overlay) throw new Error('Failed to get 2D contexts');
    baseCtx = base;
    overlayCtx = overlay;

    // 2. Set editor host for TextTool DOM access
    editorHost = this.editorHostEl;

    // 3. Set canvas element for coordinate transforms
    setCanvasElement(this.baseCanvas);

    // 4. Apply initial cursor based on persisted active tool
    // (device-ui-store self-subscribes for future tool changes)
    applyCursor();

    // 5. Single ResizeObserver on container (not individual canvases)
    // No debounce needed: applyPendingResize() sets CSS dims + backing store
    // atomically, so no CSS stretching regardless of update frequency.
    // ResizeObserver fires once per frame; canvas updates on the next rAF.
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      this.updateCanvasSize(width, height, this.currentDpr);
    });
    this.resizeObserver.observe(this.container);

    // DPR change listener
    this.dprCleanup = this.setupDprListener();

    // Trigger initial sizing (synchronous - no content to protect yet)
    const rect = this.container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.updateCanvasSize(rect.width, rect.height, this.currentDpr);
      applyPendingResize();
    }
  }

  /**
   * Stop observing and clean up.
   * Clears all DOM refs: contexts, canvas element, editor host.
   */
  stop(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.dprCleanup?.();
    this.dprCleanup = null;

    // Clear pending resize
    hasPendingResize = false;

    // Clear all DOM refs
    baseCtx = null;
    overlayCtx = null;
    editorHost = null;
    setCanvasElement(null);
  }

  /**
   * Update both canvas backing stores and notify camera store.
   * Computes effective DPR when dimensions are clamped.
   */
  private updateCanvasSize(cssWidth: number, cssHeight: number, dpr: number): void {
    const maxDim = PERFORMANCE_CONFIG.MAX_CANVAS_DIMENSION;

    // Round CSS dims to integers — eliminates sub-pixel jitter from flexbox/percentage layout
    const roundedCssW = Math.round(cssWidth);
    const roundedCssH = Math.round(cssHeight);
    if (roundedCssW <= 0 || roundedCssH <= 0) return;

    const rawPixelW = roundedCssW * dpr;
    const rawPixelH = roundedCssH * dpr;
    const pixelW = Math.min(Math.round(rawPixelW), maxDim);
    const pixelH = Math.min(Math.round(rawPixelH), maxDim);

    // CRITICAL: Compute effective DPR when dimensions are clamped
    const effectiveDpr = Math.min(pixelW / roundedCssW, pixelH / roundedCssH);

    // Queue resize for next render frame (avoids clearing canvas between frames)
    pendingCssW = roundedCssW;
    pendingCssH = roundedCssH;
    pendingPixelW = pixelW;
    pendingPixelH = pixelH;
    hasPendingResize = true;

    // Coordinate transforms need current values immediately
    useCameraStore.getState().setViewport(roundedCssW, roundedCssH, effectiveDpr);
  }

  /**
   * Setup DPR change listener using media query.
   * Returns cleanup function.
   */
  private setupDprListener(): () => void {
    this.currentDpr = window.devicePixelRatio || 1;
    const mediaQuery = window.matchMedia(`(resolution: ${this.currentDpr}dppx)`);

    const handleChange = () => {
      this.currentDpr = window.devicePixelRatio || 1;
      const rect = this.container.getBoundingClientRect();
      this.updateCanvasSize(rect.width, rect.height, this.currentDpr);

      // Recursive re-setup for new DPR value
      mediaQuery.removeEventListener('change', handleChange);
      this.dprCleanup = this.setupDprListener();
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }
}
