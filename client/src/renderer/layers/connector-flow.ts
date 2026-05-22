/**
 * Connector-flow overlay rendering.
 *
 * Draws the four N/S/E/W flow buttons around a single bindable selection, the
 * low-opacity hover preview (elbow route + optional ghost duplicate), and the
 * full-opacity live connector during a flow drag. Reuses the shared connector
 * draw atoms + `paintShapeFrame` — no connector drawing is reimplemented here.
 *
 * `drawConnectorFlow` self-gates: it reads the controller render snapshot off
 * `SelectTool` and the visibility gate off `connector-flow.ts`, so the caller
 * (`selection-overlay.ts`) just delegates unconditionally.
 *
 * The hover preview composites through an offscreen layer (`paintFadedLayer`).
 * A connector arrowhead is drawn fill-then-stroke (the stroke gives the rounded
 * corners), and the polyline butts against it — so dimming the whole thing with
 * a fractional `globalAlpha` double-composites every overlap (arrowhead
 * fill∩stroke, polyline∩arrowhead, route∩ghost) into visible darker seams.
 * Flattening to opaque pixels first and fading the whole layer once has none.
 * This is exactly what the canvas `ctx.beginLayer()` API does — not yet
 * shippable cross-browser (2026), so it is hand-rolled here.
 *
 * @module renderer/layers/connector-flow
 */

import { getHandleShapeType, getNoteProps, getShapeProps } from '@/core/accessors';
import { computeConnectorBBoxFromPointsInto } from '@/core/geometry/bbox';
import { expandBBox } from '@/core/geometry/bounds';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { ObjectHandle } from '@/core/types/objects';
import { selectTool } from '@/runtime/tool-registry';
import { useCameraStore } from '@/stores/camera-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import {
  FLOW_BTN_HOVER_RADIUS_PX,
  FLOW_DOT_RADIUS_PX,
  FLOW_PREVIEW_OPACITY,
  FLOW_SIDES,
  type FlowPreview,
  type FlowSide,
  flowButtonCenters,
  flowButtonGate,
} from '@/tools/selection/connector-flow';
import { drawSnapFeedback, paintConnectorFromPoints } from './connector-render-atoms';
import { paintShapeFrame } from './shape-preview';

// Blue matches SELECTION_STYLE.PRIMARY in selection-overlay.ts.
const FLOW_BLUE = 'rgba(29, 78, 216, 1)';
const FLOW_WHITE = '#ffffff';

/** Outward unit vector per side — arrow direction + ghost-side hint. */
const OUTWARD: Record<FlowSide, Point> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

// --- Appearance constants (screen px; divided by camera scale at use) ---

/** White halo width beyond the rest blue dot. */
const FLOW_DOT_RING_PX = 1.5;
/** White ring width beyond the hovered blue circle. */
const FLOW_HOVER_RING_PX = 2;
/** Hover arrow glyph: center → tip (and → tail) along the outward axis. */
const FLOW_ARROW_REACH_PX = 6;
/** Hover arrow glyph: arrowhead depth back from the tip. */
const FLOW_ARROW_HEAD_PX = 4.5;
/** Hover arrow glyph: arrowhead half-width across the axis. */
const FLOW_ARROW_HEAD_HALF_PX = 3;
/** Hover arrow glyph: stroke width. */
const FLOW_ARROW_LINE_PX = 2;

type ButtonMode = 'rest' | 'arrow' | 'drag';

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Draw the connector-flow overlay. Called from `drawSelectionOverlay` after the
 * marquee, before the empty-selection early return (so the drag preview renders
 * once the selection is cleared mid-drag).
 */
