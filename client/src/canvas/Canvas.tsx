import React, { useRef, useCallback, useState, useEffect } from 'react';
import type { RoomId } from '@avlo/shared';
import { CanvasStage, type CanvasStageHandle, type ResizeInfo } from './CanvasStage';
import { useRoomSnapshot } from '../hooks/use-room-snapshot';
import { useViewTransform } from './ViewTransformContext';

export interface CanvasProps {
  roomId: RoomId;
  className?: string;
}

/**
 * Canvas component that integrates rendering with coordinate transforms.
 * Bridges between the low-level CanvasStage and high-level room data.
 */
export const Canvas: React.FC<CanvasProps> = ({ roomId, className }) => {
  const stageRef = useRef<CanvasStageHandle>(null);
  const snapshot = useRoomSnapshot(roomId);
  const { transform, viewState } = useViewTransform();
  const [canvasSize, setCanvasSize] = useState<ResizeInfo | null>(null);

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
      return transform.canvasToWorld(canvasX, canvasY);
    },
    [transform, canvasSize],
  );

  // Convert world coordinates to client (CSS) coordinates
  // Used for positioning UI elements
  const _worldToClient = useCallback(
    (worldX: number, worldY: number): [number, number] => {
      if (!canvasSize || !stageRef.current) return [worldX, worldY];

      // World to canvas
      const [canvasX, canvasY] = transform.worldToCanvas(worldX, worldY);

      // Get canvas element position from stage ref
      const rect = stageRef.current.getBounds();

      // Canvas to screen (CSS): divide by DPR and add rect offset
      return [canvasX / canvasSize.dpr + rect.left, canvasY / canvasSize.dpr + rect.top];
    },
    [transform, canvasSize],
  );

  // Handle resize events from CanvasStage
  const handleResize = useCallback((info: ResizeInfo) => {
    setCanvasSize(info);
  }, []);

  // Render function for Phase 3.3 (placeholder for now)
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    // Clear and draw test pattern with transform
    stage.withContext((ctx) => {
      // Clear in device pixels
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.restore();

      // Apply view transform with world units
      // CanvasStage already applies ctx.setTransform(dpr,0,0,dpr,0,0)
      // So we only apply world transform without DPR multiplication
      ctx.save();
      ctx.scale(viewState.scale, viewState.scale);
      ctx.translate(-viewState.pan.x, -viewState.pan.y);

      // Draw test grid in world space (Phase 3 verification only)
      ctx.strokeStyle = '#e0e0e0';
      ctx.lineWidth = 1 / (viewState.scale * (canvasSize?.dpr || 1)); // Keep 1px device pixel width
      ctx.beginPath();
      for (let x = -1000; x <= 1000; x += 100) {
        ctx.moveTo(x, -1000);
        ctx.lineTo(x, 1000);
      }
      for (let y = -1000; y <= 1000; y += 100) {
        ctx.moveTo(-1000, y);
        ctx.lineTo(1000, y);
      }
      ctx.stroke();

      // Draw origin marker
      ctx.fillStyle = 'red';
      ctx.fillRect(-5, -5, 10, 10);

      ctx.restore();
    });
  }, [stageRef, viewState, snapshot.svKey, canvasSize]);

  return <CanvasStage ref={stageRef} className={className} onResize={handleResize} />;
};
