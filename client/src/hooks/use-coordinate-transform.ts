import React, { useCallback } from 'react';
import { useViewTransform } from '../canvas/ViewTransformContext';
import type { CanvasStageHandle } from '../canvas/CanvasStage';

/**
 * Hook that provides coordinate transformation functions between screen, canvas, and world space.
 * These functions work consistently in CSS pixels, with DPR handled only at the canvas context level.
 *
 * @param stageRef - Reference to the CanvasStage component
 * @returns Object with screenToWorld and worldToClient transformation functions
 */
export function useCoordinateTransform(stageRef: React.RefObject<CanvasStageHandle>) {
  const { transform: viewTransform } = useViewTransform();

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
    [viewTransform, stageRef],
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
    [viewTransform, stageRef],
  );

  return {
    screenToWorld,
    worldToClient,
  };
}
