import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { PreviewData, PointerTool, ShapeType } from './types';
import { useDeviceUIStore, getUserId, type ShapeVariant } from '@/stores/device-ui-store';
import { worldToCanvas, useCameraStore } from '@/stores/camera-store';
import { HoldDetector } from '@/core/geometry/shape-recognition/HoldDetector';
import {
  recognizePerfectShapePointCloud,
  debugRecognize,
  computeBboxCenterExtents,
} from '@/core/geometry/shape-recognition/pdollar-recognizer';
import { createFillFromStroke } from '@/utils/color';
import { transact, getObjects } from '@/runtime/room-runtime';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { cornerFrame, frameToBbox, bboxToFrame, scaleBBoxAround } from '@/core/geometry/bounds';
import type { Point, FrameTuple } from '@/core/types/geometry';

/** Toolbar shape variant → stored shapeType. */
const SHAPE_VARIANT_TO_TYPE: Record<ShapeVariant, Exclude<ShapeType, 'line'>> = {
  rectangle: 'roundedRect',
  ellipse: 'ellipse',
  diamond: 'diamond',
};

/** Click-to-place (single-click with shape tool) produces a 180wu fixed shape. */
const CLICK_TO_PLACE_SIZE = 180;
const CLICK_TO_PLACE_MAX_MS = 200;
const CLICK_TO_PLACE_MAX_DIST = 5;

/** Minimum refDist below which snap-scale freezes at s=1 (WYSIWYG locked). */
const SNAP_MIN_REF_DIST = 0.5;

type DrawingMode = 'stroke' | 'shape' | 'line';

/**
 * DrawingTool — pen, highlighter, and shape drawing.
 *
 * Zero-arg singleton. All store reads happen at begin() time and are frozen
 * for the duration of the gesture.
 *
 * Three modes:
 *   - `'stroke'` — freehand pen/highlighter. Growing point list. May transition
 *                  to `'shape'` or `'line'` when HoldDetector + $P recognizer fire.
 *   - `'shape'`  — rect/ellipse/diamond/roundedRect. Two sub-paths:
 *                  * corner-drag (from toolbar): `anchor`=pointerdown, `cursor`=live;
 *                    frame = `cornerFrame(anchor, cursor)`.
 *                  * hold-snap (from recognizer): `snapOriginFrame` = stroke bbox at
 *                    snap time, `snapOrigin` = frame center, `snapRefDist` =
 *                    `hypot(lastPoint − origin)`. Frame = uniform scale of the origin
 *                    frame around the origin by `|cursor − origin| / refDist` — WYSIWYG
 *                    at snap time, grows/shrinks as cursor moves outward/inward.
 *   - `'line'`   — hold-recognized straight line. `anchor` pinned to the first stroke
 *                  point, `cursor` tracks live. Previewed via direct `ctx.moveTo/lineTo`,
 *                  committed as a 2-point stroke (no `line` kind in Y.Doc).
 */
export class DrawingTool implements PointerTool {
  // Gesture state
  private drawing = false;
  private pointerId: number | null = null;
  private mode: DrawingMode | null = null;
  private anchor: Point | null = null;
  private cursor: Point | null = null;
  private points: Point[] = [];

  // Shape-mode metadata
  private shapeType: ShapeType | null = null;

  // Hold-snap scale state. Non-null iff we're in scale-from-origin shape mode.
  private snapOriginFrame: FrameTuple | null = null;
  private snapOrigin: Point | null = null;
  private snapRefDist = 0;

  // Frozen settings (captured at begin())
  private toolType: 'pen' | 'highlighter' = 'pen';
  private color = '#000';
  private size = 4;
  private opacity = 1;
  private fill = false;

  // Hold + click-to-place
  private hold = new HoldDetector(() => this.onHoldFire());
  private gestureStartTime = 0;

  // PointerTool interface ---------------------------------------------------

  canBegin(): boolean {
    return !this.drawing;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    const ui = useDeviceUIStore.getState();
    const settings = ui.drawingSettings;
    const activeTool = ui.activeTool;

    this.toolType = activeTool === 'highlighter' ? 'highlighter' : 'pen';
    this.color = settings.color;
    this.size = settings.size;
    this.opacity = this.toolType === 'highlighter' ? ui.highlighterOpacity : (settings.opacity ?? 1);
    this.fill = settings.fill;

    this.drawing = true;
    this.pointerId = pointerId;
    this.gestureStartTime = Date.now();

    const p: Point = [worldX, worldY];
    this.anchor = p;
    this.cursor = p;

    if (activeTool === 'shape') {
      this.mode = 'shape';
      this.shapeType = SHAPE_VARIANT_TO_TYPE[ui.shapeVariant];
      this.points = [];
    } else {
      this.mode = 'stroke';
      this.shapeType = null;
      this.points = [p];
      const [sx, sy] = worldToCanvas(worldX, worldY);
      this.hold.start({ x: sx, y: sy });
    }

    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    if (!this.drawing) return;
    const c: Point = [worldX, worldY];
    this.cursor = c;

    if (this.mode === 'stroke') {
      const [sx, sy] = worldToCanvas(worldX, worldY);
      this.hold.move({ x: sx, y: sy });
      this.addPoint(c);
      return;
    }

    invalidateOverlay();
  }

