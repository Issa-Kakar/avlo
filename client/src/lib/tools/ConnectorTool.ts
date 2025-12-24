/**
 * ConnectorTool - Draws orthogonal connectors between shapes
 *
 * Slice 1 Implementation:
 * - Drawing connectors with orthogonal routing (start → cursor/target)
 * - Shape hovering/snapping with midpoint anchor dots
 * - Preview rendering for both connector line and anchor dots
 * - Committing connector to Y.Doc on pointer-up
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
import {
  type Dir,
  type SnapTarget,
  findBestSnapTarget,
  computeRoute,
  inferDragDirection,
  getShapeFrame,
  oppositeDir,
} from '@/lib/connectors';

type Phase = 'idle' | 'creating';

/**
 * Terminal describes an endpoint during interaction.
 * Can be a free world position or attached to a shape edge.
 */
interface Terminal {
  kind: 'world' | 'shape';
  x: number;
  y: number;
  dir: Dir;
  // Shape-specific (only set when kind === 'shape')
  shapeId?: string;
  side?: Dir;
  t?: number;
}

/**
 * ConnectorTool - Implements PointerTool interface for drawing connectors.
 */
export class ConnectorTool implements PointerTool {
  // State machine
  private phase: Phase = 'idle';
  private pointerId: number | null = null;

  // Gesture state
  private from: Terminal | null = null;
  private to: Terminal | null = null;
  private routedPoints: [number, number][] = [];
  private prevRouteSignature: string | null = null;

  // Hover/snap state (used in both phases)
  private hoverSnap: SnapTarget | null = null;
  private prevSnap: SnapTarget | null = null;
  private dragDir: Dir | null = null;

  // Frozen settings (captured at begin)
  private frozenColor: string = '#000000';
  private frozenWidth: number = 2;
  private frozenOpacity: number = 1;

  constructor() {}

  canBegin(): boolean {
    return this.phase === 'idle';
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.phase !== 'idle') return;

    this.pointerId = pointerId;
    this.phase = 'creating';

    // Freeze settings from store at gesture start
    const settings = useDeviceUIStore.getState().drawingSettings;
    this.frozenColor = settings.color;
    this.frozenWidth = settings.size;
    this.frozenOpacity = settings.opacity;

    const scale = useCameraStore.getState().scale;

    // Check if starting on a shape
    const snap = findBestSnapTarget({
      cursorWorld: [worldX, worldY],
      scale,
      prevAttach: null,
    });

    if (snap) {
      // Start attached to shape
      this.from = {
        kind: 'shape',
        x: snap.position[0],
        y: snap.position[1],
        dir: snap.side, // Exit direction = the side
        shapeId: snap.shapeId,
        side: snap.side,
        t: snap.t,
      };
    } else {
      // Free start point - default direction (will be refined on move)
      this.from = {
        kind: 'world',
        x: worldX,
        y: worldY,
        dir: 'E', // Default, will be refined based on drag direction
      };
    }

    // Initialize 'to' at same position
    this.to = {
      kind: 'world',
      x: worldX,
      y: worldY,
      dir: 'W', // Opposite of default from direction
    };

    this.dragDir = null;
    this.prevRouteSignature = null;
    this.prevSnap = snap;
    this.hoverSnap = snap;
    this.updateRoute();

    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    const scale = useCameraStore.getState().scale;

    if (this.phase === 'idle') {
      // Hover mode - show anchor dots on nearby shapes
      const snap = findBestSnapTarget({
        cursorWorld: [worldX, worldY],
        scale,
        prevAttach: this.prevSnap,
      });

      this.hoverSnap = snap;
      this.prevSnap = snap;
      invalidateOverlay();
      return;
    }

    // Creating phase - update 'to' endpoint
    const snap = findBestSnapTarget({
      cursorWorld: [worldX, worldY],
      scale,
      prevAttach: this.prevSnap,
    });

    this.hoverSnap = snap;
    this.prevSnap = snap;

    if (snap) {
      // Snapped to shape - use shape attachment
      this.to = {
        kind: 'shape',
        x: snap.position[0],
        y: snap.position[1],
        dir: oppositeDir(snap.side), // Entry direction is opposite of side
        shapeId: snap.shapeId,
        side: snap.side,
        t: snap.t,
      };
      this.dragDir = null; // Reset drag direction when snapped
    } else {
      // Free endpoint - infer direction from drag
      const fromPos: [number, number] = [this.from!.x, this.from!.y];
      const cursorPos: [number, number] = [worldX, worldY];

      this.dragDir = inferDragDirection(fromPos, cursorPos, this.dragDir);

      this.to = {
        kind: 'world',
        x: worldX,
        y: worldY,
        dir: oppositeDir(this.dragDir), // Entry is opposite of travel direction
      };
    }

