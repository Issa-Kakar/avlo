/**
 * ConnectorTool - Draws orthogonal connectors between shapes
 *
 * Lean snap-based state inspired by SelectTool's endpointDrag:
 * - Snap targets and positions instead of ToolTerminal
 * - Routing delegated to routeNewConnector()
 * - Caps frozen from store at begin()
 *
 * State Machine:
 * - idle: waiting for gesture, showing hover dots on nearby shapes
 * - creating: actively drawing connector from start to cursor/target
 *
 * @module lib/tools/ConnectorTool
 */

import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { PointerTool, PreviewData, ConnectorPreview } from './types';
import type { Point } from '@/core/types/geometry';
import { useDeviceUIStore, getUserId } from '@/stores/device-ui-store';
import { transact, getObjects } from '@/runtime/room-runtime';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import {
  type Dir,
  type SnapTarget,
  type ConnectorCap,
  type ConnectorType,
  findBestSnapTarget,
  routeNewConnector,
  inferDragDirection,
} from '@/core/connectors';
import { isCtrlHeld } from '@/runtime/InputManager';

type Phase = 'idle' | 'creating';

/**
 * ConnectorTool - Implements PointerTool interface for drawing connectors.
 */
export class ConnectorTool implements PointerTool {
  // State machine
  private phase: Phase = 'idle';
  private pointerId: number | null = null;

  // Gesture state — just snap targets and positions
  private fromSnap: SnapTarget | null = null;
  private fromPosition: Point | null = null;
  private toSnap: SnapTarget | null = null;
  private toPosition: Point | null = null;
  private routedPoints: Point[] = [];

  // Hover/snap (both phases)
  private hoverSnap: SnapTarget | null = null;
  private prevSnap: SnapTarget | null = null;
  private dragDir: Dir | null = null;

  // Frozen settings (captured at begin)
  private frozenColor = '#000000';
  private frozenWidth = 2;
  private frozenStartCap: ConnectorCap = 'none';
  private frozenEndCap: ConnectorCap = 'arrow';
  private frozenConnectorType: ConnectorType | null = null;

  constructor() {}

  canBegin(): boolean {
    return this.phase === 'idle';
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.phase !== 'idle') return;

    this.pointerId = pointerId;
    this.phase = 'creating';

    // Freeze settings from store at gesture start
    const state = useDeviceUIStore.getState();
    this.frozenColor = state.drawingSettings.color;
    this.frozenWidth = state.connectorSize;
    this.frozenStartCap = state.connectorStartCap;
    this.frozenEndCap = state.connectorEndCap;
    this.frozenConnectorType = state.connectorType;

    // Check if starting on a shape (Ctrl suppresses snapping)
    const snap = isCtrlHeld()
      ? null
      : findBestSnapTarget({
          cursorWorld: [worldX, worldY],
          prevAttach: null,
          connectorType: this.frozenConnectorType,
        });

    this.fromSnap = snap;
    this.fromPosition = snap ? snap.position : [worldX, worldY];
    this.toSnap = null;
    this.toPosition = snap ? snap.position : [worldX, worldY];
    this.dragDir = null;
    this.prevSnap = snap;
    this.hoverSnap = snap;
    this.routedPoints = [];

    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    if (this.phase === 'idle') {
      // Hover mode - show anchor dots on nearby shapes (Ctrl suppresses)
      const snap = isCtrlHeld()
        ? null
        : findBestSnapTarget({
            cursorWorld: [worldX, worldY],
            prevAttach: this.prevSnap,
            connectorType: useDeviceUIStore.getState().connectorType,
          });

      this.hoverSnap = snap;
      this.prevSnap = snap;
      invalidateOverlay();
      return;
    }

    // Creating phase - update 'to' endpoint (Ctrl suppresses snapping)
    const snap = isCtrlHeld()
      ? null
      : findBestSnapTarget({
          cursorWorld: [worldX, worldY],
          prevAttach: this.prevSnap,
          connectorType: this.frozenConnectorType ?? 'elbow',
        });

    this.hoverSnap = snap;
    this.prevSnap = snap;
    this.toSnap = snap;
    this.toPosition = snap ? snap.position : [worldX, worldY];

