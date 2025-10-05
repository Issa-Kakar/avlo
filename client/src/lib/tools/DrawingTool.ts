import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { IRoomDocManager } from '../room-doc-manager';
import { STROKE_CONFIG, ROOM_CONFIG } from '@avlo/shared';
import type { ViewTransform } from '@avlo/shared';
import { simplifyStroke, calculateBBox, estimateEncodedSize } from './simplification';
import type { DrawingState, PreviewData } from './types';
import type { ToolSettings } from '@/stores/device-ui-store';
import { HoldDetector } from '../input/HoldDetector';
import { recognizeOpenStroke } from '../geometry/recognize-open-stroke';
import { SHAPE_CONFIDENCE_MIN } from '../geometry/shape-params';

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

  // RAF coalescing
  private rafId: number | null = null;
  private pendingPoint: [number, number] | null = null;
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

    // Coalesce to RAF
    this.pendingPoint = [worldX, worldY];

    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        // Double-check state in case tool was destroyed during RAF
        if (this.pendingPoint && this.state.isDrawing) {
          this.state.points.push(...this.pendingPoint);
          this.updateBounds();
        }
        this.pendingPoint = null;
        this.rafId = null;
      });
    }
  }

  private flushPending(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.pendingPoint && this.state.isDrawing) {
      this.state.points.push(...this.pendingPoint);
      this.pendingPoint = null;
    }
  }

  private updateBounds(): void {
    // Calculate bounds WITH stroke width inflation
    const bounds = calculateBBox(this.state.points, this.state.config.size);

    // Invalidate old region first (if exists)
    if (this.lastBounds) {
      this.onInvalidate?.(this.lastBounds);
    }

    // Then invalidate new region
    // CRITICAL: RenderLoop MUST internally union all invalidated regions
    // within a single frame to avoid redundant redraws
    // This is a Phase 3 RenderLoop responsibility, not DrawingTool's
    // DrawingTool can call invalidate multiple times; RenderLoop handles deduplication
    if (bounds) {
      this.onInvalidate?.(bounds);
      this.lastBounds = bounds;
    }
  }

  private onHoldFire(): void {
    if (this.snap) return;

    // Make sure we use the freshest point
    this.flushPending();

    // Use latest pointer in WORLD units
    const len = this.state.points.length;
    if (len < 2) return;
    const pointerNowWU: [number, number] = [
      this.state.points[len - 2], this.state.points[len - 1]
    ];

    // ✨ NEW: keep the live cursor in sync at the moment of snapping
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
    if (!this.state.isDrawing) return null;

    if (this.snap && this.liveCursorWU) {
      const { color, size, tool } = this.state.config;
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

    // Freehand (unchanged)
    if (this.state.points.length < 2) return null;
    return {
      kind: 'stroke', // Add discriminant for union type
      points: this.state.points,
      tool: this.state.config.tool,
      color: this.state.config.color,
      size: this.state.config.size,
      opacity: this.state.config.opacity, // Use actual commit opacity
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

    // CRITICAL: Flush RAF before commit
    this.flushPending();

    // Add final point if different
    const len = this.state.points.length;
    if (len < 2 || this.state.points[len - 2] !== finalX || this.state.points[len - 1] !== finalY) {
      this.state.points.push(finalX, finalY);
    }

    // Validate minimum points
    if (this.state.points.length < 4) {
      this.cancelDrawing();
      return;
    }

    // Store preview bounds before simplification
    const previewBounds = this.lastBounds;

    // Simplify FIRST, then check size
    const { points: simplified } = simplifyStroke(this.state.points, this.state.config.tool);

    // Check if simplification rejected the stroke (empty points means exceeded 128KB budget)
    if (simplified.length === 0) {
      // TODO: Show user toast about stroke being too complex
      this.cancelDrawing();
      return;
    }

    // Check frame size AFTER simplification (2MB transport limit)
    const estimatedSize = estimateEncodedSize(simplified);
    if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
      console.error(
        `Stroke too large for transport: ${estimatedSize} bytes (max: ${ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES})`,
      );
      // TODO: Show user toast about stroke being too complex
      this.cancelDrawing();
      return;
    }

    // Calculate final bbox for the simplified stroke
    const simplifiedBbox = calculateBBox(simplified, this.state.config.size);

    // Commit to Y.Doc
    const strokeId = ulid();
    const userId = this.userId; // Use stable ID stored at construction

    try {
      this.room.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const strokes = root.get('strokes') as Y.Array<any>;
        const meta = root.get('meta') as Y.Map<any>;

        // Get scene_ticks (MUST be initialized by RoomDocManager in Phase 2)
        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        if (!sceneTicks) {
          // This is a CRITICAL error - scene_ticks MUST be initialized in Phase 2
          console.error('CRITICAL: scene_ticks not initialized - Phase 2 implementation is broken');
          // TODO: Show user toast/banner about room metadata not initialized
          // Surface this error visibly so it's not silent
          return;
        }

        // Scene assigned AT COMMIT TIME
        const currentScene = sceneTicks.length;

        strokes.push([
          {
            id: strokeId,
            tool: this.state.config.tool, // Frozen at start
            color: this.state.config.color, // Frozen at start
            size: this.state.config.size, // Frozen at start
            opacity: this.state.config.opacity, // Frozen at start
            points: simplified, // Plain number[]
            bbox: simplifiedBbox,
            scene: currentScene,
            createdAt: Date.now(),
            userId,
          },
        ]);
      });
    } catch (err) {
      console.error('Failed to commit stroke:', err);
    } finally {
      // CRITICAL: Invalidate BOTH preview bounds AND simplified stroke bounds
      // The preview bounds clear the preview rendering
      // The simplified bounds ensure the new stroke area is redrawn
      if (previewBounds) {
        this.onInvalidate?.(previewBounds);
      }
      if (simplifiedBbox) {
        this.onInvalidate?.(simplifiedBbox);
      }
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
      const { center } = this.snap.anchors;
      const r = Math.hypot(finalCursor[0] - center[0], finalCursor[1] - center[1]);
      const n = Math.max(24, Math.ceil(2 * Math.PI * r / 8));
      points = [];
      for (let i = 0; i <= n; i++) {
        const angle = (i / n) * 2 * Math.PI;
        points.push(center[0] + r * Math.cos(angle), center[1] + r * Math.sin(angle));
      }

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
      // Corner-anchored AABB rectangle
      const { A } = this.snap.anchors;
      const C = finalCursor;
      const minX = Math.min(A[0], C[0]), maxX = Math.max(A[0], C[0]);
      const minY = Math.min(A[1], C[1]), maxY = Math.max(A[1], C[1]);
      // Create closed polyline
      points = [
        A[0], A[1],
        maxX, minY,
        maxX, maxY,
        minX, maxY,
        A[0], A[1]
      ];

    } else if (this.snap.kind === 'ellipseRect') {
      // Corner-anchored ellipse inscribed in AABB
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
    const bbox = calculateBBox(points, this.state.config.size);

    // Check size limits
    const estimatedSize = estimateEncodedSize(points);
    if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
      console.error('Perfect shape too large for transport');
      this.cancelDrawing();
      return;
    }

    // Commit as regular stroke
    const strokeId = ulid();
    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const strokes = root.get('strokes') as Y.Array<any>;
      const meta = root.get('meta') as Y.Map<any>;
      const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
      const currentScene = sceneTicks.length;

      strokes.push([{
        id: strokeId,
        tool: this.state.config.tool,
        color: this.state.config.color,
        size: this.state.config.size,
        opacity: this.state.config.opacity,
        points,  // Generated polyline
        bbox,    // Computed at commit
        scene: currentScene,
        createdAt: Date.now(),
        userId: this.userId
      }]);
    });

    // Invalidate and reset
    if (bbox) this.onInvalidate?.(bbox);
    this.resetState();
    this.snap = null;
    this.liveCursorWU = null;
  }

  destroy(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null; // Ensure idempotent
    }
    this.resetState();
    this.hold.cancel();
    this.snap = null;
    this.liveCursorWU = null;
  }
}
