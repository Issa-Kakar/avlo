import React, { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo } from 'react';
import { createEmptySnapshot } from '@avlo/shared';
import type { RoomId, Snapshot, ViewTransform } from '@avlo/shared';
import { ulid } from 'ulid';
import { CanvasStage, type CanvasStageHandle, type ResizeInfo } from './CanvasStage';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useViewTransform } from './ViewTransformContext';
import { RenderLoop } from '../renderer/RenderLoop';
import type { ViewportInfo } from '../renderer/types';
import { clearStrokeCache } from '../renderer/layers';
import { DrawingTool } from '@/lib/tools/DrawingTool';
import type { DeviceUIState } from '@/lib/tools/types';
import { toolbarToDeviceUI } from '@/lib/tools/types';
import { useDeviceUIStore } from '@/stores/device-ui-store';

export interface CanvasProps {
  roomId: RoomId;
  className?: string;
}

export interface CanvasHandle {
  screenToWorld: (clientX: number, clientY: number) => [number, number];
  worldToClient: (worldX: number, worldY: number) => [number, number];
  invalidateWorld: (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => void;
  setPreviewProvider: (provider: () => any) => void;
}

/**
 * Canvas component that integrates rendering with coordinate transforms.
 * Bridges between the low-level CanvasStage and high-level room data.
 *
 * Phase 3.3: Now uses RenderLoop with event-driven architecture
 * Phase 3.4: Fixed DPR handling in coordinate transforms
 */
export const Canvas = React.forwardRef<CanvasHandle, CanvasProps>(({ roomId, className }, ref) => {
  const stageRef = useRef<CanvasStageHandle>(null);
  const roomDoc = useRoomDoc(roomId); // MUST be called at top level, not inside useEffect
  const { transform: viewTransform } = useViewTransform();
  const drawingToolRef = useRef<DrawingTool>();
  const [_canvasSize, setCanvasSize] = useState<ResizeInfo | null>(null);
  const canvasSizeRef = useRef<ResizeInfo | null>(null); // For access in closures
  const renderLoopRef = useRef<RenderLoop | null>(null);

  // Generate stable user ID (Phase 5 placeholder)
  // IMPORTANT: This will be replaced by proper awareness management in Phase 6
  // For now, we generate a stable ID once per component mount (tab session)
  // We use useState (not useRef) to ensure the ID is created exactly once
  // and remains stable throughout the component lifecycle
  const [userId] = useState(() => {
    // Try to reuse existing ID from sessionStorage for consistency
    let id = sessionStorage.getItem('avlo-user-id');
    if (!id) {
      id = 'user-' + ulid();
      sessionStorage.setItem('avlo-user-id', id);
    }
    return id;
  });

  // Get toolbar state from Zustand store and convert to DrawingTool's DeviceUIState
  // Phase 9: Updated to use new store structure
  const { activeTool, pen, highlighter } = useDeviceUIStore();

  // Create a compatible toolbar object for the existing toolbarToDeviceUI function
  const toolbar = useMemo(() => {
    const currentSettings = activeTool === 'pen' ? pen : highlighter;
    return {
      tool: activeTool === 'pen' || activeTool === 'highlighter' ? activeTool : 'pen',
      color: currentSettings.color,
      size: currentSettings.size,
      opacity: currentSettings.opacity || 1,
    };
  }, [activeTool, pen, highlighter]);

  const deviceUI: DeviceUIState = useMemo(
    () => toolbarToDeviceUI(toolbar),
    // Re-create deviceUI when any toolbar property changes
    [toolbar.tool, toolbar.color, toolbar.size, toolbar.opacity],
  );

  // PERFORMANCE OPTIMIZATION: Store in ref to avoid React re-renders
  // We use the public subscription API (same as useRoomSnapshot hook) but store the result in a ref
  // instead of state to prevent React render storms at 60+ FPS. This maintains the architectural
  // boundary - we're still consuming immutable snapshots through the public API, just optimizing
  // how we store them to avoid unnecessary React work.
  const snapshotRef = useRef<Snapshot>(createEmptySnapshot()); // Initialize with empty snapshot
  const viewTransformRef = useRef<ViewTransform>(viewTransform); // Store latest transform

  // Keep view transform ref updated (no re-render)
  // Use useLayoutEffect to ensure ref is updated before drawing tool effect reads it
  useLayoutEffect(() => {
    viewTransformRef.current = viewTransform;
  }, [viewTransform]);

  // Subscribe to snapshots via public API (stores in ref to avoid re-renders)
  useEffect(() => {
    // Subscribe through public API and write to ref (not state)
    const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
      // IMPORTANT: DO NOT modify the snapshot - it must remain immutable
      // Phase 3 contract: snapshot.view remains identity transform - read view from UI instead
      snapshotRef.current = newSnapshot;

      // Phase 6: Always invalidate on new snapshot (no svKey gating)
      // The RenderLoop will detect scene changes and handle full clears accordingly
      if (renderLoopRef.current) {
        renderLoopRef.current.invalidateAll('snapshot-update');
      }
    });

    // Set initial snapshot
    snapshotRef.current = roomDoc.currentSnapshot;

    return unsubscribe;
  }, [roomDoc]); // Depend on roomDoc from hook

