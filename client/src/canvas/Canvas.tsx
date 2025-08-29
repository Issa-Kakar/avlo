import React, { useRef, useCallback, useState, useEffect } from 'react';
import type { RoomId, Snapshot, ViewTransform } from '@avlo/shared';
import { createEmptySnapshot } from '@avlo/shared';
import { CanvasStage, type CanvasStageHandle, type ResizeInfo } from './CanvasStage';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useViewTransform } from './ViewTransformContext';
import { RenderLoop } from '../renderer/RenderLoop';
import type { ViewportInfo } from '../renderer/types';
import { clearStrokeCache } from '../renderer/layers';

export interface CanvasProps {
  roomId: RoomId;
  className?: string;
}

export interface CanvasHandle {
  screenToWorld: (clientX: number, clientY: number) => [number, number];
  worldToClient: (worldX: number, worldY: number) => [number, number];
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
  const [_canvasSize, setCanvasSize] = useState<ResizeInfo | null>(null);
  const canvasSizeRef = useRef<ResizeInfo | null>(null); // For access in closures
  const renderLoopRef = useRef<RenderLoop | null>(null);

  // PERFORMANCE OPTIMIZATION: Store in ref to avoid React re-renders
  // We use the public subscription API (same as useRoomSnapshot hook) but store the result in a ref
  // instead of state to prevent React render storms at 60+ FPS. This maintains the architectural
  // boundary - we're still consuming immutable snapshots through the public API, just optimizing
  // how we store them to avoid unnecessary React work.
  const snapshotRef = useRef<Snapshot>(createEmptySnapshot()); // Initialize with empty snapshot
  const viewTransformRef = useRef<ViewTransform>(viewTransform); // Store latest transform

  // Keep view transform ref updated (no re-render)
  useEffect(() => {
    viewTransformRef.current = viewTransform;
  }, [viewTransform]);

  // Subscribe to snapshots via public API (stores in ref to avoid re-renders)
  useEffect(() => {
    // Subscribe through public API and write to ref (not state)
    const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
      const prevSvKey = snapshotRef.current.svKey;

      // IMPORTANT: DO NOT modify the snapshot - it must remain immutable
      // Phase 3 contract: snapshot.view remains identity transform - read view from UI instead
      snapshotRef.current = newSnapshot;

      // Invalidate render loop if content changed
      if (renderLoopRef.current && newSnapshot.svKey !== prevSvKey) {
        renderLoopRef.current.invalidateAll('content-change');
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

  // Convert screen (client/CSS) coordinates to world coordinates
  // Used for pointer events in Phase 5 - pass e.clientX/e.clientY
  const screenToWorld = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      if (!stageRef.current) return [clientX, clientY];

      // Get canvas element position from stage ref
      const rect = stageRef.current.getBounds();

      // Screen to Canvas (CSS pixels) - NO DPR multiplication
      const canvasX = clientX - rect.left;
      const canvasY = clientY - rect.top;

      // Canvas to World using ViewTransform (CSS pixels → world units)
      return viewTransform.canvasToWorld(canvasX, canvasY);
    },
    [viewTransform],
  );

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

  // Initialize render loop on mount (stable, doesn't restart on transform changes)
  useEffect(() => {
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
    // Use setTimeout(0) instead of queueMicrotask for better safety
    // This ensures the render loop is fully initialized and avoids race conditions
    let initialRenderTimeout: ReturnType<typeof setTimeout> | undefined;
    if (snapshotRef.current.svKey !== createEmptySnapshot().svKey) {
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

  // Transform change detection (separate from lifecycle)
  useEffect(() => {
    // Trigger a frame when transform changes
    // The DirtyRectTracker.notifyTransformChange() in tick() will detect the change
    // and automatically promote to full clear - we just need to trigger the frame
    renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
  }, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);

  // Expose coordinate transform functions via ref
  React.useImperativeHandle(
    ref,
    () => ({
      screenToWorld,
      worldToClient,
    }),
    [screenToWorld, worldToClient],
  );

  return <CanvasStage ref={stageRef} className={className} onResize={handleResize} />;
});

Canvas.displayName = 'Canvas';
