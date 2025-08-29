import React, { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { PERFORMANCE_CONFIG } from '@avlo/shared';
import { configureContext2D } from './internal/context2d';

/**
 * CanvasStage - A render substrate for the whiteboard
 *
 * This component provides a properly sized, DPR-aware canvas element
 * without any knowledge of Y.Doc or CRDT structures. It's a pure
 * rendering surface that will be driven by immutable snapshots.
 *
 * Architecture boundaries:
 * - NO imports of yjs, y-websocket, y-indexeddb, or y-webrtc
 * - Receives only immutable data structures
 * - Future ViewTransform (Phase 3.2) applied via withContext
 * - Render loop (Phase 3.3) will call withContext for drawing
 *
 * DPR Handling:
 * - Canvas backing store sized to device pixels (width * dpr)
 * - Default transform applies DPR scaling
 * - Clear() uses identity transform + device pixels (Option A)
 * - DPR changes trigger re-binding of media query listener
 *
 * @module canvas/CanvasStage
 */

export interface ResizeInfo {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  pixelWidth: number;
  pixelHeight: number;
}

export interface CanvasStageProps {
  className?: string;
  style?: React.CSSProperties;
  onResize?: (info: ResizeInfo) => void;
}

export interface CanvasStageHandle {
  /**
   * Clears the entire canvas using device pixel coordinates.
   * Uses identity transform to ensure complete clearing.
   */
  clear(): void;

  /**
   * Executes a drawing operation with proper save/restore state management.
   * The provided function receives a context with current DPR transform applied.
   *
   * @param run - Function that performs drawing operations on the context
   */
  withContext(run: (ctx: CanvasRenderingContext2D) => void): void;

  /**
   * Gets the bounding client rect of the canvas element.
   * Used for coordinate conversion between screen and canvas space.
   */
  getBounds(): DOMRect;
}

/**
 * Canvas component providing a DPR-aware rendering surface.
 * Handles resize observation, device pixel ratio changes, and provides
 * imperative methods for clearing and context access.
 */
export const CanvasStage = forwardRef<CanvasStageHandle, CanvasStageProps>(
  ({ className, style, onResize }, ref) => {
    // Canvas element reference
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // 2D rendering context (obtained once, reused)
    const ctxRef = useRef<CanvasRenderingContext2D | null>(null);

    // ResizeObserver instance for tracking size changes
    const resizeObserverRef = useRef<ResizeObserver | null>(null);

    // Current device pixel ratio
    const dprRef = useRef<number>(window.devicePixelRatio || 1);

    // Current canvas dimensions in CSS pixels
    const dimensionsRef = useRef<{ cssWidth: number; cssHeight: number }>({
      cssWidth: 0,
      cssHeight: 0,
    });

    // Media query listener for DPR changes
    const dprChangeListenerRef = useRef<(MediaQueryList & { handler?: () => void }) | null>(null);

    // Expose imperative API to parent components
    useImperativeHandle(
      ref,
      () => ({
        clear(): void {
          const ctx = ctxRef.current;
          const canvas = canvasRef.current;
          if (!ctx || !canvas) return;

          // Option A: Reset to identity, clear device pixels
          // This is more predictable and doesn't depend on current transform state
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0); // Identity transform
          ctx.clearRect(0, 0, canvas.width, canvas.height); // Device pixels
          ctx.restore();
        },

        withContext(run: (ctx: CanvasRenderingContext2D) => void): void {
          const ctx = ctxRef.current;
          if (!ctx) return;

          ctx.save();
          try {
            run(ctx);
          } finally {
            ctx.restore();
          }
        },

        getBounds(): DOMRect {
          return canvasRef.current?.getBoundingClientRect() || new DOMRect();
        },
      }),
      [],
    );

    // Setup ResizeObserver and DPR change listener
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Setup DPR change listener with proper cleanup
      const setupDPRListener = () => {
        // Clean up any existing listener first
        if (dprChangeListenerRef.current) {
          const oldListener = dprChangeListenerRef.current;
          const oldHandler = oldListener.handler;
          if (oldHandler) {
            oldListener.removeEventListener('change', oldHandler);
          }
        }

        const dpr = window.devicePixelRatio || 1;
        const mediaQuery = window.matchMedia(`(resolution: ${dpr}dppx)`);

        const handleDPRChange = () => {
          // Re-run the resize logic with new DPR
          if (canvasRef.current) {
            const rect = canvasRef.current.getBoundingClientRect();
            const newDpr = window.devicePixelRatio || 1;

            // Update stored values
            dprRef.current = newDpr;

            // Reapply sizing and transforms with size limits
            const maxDim = PERFORMANCE_CONFIG.MAX_CANVAS_DIMENSION;
            canvasRef.current.width = Math.min(rect.width * newDpr, maxDim);
            canvasRef.current.height = Math.min(rect.height * newDpr, maxDim);

            if (ctxRef.current) {
              configureContext2D(ctxRef.current);
              ctxRef.current.setTransform(newDpr, 0, 0, newDpr, 0, 0);
            }

            // Notify parent
            onResize?.({
              cssWidth: rect.width,
              cssHeight: rect.height,
              dpr: newDpr,
              pixelWidth: rect.width * newDpr,
              pixelHeight: rect.height * newDpr,
            });

            // Recreate listener for the new DPR value
            // Important: this will clean up the current listener first
            setupDPRListener();
          }
        };

        mediaQuery.addEventListener('change', handleDPRChange);
        // Store both the query and handler for proper cleanup
        dprChangeListenerRef.current = Object.assign(mediaQuery, { handler: handleDPRChange });
      };

      // Create ResizeObserver
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // Use contentRect for content-box sizing to avoid feedback loops
          const { width, height } = entry.contentRect; // CSS pixels
          const dpr = window.devicePixelRatio || 1;

          // Store current values in refs for use in clear() and withContext()
          dprRef.current = dpr;
          dimensionsRef.current = { cssWidth: width, cssHeight: height };

          // Set canvas buffer size (actual device pixels) with size limits
          // This changes backing store only, not CSS dimensions
          const maxDim = PERFORMANCE_CONFIG.MAX_CANVAS_DIMENSION;
          canvas.width = Math.min(width * dpr, maxDim);
          canvas.height = Math.min(height * dpr, maxDim);

          // Get context if first time
          if (!ctxRef.current) {
            const ctx = canvas.getContext('2d', {
              willReadFrequently: false,
            });
            if (!ctx) {
              console.error('Failed to get 2D context');
              return;
            }
            ctxRef.current = ctx;
            configureContext2D(ctx); // Apply defaults
          }

          // Apply device scale transform for DPR-aware rendering
          ctxRef.current.setTransform(dpr, 0, 0, dpr, 0, 0);

          // Notify parent
          onResize?.({
            cssWidth: width,
            cssHeight: height,
            dpr,
            pixelWidth: width * dpr,
            pixelHeight: height * dpr,
          });
        }
      });

      // Start observing
      observer.observe(canvas);
      resizeObserverRef.current = observer;

      // Setup DPR change listener
      setupDPRListener();

      // Cleanup on unmount
      return () => {
        resizeObserverRef.current?.disconnect();
        if (dprChangeListenerRef.current) {
          const listener = dprChangeListenerRef.current;
          const handler = listener.handler;
          if (handler) {
            listener.removeEventListener('change', handler);
          }
        }

        // Null all refs
        ctxRef.current = null;
        resizeObserverRef.current = null;
        dprChangeListenerRef.current = null;
      };
    }, [onResize]);

    return (
      <canvas
        ref={canvasRef}
        style={{
          display: 'block', // Remove inline spacing
          width: '100%', // Fill parent width
          height: '100%', // Fill parent height
          touchAction: 'none', // Prepare for Phase 5 pointer events
          ...style, // Allow style overrides
        }}
        className={className}
      />
    );
  },
);

CanvasStage.displayName = 'CanvasStage';

// Phase 3.2 Integration Point: ViewTransform
// The ViewTransform from props will be applied here within withContext
// Example: ctx.transform(view.scale, 0, 0, view.scale, view.pan.x, view.pan.y)

// Phase 3.3 Integration Point: Render Loop
// The render loop will call withContext to draw layers:
// 1. Background
// 2. Strokes (Phase 4)
// 3. Text (Phase 11)
// 4. Overlays (Phase 8)

// Phase 5 Integration Point: Pointer Events
// Event listeners will be attached to the canvas element or a sibling overlay
