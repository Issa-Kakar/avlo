import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { IRoomDocManager } from '../room-doc-manager';
import { STROKE_CONFIG } from '@avlo/shared';
import type { ViewTransform } from '@avlo/shared';
import { calculateBBox } from './simplification';
import type { DrawingState, PreviewData } from './types';
import type { DrawingSettings } from '@/stores/device-ui-store';
import { HoldDetector } from '../input/HoldDetector';
import { recognizeOpenStroke } from '../geometry/recognize-open-stroke';
import { SHAPE_CONFIDENCE_MIN } from '../geometry/shape-params';
import { createFillFromStroke } from '@/lib/utils/color';
// import { getStroke } from 'perfect-freehand';
// import { PF_OPTIONS_BASE } from '@/renderer/stroke-builder/pf-config';

// These constants are imported from @avlo/shared config
// See Step 7 for the values to add to /packages/shared/src/config.ts

type RequestOverlayFrame = () => void;
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

export class DrawingTool {
  private state!: DrawingState; // Will be initialized in resetState called from constructor
  private room: IRoomDocManager; // Use interface, not implementation
  private settings: DrawingSettings;
  private toolType: 'pen' | 'highlighter';
  private userId: string; // Stable user ID for all strokes from this tool instance

  // Bounds tracking for commit (preview doesn't use bbox anymore)
  private lastBounds: [number, number, number, number] | null = null;
  // Callbacks
  private onInvalidate?: (bounds: [number, number, number, number]) => void;
  // NEW: Perfect shapes support
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
  private getView?: () => ViewTransform;              // screen jitter (hold)
  private requestOverlayFrame?: RequestOverlayFrame;  // NEW: nudge overlay loop
  private opts: { forceSnapKind?: ForcedSnapKind } = {};
  // Instant click-to-place mode for shape tool
  private clickToPlaceStartTime: number = 0;
  private clickToPlaceStartPos: [number, number] | null = null;


  constructor(
    room: IRoomDocManager, // Use interface for loose coupling
    settings: DrawingSettings,
    toolType: 'pen' | 'highlighter',
    userId: string, // Pass stable ID, not a getter function
    onInvalidate?: (bounds: [number, number, number, number]) => void,
    requestOverlayFrame?: RequestOverlayFrame,     // NEW (overlay frames)
    getView?: () => ViewTransform,                 // stays (hold jitter)
    opts?: { forceSnapKind?: ForcedSnapKind }      // NEW parameter
  ) {
    this.room = room;
    this.settings = settings;
    this.toolType = toolType;
    this.userId = userId; // Store the stable ID
    this.onInvalidate = onInvalidate;
    this.requestOverlayFrame = requestOverlayFrame;
    this.getView = getView;
    this.opts = opts ?? {};
    this.hold = new HoldDetector(() => this.onHoldFire());
    this.resetState();
  }

  private resetState(): void {
    this.state = {
      isDrawing: false,
      pointerId: null,
      points: [], // Now stores [number, number][] tuples only
      config: {
        tool: this.toolType,
        color: this.settings.color,
        size: this.settings.size,
        opacity: this.settings.opacity ?? (this.toolType === 'highlighter' ? 0.25 : 1),
      },
      startTime: 0,
    };
    this.lastBounds = null;
    this.snap = null;
    this.liveCursorWU = null;
  }

  canStartDrawing(): boolean {
    return !this.state.isDrawing; // Tool type already validated in constructor
  }

  // PointerTool interface methods for polymorphic handling with EraserTool
  canBegin(): boolean {
    return this.canStartDrawing();
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    
    this.startDrawing(pointerId, worldX, worldY);

    // If Shape tool requested forced snap, seed it immediately
    if (this.opts.forceSnapKind) {
      // Store time and position for click detection
      this.clickToPlaceStartTime = Date.now();
      this.clickToPlaceStartPos = [worldX, worldY];

      const k = this.opts.forceSnapKind;
      this.snap =
        k === 'line'        ? { kind: 'line',        anchors: { A: [worldX, worldY] } }
      : k === 'circle'      ? { kind: 'circle',      anchors: { center: [worldX, worldY] } }
      : k === 'box'         ? { kind: 'box',         anchors: { cx: worldX, cy: worldY, angle: 0, hx0: 0.5, hy0: 0.5 } }
      : k === 'rect'        ? { kind: 'rect',        anchors: { A: [worldX, worldY] } }
      : k === 'ellipseRect' ? { kind: 'ellipseRect', anchors: { A: [worldX, worldY] } }
      : k === 'diamond'     ? { kind: 'diamond',     anchors: { A: [worldX, worldY] } }
      : /* arrow */           { kind: 'arrow',       anchors: { A: [worldX, worldY] } };

      this.liveCursorWU = [worldX, worldY];
      this.requestOverlayFrame?.(); // Start preview immediately
      return; // Skip HoldDetector in forced mode
    }

    // Existing freehand flow with HoldDetector
    if (this.getView) {
      const [sx, sy] = this.getView().worldToCanvas(worldX, worldY);
      this.hold.start({ x: sx, y: sy });
    }
    this.snap = null;
    this.liveCursorWU = [worldX, worldY];
    this.requestOverlayFrame?.();
  }

