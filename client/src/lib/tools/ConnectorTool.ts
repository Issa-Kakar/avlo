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

/**
 * Compute optimal from.outwardDir when to is snapped to a shape.
 *
 * The snapped side (toSide) determines the final approach axis:
 * - N/S (horizontal edge) → final segment is vertical
 * - E/W (vertical edge) → final segment is horizontal
 *
 * We compute from.outwardDir to help A* route cleanly around the obstacle:
 * - If from is on the "approach" side (can reach directly), go toward the shape
 * - If from must go around, use perpendicular direction based on quadrant
 *
 * @param fromPos - Start position [x, y]
 * @param toSide - The side of the shape we're snapped to (N/E/S/W)
 * @param shapeBounds - The shape's bounding box
 * @returns Optimal from.outwardDir
 */
function computeFromOutwardDirOnSnap(
  fromPos: [number, number],
  toSide: Dir,
  shapeBounds: { x: number; y: number; w: number; h: number }
): Dir {
  const { x, y, w, h } = shapeBounds;
  const shapeCenterX = x + w / 2;
  const shapeCenterY = y + h / 2;

  // The snapped side determines the FINAL APPROACH direction:
  // - N/S snaps → final approach is VERTICAL (perpendicular to horizontal edge)
  // - E/W snaps → final approach is HORIZONTAL (perpendicular to vertical edge)
  //
  // Three cases for from.outwardDir:
  //
  // 1. SAME SIDE: from is on the same side as the snap (e.g., above shape → top snap)
  //    - Shape is NOT in the way
  //    - Go PERPENDICULAR first (H for N/S snaps, V for E/W snaps) to align with snap
  //    - This creates a clean L-shape with final segment going straight into shape
  //
  // 2. OPPOSITE SIDE (beside): from is on opposite side but outside shape extent
  //    - Shape IS in the way, need to route around
  //    - Go PARALLEL first (V for N/S snaps, H for E/W snaps) to clear shape
  //
  // 3. BEHIND SHAPE: from is opposite side AND within shape extent (horizontally/vertically)
  //    - Can't go parallel directly (would hit shape)
  //    - Go PERPENDICULAR first to exit shape extent, then route around

  switch (toSide) {
    case 'N': // Final approach is vertical (down into shape)
      if (fromPos[1] < y) {
        // SAME SIDE: from is above shape
        // Go horizontal first to align X, then vertical approach
        return fromPos[0] < shapeCenterX ? 'E' : 'W';
      } else if (fromPos[0] > x && fromPos[0] < x + w) {
        // BEHIND SHAPE: from is below/beside AND horizontally within shape
        // Go horizontal to exit shape width first
        return fromPos[0] < shapeCenterX ? 'W' : 'E';
      }
      // OPPOSITE SIDE (beside): go up to match toJetty level
      return 'N';

    case 'S': // Final approach is vertical (up into shape)
      if (fromPos[1] > y + h) {
        // SAME SIDE: from is below shape
        return fromPos[0] < shapeCenterX ? 'E' : 'W';
      } else if (fromPos[0] > x && fromPos[0] < x + w) {
        // BEHIND SHAPE: horizontally within shape
        return fromPos[0] < shapeCenterX ? 'W' : 'E';
      }
      return 'S';

    case 'E': // Final approach is horizontal (left into shape)
      if (fromPos[0] > x + w) {
        // SAME SIDE: from is right of shape
        // Go vertical first to align Y, then horizontal approach
        return fromPos[1] < shapeCenterY ? 'S' : 'N';
      } else if (fromPos[1] > y && fromPos[1] < y + h) {
        // BEHIND SHAPE: vertically within shape
        return fromPos[1] < shapeCenterY ? 'N' : 'S';
      }
      return 'E';

    case 'W': // Final approach is horizontal (right into shape)
      if (fromPos[0] < x) {
        // SAME SIDE: from is left of shape
        return fromPos[1] < shapeCenterY ? 'S' : 'N';
      } else if (fromPos[1] > y && fromPos[1] < y + h) {
        // BEHIND SHAPE: vertically within shape
        return fromPos[1] < shapeCenterY ? 'N' : 'S';
      }
      return 'W';
  }
}

