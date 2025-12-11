import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { DrawingState, PreviewData } from './types';
import { useDeviceUIStore, type Tool, type ShapeVariant } from '@/stores/device-ui-store';
import { worldToCanvas } from '@/stores/camera-store';
import { HoldDetector } from '../input/HoldDetector';
import { recognizeOpenStroke } from '../geometry/recognize-open-stroke';
import { SHAPE_CONFIDENCE_MIN } from '../geometry/shape-params';
import { createFillFromStroke } from '@/lib/utils/color';
import { getActiveRoomDoc } from '@/canvas/room-runtime';
import { invalidateOverlay } from '@/canvas/invalidation-helpers';
import { userProfileManager } from '@/lib/user-profile-manager';

type ForcedSnapKind = 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow' | 'diamond';

// Helper function to map snap kinds to shape types for storage
function getShapeTypeFromSnapKind(snapKind: string): 'rect' | 'ellipse' | 'diamond' | 'roundedRect' {
  const mapping: Record<string, 'rect' | 'ellipse' | 'diamond' | 'roundedRect'> = {
    'box': 'rect',           // Hold-detected box → sharp rect
    'circle': 'ellipse',     // Hold-detected circle → ellipse
    'rect': 'roundedRect',   // Tool rect → rounded rect (default)
    'ellipseRect': 'ellipse', // Tool ellipse → ellipse
    'diamond': 'diamond'      // Diamond → diamond
  };
  return mapping[snapKind] ?? 'rect';
}

/**
 * Map shapeVariant from device-ui-store to ForcedSnapKind for shape mode.
 * Called at begin() time to determine shape behavior.
 */
function getForceSnapKindFromVariant(variant: ShapeVariant): ForcedSnapKind {
  switch (variant) {
    case 'rectangle': return 'rect';
    case 'ellipse': return 'ellipseRect';
    case 'diamond': return 'diamond';
    case 'arrow': return 'arrow';
    default: return 'rect';
  }
}

/**
 * Determine tool type ('pen' | 'highlighter') from activeTool.
 * Shape tool uses 'pen' mechanics internally.
 */
function getToolTypeFromActiveTool(activeTool: Tool): 'pen' | 'highlighter' {
  if (activeTool === 'highlighter') return 'highlighter';
  return 'pen'; // pen, shape, and others default to pen mechanics
}

/**
 * DrawingTool - Handles pen, highlighter, and shape drawing.
 *
 * PHASE 1.5 REFACTOR: Zero-arg constructor pattern.
 * All dependencies are read at runtime from module-level stores:
 * - getActiveRoomDoc() for Y.Doc mutations
 * - userProfileManager.getIdentity().userId for ownerId
 * - useDeviceUIStore.getState() for tool type, settings, shape variant
 * - invalidateOverlay() for render loop updates
 *
 * This allows the tool to be constructed once as a singleton and reused
 * across tool switches without React lifecycle involvement.
 */
export class DrawingTool {
  private state!: DrawingState; // Will be initialized in resetState called from constructor

  // Gesture-frozen values (captured at begin() time)
  private frozenToolType: 'pen' | 'highlighter' = 'pen';
  private frozenForceSnapKind: ForcedSnapKind | null = null;

  // Bounds tracking for commit (preview doesn't use bbox anymore)
  private lastBounds: [number, number, number, number] | null = null;

  // Perfect shapes support
  private hold: HoldDetector;
  private snap:
    | null
    | (
        | { kind: 'line';        anchors: { A: [number, number] } }
        | { kind: 'circle';      anchors: { center: [number, number] } }
        | { kind: 'box';         anchors: { cx: number; cy: number; angle: number; hx0: number; hy0: number } }
        | { kind: 'rect';        anchors: { A: [number, number] } }
        | { kind: 'ellipseRect'; anchors: { A: [number, number] } }
        | { kind: 'arrow';       anchors: { A: [number, number] } }
        | { kind: 'diamond';     anchors: { A: [number, number] } }
      ) = null;
  private liveCursorWU: [number, number] | null = null;

  // Instant click-to-place mode for shape tool
  private clickToPlaceStartTime: number = 0;
  private clickToPlaceStartPos: [number, number] | null = null;


  /**
   * Zero-arg constructor. All dependencies are read at runtime.
   * Can be constructed once and reused across gestures and tool switches.
   */
  constructor() {
    this.hold = new HoldDetector(() => this.onHoldFire());
    this.resetState();
  }