    this.updateRoute();
    invalidateOverlay();
  }

  end(_worldX?: number, _worldY?: number): void {
    if (this.phase !== 'creating') {
      this.resetState();
      return;
    }

    // Only commit if we have a valid connector (at least 2 points with some distance)
    if (this.from && this.to && this.routedPoints.length >= 2) {
      const dist = Math.hypot(this.to.x - this.from.x, this.to.y - this.from.y);
      if (dist > 5) {
        // Minimum distance threshold
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
      if (handle) {
        const frame = getShapeFrame(handle);
        if (frame) {
          snapShapeId = this.hoverSnap.shapeId;
          snapShapeFrame = [frame.x, frame.y, frame.w, frame.h];
          snapShapeType = (handle.y.get('shapeType') as string) || 'rect';
        }
      }
    }

    const preview: ConnectorPreview = {
      kind: 'connector',
      points: this.routedPoints,
      color: this.frozenColor,
      width: this.frozenWidth,
      opacity: this.frozenOpacity,
      startCap: 'none',
      endCap: 'arrow',

      // Snap state (only set when actually snapped - dots appear when snapped)
      snapShapeId,
      snapShapeFrame,
      snapShapeType,
      activeMidpointSide: this.hoverSnap?.isMidpoint ? this.hoverSnap.side : null,

      // Endpoint states
      fromIsAttached: this.from?.kind === 'shape',
      fromPosition: this.from ? [this.from.x, this.from.y] : null,
      toIsAttached: this.to?.kind === 'shape',
      toPosition: this.to ? [this.to.x, this.to.y] : null,

      showCursorDot: this.phase === 'creating',

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
    if (this.phase === 'creating') {
      this.updateRoute();
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
    this.from = null;
    this.to = null;
    this.routedPoints = [];
    this.prevRouteSignature = null;
    this.dragDir = null;
    // Keep hoverSnap/prevSnap for continued hover behavior
  }

  private updateRoute(): void {
    if (!this.from || !this.to) {
      this.routedPoints = [];
      return;
    }

    // Get target shape bounds if snapped (for self-intersection avoidance)
    let toShapeBounds: { x: number; y: number; w: number; h: number } | undefined;
    if (this.to.kind === 'shape' && this.hoverSnap) {
      const handle = getCurrentSnapshot().objectsById.get(this.hoverSnap.shapeId);
      if (handle) {
        const frame = getShapeFrame(handle);
        if (frame) {
          toShapeBounds = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
        }
      }
    }

    const result = computeRoute(
      {
        pos: [this.from.x, this.from.y],
        dir: this.from.dir,
        isAttached: this.from.kind === 'shape',
      },
      {
        pos: [this.to.x, this.to.y],
        dir: this.to.dir,
        isAttached: this.to.kind === 'shape',
        shapeBounds: toShapeBounds,
      },
      this.prevRouteSignature
    );

    this.routedPoints = result.points;
    this.prevRouteSignature = result.signature;
  }

  private commitConnector(): void {
    if (!this.from || !this.to || this.routedPoints.length < 2) return;

    const id = ulid();
    const userId = userProfileManager.getIdentity().userId;
    const roomDoc = getActiveRoomDoc();

    roomDoc.mutate((ydoc: Y.Doc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      const connectorMap = new Y.Map<unknown>();

      connectorMap.set('id', id);
      connectorMap.set('kind', 'connector');

      // Endpoint positions (always stored)
      connectorMap.set('fromX', this.from!.x);
      connectorMap.set('fromY', this.from!.y);
      connectorMap.set('toX', this.to!.x);
      connectorMap.set('toY', this.to!.y);

      // Anchor metadata (if attached to shape)
      if (this.from!.kind === 'shape') {
        connectorMap.set('fromShapeId', this.from!.shapeId);
        connectorMap.set('fromSide', this.from!.side);
        connectorMap.set('fromT', this.from!.t);
      }

      if (this.to!.kind === 'shape') {
        connectorMap.set('toShapeId', this.to!.shapeId);
        connectorMap.set('toSide', this.to!.side);
        connectorMap.set('toT', this.to!.t);
      }

      // Waypoints (intermediate points, excluding endpoints)
      // Full path reconstructed at render time: [from, ...waypoints, to]
      if (this.routedPoints.length > 2) {
        const waypoints = this.routedPoints.slice(1, -1);
        connectorMap.set('waypoints', waypoints);
      }

      // Styling
      connectorMap.set('color', this.frozenColor);
      connectorMap.set('width', this.frozenWidth);
      connectorMap.set('opacity', this.frozenOpacity);
      connectorMap.set('endCap', 'arrow');
      connectorMap.set('startCap', 'none');

      // Metadata
      connectorMap.set('ownerId', userId);
      connectorMap.set('createdAt', Date.now());

      objects.set(id, connectorMap);
    });
  }
}