    if (!snap) {
      this.dragDir = inferDragDirection(this.fromPosition!, [worldX, worldY], this.dragDir);
    } else {
      this.dragDir = null;
    }

    const start: SnapTarget | Point = this.fromSnap ?? this.fromPosition!;
    const end: SnapTarget | Point = snap ?? [worldX, worldY];
    this.routedPoints = routeNewConnector(start, end, this.frozenWidth, this.frozenConnectorType ?? 'elbow', this.dragDir).points;

    invalidateOverlay();
  }

  end(_worldX?: number, _worldY?: number): void {
    if (this.phase !== 'creating') {
      this.resetState();
      return;
    }

    // Only commit if we have a valid connector (at least 2 points with some distance)
    if (this.fromPosition && this.toPosition && this.routedPoints.length >= 2) {
      const [fx, fy] = this.fromPosition;
      const [tx, ty] = this.toPosition;
      const dist = Math.hypot(tx - fx, ty - fy);
      if (dist > 5) {
        this.commitConnector();
      }
    }

    this.resetState();
    invalidateOverlay();
  }

  cancel(): void {
    this.resetState();
    invalidateOverlay();
  }

  isActive(): boolean {
    return this.phase !== 'idle';
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    const preview: ConnectorPreview = {
      kind: 'connector',
      points: this.routedPoints,
      fromSnap: this.fromSnap,
      hoverSnap: this.hoverSnap,
    };
    return preview;
  }

  onPointerLeave(): void {
    this.hoverSnap = null;
    this.prevSnap = null;
    invalidateOverlay();
  }

  onViewChange(): void {
    if (this.phase === 'creating' && this.fromPosition && this.toPosition) {
      const start: SnapTarget | Point = this.fromSnap ?? this.fromPosition;
      const end: SnapTarget | Point = this.toSnap ?? this.toPosition;
      this.routedPoints = routeNewConnector(start, end, this.frozenWidth, this.frozenConnectorType ?? 'elbow', this.dragDir).points;
    }
    invalidateOverlay();
  }

  destroy(): void {
    this.cancel();
  }

  // === Private Methods ===

  private resetState(): void {
    this.phase = 'idle';
    this.pointerId = null;
    this.fromSnap = null;
    this.fromPosition = null;
    this.toSnap = null;
    this.toPosition = null;
    this.routedPoints = [];
    this.dragDir = null;
    this.frozenConnectorType = null;
    // Keep hoverSnap/prevSnap for continued hover behavior
  }

  private commitConnector(): void {
    if (!this.fromPosition || !this.toPosition || this.routedPoints.length < 2) return;

    const id = ulid();
    const userId = getUserId();
    transact(() => {
      const connectorMap = new Y.Map<unknown>();

      connectorMap.set('id', id);
      connectorMap.set('kind', 'connector');

      // Full routed path (assembled, ready to render)
      connectorMap.set('points', this.routedPoints);

      // Endpoint positions (use routed path endpoints for consistency)
      connectorMap.set('start', this.routedPoints[0]);
      connectorMap.set('end', this.routedPoints[this.routedPoints.length - 1]);

      // Anchor data (only if snapped to a shape)
      if (this.fromSnap) {
        connectorMap.set('startAnchor', {
          id: this.fromSnap.shapeId,
          side: this.fromSnap.side,
          anchor: this.fromSnap.normalizedAnchor,
        });
      }

      if (this.toSnap) {
        connectorMap.set('endAnchor', {
          id: this.toSnap.shapeId,
          side: this.toSnap.side,
          anchor: this.toSnap.normalizedAnchor,
        });
      }

      // Caps and type
      connectorMap.set('startCap', this.frozenStartCap);
      connectorMap.set('endCap', this.frozenEndCap);
      if (this.frozenConnectorType && this.frozenConnectorType !== 'elbow') {
        connectorMap.set('connectorType', this.frozenConnectorType);
      }

      // Styling (connectors are always opacity 1 — not stored)
      connectorMap.set('color', this.frozenColor);
      connectorMap.set('width', this.frozenWidth);

      // Metadata
      connectorMap.set('ownerId', userId);
      connectorMap.set('createdAt', Date.now());

      getObjects().set(id, connectorMap);
    });
  }
}
