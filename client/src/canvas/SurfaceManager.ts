/**
 * SurfaceManager - Imperative resize and DPR handling for dual-canvas setup
 *
 * Manages both base and overlay canvases atomically:
 * - Single ResizeObserver on container (not individual canvases)
 * - DPR change listener with recursive re-setup
 * - Computes effective DPR when dimensions are clamped to MAX_CANVAS_DIMENSION
 *
 * Will be owned by CanvasRuntime in future phases.
 *
 * @module canvas/SurfaceManager
 */

import { PERFORMANCE_CONFIG } from '@avlo/shared';
import { useCameraStore } from '@/stores/camera-store';

export class SurfaceManager {
  private container: HTMLElement;
  private baseCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private resizeObserver: ResizeObserver | null = null;
  private dprCleanup: (() => void) | null = null;
  private currentDpr = window.devicePixelRatio || 1;

  constructor(
    container: HTMLElement,
    baseCanvas: HTMLCanvasElement,
    overlayCanvas: HTMLCanvasElement,
  ) {
    this.container = container;
    this.baseCanvas = baseCanvas;
    this.overlayCanvas = overlayCanvas;
  }

  /**
   * Start observing resize and DPR changes.
   * Call after canvases are mounted.
   */
  start(): void {
    // Single ResizeObserver on container (not individual canvases)
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      this.updateCanvasSize(width, height, this.currentDpr);
    });
    this.resizeObserver.observe(this.container);

    // DPR change listener
    this.dprCleanup = this.setupDprListener();

    // Trigger initial sizing
    const rect = this.container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.updateCanvasSize(rect.width, rect.height, this.currentDpr);
    }
  }

  /**
   * Stop observing and clean up.
   */
  stop(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.dprCleanup?.();
    this.dprCleanup = null;
  }

  /**
   * Update both canvas backing stores and notify camera store.
   * Computes effective DPR when dimensions are clamped.
   */
  private updateCanvasSize(cssWidth: number, cssHeight: number, dpr: number): void {
    const maxDim = PERFORMANCE_CONFIG.MAX_CANVAS_DIMENSION;

    // Calculate pixel dimensions with clamping
    const rawPixelW = cssWidth * dpr;
    const rawPixelH = cssHeight * dpr;
    const pixelW = Math.min(Math.round(rawPixelW), maxDim);
    const pixelH = Math.min(Math.round(rawPixelH), maxDim);

    // CRITICAL: Compute effective DPR when dimensions are clamped
    // This fixes the bug where camera store received raw DPR but canvas was clamped
    const effectiveDpr = Math.min(pixelW / cssWidth, pixelH / cssHeight);

    // Only set if changed - setting canvas dimensions ALWAYS clears the canvas!
    if (this.baseCanvas.width !== pixelW || this.baseCanvas.height !== pixelH) {
      this.baseCanvas.width = pixelW;
      this.baseCanvas.height = pixelH;
      this.overlayCanvas.width = pixelW;
      this.overlayCanvas.height = pixelH;
    }

    // Update camera store with EFFECTIVE DPR
    // Render loops subscribe to this and will invalidate appropriately
    useCameraStore.getState().setViewport(cssWidth, cssHeight, effectiveDpr);
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
