import React, { useRef, useCallback, useState, useEffect } from 'react';
import type { RoomId, Snapshot, ViewTransform } from '@avlo/shared';
import { createEmptySnapshot } from '@avlo/shared';
import { CanvasStage, type CanvasStageHandle, type ResizeInfo } from './CanvasStage';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useViewTransform } from './ViewTransformContext';
import { RenderLoop } from '../renderer/RenderLoop';
import type { ViewportInfo } from '../renderer/types';

export interface CanvasProps {
  roomId: RoomId;
  className?: string;
}

/**
 * Canvas component that integrates rendering with coordinate transforms.
 * Bridges between the low-level CanvasStage and high-level room data.
 *
 * Phase 3.3: Now uses RenderLoop with event-driven architecture
 */
export const Canvas: React.FC<CanvasProps> = ({ roomId, className }) => {
  const stageRef = useRef<CanvasStageHandle>(null);
  const roomDoc = useRoomDoc(roomId); // MUST be called at top level, not inside useEffect
  const { transform: viewTransform, viewState } = useViewTransform();
  const [canvasSize, setCanvasSize] = useState<ResizeInfo | null>(null);
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
  const _screenToWorld = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      if (!canvasSize || !stageRef.current) return [clientX, clientY];

      // Get canvas element position from stage ref
      const rect = stageRef.current.getBounds();

      // Client (CSS) coordinates to canvas coordinates
      // Account for DPR: CSS pixels to canvas pixels
      const canvasX = (clientX - rect.left) * canvasSize.dpr;
      const canvasY = (clientY - rect.top) * canvasSize.dpr;

      // Canvas to world using transform
      return viewTransform.canvasToWorld(canvasX, canvasY);
    },
    [viewTransform, canvasSize],
  );

  // Convert world coordinates to client (CSS) coordinates
  // Used for positioning UI elements
  const _worldToClient = useCallback(
    (worldX: number, worldY: number): [number, number] => {
      if (!canvasSize || !stageRef.current) return [worldX, worldY];

      // World to canvas
      const [canvasX, canvasY] = viewTransform.worldToCanvas(worldX, worldY);

      // Get canvas element position from stage ref
      const rect = stageRef.current.getBounds();

      // Canvas to screen (CSS): divide by DPR and add rect offset
      return [canvasX / canvasSize.dpr + rect.left, canvasY / canvasSize.dpr + rect.top];
    },
    [viewTransform, canvasSize],
  );

  // Handle resize events from CanvasStage
  const handleResize = useCallback((info: ResizeInfo) => {
    setCanvasSize(info);

    // Notify render loop
    renderLoopRef.current?.setResizeInfo({
      width: info.pixelWidth,
      height: info.pixelHeight,
      dpr: info.dpr,
    });
  }, []);

  // ADD render loop initialization (stable, doesn't restart on transform changes)
  useEffect(() => {
    if (!stageRef.current) return;

    const renderLoop = new RenderLoop();
    renderLoopRef.current = renderLoop;

    renderLoop.start({
      stageRef,
      getView: () => viewTransformRef.current, // Read from UI state ref, NOT from snapshot.view
      getSnapshot: () => snapshotRef.current, // snapshot.view remains identity in Phase 3
      getViewport: (): ViewportInfo => {
        const bounds = stageRef.current?.getBounds();
        if (!bounds) {
          return {
            pixelWidth: 0,
            pixelHeight: 0,
            cssWidth: 0,
            cssHeight: 0,
            dpr: window.devicePixelRatio || 1,
          };
        }
        return {
          pixelWidth: bounds.width * (window.devicePixelRatio || 1),
          pixelHeight: bounds.height * (window.devicePixelRatio || 1),
          cssWidth: bounds.width,
          cssHeight: bounds.height,
          dpr: window.devicePixelRatio || 1,
        };
      },
      isMobile, // For FPS throttling
      onStats:
        process.env.NODE_ENV === 'development'
          ? (stats) => {
              // Log frame stats in dev (every 60 frames)
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

    // Trigger initial render ONLY if we have content
    if (snapshotRef.current.svKey !== createEmptySnapshot().svKey) {
      renderLoop.invalidateAll('content-change');
    }

    return () => {
      renderLoop.stop();
      renderLoop.destroy();
      renderLoopRef.current = null;
    };
  }, [isMobile]); // Include isMobile dependency - it's stable due to empty useCallback deps

  // ADD transform change detection (separate from lifecycle)
  useEffect(() => {
    // Trigger a frame when transform changes
    // The DirtyRectTracker.notifyTransformChange() in tick() will detect the change
    // and automatically promote to full clear - we just need to trigger the frame
    renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
  }, [viewState.scale, viewState.pan.x, viewState.pan.y]);

  return <CanvasStage ref={stageRef} className={className} onResize={handleResize} />;
};
