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
import { getShapeType } from '@avlo/shared';
import {
  type Dir,
  type SnapTarget,
  type AABB,
  findBestSnapTarget,
  computeAStarRoute,
  inferDragDirection,
  getShapeFrame,
  oppositeDir,
  resolveFreeStartDir,
  computeFreeEndDir,
} from '@/lib/connectors';

type Phase = 'idle' | 'creating';

/**
 * Internal terminal state during interaction.
 * Contains all info needed for routing AND commit.
 */
interface ToolTerminal {
  position: [number, number];
  outwardDir: Dir;
  isAnchored: boolean;
  hasCap: boolean;
  // Shape bounds for obstacle avoidance (only set when isAnchored === true)
  shapeBounds?: AABB;
  // Shape-specific commit info (only set when isAnchored === true)
  shapeId?: string;
  side?: Dir;
  normalizedAnchor?: [number, number];
}

/**
 * ConnectorTool - Implements PointerTool interface for drawing connectors.
 */
export class ConnectorTool implements PointerTool {
  // State machine
  private phase: Phase = 'idle';
  private pointerId: number | null = null;

  // Gesture state
  private from: ToolTerminal | null = null;
  private to: ToolTerminal | null = null;
  private routedPoints: [number, number][] = [];

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
    const state = useDeviceUIStore.getState();
    this.frozenColor = state.drawingSettings.color;
    this.frozenWidth = state.connectorSize;
    this.frozenOpacity = state.drawingSettings.opacity;

    const scale = useCameraStore.getState().scale;

    // Check if starting on a shape
    const snap = findBestSnapTarget({
      cursorWorld: [worldX, worldY],
      scale,
      prevAttach: null,
    });

    if (snap) {
      // Start attached to shape - snap.position already includes offset
      this.from = {
        position: snap.position,
        outwardDir: snap.side, // Extends away from shape
        isAnchored: true,
        hasCap: false, // startCap = 'none'
        shapeId: snap.shapeId,
        side: snap.side,
        normalizedAnchor: snap.normalizedAnchor,
      };
      // Will be refined on move(): initialize 'to' at same position as 'from' - prevents routing occurring inside shape
      this.to = this.from;

    } else {
      // Free start point - will be refined on move based on drag direction
      this.from = {
        position: [worldX, worldY],
        outwardDir: 'E', // Default, refined in move()
        isAnchored: false,
        hasCap: false,
      };
      // Initialize 'to' at cursor position
      this.to = {
        position: [worldX, worldY],
        outwardDir: 'W', // Opposite of default from direction
        isAnchored: false,
        hasCap: true, // endCap = 'arrow'
      };
    }

    this.dragDir = null;
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
      // Snapped to shape - snap.position already includes offset
      const handle = getCurrentSnapshot().objectsById.get(snap.shapeId);
      const frame = handle ? getShapeFrame(handle) : null;
      const shapeBounds = frame ? { x: frame.x, y: frame.y, w: frame.w, h: frame.h } : undefined;

      this.to = {
        position: snap.position,
        outwardDir: snap.side, // Extends AWAY from shape
        isAnchored: true,
        hasCap: true, // endCap = 'arrow'
        shapeBounds,
        shapeId: snap.shapeId,
        side: snap.side,
        normalizedAnchor: snap.normalizedAnchor,
      };
      this.dragDir = null; // Reset drag direction when snapped
    } else {
      // Free endpoint - infer direction from drag
      const fromPos = this.from!.position;
      const cursorPos: [number, number] = [worldX, worldY];

      this.dragDir = inferDragDirection(fromPos, cursorPos, this.dragDir);

      // Update from.outwardDir for free starts so first segment updates with drag
      if (!this.from!.isAnchored) {
        this.from!.outwardDir = this.dragDir;
      }

      this.to = {
        position: [worldX, worldY],
        outwardDir: oppositeDir(this.dragDir), // Approaching from opposite of travel
        isAnchored: false,
        hasCap: true, // endCap = 'arrow'
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
      const [fx, fy] = this.from.position;
      const [tx, ty] = this.to.position;
      const dist = Math.hypot(tx - fx, ty - fy);
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
          snapShapeType = getShapeType(handle.y);
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
      snapSide: this.hoverSnap?.side ?? null,
      snapPosition: this.hoverSnap?.edgePosition ?? null, // Use edgePosition for dot rendering

      // Endpoint states
      fromIsAttached: this.from?.isAnchored ?? false,
      fromPosition: this.from?.position ?? null,
      toIsAttached: this.to?.isAnchored ?? false,
      toPosition: this.to?.position ?? null,

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
    this.dragDir = null;
    // Keep hoverSnap/prevSnap for continued hover behavior
  }

  private updateRoute(): void {
    if (!this.from || !this.to) {
      this.routedPoints = [];
      return;
    }

    const snapshot = getCurrentSnapshot();

    // Get source shape bounds if attached (for bidirectional obstacle avoidance)
    let fromShapeBounds: AABB | null = null;
    if (this.from.isAnchored && this.from.shapeId) {
      const handle = snapshot.objectsById.get(this.from.shapeId);
      if (handle) {
        const frame = getShapeFrame(handle);
        if (frame) {
          fromShapeBounds = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
        }
      }
    }

    // Get target shape bounds (already set in move() for to terminal)
    const toShapeBounds: AABB | null = this.to.shapeBounds ?? null;

    // Determine endpoint configuration
    const fromAnchored = this.from.isAnchored;
    const toAnchored = this.to.isAnchored;

    // Resolve directions based on endpoint configuration
    let resolvedFromDir = this.from.outwardDir;
    let resolvedToDir = this.to.outwardDir;

    if (!fromAnchored && toAnchored && toShapeBounds) {
      // FREE→ANCHORED: Compute start direction from spatial relationship
      resolvedFromDir = resolveFreeStartDir(
        this.from.position,
        { position: this.to.position, outwardDir: this.to.outwardDir, shapeBounds: toShapeBounds },
        this.frozenWidth,
      );
    } else if (fromAnchored && !toAnchored) {
      // ANCHORED→FREE: Compute end direction from primary axis
      resolvedToDir = computeFreeEndDir(this.from.position, this.to.position);
    }
    // Both free: A-star routing becomes Z-route, uses inferDragDirection (already set in move())
    // Both anchored: Both directions from snap.side (already set)

    // Call primitives-based A* routing directly
    const result = computeAStarRoute(
      this.from.position,
      resolvedFromDir,
      this.to.position,
      resolvedToDir,
      fromShapeBounds,
      toShapeBounds,
      this.frozenWidth,
    );

    this.routedPoints = result.points;
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

      // Full routed path (assembled, ready to render)
      connectorMap.set('points', this.routedPoints);

      // Endpoint positions (always present)
      connectorMap.set('start', this.from!.position);
      connectorMap.set('end', this.to!.position);

      // Anchor data (grouped, only if anchored)
      if (this.from!.isAnchored) {
        connectorMap.set('startAnchor', {
          id: this.from!.shapeId,
          side: this.from!.side,
          anchor: this.from!.normalizedAnchor,
        });
      }

      if (this.to!.isAnchored) {
        connectorMap.set('endAnchor', {
          id: this.to!.shapeId,
          side: this.to!.side,
          anchor: this.to!.normalizedAnchor,
        });
      }

      // Caps (flat)
      connectorMap.set('startCap', 'none');
      connectorMap.set('endCap', 'arrow');

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
