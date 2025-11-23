import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { IRoomDocManager } from '../room-doc-manager';
import { STROKE_CONFIG, ROOM_CONFIG } from '@avlo/shared';
import type { ViewTransform } from '@avlo/shared';
import {  calculateBBox, estimateEncodedSize } from './simplification';
import type { DrawingState, PreviewData } from './types';
import type { ToolSettings } from '@/stores/device-ui-store';
import { HoldDetector } from '../input/HoldDetector';
import { recognizeOpenStroke } from '../geometry/recognize-open-stroke';
import { SHAPE_CONFIDENCE_MIN } from '../geometry/shape-params';
// import { getStroke } from 'perfect-freehand';
// import { PF_OPTIONS_BASE } from '@/renderer/stroke-builder/pf-config';

// These constants are imported from @avlo/shared config
// See Step 7 for the values to add to /packages/shared/src/config.ts

type RequestOverlayFrame = () => void;
type ForcedSnapKind = 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'arrow';

export class DrawingTool {
  private state!: DrawingState; // Will be initialized in resetState called from constructor
  private room: IRoomDocManager; // Use interface, not implementation
  private settings: ToolSettings;
  private toolType: 'pen' | 'highlighter';
  private userId: string; // Stable user ID for all strokes from this tool instance

  // Bounds tracking for commit (preview doesn't use bbox anymore)
  private lastBounds: [number, number, number, number] | null = null;
  private shapeType: 'rect' | 'ellipse' | 'diamond' | 'roundedRect' | null = null;
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
      ) = null;
  private liveCursorWU: [number, number] | null = null;
  private getView?: () => ViewTransform;              // screen jitter (hold)
  private requestOverlayFrame?: RequestOverlayFrame;  // NEW: nudge overlay loop
  private opts: { forceSnapKind?: ForcedSnapKind } = {};

  constructor(
    room: IRoomDocManager, // Use interface for loose coupling
    settings: ToolSettings,
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
      points: [],
      pointsPF: [],
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
      const k = this.opts.forceSnapKind;
      this.snap =
        k === 'line'        ? { kind: 'line',        anchors: { A: [worldX, worldY] } }
      : k === 'circle'      ? { kind: 'circle',      anchors: { center: [worldX, worldY] } }
      : k === 'box'         ? { kind: 'box',         anchors: { cx: worldX, cy: worldY, angle: 0, hx0: 0.5, hy0: 0.5 } }
      : k === 'rect'        ? { kind: 'rect',        anchors: { A: [worldX, worldY] } }
      : k === 'ellipseRect' ? { kind: 'ellipseRect', anchors: { A: [worldX, worldY] } }
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
      // Build polyline from (anchors + live cursor), compute bbox ONCE, commit.
      this.commitPerfectShapeFromPreview();
      return;
    }

    // Freehand path commit (existing)
    if (worldX !== undefined && worldY !== undefined) {
      this.commitStroke(worldX, worldY);
    } else {
      // Fallback to last point if no final coords provided
      const len = this.state.points.length;
      if (len >= 2) {
        this.commitStroke(this.state.points[len - 2], this.state.points[len - 1]);
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
      points: [worldX, worldY],
      pointsPF: [[worldX, worldY]],
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
    if (L >= 2 && pts[L - 2] === worldX && pts[L - 1] === worldY) return;

    // Append immediately; keep both buffers in lockstep for PF + commit
    this.state.points.push(worldX, worldY);
    this.state.pointsPF.push([worldX, worldY]);

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
    if (len < 2) return;
    const pointerNowWU: [number, number] = [
      this.state.points[len - 2], this.state.points[len - 1]
    ];

    //  keep the live cursor in sync at the moment of snapping
    this.liveCursorWU = pointerNowWU;

    console.group('🎯 Hold Detector Fired - Shape Recognition');
    console.log(`Stroke has ${this.state.points.length / 2} points after 600ms dwell`);

    const result = recognizeOpenStroke({
      pointsWU: this.state.points,
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
        anchors: { kind: this.snap.kind, ...this.snap.anchors } as any,
        cursor: this.liveCursorWU,
        bbox: null
      };
    }

    // Freehand: return PF-native tuples for zero-conversion preview
    if (this.state.pointsPF.length < 1) return null;
    return {
      kind: 'stroke',
      points: this.state.pointsPF, // PF-native tuples
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

    // 1) CRITICAL: Flush RAF before commit
    this.flushPending();

    // 2) Add final point to BOTH arrays (lockstep critical!)
    const len = this.state.points.length;
    const needsFinal = len < 2 || this.state.points[len - 2] !== finalX || this.state.points[len - 1] !== finalY;
    if (needsFinal) {
      this.state.points.push(finalX, finalY);
      this.state.pointsPF.push([finalX, finalY]); // CRITICAL: Keep PF tuples in lockstep
    }

    // 4) Store preview bounds for invalidation
    const previewBounds = this.lastBounds;

    // 5) NO SIMPLIFICATION for freehand - use raw centerline
    const rawPoints = this.state.points;

    // 6) Canonical PF tuples = exact tuple buffer used for preview (clone for immutability)
    const canonicalTuples = this.state.pointsPF.slice();

    // 7) Size check on raw centerline (transport limit)
    const estimatedSize = estimateEncodedSize(rawPoints);
    if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
      console.error(
        `Stroke too large for transport: ${estimatedSize} bytes (max: ${ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES})`,
      );
      // TODO: Show user toast about stroke being too complex
      this.cancelDrawing();
      return;
    }

    // 8) Compute final bbox from raw centerline
    const finalBbox = calculateBBox(rawPoints, this.state.config.size);

    // 11) Commit to Y.Doc with BOTH raw points and canonical tuples
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
        strokeMap.set('points', canonicalTuples);  // Store as tuples (no more flat arrays)
        strokeMap.set('ownerId', userId);
        strokeMap.set('createdAt', Date.now());

        objects.set(strokeId, strokeMap);
      });
    } catch (err) {
      console.error('Failed to commit stroke:', err);
    } finally {
      // 12) Invalidate preview + final bbox
      if (previewBounds) {
        this.onInvalidate?.(previewBounds);
      }
      if (finalBbox) {
        this.onInvalidate?.(finalBbox);
      }
      // 13) Reset state (finalOutline persists for held frame)
      this.resetState();
    }
  }

  private commitPerfectShapeFromPreview(): void {
    if (!this.snap || !this.liveCursorWU) return;

    // Generate polyline from (anchors + final cursor)
    let points: number[];
    const finalCursor = this.liveCursorWU!;
    
    if (this.snap.kind === 'line') {
      const { A } = this.snap.anchors;
      const B = finalCursor;
      points = [A[0], A[1], B[0], B[1]];

    } else if (this.snap.kind === 'circle') {
      this.shapeType = 'ellipse';
      const { center } = this.snap.anchors;
      const r = Math.hypot(finalCursor[0] - center[0], finalCursor[1] - center[1]);
      const n = Math.max(24, Math.ceil(2 * Math.PI * r / 8));
      points = [];
      for (let i = 0; i <= n; i++) {
        const angle = (i / n) * 2 * Math.PI;
        points.push(center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle));
      }

    } else if (this.snap.kind === 'box') {
      this.shapeType = 'rect';
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

      const corners = [
        [-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]
      ];
      points = [];
      for (const [lx, ly] of corners) {
        points.push(
          cx + lx * cos - ly * sin,
          cy + lx * sin + ly * cos
        );
      }

    } else if (this.snap.kind === 'rect') {
      this.shapeType = 'roundedRect' as const;
      const { A } = this.snap.anchors;
      const C = finalCursor;
      const B: [number, number] = [C[0], A[1]];
      const D: [number, number] = [A[0], C[1]];
      points = [
        A[0], A[1],
        B[0], B[1],
        C[0], C[1],
        D[0], D[1],
        A[0], A[1],
      ];
    

    } else if (this.snap.kind === 'ellipseRect') {
      // Corner-anchored ellipse inscribed in AABB
      this.shapeType = 'ellipse';
      const { A } = this.snap.anchors;
      const C = finalCursor;
      const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
      const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const rx = Math.max(0.0001, (maxX - minX) / 2);
      const ry = Math.max(0.0001, (maxY - minY) / 2);
      // Approximate perimeter for point density
      const perim = Math.PI * (3*(rx+ry) - Math.sqrt((3*rx+ry)*(rx+3*ry)));
      const n = Math.max(24, Math.ceil(perim / 8));
      points = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * 2 * Math.PI;
        points.push(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
      }

    } else if (this.snap.kind === 'arrow') {
      // Arrow with dynamic head size
      const { A } = this.snap.anchors;
      const B = finalCursor;
      const vx = B[0] - A[0], vy = B[1] - A[1];
      const len = Math.hypot(vx, vy) || 1;
      const headSize = Math.min(40, len * 0.25);
      const spread = Math.PI / 7; // ~25 degrees
      const theta = Math.atan2(vy, vx);
      const H1: [number, number] = [
        B[0] - headSize * Math.cos(theta + spread),
        B[1] - headSize * Math.sin(theta + spread)
      ];
      const H2: [number, number] = [
        B[0] - headSize * Math.cos(theta - spread),
        B[1] - headSize * Math.sin(theta - spread)
      ];
      // Single continuous polyline: shaft + head
      points = [A[0], A[1], B[0], B[1], H1[0], H1[1], B[0], B[1], H2[0], H2[1]];

    } else {
      // Exhaustive check - TypeScript ensures all cases are handled
      const _exhaustive: never = this.snap;
      console.error('Unknown snap kind:', _exhaustive);
      this.cancelDrawing();
      return;
    }

    // NOW compute bbox at commit time
    const bbox = calculateBBox(points, 0);

    // Check size limits
    const estimatedSize = estimateEncodedSize(points);
    if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
      console.error('Perfect shape too large for transport');
      this.cancelDrawing();
      return;
    }

    // Commit as shape object
    const shapeId = ulid();
    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<any>>;

      const shapeMap = new Y.Map();
      shapeMap.set('id', shapeId);
      shapeMap.set('kind', 'shape');
      shapeMap.set('shapeType', this.shapeType as 'rect' | 'ellipse' | 'diamond' | 'roundedRect');  // Store the shape type
      shapeMap.set('strokeColor', this.state.config.color);
      shapeMap.set('strokeWidth', this.state.config.size);
      // shapeMap.set('fillColor', '#');
      shapeMap.set('opacity', this.state.config.opacity);
      shapeMap.set('frame', bbox ? [bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]] : [0, 0, 0, 0]);  // Convert bbox to frame [x, y, w, h]
      shapeMap.set('ownerId', this.userId);
      shapeMap.set('createdAt', Date.now());

      objects.set(shapeId, shapeMap);
    });

    // Invalidate and reset
    if (bbox) this.onInvalidate?.(bbox);
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
}