  /**
   * Read and freeze settings from store at gesture start.
   * Called at begin() time to capture current settings.
   * Uses frozenToolType which is set at the start of begin().
   */
  private getFrozenSettings(): { size: number; color: string; opacity: number } {
    const state = useDeviceUIStore.getState();
    const base = state.drawingSettings;

    return {
      size: base.size,
      color: base.color,
      opacity: this.frozenToolType === 'highlighter'
        ? state.highlighterOpacity
        : (base.opacity ?? 1),
    };
  }

  /**
   * Read fill flag LIVE from store (not frozen).
   * Allows users to toggle fill during shape preview.
   */
  private getFillEnabled(): boolean {
    return useDeviceUIStore.getState().drawingSettings.fill;
  }

  private resetState(): void {
    // Read current settings from store (will be frozen on begin())
    const settings = this.getFrozenSettings();

    this.state = {
      isDrawing: false,
      pointerId: null,
      points: [], // Now stores [number, number][] tuples only
      config: {
        tool: this.frozenToolType,
        color: settings.color,
        size: settings.size,
        opacity: settings.opacity,
      },
      startTime: 0,
    };
    this.lastBounds = null;
    this.snap = null;
    this.liveCursorWU = null;
    this.frozenForceSnapKind = null;
  }

  canStartDrawing(): boolean {
    return !this.state.isDrawing;
  }

  // PointerTool interface methods for polymorphic handling with EraserTool
  canBegin(): boolean {
    return this.canStartDrawing();
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    // PHASE 1.5: Read and freeze tool state at gesture start
    const uiState = useDeviceUIStore.getState();
    const activeTool = uiState.activeTool;

    // Freeze tool type for this gesture
    this.frozenToolType = getToolTypeFromActiveTool(activeTool);

    // Freeze forceSnapKind for shape tool
    if (activeTool === 'shape') {
      this.frozenForceSnapKind = getForceSnapKindFromVariant(uiState.shapeVariant);
    } else {
      this.frozenForceSnapKind = null;
    }

    this.startDrawing(pointerId, worldX, worldY);

    // If Shape tool requested forced snap, seed it immediately
    if (this.frozenForceSnapKind) {
      // Store time and position for click detection
      this.clickToPlaceStartTime = Date.now();
      this.clickToPlaceStartPos = [worldX, worldY];

      const k = this.frozenForceSnapKind;
      this.snap =
        k === 'line'        ? { kind: 'line',        anchors: { A: [worldX, worldY] } }
      : k === 'circle'      ? { kind: 'circle',      anchors: { center: [worldX, worldY] } }
      : k === 'box'         ? { kind: 'box',         anchors: { cx: worldX, cy: worldY, angle: 0, hx0: 0.5, hy0: 0.5 } }
      : k === 'rect'        ? { kind: 'rect',        anchors: { A: [worldX, worldY] } }
      : k === 'ellipseRect' ? { kind: 'ellipseRect', anchors: { A: [worldX, worldY] } }
      : k === 'diamond'     ? { kind: 'diamond',     anchors: { A: [worldX, worldY] } }
      : /* arrow */           { kind: 'arrow',       anchors: { A: [worldX, worldY] } };

      this.liveCursorWU = [worldX, worldY];
      invalidateOverlay(); // Start preview immediately
      return; // Skip HoldDetector in forced mode
    }

    // Existing freehand flow with HoldDetector
    const [sx, sy] = worldToCanvas(worldX, worldY);
    this.hold.start({ x: sx, y: sy });
    this.snap = null;
    this.liveCursorWU = [worldX, worldY];
    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    // Always mirror the latest pointer in world space
    this.liveCursorWU = [worldX, worldY];

    // Keep hold jitter in SCREEN px prior to snap
    if (!this.snap) {
      const [sx, sy] = worldToCanvas(worldX, worldY);
      this.hold.move({ x: sx, y: sy });
    }

    if (this.snap) {
      // After snap: just request an overlay frame (liveCursorWU already updated above)
      invalidateOverlay();                // CRITICAL: drives overlay
      return;
    }

    // Before snap: freehand path behavior stays the same
    this.addPoint(worldX, worldY);                         // will call updateBounds()
    // updateBounds() → invalidateOverlay() for preview
  }

