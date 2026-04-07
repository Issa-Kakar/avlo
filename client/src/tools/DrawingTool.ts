import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { PreviewData, PointerTool } from './types';
import { useDeviceUIStore, getUserId, type Tool, type ShapeVariant } from '@/stores/device-ui-store';
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

type ForcedSnapKind = 'line' | 'circle' | 'box' | 'rect' | 'ellipseRect' | 'diamond';

function getShapeTypeFromSnapKind(snapKind: string): 'rect' | 'ellipse' | 'diamond' | 'roundedRect' {
  const mapping: Record<string, 'rect' | 'ellipse' | 'diamond' | 'roundedRect'> = {
    box: 'rect',
    circle: 'ellipse',
    rect: 'roundedRect',
    ellipseRect: 'ellipse',
    diamond: 'diamond',
    diamondHold: 'diamond',
  };
  return mapping[snapKind] ?? 'rect';
}

function getForceSnapKindFromVariant(variant: ShapeVariant): ForcedSnapKind {
  switch (variant) {
    case 'rectangle':
      return 'rect';
    case 'ellipse':
      return 'ellipseRect';
    case 'diamond':
      return 'diamond';
    default:
      return 'rect';
  }
}

function getToolTypeFromActiveTool(activeTool: Tool): 'pen' | 'highlighter' {
  if (activeTool === 'highlighter') return 'highlighter';
  return 'pen';
}

/**
 * DrawingTool - Handles pen, highlighter, and shape drawing.
 *
 * Zero-arg constructor. All store reads happen at begin() time.
 * Singleton — constructed once in tool-registry, reused across gestures.
 */
export class DrawingTool implements PointerTool {
  // Gesture state
  private drawing = false;
  private pointerId: number | null = null;
  private points: [number, number][] = [];

  // Frozen settings (captured at begin())
  private toolType: 'pen' | 'highlighter' = 'pen';
  private color = '#000';
  private size = 4;
  private opacity = 1;
  private forceSnapKind: ForcedSnapKind | null = null;

  // Perfect shapes
  private hold = new HoldDetector(() => this.onHoldFire());
  private snap:
    | null
    | (
        | { kind: 'line'; anchors: { A: [number, number] } }
        | { kind: 'circle'; anchors: { center: [number, number] } }
        | {
            kind: 'box';
            anchors: { cx: number; cy: number; angle: number; hx0: number; hy0: number };
          }
        | { kind: 'rect'; anchors: { A: [number, number] } }
        | { kind: 'ellipseRect'; anchors: { A: [number, number] } }
        | { kind: 'diamond'; anchors: { A: [number, number] } }
        | { kind: 'diamondHold'; anchors: { cx: number; cy: number; hx0: number; hy0: number } }
      ) = null;
  private liveCursorWU: [number, number] | null = null;

  // Click-to-place for shape tool
  private clickToPlaceStartTime = 0;
  private clickToPlaceStartPos: [number, number] | null = null;

  constructor() {}

  private getFillEnabled(): boolean {
    return useDeviceUIStore.getState().drawingSettings.fill;
  }

  private resetGesture(): void {
    this.drawing = false;
    this.pointerId = null;
    this.points = [];
    this.snap = null;
    this.liveCursorWU = null;
    this.forceSnapKind = null;
  }

  // PointerTool interface

  canBegin(): boolean {
    return !this.drawing;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    // Freeze all settings from store
    const uiState = useDeviceUIStore.getState();
    const activeTool = uiState.activeTool;
    this.toolType = getToolTypeFromActiveTool(activeTool);

    const settings = uiState.drawingSettings;
    this.color = settings.color;
    this.size = settings.size;
    this.opacity = this.toolType === 'highlighter' ? uiState.highlighterOpacity : (settings.opacity ?? 1);

    // Start drawing
    this.drawing = true;
    this.pointerId = pointerId;
    this.points = [[worldX, worldY]];

    // Shape mode
    if (activeTool === 'shape') {
      this.forceSnapKind = getForceSnapKindFromVariant(uiState.shapeVariant);
    } else {
      this.forceSnapKind = null;
    }

    if (this.forceSnapKind) {
      this.clickToPlaceStartTime = Date.now();
      this.clickToPlaceStartPos = [worldX, worldY];

      const k = this.forceSnapKind;
      this.snap =
        k === 'line'
          ? { kind: 'line', anchors: { A: [worldX, worldY] } }
          : k === 'circle'
            ? { kind: 'circle', anchors: { center: [worldX, worldY] } }
            : k === 'box'
              ? { kind: 'box', anchors: { cx: worldX, cy: worldY, angle: 0, hx0: 0.5, hy0: 0.5 } }
              : k === 'rect'
                ? { kind: 'rect', anchors: { A: [worldX, worldY] } }
                : k === 'ellipseRect'
                  ? { kind: 'ellipseRect', anchors: { A: [worldX, worldY] } }
                  : /* diamond */ { kind: 'diamond', anchors: { A: [worldX, worldY] } };

      this.liveCursorWU = [worldX, worldY];
      invalidateOverlay();
      return;
    }

    // Freehand flow with HoldDetector
    const [sx, sy] = worldToCanvas(worldX, worldY);
    this.hold.start({ x: sx, y: sy });
    this.snap = null;
    this.liveCursorWU = [worldX, worldY];
    invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    this.liveCursorWU = [worldX, worldY];

    if (!this.snap) {
      const [sx, sy] = worldToCanvas(worldX, worldY);
      this.hold.move({ x: sx, y: sy });
    }

    if (this.snap) {
      invalidateOverlay();
      return;
    }

    this.addPoint(worldX, worldY);
  }