  end(worldX?: number, worldY?: number): void {
    this.hold.cancel();
    if (!this.drawing || !this.anchor || !this.cursor) {
      this.cancelDrawing();
      return;
    }

    if (worldX !== undefined && worldY !== undefined) {
      this.cursor = [worldX, worldY];
    }

    if (this.mode === 'stroke') {
      const len = this.points.length;
      const last = len >= 1 ? this.points[len - 1] : null;
      if (!last || last[0] !== this.cursor[0] || last[1] !== this.cursor[1]) {
        this.points.push(this.cursor);
      }
      this.commitStroke(this.points);
      return;
    }

    if (this.mode === 'line') {
      this.commitStroke([this.anchor, this.cursor]);
      return;
    }

    if (this.mode === 'shape') {
      if (!this.snapOriginFrame) this.maybeClickToPlace();
      this.commitShape();
      return;
    }

    this.cancelDrawing();
  }

  cancel(): void {
    this.hold.cancel();
    this.cancelDrawing();
  }

  isActive(): boolean {
    return this.drawing;
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    if (!this.drawing || !this.cursor) return null;

    if (this.mode === 'line' && this.anchor) {
      return {
        kind: 'shape',
        shapeType: 'line',
        a: this.anchor,
        b: this.cursor,
        color: this.color,
        width: this.size,
        opacity: this.opacity,
      };
    }

    if (this.mode === 'shape' && this.shapeType && this.shapeType !== 'line') {
      const frame = this.computeShapeFrame();
      if (!frame || frame[2] < 1 || frame[3] < 1) return null;
      return {
        kind: 'shape',
        shapeType: this.shapeType,
        frame,
        color: this.color,
        width: this.size,
        opacity: this.opacity,
        fill: this.fill,
      };
    }

    if (this.mode === 'stroke' && this.points.length >= 1) {
      return {
        kind: 'stroke',
        tool: this.toolType,
        points: this.points,
        color: this.color,
        size: this.size,
        opacity: this.opacity,
      };
    }

    return null;
  }

  onPointerLeave(): void {}

  onViewChange(): void {}

  destroy(): void {
    this.hold.cancel();
    this.resetGesture();
  }

  // Private -----------------------------------------------------------------

  private resetGesture(): void {
    this.drawing = false;
    this.pointerId = null;
    this.mode = null;
    this.anchor = null;
    this.cursor = null;
    this.points = [];
    this.shapeType = null;
    this.snapOriginFrame = null;
    this.snapOrigin = null;
    this.snapRefDist = 0;
  }

  private cancelDrawing(): void {
    invalidateOverlay();
    this.resetGesture();
  }

  private addPoint(p: Point): void {
    const pts = this.points;
    const L = pts.length;
    if (L >= 1) {
      const last = pts[L - 1];
      const scale = useCameraStore.getState().scale;
      const dx = (p[0] - last[0]) * scale;
      const dy = (p[1] - last[1]) * scale;
      if (dx * dx + dy * dy < 1.0) return;
    }
    pts.push(p);
    invalidateOverlay();
  }

  private maybeClickToPlace(): void {
    if (!this.anchor || !this.cursor) return;
    const dt = Date.now() - this.gestureStartTime;
    if (dt >= CLICK_TO_PLACE_MAX_MS) return;
    const dist = Math.hypot(this.cursor[0] - this.anchor[0], this.cursor[1] - this.anchor[1]);
    if (dist >= CLICK_TO_PLACE_MAX_DIST) return;

    const half = CLICK_TO_PLACE_SIZE / 2;
    const click = this.anchor;
    this.anchor = [click[0] - half, click[1] - half];
    this.cursor = [click[0] + half, click[1] + half];
  }