  end(worldX?: number, worldY?: number): void {
    this.hold.cancel();

    if (this.snap && this.liveCursorWU) {
      // Check if this is a click (not drag)
      const timeDelta = Date.now() - this.clickToPlaceStartTime;
      const isClick = timeDelta < 200;  // 200ms threshold for click

      if (this.clickToPlaceStartPos && worldX !== undefined && worldY !== undefined) {
        const distMoved = Math.hypot(
          worldX - this.clickToPlaceStartPos[0],
          worldY - this.clickToPlaceStartPos[1]
        );
        const isStationary = distMoved < 5;  // 5 world units threshold

        if (isClick && isStationary && this.frozenForceSnapKind) {
          // Place fixed-size shape at click position
          const fixedSize = 180;  // Fixed size in world units

          // Determine cursor position for fixed shape
          let fixedCursor: [number, number];

          if (this.snap.kind === 'rect' || this.snap.kind === 'ellipseRect' || this.snap.kind === 'diamond') {
            // For corner-anchored shapes, place centered at click
            fixedCursor = [
              this.clickToPlaceStartPos[0] + fixedSize,
              this.clickToPlaceStartPos[1] + fixedSize
            ];
            // Adjust anchor to center the shape
            this.snap.anchors.A = [
              this.clickToPlaceStartPos[0] - fixedSize/2,
              this.clickToPlaceStartPos[1] - fixedSize/2
            ];
          } else {
            // Other shapes - adjust as needed
            fixedCursor = [
              this.clickToPlaceStartPos[0] + fixedSize/2,
              this.clickToPlaceStartPos[1] + fixedSize/2
            ];
          }

          this.liveCursorWU = fixedCursor;
        }
      }

      this.commitPerfectShapeFromPreview();
      return;
    }

    // Freehand path commit (existing)
    if (worldX !== undefined && worldY !== undefined) {
      this.commitStroke(worldX, worldY);
    } else {
      // Fallback to last point if no final coords provided
      const len = this.state.points.length;
      if (len >= 1) {
        const lastPoint = this.state.points[len - 1];
        this.commitStroke(lastPoint[0], lastPoint[1]);
      } else {
        this.cancelDrawing();
      }
    }
  }

  cancel(): void {
    this.hold.cancel();
    this.snap = null;
    this.liveCursorWU = null;
    this.cancelDrawing();
  }

  isActive(): boolean {
    return this.isDrawing();
  }

  startDrawing(pointerId: number, worldX: number, worldY: number): void {
    if (this.state.isDrawing) return;

    // CRITICAL: Freeze settings from store at gesture start
    // Note: frozenToolType is already set by begin() before calling this
    const frozen = this.getFrozenSettings();

    this.state = {
      isDrawing: true,
      pointerId,
      points: [[worldX, worldY]], // Store as tuples from the start
      config: {
        tool: this.frozenToolType,
        color: frozen.color,
        size: frozen.size,
        opacity: frozen.opacity,
      },
      startTime: Date.now(),
    };
  }

  addPoint(worldX: number, worldY: number): void {
    if (!this.state.isDrawing) return;

    // Drop exact duplicate (but DO NOT decimate otherwise)
    const pts = this.state.points;
    const L = pts.length;
    if (L >= 1 && pts[L - 1][0] === worldX && pts[L - 1][1] === worldY) return;

    // Append immediately to tuple array
    this.state.points.push([worldX, worldY]);

    // Invalidate dirty region and ensure overlay rAF runs promptly
    this.updateBounds();           // Legacy bounds tracking
    invalidateOverlay();           // Nudge overlay for preview update
  }

  private flushPending(): void {
    // No-op: preview capture no longer buffers by rAF.
  }

  private updateBounds(): void {
    // Legacy bounds tracking - no longer needed since overlay uses full clear
    // Kept as no-op for now in case we re-add dirty rect optimization later
  }

  private onHoldFire(): void {
    if (this.snap) return;

    // legacy
    this.flushPending();

    // Use latest pointer in WORLD units
    const len = this.state.points.length;
    if (len < 1) return;
    const pointerNowWU: [number, number] = this.state.points[len - 1];

    //  keep the live cursor in sync at the moment of snapping
    this.liveCursorWU = pointerNowWU;

    console.group('🎯 Hold Detector Fired - Shape Recognition');
    console.log(`Stroke has ${this.state.points.length} points after 600ms dwell`);

    // Convert tuples to flat array for shape recognition (temporary until RDP is updated)
    const flatPoints = this.tupleArrayToFlat(this.state.points);

    const result = recognizeOpenStroke({
      pointsWU: flatPoints,
      pointerNowWU
    });

    // Handle near-miss result - don't snap, continue freehand
    if (result.ambiguous) {
      console.log('🤷 Near-miss detected - NO SNAP, user likely intended a shape but didn\'t quite make it');
      console.groupEnd();
      // Don't set snap, don't cancel hold, just continue drawing
      // This prevents the annoying line snap when user almost drew a shape
      return;
    }

    // Handle recognized shapes (line, circle, box)
    if (result.kind === 'line' || result.score >= SHAPE_CONFIDENCE_MIN) {
      // Freeze anchors; do NOT compute live geometry here.
      this.snap = (
        result.kind === 'line'
          ? { kind: 'line',   anchors: { A: result.line!.A } }
        : result.kind === 'circle'
          ? { kind: 'circle', anchors: { center: [result.circle!.cx, result.circle!.cy] } }
          : { kind: 'box',     anchors: {
              cx: result.box!.cx,
              cy: result.box!.cy,
              angle: 0,  // ALWAYS 0 for AABB
              hx0: result.box!.hx,
              hy0: result.box!.hy
            }}
      );
      console.log(`✅ SNAP DECISION: ${result.kind.toUpperCase()} (score: ${result.score.toFixed(3)})`);
      console.groupEnd();
      invalidateOverlay();
      this.hold.cancel();
    }
  }

