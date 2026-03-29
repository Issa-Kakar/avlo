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
import { useCameraStore } from '@/stores/camera-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import { invalidateOverlay, holdPreviewForOneFrame } from '@/canvas/invalidation-helpers';
import { userProfileManager } from '@/lib/user-profile-manager';
import { getShapeType, getFrame } from '@avlo/shared';
import { getTextFrame } from '@/lib/text/text-system';
import { getCodeFrame } from '@/lib/code/code-system';
import {
  type Dir,
  type SnapTarget,
  type ConnectorCap,
  type ConnectorType,
  findBestSnapTarget,
  routeNewConnector,
  inferDragDirection,
} from '@/lib/connectors';
import { isAnchorInterior } from '@/lib/connectors/types';
import { isCtrlHeld } from '@/canvas/cursor-tracking';

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
  private fromPosition: [number, number] | null = null;
  private toSnap: SnapTarget | null = null;
  private toPosition: [number, number] | null = null;
  private routedPoints: [number, number][] = [];

  // Hover/snap (both phases)
  private hoverSnap: SnapTarget | null = null;
  private prevSnap: SnapTarget | null = null;
  private dragDir: Dir | null = null;

  // Frozen settings (captured at begin)
  private frozenColor = '#000000';
  private frozenWidth = 2;
  private frozenOpacity = 1;
  private frozenStartCap: ConnectorCap = 'none';
  private frozenEndCap: ConnectorCap = 'arrow';
  private frozenConnectorType: ConnectorType | null = null;

  // Straight connector dash info
  private startDashTo: [number, number] | null = null;
  private endDashTo: [number, number] | null = null;

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
    this.frozenOpacity = state.drawingSettings.opacity;
    this.frozenStartCap = state.connectorStartCap;
    this.frozenEndCap = state.connectorEndCap;
    this.frozenConnectorType = state.connectorType;

    const scale = useCameraStore.getState().scale;

    // Check if starting on a shape (Ctrl suppresses snapping)
    const snap = isCtrlHeld()
      ? null
      : findBestSnapTarget({
          cursorWorld: [worldX, worldY],
          scale,
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
    const scale = useCameraStore.getState().scale;

    if (this.phase === 'idle') {
      // Hover mode - show anchor dots on nearby shapes (Ctrl suppresses)
      const snap = isCtrlHeld()
        ? null
        : findBestSnapTarget({
            cursorWorld: [worldX, worldY],
            scale,
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
          scale,
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

    const start: SnapTarget | [number, number] = this.fromSnap ?? this.fromPosition!;
    const end: SnapTarget | [number, number] = snap ?? [worldX, worldY];
    const routeResult = routeNewConnector(
      start,
      end,
      this.frozenWidth,
      this.frozenConnectorType ?? 'elbow',
      this.dragDir,
    );
    this.routedPoints = routeResult.points;
    this.startDashTo = routeResult.startDashTo;
    this.endDashTo = routeResult.endDashTo;

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

    holdPreviewForOneFrame();
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
    // Build ConnectorPreview for overlay rendering
    const snapshot = getCurrentSnapshot();

    // Snap state (ONLY set when actually snapped - dots appear when snapped)
    let snapShapeId: string | null = null;
    let snapShapeFrame: [number, number, number, number] | null = null;
    let snapShapeType: string | null = null;

    if (this.hoverSnap) {
      const handle = snapshot.objectsById.get(this.hoverSnap.shapeId);
      if (
        handle &&
        (handle.kind === 'shape' ||
          handle.kind === 'text' ||
          handle.kind === 'code' ||
          handle.kind === 'image' ||
          handle.kind === 'note' ||
          handle.kind === 'bookmark')
      ) {
        const frame =
          handle.kind === 'text' || handle.kind === 'note'
            ? getTextFrame(handle.id)
            : handle.kind === 'code'
              ? getCodeFrame(handle.id)
              : getFrame(handle.y);
        if (frame) {
          snapShapeId = this.hoverSnap.shapeId;
          snapShapeFrame = [frame[0], frame[1], frame[2], frame[3]];
          snapShapeType = handle.kind === 'shape' ? getShapeType(handle.y) : 'rect';
        }
      }
    }

    const preview: ConnectorPreview = {
      kind: 'connector',
      points: this.routedPoints,
      color: this.frozenColor,
      width: this.frozenWidth,
      opacity: this.frozenOpacity,
      startCap: this.frozenStartCap,
      endCap: this.frozenEndCap,

      // Snap state (only set when actually snapped - dots appear when snapped)
      snapShapeId,
      snapShapeFrame,
      snapShapeType,
      activeMidpointSide: this.hoverSnap?.isMidpoint ? this.hoverSnap.side : null,
      snapSide: this.hoverSnap?.side ?? null,
      snapPosition: this.hoverSnap?.edgePosition ?? null,

      // Endpoint states
      fromIsAttached: this.fromSnap !== null,
      fromPosition: this.fromPosition,
      toIsAttached: this.toSnap !== null,
      toPosition: this.toPosition,

      // Straight connector fields
      connectorType: this.frozenConnectorType ?? useDeviceUIStore.getState().connectorType,
      startDashTo: this.startDashTo,
      endDashTo: this.endDashTo,
      isCenterSnap: !!(
        this.hoverSnap &&
        this.hoverSnap.normalizedAnchor[0] === 0.5 &&
        this.hoverSnap.normalizedAnchor[1] === 0.5 &&
        isAnchorInterior(this.hoverSnap.normalizedAnchor)
      ),

      bbox: null,
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
      const start: SnapTarget | [number, number] = this.fromSnap ?? this.fromPosition;
      const end: SnapTarget | [number, number] = this.toSnap ?? this.toPosition;
      const routeResult = routeNewConnector(
        start,
        end,
        this.frozenWidth,
        this.frozenConnectorType ?? 'elbow',
        this.dragDir,
      );
      this.routedPoints = routeResult.points;
      this.startDashTo = routeResult.startDashTo;
      this.endDashTo = routeResult.endDashTo;
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
    this.startDashTo = null;
    this.endDashTo = null;
    this.frozenConnectorType = null;
    // Keep hoverSnap/prevSnap for continued hover behavior
  }

  private commitConnector(): void {
    if (!this.fromPosition || !this.toPosition || this.routedPoints.length < 2) return;

    const id = ulid();
    const userId = userProfileManager.getIdentity().userId;
    const roomDoc = getActiveRoomDoc();

    roomDoc.mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

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

      // Styling
      connectorMap.set('color', this.frozenColor);
      connectorMap.set('width', this.frozenWidth);
      connectorMap.set('opacity', this.frozenOpacity);

      // Metadata
      connectorMap.set('ownerId', userId);
      connectorMap.set('createdAt', Date.now());

      objects.set(id, connectorMap);
    });
  }
}