type Phase = 'idle' | 'creating';

/**
 * Terminal describes an endpoint during interaction.
 * Can be a free world position or attached to a shape edge.
 */
interface Terminal {
  kind: 'world' | 'shape';
  x: number;
  y: number;
  /**
   * Direction the jetty extends from this point (AWAY from any attached shape).
   * - For shape-attached: SAME as snap.side (N side = jetty extends north, away from shape)
   * - For free: Direction of travel toward the other endpoint
   *
   * Arrow head direction is derived from the last segment, which goes FROM toJetty TO to.pos,
   * so arrow naturally points OPPOSITE of outwardDir (into the shape).
   */
  outwardDir: Dir;
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
      // Start attached to shape - jetty extends outward (same as snap.side)
      this.from = {
        kind: 'shape',
        x: snap.position[0],
        y: snap.position[1],
        outwardDir: snap.side, // Jetty extends away from shape
        shapeId: snap.shapeId,
        side: snap.side,
        t: snap.t,
      };
    } else {
      // Free start point - will be refined on move based on drag direction
      this.from = {
        kind: 'world',
        x: worldX,
        y: worldY,
        outwardDir: 'E', // Default, refined in move() based on drag direction
      };
    }

    // Initialize 'to' at same position
    this.to = {
      kind: 'world',
      x: worldX,
      y: worldY,
      outwardDir: 'W', // Opposite of default from direction
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
      // Snapped to shape - jetty extends outward from shape (same as snap.side)
      // Arrow will point OPPOSITE of outwardDir (into the shape)
      this.to = {
        kind: 'shape',
        x: snap.position[0],
        y: snap.position[1],
        outwardDir: snap.side, // Jetty extends AWAY from shape (NOT oppositeDir!)
        shapeId: snap.shapeId,
        side: snap.side,
        t: snap.t,
      };
      this.dragDir = null; // Reset drag direction when snapped

      // CRITICAL: Update from.outwardDir based on snap position and side
      // This ensures the first segment routes optimally around the obstacle
      const handle = getCurrentSnapshot().objectsById.get(snap.shapeId);
      if (handle) {
        const frame = getShapeFrame(handle);
        if (frame) {
          const fromPos: [number, number] = [this.from!.x, this.from!.y];
          const shapeBounds = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
          this.from!.outwardDir = computeFromOutwardDirOnSnap(fromPos, snap.side, shapeBounds);
        }
      }
    } else {
      // Free endpoint - infer direction from drag
      const fromPos: [number, number] = [this.from!.x, this.from!.y];
      const cursorPos: [number, number] = [worldX, worldY];

      this.dragDir = inferDragDirection(fromPos, cursorPos, this.dragDir);

      // Update from.outwardDir for free starts so first segment updates with drag
      if (this.from!.kind === 'world') {
        this.from!.outwardDir = this.dragDir;
      }

      this.to = {
        kind: 'world',
        x: worldX,
        y: worldY,
        outwardDir: oppositeDir(this.dragDir), // Approaching from opposite of travel
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

    const snapshot = getCurrentSnapshot();

    // Get source shape bounds if attached (for bidirectional obstacle avoidance)
    let fromShapeBounds: { x: number; y: number; w: number; h: number } | undefined;
    if (this.from.kind === 'shape' && this.from.shapeId) {
      const handle = snapshot.objectsById.get(this.from.shapeId);
      if (handle) {
        const frame = getShapeFrame(handle);
        if (frame) {
          fromShapeBounds = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
        }
      }
    }

    // Get target shape bounds if snapped (for obstacle avoidance)
    let toShapeBounds: { x: number; y: number; w: number; h: number } | undefined;
    if (this.to.kind === 'shape' && this.hoverSnap) {
      const handle = snapshot.objectsById.get(this.hoverSnap.shapeId);
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
        dir: this.from.outwardDir,
        isAttached: this.from.kind === 'shape',
        shapeBounds: fromShapeBounds,
      },
      {
        pos: [this.to.x, this.to.y],
        dir: this.to.outwardDir,
        isAttached: this.to.kind === 'shape',
        shapeBounds: toShapeBounds,
      },
      this.prevRouteSignature,
      this.frozenWidth
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
