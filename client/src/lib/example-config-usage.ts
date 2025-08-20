/**
 * Example of using the centralized config in client code
 * This demonstrates proper usage patterns for Phase 2 and beyond
 */

import {
  ROOM_CONFIG,
  STROKE_CONFIG,
  PERFORMANCE_CONFIG,
  isRoomReadOnly,
  isRoomSizeWarning,
  getRoomSizePercentage,
} from '@shared/config';

// Example 1: Room size monitoring
export function getRoomStatusBadge(sizeBytes: number) {
  if (isRoomReadOnly(sizeBytes)) {
    return {
      type: 'error',
      message: 'Room is read-only (10 MB limit reached)',
      percentage: 100,
    };
  }

  if (isRoomSizeWarning(sizeBytes)) {
    const percentage = getRoomSizePercentage(sizeBytes);
    return {
      type: 'warning',
      message: `Room is ${percentage.toFixed(0)}% full`,
      percentage,
    };
  }

  return null; // No badge needed
}

// Example 2: Stroke validation (will be used in Phase 3)
export function validateStrokeBeforeCommit(points: number[], tool: 'pen' | 'highlighter') {
  const pointCount = points.length / 2; // Assuming x,y pairs

  // Check point count limit
  if (pointCount > STROKE_CONFIG.MAX_POINTS_PER_STROKE) {
    return {
      valid: false,
      error: `Stroke has ${pointCount} points, exceeds maximum of ${STROKE_CONFIG.MAX_POINTS_PER_STROKE}`,
    };
  }

  // Get appropriate tolerance for simplification
  const tolerance =
    tool === 'pen'
      ? STROKE_CONFIG.PEN_SIMPLIFICATION_TOLERANCE
      : STROKE_CONFIG.HIGHLIGHTER_SIMPLIFICATION_TOLERANCE;

  return {
    valid: true,
    tolerance,
    maxPoints: STROKE_CONFIG.MAX_POINTS_PER_STROKE,
  };
}

// Example 3: Frame rate management (will be used in Phase 3)
export class FrameRateManager {
  private lastFrameTime = 0;

  shouldRender(): boolean {
    const now = performance.now();
    const elapsed = now - this.lastFrameTime;

    // Use different FPS for hidden tabs
    const targetFPS = document.hidden
      ? PERFORMANCE_CONFIG.HIDDEN_TAB_FPS
      : PERFORMANCE_CONFIG.MAX_FPS;

    const minInterval = 1000 / targetFPS;

    if (elapsed >= minInterval) {
      this.lastFrameTime = now;
      return true;
    }

    return false;
  }

  getRenderBudget(): number {
    return PERFORMANCE_CONFIG.RENDER_BUDGET_MS;
  }

  getMicroBatchWindow(isUnderPressure: boolean): number {
    if (isUnderPressure) {
      return PERFORMANCE_CONFIG.MICRO_BATCH_MAX_MS;
    }
    return PERFORMANCE_CONFIG.MICRO_BATCH_DEFAULT_MS;
  }
}

// Example 4: Room capacity check (will be used in Phase 4)
export function canJoinRoom(currentClients: number): boolean {
  return currentClients < ROOM_CONFIG.MAX_CLIENTS_PER_ROOM;
}

export function getRoomCapacityMessage(currentClients: number): string | null {
  const max = ROOM_CONFIG.MAX_CLIENTS_PER_ROOM;
  const remaining = max - currentClients;

  if (remaining <= 0) {
    return 'Room is full';
  }

  if (remaining <= 5) {
    return `Only ${remaining} spots remaining`;
  }

  return null; // Plenty of space
}

// Example 5: Export configuration (will be used in Phase 6)
export function getExportConstraints() {
  return {
    maxEdgeSize: PERFORMANCE_CONFIG.EXPORT_MAX_EDGE_PX,
    padding: PERFORMANCE_CONFIG.EXPORT_PADDING_PX,
    timeout: PERFORMANCE_CONFIG.EXPORT_TIMEOUT_MS,

    // Helper to check if dimensions are valid
    isValidDimensions: (width: number, height: number) => {
      return Math.max(width, height) <= PERFORMANCE_CONFIG.EXPORT_MAX_EDGE_PX;
    },
  };
}

// Example 6: Demonstrating config usage in a React component (conceptual)
// This would be implemented in actual React components in later phases
export function useRoomSizeMonitor(sizeBytes: number) {
  const isWarning = isRoomSizeWarning(sizeBytes);
  const isReadOnly = isRoomReadOnly(sizeBytes);
  const percentage = getRoomSizePercentage(sizeBytes);

  return {
    isWarning,
    isReadOnly,
    percentage,
    warningThreshold: ROOM_CONFIG.ROOM_SIZE_WARNING_BYTES,
    readOnlyThreshold: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
  };
}