  getPreview(): PreviewData | null {

    // Normal drawing state checks
    if (!this.state.isDrawing) return null;

    if (this.snap && this.liveCursorWU) {
      const { color, size } = this.state.config;
      return {
        kind: 'perfectShape',
        shape: this.snap.kind,
        color,
        size,
        opacity: this.state.config.opacity, // Use actual commit opacity
        fill: this.getFillEnabled(),  // Read LIVE from store for real-time toggle
        anchors: { kind: this.snap.kind, ...this.snap.anchors } as any,
        cursor: this.liveCursorWU,
        bbox: null
      };
    }

    // Freehand: return tuples for zero-conversion preview
    if (this.state.points.length < 1) return null;
    return {
      kind: 'stroke',
      points: this.state.points, // Direct tuple array
      tool: this.state.config.tool,
      color: this.state.config.color,
      size: this.state.config.size,
      opacity: this.state.config.opacity,
      bbox: this.lastBounds,
    };
  }

  isDrawing(): boolean {
    return this.state.isDrawing;
  }

  getPointerId(): number | null {
    return this.state.pointerId;
  }

  cancelDrawing(): void {
    this.flushPending();
    // Invalidate overlay to clear any preview
    invalidateOverlay();
    this.resetState();
  }

  commitStroke(finalX: number, finalY: number): void {
    if (!this.state.isDrawing) return;

    this.flushPending();

    // 2) Add final point to tuple array if needed
    const len = this.state.points.length;
    const needsFinal = len < 1 || this.state.points[len - 1][0] !== finalX || this.state.points[len - 1][1] !== finalY;
    if (needsFinal) {
      this.state.points.push([finalX, finalY]);
    }

    // 3) Get runtime dependencies (bbox no longer needed - overlay uses full clear)
    const roomDoc = getActiveRoomDoc();
    const userId = userProfileManager.getIdentity().userId;

    // 4) Commit to Y.Doc with tuple points directly
    const strokeId = ulid();

    try {
      roomDoc.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const objects = root.get('objects') as Y.Map<Y.Map<any>>;

        const strokeMap = new Y.Map();
        strokeMap.set('id', strokeId);
        strokeMap.set('kind', 'stroke');
        strokeMap.set('tool', this.state.config.tool);
        strokeMap.set('color', this.state.config.color);
        strokeMap.set('width', this.state.config.size);  // Renamed from 'size' to 'width' per migration spec
        strokeMap.set('opacity', this.state.config.opacity);
        strokeMap.set('points', this.state.points);  // Direct reference - Yjs copies internally
        strokeMap.set('ownerId', userId);
        strokeMap.set('createdAt', Date.now());

        objects.set(strokeId, strokeMap);
      });
    } catch (err) {
      console.error('Failed to commit stroke:', err);
    } finally {
      // 5) Invalidate overlay to clear preview and reset state
      invalidateOverlay();
      this.resetState();
    }
  }

  private commitPerfectShapeFromPreview(): void {
    if (!this.snap || !this.liveCursorWU) return;

    const finalCursor = this.liveCursorWU!;
    let frame: [number, number, number, number];
    const shapeType = getShapeTypeFromSnapKind(this.snap.kind);

    // Get runtime dependencies
    const roomDoc = getActiveRoomDoc();
    const userId = userProfileManager.getIdentity().userId;

    if (this.snap.kind === 'line') {
      // Line is not a shape object, skip for now
      // TODO: Implement connector tool for lines and arrows
      console.log('Line/Arrow shapes not yet supported as shape objects');
      this.cancelDrawing();
      return;

    } else if (this.snap.kind === 'arrow') {
      // Arrow is not a shape object, skip for now
      console.log('Line/Arrow shapes not yet supported as shape objects');
      this.cancelDrawing();
      return;

    } else if (this.snap.kind === 'circle') {
      const { center } = this.snap.anchors;
      const r = Math.hypot(finalCursor[0] - center[0], finalCursor[1] - center[1]);
      // Calculate frame directly: [x, y, width, height]
      frame = [
        center[0] - r,
        center[1] - r,
        r * 2,
        r * 2
      ];

    } else if (this.snap.kind === 'box') {
      const { cx, cy, angle, hx0, hy0 } = this.snap.anchors;
      // Compute final scale from cursor
      const dx = finalCursor[0] - cx;
      const dy = finalCursor[1] - cy;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const localX =  dx *  cos + dy *  sin;
      const localY = -dx *  sin + dy *  cos;
      const sx = Math.max(0.0001, Math.abs(localX) / Math.max(1e-6, hx0));
      const sy = Math.max(0.0001, Math.abs(localY) / Math.max(1e-6, hy0));
      const hx = hx0 * sx;
      const hy = hy0 * sy;
      // Calculate frame directly for AABB box
      frame = [
        cx - hx,
        cy - hy,
        hx * 2,
        hy * 2
      ];

    } else if (this.snap.kind === 'rect') {
      // Corner-anchored rectangle
      const { A } = this.snap.anchors;
      const C = finalCursor;
      const minX = Math.min(A[0], C[0]);
      const minY = Math.min(A[1], C[1]);
      const maxX = Math.max(A[0], C[0]);
      const maxY = Math.max(A[1], C[1]);
      frame = [
        minX,
        minY,
        maxX - minX,
        maxY - minY
      ];

    } else if (this.snap.kind === 'ellipseRect') {
      // Corner-anchored ellipse
      const { A } = this.snap.anchors;
      const C = finalCursor;
      const minX = Math.min(A[0], C[0]);
      const minY = Math.min(A[1], C[1]);
      const maxX = Math.max(A[0], C[0]);
      const maxY = Math.max(A[1], C[1]);
      frame = [
        minX,
        minY,
        maxX - minX,
        maxY - minY
      ];

    } else if (this.snap.kind === 'diamond') {
      // Corner-anchored diamond (same as rect/ellipse)
      const { A } = this.snap.anchors;
      const C = finalCursor;
      const minX = Math.min(A[0], C[0]);
      const minY = Math.min(A[1], C[1]);
      const maxX = Math.max(A[0], C[0]);
      const maxY = Math.max(A[1], C[1]);
      frame = [
        minX,
        minY,
        maxX - minX,
        maxY - minY
      ];

    } else {
      // Exhaustive check - TypeScript ensures all cases are handled
      const _exhaustive: never = this.snap;
      console.error('Unknown snap kind:', _exhaustive);
      this.cancelDrawing();
      return;
    }
    console.log('frame', frame);
    // Commit as shape object
    const shapeId = ulid();
    roomDoc.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<any>>;

      const shapeMap = new Y.Map();
      shapeMap.set('id', shapeId);
      shapeMap.set('kind', 'shape');
      shapeMap.set('shapeType', shapeType);  // Use the mapped shape type
      shapeMap.set('color', this.state.config.color);  // Phase 3: Use 'color' not 'strokeColor'
      shapeMap.set('width', this.state.config.size);   // Phase 3: Use 'width' not 'strokeWidth'

      // Add fill color if enabled (read LIVE from store at commit time)
      if (this.getFillEnabled()) {
        const fillColor = createFillFromStroke(this.state.config.color);
        shapeMap.set('fillColor', fillColor);
      }

      shapeMap.set('opacity', this.state.config.opacity);
      shapeMap.set('frame', frame);  // Direct frame, no conversion needed
      shapeMap.set('ownerId', userId);
      shapeMap.set('createdAt', Date.now());

      objects.set(shapeId, shapeMap);
    });

    // Invalidate overlay to clear preview
    invalidateOverlay();
    this.resetState();
    this.snap = null;
    this.liveCursorWU = null;
  }

  destroy(): void {
    this.resetState();
    this.hold.cancel();
    this.snap = null;
    this.liveCursorWU = null;
  }

  // Helper functions for Vec2 conversion (temporary until RDP is updated to work with tuples)
  private tupleArrayToFlat(tuples: [number, number][]): number[] {
    const flat: number[] = [];
    for (const [x, y] of tuples) {
      flat.push(x, y);
    }
    return flat;
  }

}
