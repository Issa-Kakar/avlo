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
 * @module renderer/layers/connector-flow
 */

import { getNoteProps, getShapeProps } from '@/core/accessors';
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

/** Outward unit vector per side — chevron direction + ghost-side hint. */
const OUTWARD: Record<FlowSide, Point> = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };

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
  drawFlowButtons(ctx, gate.bbox, render.preview, scale);
}

// =============================================================================
// HOVER PREVIEW
// =============================================================================

function drawFlowPreview(ctx: CanvasRenderingContext2D, source: ObjectHandle, preview: FlowPreview, color: string, width: number): void {
  if (preview.kind === 'dragOnly') return;

  // Ghost duplicate UNDER the route — keeps the connector arrowhead visible.
  // paintShapeFrame sets its own globalAlpha, so pass the preview alpha in.
  if (preview.kind === 'duplicate') {
    if (source.kind === 'shape') {
      const sp = getShapeProps(source.y);
      if (sp) {
        paintShapeFrame(ctx, sp.shapeType, preview.dupFrame, sp.fillColor ?? null, sp.color, sp.width, FLOW_PREVIEW_OPACITY);
      }
    } else if (source.kind === 'note') {
      const np = getNoteProps(source.y);
      if (np) {
        paintShapeFrame(ctx, 'roundedRect', preview.dupFrame, np.fillColor, null, 0, FLOW_PREVIEW_OPACITY);
      }
    }
  }

  // Elbow route on top (paintConnectorFromPoints respects ambient alpha).
  ctx.save();
  ctx.globalAlpha = FLOW_PREVIEW_OPACITY;
  paintConnectorFromPoints(ctx, preview.route, preview.routeCount, width, 'none', 'arrow', color);
  ctx.restore();
}

// =============================================================================
// BUTTONS
// =============================================================================

function drawFlowButtons(ctx: CanvasRenderingContext2D, bbox: Readonly<BBoxTuple>, preview: FlowPreview | null, scale: number): void {
  const centers = flowButtonCenters(bbox, scale);
  const hoveredSide = preview ? preview.side : null;
  // Candidate / duplicate → directional chevron; dragOnly → enlarged dot, no arrow.
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
    fillCircle(ctx, cx, cy, dotR + 2.5 / scale, FLOW_WHITE);
    fillCircle(ctx, cx, cy, dotR, FLOW_BLUE);
  } else {
    const hoverR = FLOW_BTN_HOVER_RADIUS_PX / scale;
    fillCircle(ctx, cx, cy, hoverR + 2 / scale, FLOW_WHITE); // white ring
    fillCircle(ctx, cx, cy, hoverR, FLOW_BLUE);
    if (mode === 'arrow') drawChevron(ctx, cx, cy, outward, scale);
  }
  ctx.restore();
}

/** White directional chevron pointing outward, centered in the button. */
function drawChevron(ctx: CanvasRenderingContext2D, cx: number, cy: number, outward: Point, scale: number): void {
  const d = 3 / scale; // tip / tail distance from center along the outward axis
  const w = 4 / scale; // half-width of the V across the perpendicular
  const ox = outward[0];
  const oy = outward[1];
  const px = -oy; // perpendicular
  const py = ox;
  ctx.beginPath();
  ctx.moveTo(cx - ox * d + px * w, cy - oy * d + py * w);
  ctx.lineTo(cx + ox * d, cy + oy * d);
  ctx.lineTo(cx - ox * d - px * w, cy - oy * d - py * w);
  ctx.strokeStyle = FLOW_WHITE;
  ctx.lineWidth = 2 / scale;
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