  move(worldX: number, worldY: number): void {
    // Always mirror the latest pointer in world space
    this.liveCursorWU = [worldX, worldY];

    // Keep hold jitter in SCREEN px prior to snap
    if (!this.snap && this.getView) {
      const [sx, sy] = this.getView().worldToCanvas(worldX, worldY);
      this.hold.move({ x: sx, y: sy });
    }

    if (this.snap) {
      // After snap: just request an overlay frame (liveCursorWU already updated above)
      this.requestOverlayFrame?.();                // CRITICAL: drives overlay
      return;
    }

    // Before snap: freehand path behavior stays the same
    this.addPoint(worldX, worldY);                         // will call updateBounds()
    // updateBounds() → onInvalidate(bounds) → Canvas maps that to overlay invalidation
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

        if (isClick && isStationary && this.opts.forceSnapKind) {
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

    // Freeze tool settings at gesture start (CRITICAL)
    this.state = {
      isDrawing: true,
      pointerId,
      points: [[worldX, worldY]], // Store as tuples from the start
      config: {
        tool: this.toolType,
        color: this.settings.color,
        size: this.settings.size,
        opacity:
          this.toolType === 'highlighter'
            ? STROKE_CONFIG.HIGHLIGHTER_DEFAULT_OPACITY
            : (this.settings.opacity ?? 1),
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
    this.updateBounds();           // canvas maps this to overlay invalidation
    this.requestOverlayFrame?.();  // nudge overlay even if bounds didn't expand
  }

  private flushPending(): void {
    // No-op: preview capture no longer buffers by rAF.
  }

  private updateBounds(): void {
    // Calculate bounds for commit time (preview doesn't use bbox with dual canvas)
    //const bounds = calculateBBox(this.state.points, this.state.config.size);

    // Store for commit and final invalidation
    // if (bounds) {
    //   this.lastBounds = bounds;
    // }

    // Trigger overlay invalidation (overlay does full clear, no dirty rects for preview)
    // Canvas maps onInvalidate to overlay invalidation regardless of bounds
    if (this.lastBounds) {
      this.onInvalidate?.(this.lastBounds);
    }
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
      this.requestOverlayFrame?.();
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
        fill: (this.settings as any).fill,  // Include fill flag for preview
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
    if (this.lastBounds) {
      this.onInvalidate?.(this.lastBounds);
    }
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

    // 3) Store preview bounds for invalidation
    const previewBounds = this.lastBounds;

    // 4) Compute final bbox from tuples (no clone needed - Yjs copies internally)
    const finalBbox = calculateBBox(this.state.points, this.state.config.size);

    // 5) Commit to Y.Doc with tuple points directly
    const strokeId = ulid();
    const userId = this.userId;

    try {
      this.room.mutate((ydoc) => {
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
      // 6) Invalidate preview + final bbox
      if (previewBounds) {
        this.onInvalidate?.(previewBounds);
      }
      if (finalBbox) {
        this.onInvalidate?.(finalBbox);
      }
      // 7) Reset state
      this.resetState();
    }
  }

  private commitPerfectShapeFromPreview(): void {
    if (!this.snap || !this.liveCursorWU) return;

    const finalCursor = this.liveCursorWU!;
    let frame: [number, number, number, number];
    const shapeType = getShapeTypeFromSnapKind(this.snap.kind);

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
    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<any>>;

      const shapeMap = new Y.Map();
      shapeMap.set('id', shapeId);
      shapeMap.set('kind', 'shape');
      shapeMap.set('shapeType', shapeType);  // Use the mapped shape type
      shapeMap.set('color', this.state.config.color);  // Phase 3: Use 'color' not 'strokeColor'
      shapeMap.set('width', this.state.config.size);   // Phase 3: Use 'width' not 'strokeWidth'

      // Add fill color if enabled (passed through settings)
      if ((this.settings as any).fill) {
        const fillColor = createFillFromStroke(this.state.config.color);
        shapeMap.set('fillColor', fillColor);
      }

      shapeMap.set('opacity', this.state.config.opacity);
      shapeMap.set('frame', frame);  // Direct frame, no conversion needed
      shapeMap.set('ownerId', this.userId);
      shapeMap.set('createdAt', Date.now());

      objects.set(shapeId, shapeMap);
    });

    // Invalidate using frame bounds (with stroke width inflation)
    const strokeWidth = this.state.config.size;
    const padding = strokeWidth * 0.5 + 1;
    const inflatedBounds: [number, number, number, number] = [
      frame[0] - padding,
      frame[1] - padding,
      frame[0] + frame[2] + padding,
      frame[1] + frame[3] + padding
    ];
    this.onInvalidate?.(inflatedBounds);
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

  // private flatToTupleArray(flat: number[]): [number, number][] {
  //   const tuples: [number, number][] = [];
  //   for (let i = 0; i < flat.length; i += 2) {
  //     if (i + 1 < flat.length) {
  //       tuples.push([flat[i], flat[i + 1]]);
  //     }
  //   }
  //   return tuples;
  // }
}