export function drawConnectorFlow(ctx: CanvasRenderingContext2D): void {
  const render = selectTool.getConnectorFlowRender();
  const scale = useCameraStore.getState().scale;

  // Live drag — full-opacity connector following the cursor + snap feedback.
  if (render.phase === 'drag') {
    paintConnectorFromPoints(ctx, render.route, render.routeCount, render.width, 'none', 'arrow', render.color);
    drawSnapFeedback(ctx, render.toSnap);
    return;
  }

  // Idle — buttons + hover preview. Self-gate on the shared visibility gate.
  const gate = flowButtonGate();
  if (!gate) return;

  if (render.preview) {
    const st = useDeviceUIStore.getState();
    drawFlowPreview(ctx, gate.handle, render.preview, st.drawingSettings.color, st.connectorSize);
  }
  drawFlowButtons(ctx, gate.bbox, getHandleShapeType(gate.handle), render.preview, scale);
}

// =============================================================================
// HOVER PREVIEW
// =============================================================================

// Scratch — world bbox the preview layer is sized to. Written + read synchronously.
const _previewBbox: BBoxTuple = [0, 0, 0, 0];

function drawFlowPreview(ctx: CanvasRenderingContext2D, source: ObjectHandle, preview: FlowPreview, color: string, width: number): void {
  if (preview.kind === 'dragOnly') return;

  // Ghost-duplicate props — read once, reused for both layer sizing and the draw.
  const dupFrame = preview.kind === 'duplicate' ? preview.dupFrame : null;
  const sp = dupFrame && source.kind === 'shape' ? getShapeProps(source.y) : null;
  const np = dupFrame && source.kind === 'note' ? getNoteProps(source.y) : null;

  // Layer bbox = connector route, unioned with the ghost frame (+ its stroke).
  computeConnectorBBoxFromPointsInto(preview.route, preview.routeCount, width, 'none', 'arrow', _previewBbox);
  if (dupFrame) {
    const gp = sp ? sp.width / 2 : 0;
    expandBBox(_previewBbox, dupFrame[0] - gp, dupFrame[1] - gp, dupFrame[0] + dupFrame[2] + gp, dupFrame[1] + dupFrame[3] + gp);
  }

  // Flatten the ghost + route to opaque pixels, then fade the whole layer once
  // — drawing them directly at FLOW_PREVIEW_OPACITY double-composites overlaps.
  paintFadedLayer(ctx, FLOW_PREVIEW_OPACITY, _previewBbox, (layer) => {
    if (dupFrame) {
      if (sp) paintShapeFrame(layer, sp.shapeType, dupFrame, sp.fillColor ?? null, sp.color, sp.width, 1);
      else if (np) paintShapeFrame(layer, 'roundedRect', dupFrame, np.fillColor, null, 0, 1);
    }
    paintConnectorFromPoints(layer, preview.route, preview.routeCount, width, 'none', 'arrow', color);
  });
}

// =============================================================================
// BUTTONS
// =============================================================================

function drawFlowButtons(
  ctx: CanvasRenderingContext2D,
  bbox: Readonly<BBoxTuple>,
  shapeType: string,
  preview: FlowPreview | null,
  scale: number,
): void {
  const centers = flowButtonCenters(bbox, shapeType, scale);
  const hoveredSide = preview ? preview.side : null;
  // Candidate / duplicate → directional arrow; dragOnly → plain enlarged circle.
  const hoverMode: ButtonMode = preview && preview.kind === 'dragOnly' ? 'drag' : 'arrow';

  for (let i = 0; i < 4; i++) {
    const side = FLOW_SIDES[i];
    const center = centers[i];
    const mode: ButtonMode = side === hoveredSide ? hoverMode : 'rest';
    drawFlowButton(ctx, center[0], center[1], OUTWARD[side], mode, scale);
  }
}