  end(worldX?: number, worldY?: number): void {
    this.hold.cancel();

    if (this.snap && this.liveCursorWU) {
      const timeDelta = Date.now() - this.clickToPlaceStartTime;
      const isClick = timeDelta < 200;

      if (this.clickToPlaceStartPos && worldX !== undefined && worldY !== undefined) {
        const distMoved = Math.hypot(worldX - this.clickToPlaceStartPos[0], worldY - this.clickToPlaceStartPos[1]);
        const isStationary = distMoved < 5;

        if (isClick && isStationary && this.forceSnapKind) {
          const fixedSize = 180;

          let fixedCursor: [number, number];

          if (this.snap.kind === 'rect' || this.snap.kind === 'ellipseRect' || this.snap.kind === 'diamond') {
            fixedCursor = [this.clickToPlaceStartPos[0] + fixedSize, this.clickToPlaceStartPos[1] + fixedSize];
            this.snap.anchors.A = [this.clickToPlaceStartPos[0] - fixedSize / 2, this.clickToPlaceStartPos[1] - fixedSize / 2];
          } else {
            fixedCursor = [this.clickToPlaceStartPos[0] + fixedSize / 2, this.clickToPlaceStartPos[1] + fixedSize / 2];
          }

          this.liveCursorWU = fixedCursor;
        }
      }

      this.commitPerfectShapeFromPreview();
      return;
    }

    if (worldX !== undefined && worldY !== undefined) {
      this.commitStroke(worldX, worldY);
    } else {
      const len = this.points.length;
      if (len >= 1) {
        const lastPoint = this.points[len - 1];
        this.commitStroke(lastPoint[0], lastPoint[1]);
      } else {
        this.cancelDrawing();
      }
    }
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
    if (!this.drawing) return null;

    if (this.snap && this.liveCursorWU) {
      return {
        kind: 'perfectShape',
        shape: this.snap.kind,
        color: this.color,
        size: this.size,
        opacity: this.opacity,
        fill: this.getFillEnabled(),
        anchors: { kind: this.snap.kind, ...this.snap.anchors } as any,
        cursor: this.liveCursorWU,
        bbox: null,
      };
    }

    if (this.points.length < 1) return null;
    return {
      kind: 'stroke',
      points: this.points,
      tool: this.toolType,
      color: this.color,
      size: this.size,
      opacity: this.opacity,
      bbox: null,
    };
  }

  onPointerLeave(): void {}

  onViewChange(): void {}

  destroy(): void {
    this.resetGesture();
    this.hold.cancel();
  }

  // --- Private ---

  private addPoint(worldX: number, worldY: number): void {
    if (!this.drawing) return;

    const pts = this.points;
    const L = pts.length;
    if (L >= 1) {
      const last = pts[L - 1];
      const scale = useCameraStore.getState().scale;
      const dx = (worldX - last[0]) * scale;
      const dy = (worldY - last[1]) * scale;
      if (dx * dx + dy * dy < 1.0) return;
    }

    this.points.push([worldX, worldY]);
    invalidateOverlay();
  }

  /* eslint-disable no-console */
  private onHoldFire(): void {
    if (this.snap) return;

    const len = this.points.length;
    if (len < 1) return;
    const pointerNowWU: [number, number] = this.points[len - 1];
    this.liveCursorWU = pointerNowWU;

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

    const bbox = computeBboxCenterExtents(this.points);

    switch (result.best.kind) {
      case 'line':
        this.snap = {
          kind: 'line',
          anchors: { A: this.points[0] },
        };
        break;
      case 'circle':
        this.snap = {
          kind: 'circle',
          anchors: { center: [bbox.cx, bbox.cy] },
        };
        break;
      case 'box':
        this.snap = {
          kind: 'box',
          anchors: {
            cx: bbox.cx,
            cy: bbox.cy,
            angle: 0,
            hx0: bbox.hx,
            hy0: bbox.hy,
          },
        };
        break;
      case 'diamond':
        this.snap = {
          kind: 'diamondHold',
          anchors: {
            cx: bbox.cx,
            cy: bbox.cy,
            hx0: bbox.hx,
            hy0: bbox.hy,
          },
        };
        break;
    }

    console.log(`SNAP: ${result.best.kind.toUpperCase()}`);
    console.groupEnd();
    invalidateOverlay();
    this.hold.cancel();
  }
  /* eslint-enable no-console */

