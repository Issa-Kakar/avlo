/**
 * ConnectorTool - Draws orthogonal connectors between shapes
 *
 * Lean snap-based state inspired by SelectTool's endpointDrag:
 * - Snap targets and positions instead of ToolTerminal
 * - Routing delegated to routeNewConnectorInto() with a pooled preview buffer
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
import { anchorRecordFromSnap } from '@/core/connectors/anchor-atoms';
import { routeNewConnectorInto } from '@/core/connectors/reroute-connector';
import { findBestSnapTarget } from '@/core/connectors/snap';
import type { ConnectorCap, ConnectorType, SnapTarget } from '@/core/connectors/types';
import type { Point } from '@/core/types/geometry';
import type { ConnectorEndpoint } from '@/core/types/objects';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { isCtrlHeld } from '@/runtime/InputManager';
import { getObjects, transact } from '@/runtime/room-runtime';
import { getUserId, useDeviceUIStore } from '@/stores/device-ui-store';
import type { ConnectorPreview, PointerTool, PreviewData } from './types';

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
  /** Pooled preview buffer — reused across pointer moves. Iterate by `routedCount`. */
  private readonly routedPoints: Point[] = [];
  private routedCount = 0;

  // Hover/snap (both phases)
  private hoverSnap: SnapTarget | null = null;
  private prevSnap: SnapTarget | null = null;

  // Frozen settings (captured at begin)
  private frozenColor = '#000000';
  private frozenWidth = 2;
  private frozenStartCap: ConnectorCap = 'none';
  private frozenEndCap: ConnectorCap = 'arrow';
  private frozenConnectorType: ConnectorType | null = null;

  canBegin(): boolean {
    return this.phase === 'idle';
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.phase !== 'idle') return;

    this.pointerId = pointerId;
    this.phase = 'creating';

    // Freeze settings from store at gesture start
    const state = useDeviceUIStore.getState();
    this.frozenColor = state.connectorColor;
    this.frozenWidth = state.connectorWidth;
    this.frozenStartCap = state.connectorStartCap;
    this.frozenEndCap = state.connectorEndCap;
    this.frozenConnectorType = state.connectorType;

    // Check if starting on a shape (Ctrl suppresses snapping)
    const snap = this.probeSnap(worldX, worldY, null);

    this.fromSnap = snap;
    this.fromPosition = snap ? snap.position : [worldX, worldY];
    this.toSnap = null;
    this.toPosition = snap ? snap.position : [worldX, worldY];
    this.prevSnap = snap;
    this.hoverSnap = snap;
    this.routedPoints.length = 0;
    this.routedCount = 0;

    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    if (this.phase === 'idle') {
      // Hover mode - show anchor dots on nearby shapes (Ctrl suppresses)
      const snap = this.probeSnap(worldX, worldY, this.prevSnap);
      this.hoverSnap = snap;
      this.prevSnap = snap;
      invalidateOverlay();
      return;
    }

    // Creating phase - update 'to' endpoint (Ctrl suppresses snapping)
    const snap = this.probeSnap(worldX, worldY, this.prevSnap);

    this.hoverSnap = snap;
    this.prevSnap = snap;
    this.toSnap = snap;
    this.toPosition = snap ? snap.position : [worldX, worldY];

    this.refreshRoute();
    invalidateOverlay();
  }

  end(_worldX?: number, _worldY?: number): void {
    if (this.phase !== 'creating') {
      this.resetState();
      return;
    }

    // Only commit if we have a valid connector (at least 2 points with some distance)
    if (this.fromPosition && this.toPosition && this.routedCount >= 2) {
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
      pointsCount: this.routedCount,
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
    if (this.phase === 'creating') this.refreshRoute();
    invalidateOverlay();
  }

  destroy(): void {
    this.cancel();
  }

  // === Private Methods ===

  private probeSnap(worldX: number, worldY: number, prevAttach: SnapTarget | null): SnapTarget | null {
    if (isCtrlHeld()) return null;
    return findBestSnapTarget({
      cursorWorld: [worldX, worldY],
      prevAttach,
      connectorType: this.frozenConnectorType ?? useDeviceUIStore.getState().connectorType,
    });
  }

  private refreshRoute(): void {
    if (!this.fromPosition || !this.toPosition) return;
    const start: SnapTarget | Point = this.fromSnap ?? this.fromPosition;
    const end: SnapTarget | Point = this.toSnap ?? this.toPosition;
    this.routedCount = routeNewConnectorInto(start, end, this.frozenWidth, this.frozenConnectorType ?? 'elbow', this.routedPoints);
  }

  private resetState(): void {
    this.phase = 'idle';
    this.pointerId = null;
    this.fromSnap = null;
    this.fromPosition = null;
    this.toSnap = null;
    this.toPosition = null;
    this.routedPoints.length = 0;
    this.routedCount = 0;
    this.frozenConnectorType = null;
    // Keep hoverSnap/prevSnap for continued hover behavior
  }

  private commitConnector(): void {
    const fromPos = this.fromPosition;
    const toPos = this.toPosition;
    if (!fromPos || !toPos || this.routedCount < 2) return;

    const id = ulid();
    const userId = getUserId();
    const fromSnap = this.fromSnap;
    const toSnap = this.toSnap;
    transact(() => {
      const connectorMap = new Y.Map<unknown>();

      connectorMap.set('id', id);
      connectorMap.set('kind', 'connector');

      // Single union per side. Anchor when snapped, Point otherwise. Local route cache
      // is populated by the deep observer on Phase C (rerouteCanonical).
      const start: ConnectorEndpoint = fromSnap ? anchorRecordFromSnap(fromSnap) : ([fromPos[0], fromPos[1]] as Point);
      const end: ConnectorEndpoint = toSnap ? anchorRecordFromSnap(toSnap) : ([toPos[0], toPos[1]] as Point);
      connectorMap.set('start', start);
      connectorMap.set('end', end);

      // Caps and type — connectorType is ALWAYS stored now (required discriminated field)
      connectorMap.set('startCap', this.frozenStartCap);
      connectorMap.set('endCap', this.frozenEndCap);
      connectorMap.set('connectorType', this.frozenConnectorType ?? 'elbow');

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