  // Helper to detect mobile (Phase 3.3 FPS throttling)
  const isMobile = useCallback(() => {
    return (
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      window.matchMedia?.('(max-width: 768px)').matches ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    );
  }, []);

  // Convert screen coordinates (DOM event) to world coordinates (Y.Doc space)
  // CRITICAL: This function is stable (no deps) to prevent effect re-runs
  // It reads viewTransform from ref to always use the latest transform
  const screenToWorld = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const canvas = stageRef.current?.getCanvasElement();
    const transform = viewTransformRef.current; // Always get latest transform
    if (!canvas || !transform) {
      console.warn('Cannot convert coordinates: canvas or transform not ready');
      return null; // Signal error to caller
    }

    const rect = canvas.getBoundingClientRect();
    // Screen → Canvas (CSS pixels)
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;

    // Canvas → World (using ViewTransform)
    return transform.canvasToWorld(canvasX, canvasY);
  }, []); // NO DEPENDENCIES - stable function that reads from refs

  // Convert world coordinates to client (CSS) coordinates
  // Used for positioning UI elements
  const worldToClient = useCallback(
    (worldX: number, worldY: number): [number, number] => {
      if (!stageRef.current) return [worldX, worldY];

      // World to canvas (returns CSS pixels)
      const [canvasX, canvasY] = viewTransform.worldToCanvas(worldX, worldY);

      // Get canvas element position
      const rect = stageRef.current.getBounds();

      // Canvas to screen (both in CSS pixels) - NO DPR division
      return [canvasX + rect.left, canvasY + rect.top];
    },
    [viewTransform],
  );

  // Handle resize events from CanvasStage
  const handleResize = useCallback((info: ResizeInfo) => {
    setCanvasSize(info);
    canvasSizeRef.current = info; // Update ref for closure access

    // Notify render loop of resize
    renderLoopRef.current?.setResizeInfo({
      width: info.pixelWidth,
      height: info.pixelHeight,
      dpr: info.dpr,
    });
  }, []);

  // CRITICAL FIX: Compute stageReady to ensure effect re-runs when stage becomes available
  // This prevents the initialization from silently failing if timing precondition is missed
  const stageReady = !!(renderLoopRef.current && stageRef.current?.getCanvasElement());

  // Initialize render loop on mount (stable, doesn't restart on transform changes)
  // Use useLayoutEffect to ensure render loop exists before drawing tool effect
  useLayoutEffect(() => {
    if (!stageRef.current) return;

    const renderLoop = new RenderLoop();
    renderLoopRef.current = renderLoop;

    renderLoop.start({
      stageRef,
      getView: () => viewTransformRef.current,
      getSnapshot: () => snapshotRef.current,
      getViewport: (): ViewportInfo => {
        // Use cached canvas size if available for better performance
        const cachedSize = canvasSizeRef.current;
        if (cachedSize && cachedSize.cssWidth > 0 && cachedSize.cssHeight > 0) {
          return {
            pixelWidth: cachedSize.pixelWidth,
            pixelHeight: cachedSize.pixelHeight,
            cssWidth: cachedSize.cssWidth,
            cssHeight: cachedSize.cssHeight,
            dpr: cachedSize.dpr,
          };
        }

        // Fallback to getBounds if canvasSize not yet set
        const bounds = stageRef.current?.getBounds();
        const dpr = window.devicePixelRatio || 1;

        if (!bounds || bounds.width === 0 || bounds.height === 0) {
          // Return minimal valid viewport for edge cases
          return {
            pixelWidth: 1,
            pixelHeight: 1,
            cssWidth: 1,
            cssHeight: 1,
            dpr,
          };
        }

        return {
          pixelWidth: Math.max(1, Math.round(bounds.width * dpr)),
          pixelHeight: Math.max(1, Math.round(bounds.height * dpr)),
          cssWidth: bounds.width,
          cssHeight: bounds.height,
          dpr,
        };
      },
      getGates: () => roomDoc.getGateStatus(), // Phase 7: Provide gate status for presence rendering
      isMobile,
      onStats: import.meta.env.DEV
        ? (stats) => {
            if (stats.frameCount % 60 === 0) {
              // eslint-disable-next-line no-console
              console.log('[RenderLoop Stats]', {
                fps: stats.fps.toFixed(1),
                avgMs: stats.avgMs.toFixed(2),
                overBudget: stats.overBudgetCount,
                skipped: stats.skippedCount,
                lastClear: stats.lastClearType,
              });
            }
          }
        : undefined,
    });

    // Trigger initial render if we have content
    // Use gate status instead of svKey comparison
    // Use setTimeout(0) instead of queueMicrotask for better safety
    // This ensures the render loop is fully initialized and avoids race conditions
    let initialRenderTimeout: ReturnType<typeof setTimeout> | undefined;
    const gateStatus = roomDoc.getGateStatus();
    if (gateStatus.firstSnapshot) {
      initialRenderTimeout = setTimeout(() => {
        // Safety check - renderLoop might have been destroyed if component unmounted quickly
        if (renderLoopRef.current === renderLoop) {
          renderLoop.invalidateAll('content-change');
        }
      }, 0);
    }

    return () => {
      if (initialRenderTimeout) {
        clearTimeout(initialRenderTimeout);
      }
      renderLoop.stop();
      renderLoop.destroy();
      renderLoopRef.current = null;
      // Clear stroke render cache on unmount
      // This prevents memory leaks when switching rooms
      clearStrokeCache();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // NO DEPENDENCIES - stable render loop lifecycle, isMobile is a stable callback

  // CRITICAL FIX: Combined initialization and event listener effect
  // This ensures everything is wired up atomically when dependencies are ready
  // IMPORTANT: viewTransform is NOT in dependencies to prevent mid-gesture teardown
  // stageReady IS in dependencies to ensure re-run when stage becomes available
  useEffect(() => {
    // Wait for all required dependencies
    const renderLoop = renderLoopRef.current;
    const canvas = stageRef.current?.getCanvasElement();
    const initialTransform = viewTransformRef.current; // Check initial availability

    // Guard: ensure all required components exist
    // This effect WILL re-run when stageReady changes (once)
    if (!renderLoop || !canvas || !roomDoc || !initialTransform) {
      // Only log in development mode
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.debug('DrawingTool waiting for dependencies:', {
          renderLoop: !!renderLoop,
          canvas: !!canvas,
          room: !!roomDoc,
          viewTransform: !!initialTransform,
        });
      }
      return; // Dependencies not ready yet, will retry when stageReady changes
    }

    // Validate that RenderLoop supports preview provider BEFORE creating tool
    if (typeof renderLoop.setPreviewProvider !== 'function') {
      console.error(
        'RenderLoop does not support preview provider - Phase 3 implementation missing',
      );
      return; // Exit early before creating tool to prevent memory leak
    }

    // Create drawing tool AFTER validation
    const tool = new DrawingTool(
      roomDoc,
      deviceUI,
      userId, // Pass the stable ID value
      (bounds) => {
        // Invalidate with inflated bounds
        renderLoop.invalidateWorld({
          minX: bounds[0],
          minY: bounds[1],
          maxX: bounds[2],
          maxY: bounds[3],
        });
      },
    );

    drawingToolRef.current = tool;

    // Mobile detection for view-only enforcement
    // CRITICAL FIX: Include maxTouchPoints check for iPadOS (reports as "Macintosh")
    const isMobile =
      /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

    // Set preview provider on RenderLoop (disabled on mobile - no authoring overlays)
    if (!isMobile) {
      renderLoop.setPreviewProvider({
        getPreview: () => tool.getPreview(),
      });
    }

    // EVENT LISTENERS - Attached in same effect to ensure atomicity
    const handlePointerDown = (e: PointerEvent) => {
      // Gate early for mobile view-only (no preview, no capture)
      if (isMobile) return;

      if (!tool.canStartDrawing()) return;

      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (!worldCoords) return; // Transform failed

      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);

      const [worldX, worldY] = worldCoords;
      tool.startDrawing(e.pointerId, worldX, worldY);

      // Update activity state to drawing
      roomDoc.updateActivity('drawing');
    };

    const handlePointerMove = (e: PointerEvent) => {
      // Update awareness cursor position (not on mobile)
      if (!isMobile) {
        const worldCoords = screenToWorld(e.clientX, e.clientY);
        if (worldCoords) {
          const [worldX, worldY] = worldCoords;
          roomDoc.updateCursor(worldX, worldY);
        }
      }

      if (!tool.isDrawing()) return;
      if (e.pointerId !== tool.getPointerId()) return;

      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (!worldCoords) return; // Transform failed, skip this point

      e.preventDefault();
      const [worldX, worldY] = worldCoords;
      tool.addPoint(worldX, worldY);
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (!tool.isDrawing()) return;
      if (e.pointerId !== tool.getPointerId()) return;

      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if already released
      }

      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (!worldCoords) {
        // Can't get final point, cancel the stroke for safety
        console.warn('Failed to get final coordinates, canceling stroke');
        tool.cancelDrawing();
        // Still update activity to idle even on cancel
        roomDoc.updateActivity('idle');
        return;
      }

      const [worldX, worldY] = worldCoords;
      tool.commitStroke(worldX, worldY);

      // Update activity state to idle
      roomDoc.updateActivity('idle');
    };

    const handlePointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== tool.getPointerId()) return;

      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if already released
      }

      tool.cancelDrawing();
    };

    const handleLostPointerCapture = (e: PointerEvent) => {
      if (e.pointerId !== tool.getPointerId()) return;
      tool.cancelDrawing();
    };

    const handlePointerLeave = () => {
      // Clear cursor when pointer leaves canvas
      roomDoc.updateCursor(undefined, undefined);
    };

    // Set canvas styles (conditional for mobile)
    if (!isMobile) {
      // Only disable touch on desktop (preserve scrolling on mobile)
      canvas.style.touchAction = 'none';
      canvas.style.cursor = 'crosshair';
    }
    // CRITICAL FIX: Ensure NO global CSS sets touch-action: none on canvas for mobile
    // Check your stylesheets - mobile MUST preserve touch-action: auto for scrolling
    // Note: Canvas CSS size should be set by CanvasStage
    // Physical size (width/height) = CSS size * DPR (handled by CanvasStage)

    // Attach listeners with non-passive flag for preventDefault
    canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
    canvas.addEventListener('pointermove', handlePointerMove, { passive: false });
    canvas.addEventListener('pointerup', handlePointerUp, { passive: false });
    canvas.addEventListener('pointercancel', handlePointerCancel, { passive: false });
    canvas.addEventListener('lostpointercapture', handleLostPointerCapture, { passive: false });
    canvas.addEventListener('pointerleave', handlePointerLeave, { passive: false });

    // CLEANUP - comprehensive cleanup on any dependency change
    return () => {
      // Cancel any in-progress drawing
      const pointerId = tool.getPointerId();
      if (pointerId !== null) {
        try {
          canvas.releasePointerCapture(pointerId);
        } catch {
          // Ignore errors
        }
      }
      tool.cancelDrawing();

      // Remove event listeners
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerCancel);
      canvas.removeEventListener('lostpointercapture', handleLostPointerCapture);
      canvas.removeEventListener('pointerleave', handlePointerLeave);

      // Clean up tool and preview provider
      tool.destroy();
      drawingToolRef.current = undefined;
      renderLoop.setPreviewProvider(null);
    };
  }, [roomDoc, userId, deviceUI, stageReady, screenToWorld]); // CRITICAL: stageReady ensures re-run, but NO viewTransform to prevent mid-gesture teardown

  // Transform change detection (separate from lifecycle)
  useEffect(() => {
    // Trigger a frame when transform changes
    // The DirtyRectTracker.notifyTransformChange() in tick() will detect the change
    // and automatically promote to full clear - we just need to trigger the frame
    renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
  }, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);

  // Expose coordinate transform functions and render loop methods via ref
  React.useImperativeHandle(
    ref,
    () => ({
      screenToWorld: (clientX: number, clientY: number): [number, number] => {
        const result = screenToWorld(clientX, clientY);
        return result || [clientX, clientY]; // Fallback for compatibility
      },
      worldToClient,
      invalidateWorld: (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => {
        renderLoopRef.current?.invalidateWorld(bounds);
      },
      setPreviewProvider: (provider: () => any) => {
        // Store provider on renderLoop for Phase 5 preview rendering
        if (renderLoopRef.current) {
          (renderLoopRef.current as any).previewProvider = provider;
        }
      },
    }),
    [screenToWorld, worldToClient],
  );

  return <CanvasStage ref={stageRef} className={className} onResize={handleResize} />;
});

Canvas.displayName = 'Canvas';