  private cancelDrawing(): void {
    invalidateOverlay();
    this.resetGesture();
  }

  private commitStroke(finalX: number, finalY: number): void {
    if (!this.drawing) return;

    const len = this.points.length;
    const needsFinal = len < 1 || this.points[len - 1][0] !== finalX || this.points[len - 1][1] !== finalY;
    if (needsFinal) {
      this.points.push([finalX, finalY]);
    }

    const userId = getUserId();
    const strokeId = ulid();

    try {
      transact(() => {
        const strokeMap = new Y.Map();
        strokeMap.set('id', strokeId);
        strokeMap.set('kind', 'stroke');
        strokeMap.set('tool', this.toolType);
        strokeMap.set('color', this.color);
        strokeMap.set('width', this.size);
        strokeMap.set('opacity', this.opacity);
        strokeMap.set('points', this.points);
        strokeMap.set('ownerId', userId);
        strokeMap.set('createdAt', Date.now());

        getObjects().set(strokeId, strokeMap);
      });
    } catch (err) {
      console.error('Failed to commit stroke:', err);
    } finally {
      invalidateOverlay();
      this.resetGesture();
    }
  }

  private commitPerfectShapeFromPreview(): void {
    if (!this.snap || !this.liveCursorWU) return;

    const finalCursor = this.liveCursorWU!;
    let frame: [number, number, number, number];
    const shapeType = getShapeTypeFromSnapKind(this.snap.kind);

    const userId = getUserId();

    if (this.snap.kind === 'line') {
      const { A } = this.snap.anchors;
      const strokeId = ulid();
      transact(() => {
        const strokeMap = new Y.Map();
        strokeMap.set('id', strokeId);
        strokeMap.set('kind', 'stroke');
        strokeMap.set('tool', this.toolType);
        strokeMap.set('color', this.color);
        strokeMap.set('width', this.size);
        strokeMap.set('opacity', this.opacity);
        strokeMap.set('points', [A, finalCursor]);
        strokeMap.set('ownerId', userId);
        strokeMap.set('createdAt', Date.now());
        getObjects().set(strokeId, strokeMap);
      });
      invalidateOverlay();
      this.resetGesture();
      return;
    } else if (this.snap.kind === 'circle') {
      const { center } = this.snap.anchors;
      const r = Math.hypot(finalCursor[0] - center[0], finalCursor[1] - center[1]);
      frame = [center[0] - r, center[1] - r, r * 2, r * 2];
    } else if (this.snap.kind === 'box') {
      const { cx, cy, angle, hx0, hy0 } = this.snap.anchors;
      const dx = finalCursor[0] - cx;
      const dy = finalCursor[1] - cy;
      const cos = Math.cos(angle),
        sin = Math.sin(angle);
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      const sx = Math.max(0.0001, Math.abs(localX) / Math.max(1e-6, hx0));
      const sy = Math.max(0.0001, Math.abs(localY) / Math.max(1e-6, hy0));
      const hx = hx0 * sx;
      const hy = hy0 * sy;
      frame = [cx - hx, cy - hy, hx * 2, hy * 2];
    } else if (this.snap.kind === 'rect' || this.snap.kind === 'ellipseRect' || this.snap.kind === 'diamond') {
      const { A } = this.snap.anchors;
      const C = finalCursor;
      const minX = Math.min(A[0], C[0]);
      const minY = Math.min(A[1], C[1]);
      const maxX = Math.max(A[0], C[0]);
      const maxY = Math.max(A[1], C[1]);
      frame = [minX, minY, maxX - minX, maxY - minY];
    } else if (this.snap.kind === 'diamondHold') {
      const { cx, cy, hx0, hy0 } = this.snap.anchors;
      const dx = Math.abs(finalCursor[0] - cx);
      const dy = Math.abs(finalCursor[1] - cy);
      const sx = Math.max(0.0001, dx / Math.max(1e-6, hx0));
      const sy = Math.max(0.0001, dy / Math.max(1e-6, hy0));
      const hx = hx0 * sx;
      const hy = hy0 * sy;
      frame = [cx - hx, cy - hy, hx * 2, hy * 2];
    } else {
      const _exhaustive: never = this.snap;
      console.error('Unknown snap kind:', _exhaustive);
      this.cancelDrawing();
      return;
    }

    const shapeId = ulid();
    transact(() => {
      const shapeMap = new Y.Map();
      shapeMap.set('id', shapeId);
      shapeMap.set('kind', 'shape');
      shapeMap.set('shapeType', shapeType);
      shapeMap.set('color', this.color);
      shapeMap.set('width', this.size);

      if (this.getFillEnabled()) {
        const fillColor = createFillFromStroke(this.color);
        shapeMap.set('fillColor', fillColor);
      }

      shapeMap.set('opacity', this.opacity);
      shapeMap.set('frame', frame);
      shapeMap.set('ownerId', userId);
      shapeMap.set('createdAt', Date.now());

      getObjects().set(shapeId, shapeMap);
    });

    invalidateOverlay();
    this.resetGesture();
  }
}