function drawFlowButton(ctx: CanvasRenderingContext2D, cx: number, cy: number, outward: Point, mode: ButtonMode, scale: number): void {
  ctx.save();
  if (mode === 'rest') {
    const dotR = FLOW_DOT_RADIUS_PX / scale;
    fillCircle(ctx, cx, cy, dotR + FLOW_DOT_RING_PX / scale, FLOW_WHITE);
    fillCircle(ctx, cx, cy, dotR, FLOW_BLUE);
  } else {
    const hoverR = FLOW_BTN_HOVER_RADIUS_PX / scale;
    fillCircle(ctx, cx, cy, hoverR + FLOW_HOVER_RING_PX / scale, FLOW_WHITE); // white ring
    fillCircle(ctx, cx, cy, hoverR, FLOW_BLUE);
    if (mode === 'arrow') drawArrow(ctx, cx, cy, outward, scale);
  }
  ctx.restore();
}

/**
 * White outward-pointing arrow — a shaft plus a two-winged head, like a standard
 * line arrow — centered in the hovered button. One path, one stroke: the shaft
 * is its own subpath, the head is `wing → tip → wing`; both meet at the tip.
 */
function drawArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, outward: Point, scale: number): void {
  const reach = FLOW_ARROW_REACH_PX / scale;
  const head = FLOW_ARROW_HEAD_PX / scale;
  const half = FLOW_ARROW_HEAD_HALF_PX / scale;
  const ox = outward[0];
  const oy = outward[1];
  const px = -oy; // perpendicular
  const py = ox;

  const tipX = cx + ox * reach;
  const tipY = cy + oy * reach;
  // Wing roots — `head` back from the tip along the outward axis.
  const backX = tipX - ox * head;
  const backY = tipY - oy * head;

  ctx.beginPath();
  ctx.moveTo(cx - ox * reach, cy - oy * reach); // shaft: tail → tip
  ctx.lineTo(tipX, tipY);
  ctx.moveTo(backX + px * half, backY + py * half); // head: wing → tip → wing
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(backX - px * half, backY - py * half);
  ctx.strokeStyle = FLOW_WHITE;
  ctx.lineWidth = FLOW_ARROW_LINE_PX / scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function fillCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// =============================================================================
// FADED LAYER — offscreen flatten-then-fade
// =============================================================================

// Module offscreen canvas — sized per call to the (clamped) preview bbox, so it
// holds at most one visible-canvas worth of pixels and shrinks back afterward.
let _layerCanvas: HTMLCanvasElement | null = null;

/** The module offscreen context, resized to `w×h` device px and returned cleared. */
function acquireLayer(w: number, h: number): CanvasRenderingContext2D | null {
  if (!_layerCanvas) _layerCanvas = document.createElement('canvas');
  const canvas = _layerCanvas;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/**
 * Run `draw` into an offscreen layer at full opacity, then composite the whole
 * layer onto `ctx` once at `alpha`. Overlaps inside `draw` flatten opaque before
 * the single fade, so no double-composited seam survives.
 *
 * The layer is sized to `worldBbox` clamped to the visible canvas. The camera
 * transform is pan/zoom only (axis-aligned), so `m.a/m.d/m.e/m.f` suffice and
 * the destination blit is a pixel-exact 1:1 device copy.
 */
function paintFadedLayer(
  ctx: CanvasRenderingContext2D,
  alpha: number,
  worldBbox: Readonly<BBoxTuple>,
  draw: (layer: CanvasRenderingContext2D) => void,
): void {
  const m = ctx.getTransform();
  const x0 = Math.max(0, Math.floor(m.a * worldBbox[0] + m.e));
  const y0 = Math.max(0, Math.floor(m.d * worldBbox[1] + m.f));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(m.a * worldBbox[2] + m.e));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(m.d * worldBbox[3] + m.f));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 1 || h < 1) return; // fully off-screen or degenerate

  const layer = acquireLayer(w, h);
  if (!layer) return;

  // Mirror the destination's world transform, shifted so the bbox lands at the
  // layer origin — `draw` keeps emitting world coordinates.
  layer.setTransform(m.a, 0, 0, m.d, m.e - x0, m.f - y0);
  draw(layer);

  // Blit the flattened layer 1:1 in device pixels at the target opacity.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  ctx.drawImage(layer.canvas, x0, y0);
  ctx.restore();
}