  /**
   * Frame for the current shape gesture:
   *   - hold-snap: scale `snapOriginFrame` around `snapOrigin` by
   *     `|cursor − origin| / snapRefDist` (uniform hypot ratio). At snap time the
   *     ratio is exactly 1 so the preview matches the stroke bbox verbatim
   *     (WYSIWYG). Inward motion shrinks, outward grows — like a uniform
   *     scale-transform around frame center.
   *   - corner-drag: `cornerFrame(anchor, cursor)` — toolbar shape path.
   */
  private computeShapeFrame(): FrameTuple | null {
    if (this.snapOriginFrame && this.snapOrigin) {
      if (!this.cursor) return this.snapOriginFrame;
      const dx = this.cursor[0] - this.snapOrigin[0];
      const dy = this.cursor[1] - this.snapOrigin[1];
      const curDist = Math.hypot(dx, dy);
      const s = this.snapRefDist > SNAP_MIN_REF_DIST ? curDist / this.snapRefDist : 1;
      const scaled = scaleBBoxAround(frameToBbox(this.snapOriginFrame), this.snapOrigin, s, s);
      return bboxToFrame(scaled);
    }
    if (!this.anchor || !this.cursor) return null;
    return cornerFrame(this.anchor, this.cursor);
  }

  /* eslint-disable no-console */
  private onHoldFire(): void {
    if (this.mode !== 'stroke') return;
    if (this.points.length < 1) return;

    console.group('Hold Detector Fired - $P Shape Recognition');
    console.log(`Stroke has ${this.points.length} points after 600ms dwell`);

    const result = recognizePerfectShapePointCloud(this.points);
    debugRecognize(this.points);

    if (!result) {
      console.log('Not enough points for recognition');
      console.groupEnd();
      return;
    }

    console.log(`Best: ${result.best.kind} (${result.best.templateId})`);
    console.log(`Distance: ${result.best.distance.toFixed(3)}, Margin: ${(result.margin * 100).toFixed(1)}%`);

    if (result.ambiguous) {
      console.log('Ambiguous - NO SNAP, continuing freehand');
      console.groupEnd();
      return;
    }

    const bb = computeBboxCenterExtents(this.points);
    const originFrame: FrameTuple = [bb.cx - bb.hx, bb.cy - bb.hy, bb.hx * 2, bb.hy * 2];
    const origin: Point = [bb.cx, bb.cy];
    const lastPt = this.points[this.points.length - 1];
    const refDist = Math.hypot(lastPt[0] - origin[0], lastPt[1] - origin[1]);

    switch (result.best.kind) {
      case 'line':
        this.mode = 'line';
        this.shapeType = 'line';
        this.anchor = this.points[0];
        this.points = [];
        break;
      case 'circle':
        this.enterSnapShape('ellipse', originFrame, origin, refDist);
        break;
      case 'box':
        this.enterSnapShape('rect', originFrame, origin, refDist);
        break;
      case 'diamond':
        this.enterSnapShape('diamond', originFrame, origin, refDist);
        break;
    }

    console.log(`SNAP: ${result.best.kind.toUpperCase()}`);
    console.groupEnd();
    this.hold.cancel();
    invalidateOverlay();
  }
  /* eslint-enable no-console */

  private enterSnapShape(shapeType: Exclude<ShapeType, 'line'>, originFrame: FrameTuple, origin: Point, refDist: number): void {
    this.mode = 'shape';
    this.shapeType = shapeType;
    this.snapOriginFrame = originFrame;
    this.snapOrigin = origin;
    this.snapRefDist = refDist;
    this.points = [];
  }

  private commitStroke(points: Point[]): void {
    const strokeId = ulid();
    const userId = getUserId();
    try {
      transact(() => {
        const m = new Y.Map();
        m.set('id', strokeId);
        m.set('kind', 'stroke');
        m.set('tool', this.toolType);
        m.set('color', this.color);
        m.set('width', this.size);
        m.set('opacity', this.opacity);
        m.set('points', points);
        m.set('ownerId', userId);
        m.set('createdAt', Date.now());
        getObjects().set(strokeId, m);
      });
    } catch (err) {
      console.error('Failed to commit stroke:', err);
    } finally {
      invalidateOverlay();
      this.resetGesture();
    }
  }

  private commitShape(): void {
    if (!this.shapeType || this.shapeType === 'line') {
      this.cancelDrawing();
      return;
    }

    const frame = this.computeShapeFrame();
    if (!frame || frame[2] < 1 || frame[3] < 1) {
      this.cancelDrawing();
      return;
    }

    const shapeId = ulid();
    const userId = getUserId();
    const shapeType = this.shapeType;
    try {
      transact(() => {
        const m = new Y.Map();
        m.set('id', shapeId);
        m.set('kind', 'shape');
        m.set('shapeType', shapeType);
        m.set('color', this.color);
        m.set('width', this.size);
        if (this.fill) m.set('fillColor', createFillFromStroke(this.color));
        m.set('opacity', this.opacity);
        m.set('frame', frame);
        m.set('ownerId', userId);
        m.set('createdAt', Date.now());
        getObjects().set(shapeId, m);
      });
    } catch (err) {
      console.error('Failed to commit shape:', err);
    } finally {
      invalidateOverlay();
      this.resetGesture();
    }
  }
}
