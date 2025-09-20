import React, { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo } from 'react';
import { createEmptySnapshot } from '@avlo/shared';
import type { RoomId, Snapshot, ViewTransform } from '@avlo/shared';
import { ulid } from 'ulid';
import { CanvasStage, type CanvasStageHandle, type ResizeInfo } from './CanvasStage';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useViewTransform } from './ViewTransformContext';
import { RenderLoop } from '../renderer/RenderLoop';
import { OverlayRenderLoop } from '../renderer/OverlayRenderLoop';
import type { ViewportInfo } from '../renderer/types';
import { clearStrokeCache, drawPresenceOverlays } from '../renderer/layers';
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import type { DeviceUIState } from '@/lib/tools/types';
import { toolbarToDeviceUI } from '@/lib/tools/types';
import { useDeviceUIStore } from '@/stores/device-ui-store';

// Unified interface for both DrawingTool and EraserTool
type PointerTool = DrawingTool | EraserTool;

// Epsilon equality for floating point comparison
function bboxEquals(a: number[], b: number[]): boolean {
  const eps = 1e-3;
  return (
    Math.abs(a[0] - b[0]) < eps &&
    Math.abs(a[1] - b[1]) < eps &&
    Math.abs(a[2] - b[2]) < eps &&
    Math.abs(a[3] - b[3]) < eps
  );
}

interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function diffBounds(prev: Snapshot, next: Snapshot): WorldBounds[] {
  const prevStrokeMap = new Map(prev.strokes.map((s) => [s.id, s]));
  const nextStrokeMap = new Map(next.strokes.map((s) => [s.id, s]));
  const dirty: WorldBounds[] = [];

  // Added/modified strokes
  for (const [id, stroke] of nextStrokeMap) {
    const prevStroke = prevStrokeMap.get(id);
    if (!prevStroke || !bboxEquals(prevStroke.bbox, stroke.bbox)) {
      // Don't inflate here - DirtyRectTracker will handle it
      dirty.push({
        minX: stroke.bbox[0],
        minY: stroke.bbox[1],
        maxX: stroke.bbox[2],
        maxY: stroke.bbox[3],
      });
    }
  }

  // Removed strokes
  for (const [id, stroke] of prevStrokeMap) {
    if (!nextStrokeMap.has(id)) {
      // Don't inflate here - DirtyRectTracker will handle it
      dirty.push({
        minX: stroke.bbox[0],
        minY: stroke.bbox[1],
        maxX: stroke.bbox[2],
        maxY: stroke.bbox[3],
      });
    }
  }

  // Handle text blocks
  const prevTextMap = new Map(prev.texts.map((t) => [t.id, t]));
  const nextTextMap = new Map(next.texts.map((t) => [t.id, t]));

  // Added/modified texts
  for (const [id, text] of nextTextMap) {
    const prevText = prevTextMap.get(id);
    if (
      !prevText ||
      prevText.x !== text.x ||
      prevText.y !== text.y ||
      prevText.w !== text.w ||
      prevText.h !== text.h
    ) {
      // Don't add padding here - DirtyRectTracker will handle it
      dirty.push({
        minX: text.x,
        minY: text.y,
        maxX: text.x + text.w,
        maxY: text.y + text.h,
      });
    }
  }

  // Removed texts
  for (const [id, text] of prevTextMap) {
    if (!nextTextMap.has(id)) {
      // Don't add padding here - DirtyRectTracker will handle it
      dirty.push({
        minX: text.x,
        minY: text.y,
        maxX: text.x + text.w,
        maxY: text.y + text.h,
      });
    }
  }

  return dirty; // Let DirtyRectTracker handle coalescing
}

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
  // Replace single stageRef with two stages
  const baseStageRef = useRef<CanvasStageHandle>(null);
  const overlayStageRef = useRef<CanvasStageHandle>(null);
  const roomDoc = useRoomDoc(roomId); // MUST be called at top level, not inside useEffect
  const { transform: viewTransform } = useViewTransform();
  const toolRef = useRef<PointerTool>();
  const [_canvasSize, setCanvasSize] = useState<ResizeInfo | null>(null);
  const canvasSizeRef = useRef<ResizeInfo | null>(null); // For access in closures
  const renderLoopRef = useRef<RenderLoop | null>(null); // existing
  const overlayLoopRef = useRef<OverlayRenderLoop | null>(null); // new

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
  const { activeTool, pen, highlighter, eraser } = useDeviceUIStore();

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
  // 3C: Update snapshot subscription to check docVersion
  useEffect(() => {
    let lastDocVersion = -1;

    const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
      const prevSnapshot = snapshotRef.current;
      snapshotRef.current = newSnapshot;

      if (!renderLoopRef.current || !overlayLoopRef.current) return;

      // Check if scene changed (requires full clear on both)
      if (!prevSnapshot || prevSnapshot.scene !== newSnapshot.scene) {
        renderLoopRef.current.invalidateAll('scene-change');
        overlayLoopRef.current.invalidateAll();
        lastDocVersion = newSnapshot.docVersion;
        return;
      }

      // Check if document content changed (not just presence)
      // CRITICAL: docVersion increments on Y.Doc changes, NOT on presence changes
      if (newSnapshot.docVersion !== lastDocVersion) {
        lastDocVersion = newSnapshot.docVersion;

        // Hold preview for one frame to prevent flash on commit
        overlayLoopRef.current.holdPreviewForOneFrame();

        // Use bbox diffing for targeted invalidation
        const changedBounds = diffBounds(prevSnapshot, newSnapshot);

        // Use optimized dirty rect invalidation for all changes
        // The translucent check in RenderLoop will promote to full clear when needed
        for (const bounds of changedBounds) {
          renderLoopRef.current.invalidateWorld(bounds);
        }

        overlayLoopRef.current.invalidateAll(); // Also update overlay for new doc
      } else {
        // Presence-only change - update overlay only
        overlayLoopRef.current.invalidateAll();
      }
    });

    snapshotRef.current = roomDoc.currentSnapshot;
    lastDocVersion = roomDoc.currentSnapshot.docVersion;

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
    const canvas = baseStageRef.current?.getCanvasElement();
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
      if (!baseStageRef.current) return [worldX, worldY];

      // World to canvas (returns CSS pixels)
      const [canvasX, canvasY] = viewTransform.worldToCanvas(worldX, worldY);

      // Get canvas element position
      const rect = baseStageRef.current.getBounds();

      // Canvas to screen (both in CSS pixels) - NO DPR division
      return [canvasX + rect.left, canvasY + rect.top];
    },
    [viewTransform],
  );

  // 3G: Handle resize for both stages
  const handleBaseResize = useCallback((info: ResizeInfo) => {
    setCanvasSize(info);
    canvasSizeRef.current = info;
    renderLoopRef.current?.setResizeInfo({
      width: info.pixelWidth,
      height: info.pixelHeight,
      dpr: info.dpr,
    });
  }, []);

  const handleOverlayResize = useCallback((_info: ResizeInfo) => {
    // Overlay just needs to invalidate on resize
    overlayLoopRef.current?.invalidateAll();
  }, []);

  // CRITICAL FIX: Compute stageReady to ensure effect re-runs when stage becomes available
  // This prevents the initialization from silently failing if timing precondition is missed
  const stageReady = !!(renderLoopRef.current && baseStageRef.current?.getCanvasElement());

  // 3D: Initialize base render loop
  // Use useLayoutEffect to ensure render loop exists before drawing tool effect
  useLayoutEffect(() => {
    if (!baseStageRef.current) return;

    const renderLoop = new RenderLoop();
    renderLoopRef.current = renderLoop;

    renderLoop.start({
      stageRef: baseStageRef,
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
        const bounds = baseStageRef.current?.getBounds();
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

  // 3E: Add overlay render loop initialization
  useLayoutEffect(() => {
    if (!overlayStageRef.current) return;

    const overlayLoop = new OverlayRenderLoop();
    overlayLoopRef.current = overlayLoop;

    overlayLoop.start({
      stage: overlayStageRef.current!,
      getView: () => viewTransformRef.current!,
      getViewport: () => {
        const cachedSize = canvasSizeRef.current;
        if (cachedSize && cachedSize.cssWidth > 0) {
          return {
            cssWidth: cachedSize.cssWidth,
            cssHeight: cachedSize.cssHeight,
            dpr: cachedSize.dpr,
          };
        }
        // Fallback
        const dpr = window.devicePixelRatio || 1;
        return { cssWidth: 1, cssHeight: 1, dpr };
      },
      getGates: () => roomDoc.getGateStatus(),
      getPresence: () => snapshotRef.current.presence, // Get from current snapshot
      getSnapshot: () => snapshotRef.current, // Added for eraser dimming
      drawPresence: (ctx, presence, view, vp) => {
        // Import drawPresenceOverlays from layers
        const viewport: ViewportInfo = {
          pixelWidth: Math.round(vp.cssWidth * vp.dpr),
          pixelHeight: Math.round(vp.cssHeight * vp.dpr),
          cssWidth: vp.cssWidth,
          cssHeight: vp.cssHeight,
          dpr: vp.dpr,
        };
        drawPresenceOverlays(
          ctx,
          snapshotRef.current, // Pass full snapshot (presence is already up-to-date)
          view,
          viewport,
          roomDoc.getGateStatus(),
        );
      },
    });

    return () => {
      overlayLoop.stop();
      overlayLoop.destroy();
      overlayLoopRef.current = null;
    };
  }, [roomDoc]);

  // CRITICAL FIX: Combined initialization and event listener effect
  // This ensures everything is wired up atomically when dependencies are ready
  // IMPORTANT: viewTransform is NOT in dependencies to prevent mid-gesture teardown
  // stageReady IS in dependencies to ensure re-run when stage becomes available
  useEffect(() => {
    // Wait for all required dependencies
    const renderLoop = renderLoopRef.current;
    const canvas = baseStageRef.current?.getCanvasElement();
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

    // Mobile detection for view-only enforcement
    // CRITICAL FIX: Include maxTouchPoints check for iPadOS (reports as "Macintosh")
    const isMobile =
      /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

    // Create appropriate tool based on activeTool (branch ONCE here)
    let tool: PointerTool | null = null;

    if (activeTool === 'eraser') {
      // Pass deviceUI.eraser directly (no adapter needed)
      tool = new EraserTool(
        roomDoc,
        eraser,  // Direct from store, no adapter
        userId,
        () => overlayLoopRef.current?.invalidateAll(),
        // Pass viewport callback for hit-test pruning
        () => {
          const size = canvasSizeRef.current;
          if (size) {
            return {
              cssWidth: size.cssWidth,
              cssHeight: size.cssHeight,
              dpr: size.dpr
            };
          }
          return { cssWidth: 1, cssHeight: 1, dpr: 1 };
        }
      );
    } else if (activeTool === 'pen' || activeTool === 'highlighter') {
      // Use adapter only for DrawingTool
      const adaptedUI = toolbarToDeviceUI({
        tool: activeTool,
        color: activeTool === 'pen' ? pen.color : highlighter.color,
        size: activeTool === 'pen' ? pen.size : highlighter.size,
        opacity: activeTool === 'pen' ? (pen.opacity || 1) : (highlighter.opacity || 0.25)
      });

      tool = new DrawingTool(
        roomDoc,
        adaptedUI,
        userId,
        (_bounds) => {
          // During drawing, invalidate overlay (preview is there)
          // The overlay will full-clear anyway, but this triggers a frame
          overlayLoopRef.current?.invalidateAll();
        },
      );
    } else {
      return; // Unsupported tool
    }

    toolRef.current = tool;

    // Set preview provider on overlay loop (both tools implement getPreview())
    if (!isMobile && overlayLoopRef.current) {
      overlayLoopRef.current.setPreviewProvider({
        getPreview: () => tool?.getPreview() || null,
      });
    }

    // Update cursor style
    canvas.style.cursor = activeTool === 'eraser' ? 'none' : 'crosshair';

    // UNIFIED POINTER HANDLERS - No tool branching here!
    const handlePointerDown = (e: PointerEvent) => {
      // Canvas gates for mobile (not tool)
      if (isMobile) return;
      if (!tool?.canBegin()) return;

      const worldCoords = screenToWorld(e.clientX, e.clientY);
      if (!worldCoords) return;

      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);

      // Polymorphic call - works for any tool
      tool.begin(e.pointerId, worldCoords[0], worldCoords[1]);
      roomDoc.updateActivity('drawing'); // Same for pen/eraser
    };

    const handlePointerMove = (e: PointerEvent) => {
      // Update awareness cursor (not on mobile)
      if (!isMobile) {
        const worldCoords = screenToWorld(e.clientX, e.clientY);
        if (worldCoords) {
          roomDoc.updateCursor(worldCoords[0], worldCoords[1]);

          // Always forward movement to the tool (for hover preview)
          if (tool) {
            tool.move(worldCoords[0], worldCoords[1]);
          }
        }
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (!tool?.isActive() || e.pointerId !== tool.getPointerId()) return;

      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}

      const worldCoords = screenToWorld(e.clientX, e.clientY);
      tool.end(worldCoords?.[0], worldCoords?.[1]);
      roomDoc.updateActivity('idle');
    };

    const handlePointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== tool?.getPointerId()) return;

      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}

      tool?.cancel();
      roomDoc.updateActivity('idle');
    };

    const handleLostPointerCapture = (e: PointerEvent) => {
      if (e.pointerId !== tool?.getPointerId()) return;
      tool?.cancel();
    };

    const handlePointerLeave = () => {
      // Clear cursor when pointer leaves canvas
      roomDoc.updateCursor(undefined, undefined);
    };

    // Set canvas styles (conditional for mobile)
    if (!isMobile) {
      // Only disable touch on desktop (preserve scrolling on mobile)
      canvas.style.touchAction = 'none';
      // Don't override the cursor here - it was already set based on tool above
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
      // Cleanup
      const pointerId = tool?.getPointerId();
      if (pointerId !== null) {
        try {
          canvas.releasePointerCapture(pointerId);
        } catch {}
      }
      tool?.cancel();
      tool?.destroy();
      toolRef.current = undefined;
      overlayLoopRef.current?.setPreviewProvider(null);

      // Remove event listeners
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerCancel);
      canvas.removeEventListener('lostpointercapture', handleLostPointerCapture);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, [roomDoc, userId, activeTool, pen, highlighter, eraser, stageReady, screenToWorld]); // Include all tool dependencies

  // 3F: Handle transform changes for both loops
  useEffect(() => {
    // Trigger a frame when transform changes
    // The DirtyRectTracker.notifyTransformChange() in tick() will detect the change
    // and automatically promote to full clear - we just need to trigger the frame
    renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
    overlayLoopRef.current?.invalidateAll(); // Overlay needs redraw on pan/zoom
  }, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);

  // 3H: Update imperative handle for preview routing
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
        // Route to overlay loop instead of base loop
        if (overlayLoopRef.current) {
          overlayLoopRef.current.setPreviewProvider({
            getPreview: provider,
          });
        }
      },
    }),
    [screenToWorld, worldToClient],
  );

  // 3J: Update JSX to render two canvases
  return (
    <div className="relative w-full h-full">
      <CanvasStage
        ref={baseStageRef}
        className={className}
        style={{ position: 'absolute', inset: 0, zIndex: 1 }}
        onResize={handleBaseResize}
      />
      <CanvasStage
        ref={overlayStageRef}
        className={className}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 2,
          pointerEvents: 'none', // Critical: overlay doesn't block input
        }}
        onResize={handleOverlayResize}
      />
    </div>
  );
});

Canvas.displayName = 'Canvas';
