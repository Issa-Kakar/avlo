/**
 * Connector Flows — inline connector affordances for the Select tool.
 *
 * When exactly one *bindable* object is selected, four buttons appear at the
 * N/S/E/W midpoints of its selection box:
 *  - **Drag** from a button → live connector creation (mirrors `ConnectorTool`).
 *  - **Click** a button → commit a precomputed hover preview: connect to a
 *    well-aligned nearby object, or spawn a wired-up duplicate shape/note.
 *
 * This controller owns hover state, drag state, and the single pooled route
 * buffer. It NEVER touches `selection-store.transform` — `transform.kind` stays
 * `'none'` for the whole feature, so every transform reader is untouched. The
 * committed duplicate + connector flow through the normal observer pipeline;
 * only the *previews* are overlay-only.
 *
 * Candidate placement is semantics-aware. When a well-aligned target exists but
 * an existing connector already wires the source's hovered midpoint to it,
 * clicking would only stack a second identical connector — so the preview
 * instead becomes a fresh sibling node, placed in clear space beside that
 * target (probed against the spatial index). The plain straight duplicate (no
 * candidate) never offsets — the absence of a candidate already means nothing
 * well-aligned sits in that sight-line.
 *
 * Every preview routes through `routeNewConnectorInto` — the candidate to its
 * snap target, a duplicate/sibling to a `VirtualAnchor` of the uncreated ghost
 * shape — so the hovered elbow path is byte-identical to the canonical route the
 * deep observer commits once the connector (and any duplicate) lands in the doc.
 *
 * Pure geometry helpers (`flowButtonCenters` / `hitFlowButton` / `flowButtonGate`)
 * are shared by `SelectTool` (hit) and `renderer/layers/connector-flow.ts` (draw).
 *
 * @module tools/selection/connector-flow
 */

import { generateNZAtTop, type ZKey } from '@avlo/shared';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import { getEnd, getHandleShapeType, getNoteProps, getShapeProps, getStart } from '@/core/accessors';
import { anchorRecordFromSnap } from '@/core/connectors/anchor-atoms';
import { createConnector, insertConnector } from '@/core/connectors/connector-actions';
import { routeNewConnectorInto, type VirtualAnchor } from '@/core/connectors/reroute-connector';
import { midpointAnchorFor } from '@/core/connectors/shape-geometry';
import { findBestSnapTarget } from '@/core/connectors/snap';
import type { Dir, ElbowSnapTarget, SnapTarget } from '@/core/connectors/types';
import { frameOf } from '@/core/geometry/frame-of';
import { slideClear } from '@/core/spatial/clear-placement';
import { shouldShowHandles } from '@/core/spatial/handle-hit';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ConnectorEndpoint, ObjectHandle, StoredElbowAnchor } from '@/core/types/objects';
import { isBindableKind } from '@/core/types/objects';
import { isCtrlHeld } from '@/runtime/input/InputManager';
import { getAttachedConnectors, getHandle, getObjects, getSpatialIndex, getZOrder, transact } from '@/runtime/room-runtime';
import { textTool } from '@/runtime/tool-registry';
import { getUserId } from '@/stores/auth-store';
import { useCameraStore } from '@/stores/camera-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { computeSelectionBounds, useSelectionStore } from '@/stores/selection-store';

// =============================================================================
// TUNING CONSTANTS — all tunable
// =============================================================================

/** Candidate cross-center within ±25% of `crossDim` (middle-50% band). */
const FLOW_ALIGN_TOLERANCE = 0.25;
/** Candidate cutoff = `4 * flowDim` edge-to-edge — connector + shape + connector, plus slack. */
const FLOW_DIST_FACTOR = 4;
/** Duplicate near edge sits `1 * flowDim` past S's edge. */
const FLOW_DUP_GAP_FACTOR = 1;
/** Float-noise tolerance on the `gap ≥ 0` direction test. */
const FLOW_EDGE_EPS = 0.5;
/**
 * Gap a sibling keeps from the candidate (and from any object it slides past),
 * as a fraction of the sibling's cross dimension. Redundant-connector sibling
 * placement only — the straight duplicate never offsets.
 */
const FLOW_SIBLING_GAP_FACTOR = 0.25;
/** How far a sibling may slide past the candidate before giving up, in sibling widths. */
const FLOW_OFFSET_MAX_REACH = 4;
/** Tolerance for "an anchor sits on the side midpoint" (normalized [0..1] units). */
const FLOW_ANCHOR_EPS = 0.02;
/** Max button-center offset outward from the selection box (screen px). `flowButtonCenters`
 * shrinks it with the selection's smaller screen dim so the buttons stay visually proportional
 * when zoomed out — the fixed offset feels too wide once the source is small on screen. Floored
 * at `FLOW_BTN_ARROW_RADIUS_PX` so the hovered disc never overlaps the source. */
export const FLOW_BTN_OFFSET_PX = 22;
/** Rest blue-dot radius (screen px). */
export const FLOW_DOT_RADIUS_PX = 3;
/** Hovered arrow-mode button radius (screen px) — the full disc, no white ring sitting beyond it.
 * Sized just past the arrow glyph's max extent (tip at radius 7 + cap ≈ 1) so the rest→hover
 * pop stays modest while leaving a thin visible margin around the arrow. The drag-mode button
 * is smaller (renderer-local). Also the floor on the per-frame offset clamp — a smaller
 * offset would let the hovered disc overlap the source. */
export const FLOW_BTN_ARROW_RADIUS_PX = 10;
/** Hit radius (screen px). */
const FLOW_BTN_HIT_PX = 14;
/** Min smaller-axis screen dim (px) below which flow buttons hide — well above
 * `HANDLE_MIN_BBOX_PX`, so flow vanishes earlier than resize handles do. The fixed
 * offset + hover radius feels disproportionate on a small on-screen selection long
 * before its corner stamps physically meet. */
export const FLOW_MIN_BBOX_PX = 32;
/** Hover-preview alpha. */
export const FLOW_PREVIEW_OPACITY = 0.4;

/** Min drag length (world units) before a flow drag commits — shorter aborts. */
const FLOW_DROP_DIST = 5;

// =============================================================================
// TYPES
// =============================================================================

export type FlowSide = 'n' | 's' | 'e' | 'w';

/** Side order shared by `flowButtonCenters` / `hitFlowButton` / the renderer. */
export const FLOW_SIDES: readonly FlowSide[] = ['n', 'e', 's', 'w'];

/**
 * Hover preview — what a click on the hovered button would commit.
 *  - `candidate` — a nearby aligned object: preview the elbow route to it.
 *  - `duplicate` — duplicable source spawns a sibling node: straight ahead with
 *    no candidate, or offset into clear space when the candidate is already
 *    wired up. Carries the ghost frame + route.
 *  - `dragOnly`  — no candidate, non-duplicable source: nothing to preview.
 *
 * `candidate` / `duplicate` carry the resolved `startAnchor` / `endAnchor` —
 * shape-aware normalized midpoints — so `commitHover` stores the exact anchors
 * the preview routed with (a triangle's slanted-edge anchor, not the bbox one).
 * `route` aliases the controller's pooled buffer; iterate by `routeCount`.
 */
export type FlowPreview =
  | { kind: 'candidate'; side: FlowSide; targetId: string; startAnchor: Point; endAnchor: Point; route: Point[]; routeCount: number }
  | { kind: 'duplicate'; side: FlowSide; dupFrame: FrameTuple; startAnchor: Point; endAnchor: Point; route: Point[]; routeCount: number }
  | { kind: 'dragOnly'; side: FlowSide };

/** Overlay render snapshot — `idle` carries the hover preview, `drag` the live connector. */
export type FlowRenderState =
  | { phase: 'idle'; preview: FlowPreview | null }
  | { phase: 'drag'; route: Point[]; routeCount: number; color: string; width: number; toSnap: SnapTarget | null };

/** Visibility-gate result: the single bindable source + its selection bbox. */
export interface FlowGate {
  handle: ObjectHandle;
  bbox: BBoxTuple;
}

// =============================================================================
// SIDE GEOMETRY TABLES
// =============================================================================

/** Cardinal of the source button side. */
const SIDE_DIR: Record<FlowSide, Dir> = { n: 'N', e: 'E', s: 'S', w: 'W' };
/** Cardinal of the candidate's facing (opposite) side. */
const OPPOSITE_DIR: Record<FlowSide, Dir> = { n: 'S', e: 'W', s: 'N', w: 'E' };

// =============================================================================
// BUTTON GEOMETRY (pure — shared with the renderer)
// =============================================================================

// Module scratch — 4 button centers in FLOW_SIDES order. Callers read synchronously.
const _btnCenters: [Point, Point, Point, Point] = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
];

/**
 * The 4 flow-button centers — bbox cardinal positions pushed outward from the
 * selection box. The offset is `FLOW_BTN_OFFSET_PX` (screen px) for comfortably-
 * sized selections and shrinks with the smaller screen dim once that ratio gets
 * tight, so the buttons stay visually proportional when zoomed out (floored at
 * `FLOW_BTN_ARROW_RADIUS_PX` so the hovered disc can't overlap the source).
 * The buttons are pure UI affordances and live at the bbox edges regardless of
 * shape geometry, so a triangle's E button sits outside the bbox like every
 * other shape's E button (consistent click target, never crowded into the
 * interior). The connector anchor is shape-aware and resolved separately via
 * `flowAnchor` — a triangle's E/W connector routes from the slanted-edge
 * midpoint even though the button sits at the bbox edge.
 * Returns a module scratch in `FLOW_SIDES` order — read it before the next call.
 */
export function flowButtonCenters(b: Readonly<BBoxTuple>, scale: number): readonly Point[] {
  const minScreenDim = Math.min((b[2] - b[0]) * scale, (b[3] - b[1]) * scale);
  const offPx = Math.max(FLOW_BTN_ARROW_RADIUS_PX, Math.min(FLOW_BTN_OFFSET_PX, minScreenDim * 0.5));
  const off = offPx / scale;
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  // n
  _btnCenters[0][0] = cx;
  _btnCenters[0][1] = b[1] - off;
  // e
  _btnCenters[1][0] = b[2] + off;
  _btnCenters[1][1] = cy;
  // s
  _btnCenters[2][0] = cx;
  _btnCenters[2][1] = b[3] + off;
  // w
  _btnCenters[3][0] = b[0] - off;
  _btnCenters[3][1] = cy;
  return _btnCenters;
}

/** Which flow button (if any) `at` is over. */
export function hitFlowButton(at: Point, b: Readonly<BBoxTuple>, scale: number): FlowSide | null {
  const centers = flowButtonCenters(b, scale);
  const r = FLOW_BTN_HIT_PX / scale;
  const r2 = r * r;
  for (let i = 0; i < 4; i++) {
    const dx = at[0] - centers[i][0];
    const dy = at[1] - centers[i][1];
    if (dx * dx + dy * dy <= r2) return FLOW_SIDES[i];
  }
  return null;
}

/**
 * The single flow-button visibility gate. Returns the source handle + its
 * selection bbox when all conditions hold (single bindable selection, standard
 * mode, no transform, handles visible, selection's smaller screen dim ≥
 * `FLOW_MIN_BBOX_PX`, not full-DOM editing), else `null`. The screen-dim check
 * hides flow earlier than handles do — the fixed offset + hover radius dominate
 * a small on-screen selection long before its corner stamps physically meet.
 * Shared by `SelectTool` (hit) and the renderer (draw) so they never disagree.
 */
export function flowButtonGate(): FlowGate | null {
  const store = useSelectionStore.getState();
  if (store.mode !== 'standard' || store.selectedIds.length !== 1) return null;
  if (store.transform.kind !== 'none') return null;
  if (store.codeEditingId !== null) return null;
  // Same gate as resize handles: shape/note label editing keeps affordances.
  if (store.textEditingId !== null && !textTool.isEditingLabel()) return null;
  const handle = getHandle(store.selectedIds[0]);
  if (!handle || !isBindableKind(handle.kind)) return null;
  const bbox = computeSelectionBounds();
  if (!bbox || !shouldShowHandles(bbox)) return null;
  const scale = useCameraStore.getState().scale;
  if (Math.min((bbox[2] - bbox[0]) * scale, (bbox[3] - bbox[1]) * scale) < FLOW_MIN_BBOX_PX) return null;
  return { handle, bbox };
}

// =============================================================================
// SNAP / ANCHOR HELPERS
// =============================================================================

/**
 * Owned normalized midpoint anchor for a flow side — a fresh `Point` safe to
 * retain in a snap target or `FlowPreview`. A triangle's E/W land on the
 * slanted-edge centers, matching what the snap pipeline produces for a
 * hand-drawn connector to the same midpoint.
 */
function flowAnchor(shapeType: string, side: Dir): Point {
  const out: Point = [0, 0];
  midpointAnchorFor(shapeType, side, out);
  return out;
}

/** Hand-built elbow snap target at a shape's normalized-anchor midpoint. */
function buildElbowSnap(shapeId: string, anchor: Point, frame: Readonly<FrameTuple>, dir: Dir): ElbowSnapTarget {
  return {
    kind: 'elbow',
    shapeId,
    normalizedAnchor: anchor,
    position: [frame[0] + anchor[0] * frame[2], frame[1] + anchor[1] * frame[3]],
    side: dir,
    isMidpoint: true,
    isInside: false,
  };
}

/** Stored elbow anchor literal — clones `anchor` so the Y.Doc never holds a live reference. */
function anchorRecord(id: string, anchor: Point): StoredElbowAnchor {
  return { id, anchor: [anchor[0], anchor[1]] };
}

// =============================================================================
// CANDIDATE DETECTION
// =============================================================================

interface FlowCandidate {
  handle: ObjectHandle;
  frame: FrameTuple;
}

// Module scratch for the coarse spatial prefilter region.
const _candRegion: BBoxTuple = [0, 0, 0, 0];

/**
 * Find the best connect-to candidate for a button on `side` of `source`.
 * Coarse spatial prefilter → precise direction/distance/alignment gates → pick
 * smallest gap (tie-break: smaller alignment delta).
 */
function findFlowCandidate(source: ObjectHandle, side: FlowSide, srcFrame: Readonly<FrameTuple>): FlowCandidate | null {
  const [sx, sy, sw, sh] = srcFrame;
  const horizontal = side === 'e' || side === 'w';
  const flowDim = horizontal ? sw : sh;
  const crossDim = horizontal ? sh : sw;
  const reach = FLOW_DIST_FACTOR * flowDim;
  const sCrossCenter = horizontal ? sy + sh / 2 : sx + sw / 2;

  // Coarse prefilter region — extends `reach` along D, source cross-extent ± crossDim.
  if (side === 'e') {
    _candRegion[0] = sx + sw;
    _candRegion[2] = sx + sw + reach;
    _candRegion[1] = sy - crossDim;
    _candRegion[3] = sy + sh + crossDim;
  } else if (side === 'w') {
    _candRegion[0] = sx - reach;
    _candRegion[2] = sx;
    _candRegion[1] = sy - crossDim;
    _candRegion[3] = sy + sh + crossDim;
  } else if (side === 's') {
    _candRegion[1] = sy + sh;
    _candRegion[3] = sy + sh + reach;
    _candRegion[0] = sx - crossDim;
    _candRegion[2] = sx + sw + crossDim;
  } else {
    _candRegion[1] = sy - reach;
    _candRegion[3] = sy;
    _candRegion[0] = sx - crossDim;
    _candRegion[2] = sx + sw + crossDim;
  }

  const handles = getSpatialIndex().queryBBox(_candRegion);
  let best: FlowCandidate | null = null;
  let bestGap = Infinity;
  let bestAlign = Infinity;

  for (const h of handles) {
    if (h.id === source.id || !isBindableKind(h.kind)) continue;
    const cf = frameOf(h);
    if (!cf) continue;
    const [cx, cy, cw, ch] = cf;

    // Edge-to-edge gap: source's D-edge → candidate's near edge.
    let gap: number;
    if (side === 'e') gap = cx - (sx + sw);
    else if (side === 'w') gap = sx - (cx + cw);
    else if (side === 's') gap = cy - (sy + sh);
    else gap = sy - (cy + ch);
    if (gap < -FLOW_EDGE_EPS || gap > reach) continue;

    const cCrossCenter = horizontal ? cy + ch / 2 : cx + cw / 2;
    const align = Math.abs(cCrossCenter - sCrossCenter);
    if (align > FLOW_ALIGN_TOLERANCE * crossDim) continue;

    if (gap < bestGap - FLOW_EDGE_EPS || (gap <= bestGap + FLOW_EDGE_EPS && align < bestAlign)) {
      best = { handle: h, frame: cf };
      bestGap = gap;
      bestAlign = align;
    }
  }
  return best;
}

/** Duplicate frame: same size as the source, one `flowDim` gap past its D-edge. */
function computeDupFrame(side: FlowSide, f: Readonly<FrameTuple>): FrameTuple {
  const [sx, sy, sw, sh] = f;
  switch (side) {
    case 'e':
      return [sx + sw + FLOW_DUP_GAP_FACTOR * sw, sy, sw, sh];
    case 'w':
      return [sx - sw - FLOW_DUP_GAP_FACTOR * sw, sy, sw, sh];
    case 's':
      return [sx, sy + sh + FLOW_DUP_GAP_FACTOR * sh, sw, sh];
    case 'n':
      return [sx, sy - sh - FLOW_DUP_GAP_FACTOR * sh, sw, sh];
  }
}

// =============================================================================
// SEMANTIC PLACEMENT — redundancy check + clear-space search
// =============================================================================

/**
 * Source-sized placement frame aligned beside `cand`: connector-facing edge
 * level with the candidate's, centered on the candidate's cross axis. The
 * clear-spot search slides this perpendicular to the hover axis.
 */
function computeSiblingBaseFrame(side: FlowSide, src: Readonly<FrameTuple>, cand: Readonly<FrameTuple>): FrameTuple {
  const dw = src[2];
  const dh = src[3];
  const candCx = cand[0] + cand[2] / 2;
  const candCy = cand[1] + cand[3] / 2;
  switch (side) {
    case 'n': // candidate above — level the bottom edges
      return [candCx - dw / 2, cand[1] + cand[3] - dh, dw, dh];
    case 's': // candidate below — level the top edges
      return [candCx - dw / 2, cand[1], dw, dh];
    case 'e': // candidate right — level the left edges
      return [cand[0], candCy - dh / 2, dw, dh];
    case 'w': // candidate left — level the right edges
      return [cand[0] + cand[2] - dw, candCy - dh / 2, dw, dh];
  }
}

/**
 * Closest clear sibling placement beside the candidate (redundant-connector
 * case). The sibling keeps the candidate's facing-edge alignment — only the
 * perpendicular offset is searched. Both directions start flush-adjacent to the
 * candidate and slide outward just past any blocker; the clear spot nearest the
 * candidate wins. The first slot accounts for the candidate's OWN dimensions, so
 * it is genuinely adjacent whatever the candidate's size. `null` when both
 * directions run past the reach cap → caller uses the redundant connector.
 */
function findClearSiblingFrame(side: FlowSide, src: Readonly<FrameTuple>, cand: Readonly<FrameTuple>): FrameTuple | null {
  const base = computeSiblingBaseFrame(side, src, cand);
  const pIdx = side === 'e' || side === 'w' ? 1 : 0; // e/w hover slides Y, n/s slides X
  const pExt = pIdx + 2;
  const sibCross = base[pExt];
  const half = sibCross / 2;
  const gap = sibCross * FLOW_SIBLING_GAP_FACTOR;
  const candC = cand[pIdx] + cand[pExt] / 2;
  // First slot flush-adjacent to the candidate (its half-extent + sibling's +
  // gap); the cap allows a few sibling widths of sliding past blockers.
  const flushOffset = cand[pExt] / 2 + half + gap;
  const maxOffset = cand[pExt] / 2 + half + FLOW_OFFSET_MAX_REACH * sibCross;
  // Tie-break leads toward the source's cross axis (the tidier side).
  const firstDir = candC > src[pIdx] + src[pExt] / 2 ? -1 : 1;

  let bestC = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 2; i++) {
    const dir = i === 0 ? firstDir : -firstDir;
    const c = slideClear(base, pIdx, half, gap, dir, candC + dir * flushOffset, candC + dir * maxOffset);
    if (c !== null && Math.abs(c - candC) < bestDist) {
      bestDist = Math.abs(c - candC);
      bestC = c;
    }
  }
  if (bestDist === Number.POSITIVE_INFINITY) return null;
  const out: FrameTuple = [base[0], base[1], base[2], base[3]];
  out[pIdx] = bestC - half;
  return out;
}

/**
 * True when an existing connector already ties the source's side-midpoint
 * `mid` to `candidateId`, in either direction — which makes the straight flow
 * connection redundant (clicking would only stack a second connector at the
 * same spot). `mid` is the source's shape-aware normalized midpoint anchor.
 */
function hasRedundantConnector(sourceId: string, candidateId: string, mid: Readonly<Point>): boolean {
  const attached = getAttachedConnectors(sourceId);
  if (!attached) return false;
  for (const cid of attached) {
    const cy = getObjects().get(cid);
    if (!cy) continue;
    const start = getStart(cy);
    const end = getEnd(cy);
    // Both endpoints must be shape-bound for the connector to link two shapes.
    if (!start || !end || Array.isArray(start) || Array.isArray(end)) continue;
    let srcAnchor: [number, number] | null = null;
    if (start.id === sourceId && end.id === candidateId) srcAnchor = start.anchor;
    else if (start.id === candidateId && end.id === sourceId) srcAnchor = end.anchor;
    if (srcAnchor && Math.abs(srcAnchor[0] - mid[0]) <= FLOW_ANCHOR_EPS && Math.abs(srcAnchor[1] - mid[1]) <= FLOW_ANCHOR_EPS) {
      return true;
    }
  }
  return false;
}

/**
 * Insert a blank duplicate of `source` (shape or note) at `dupFrame`. Copies
 * style + size, NOT content (the user types into it). MUST run inside `transact()`.
 * Returns the new id, or `null` if the source props can't be read.
 */
function insertDuplicate(source: ObjectHandle, dupFrame: Readonly<FrameTuple>, z: ZKey): string | null {
  const id = ulid();
  const m = new Y.Map<unknown>();
  m.set('id', id);

  if (source.kind === 'shape') {
    const sp = getShapeProps(source.y);
    if (!sp) return null;
    m.set('kind', 'shape');
    m.set('shapeType', sp.shapeType);
    m.set('color', sp.color);
    m.set('width', sp.width);
    m.set('opacity', sp.opacity);
    if (sp.fillColor) m.set('fillColor', sp.fillColor);
    m.set('frame', [dupFrame[0], dupFrame[1], dupFrame[2], dupFrame[3]]);
  } else if (source.kind === 'note') {
    const np = getNoteProps(source.y);
    if (!np) return null;
    m.set('kind', 'note');
    // Notes store origin + scale, not a frame; size derives from content + scale.
    m.set('origin', [dupFrame[0], dupFrame[1]]);
    m.set('scale', np.scale);
    m.set('fontFamily', np.fontFamily);
    m.set('align', np.align);
    m.set('alignV', np.alignV);
    m.set('fillColor', np.fillColor);
    m.set('content', new Y.XmlFragment());
  } else {
    return null;
  }

  m.set('ownerId', getUserId());
  m.set('createdAt', Date.now());
  m.set('z', z);
  getObjects().set(id, m);
  return id;
}

// =============================================================================
// CONTROLLER
// =============================================================================

/**
 * Owns connector-flow hover + drag state. One pooled route buffer serves both
 * (they never overlap — a drag begin clears hover first).
 */
export class ConnectorFlowController {
  private phase: 'idle' | 'drag' = 'idle';

  // Hover state (idle only). Set/cleared atomically.
  private hover: { sourceId: string; side: FlowSide; preview: FlowPreview } | null = null;

  // Drag state — mirrors ConnectorTool's snap-based gesture model.
  private dragSourceId = '';
  private fromSnap: ElbowSnapTarget | null = null;
  private toSnap: SnapTarget | null = null;
  private toPosition: Point | null = null;
  private prevSnap: SnapTarget | null = null;
  /** Pooled route buffer — shared by hover preview + drag. Iterate by `routedCount`. */
  private readonly routeBuf: Point[] = [];
  private routedCount = 0;
  private frozenColor = '#000000';
  private frozenWidth = 2;

  // --- Hover ---

  /** Recompute the hover preview for `side` of `sourceId`. No-op if unchanged. */
  updateHover(sourceId: string, side: FlowSide, sourceHandle: ObjectHandle): void {
    if (this.phase !== 'idle') return;
    if (this.hover && this.hover.sourceId === sourceId && this.hover.side === side) return;
    const preview = this.computeHoverPreview(sourceId, side, sourceHandle);
    this.hover = preview ? { sourceId, side, preview } : null;
  }

  /** Drop the hover preview. Safe in any phase (drag state is untouched). */
  clearHover(): void {
    this.hover = null;
  }

  /**
   * Resolve what a click on the hovered button commits. Decision matrix:
   *  - candidate, not redundant     → connect straight to it.
   *  - candidate, redundant         → sibling node in clear space beside it
   *                                   (else the redundant connector — accepted).
   *  - no candidate, duplicable     → duplicate straight ahead. Never offset:
   *                                   no candidate already means nothing
   *                                   well-aligned sits in that sight-line.
   *  - no candidate, non-duplicable → drag-only.
   *
   * Anchors are shape-aware: each endpoint anchor is the connecting shape's own
   * normalized side-midpoint (`flowAnchor`), so a triangle wires from its
   * slanted-edge center, not the bbox corner.
   */
  private computeHoverPreview(sourceId: string, side: FlowSide, sourceHandle: ObjectHandle): FlowPreview | null {
    const frame = frameOf(sourceHandle);
    if (!frame) return null;
    const width = useDeviceUIStore.getState().connector.width;
    // Source routing shape type — a shape's `shapeType`, `'rect'` for a note.
    // The duplicate copies the source, so this is also the duplicate's type;
    // it matches exactly what `bakeCanonicalEndpoint` reads post-commit.
    const srcShapeType = getHandleShapeType(sourceHandle);
    const srcAnchor = flowAnchor(srcShapeType, SIDE_DIR[side]);
    const srcSnap = buildElbowSnap(sourceId, srcAnchor, frame, SIDE_DIR[side]);
    const duplicable = sourceHandle.kind === 'shape' || sourceHandle.kind === 'note';

    const candidate = findFlowCandidate(sourceHandle, side, frame);
    if (candidate) {
      // Redundant: an existing connector already ties this midpoint to the
      // candidate. Rather than stack a second identical connector, place a
      // fresh sibling in clear space beside the candidate — when the source is
      // duplicable and such a spot exists. Otherwise the connector below is the
      // accepted last resort.
      if (duplicable && hasRedundantConnector(sourceId, candidate.handle.id, srcAnchor)) {
        const spot = findClearSiblingFrame(side, frame, candidate.frame);
        if (spot) return this.makeDuplicatePreview(side, spot, srcSnap, srcShapeType, width);
      }

      // Connect straight to the candidate — source midpoint → its facing
      // midpoint, each anchor resolved against that shape's own type.
      const candAnchor = flowAnchor(getHandleShapeType(candidate.handle), OPPOSITE_DIR[side]);
      const candSnap = buildElbowSnap(candidate.handle.id, candAnchor, candidate.frame, OPPOSITE_DIR[side]);
      this.routedCount = routeNewConnectorInto(srcSnap, candSnap, width, 'elbow', this.routeBuf);
      return {
        kind: 'candidate',
        side,
        targetId: candidate.handle.id,
        startAnchor: srcAnchor,
        endAnchor: candAnchor,
        route: this.routeBuf,
        routeCount: this.routedCount,
      };
    }

    // No candidate — a clear sight-line ahead. Shape/note spawns a wired-up
    // clone straight in front; the offset search plays no part here.
    if (duplicable) {
      return this.makeDuplicatePreview(side, computeDupFrame(side, frame), srcSnap, srcShapeType, width);
    }

    // text / code / image / bookmark with no candidate → drag-only.
    return { kind: 'dragOnly', side };
  }

  /**
   * Build a `duplicate` preview. The ghost end is a `VirtualAnchor` — its frame
   * + shapeType + facing anchor — so the previewed elbow path is byte-identical
   * to the canonical reroute the observer runs once the duplicate is committed
   * (same anchored→anchored direction resolution, obstacle set, edge-clearance
   * stub). Routing it as a bare free point — the old behaviour — derived the end
   * direction from the raw delta and dropped the dup as an obstacle, so an
   * offset sibling's arrow could enter from the wrong side.
   *
   * The duplicate copies the source, so its facing anchor resolves against the
   * same `dupShapeType` — a triangle dup gets a slanted-edge anchor too.
   */
  private makeDuplicatePreview(
    side: FlowSide,
    dupFrame: FrameTuple,
    srcSnap: ElbowSnapTarget,
    dupShapeType: string,
    width: number,
  ): FlowPreview {
    const dupAnchor = flowAnchor(dupShapeType, OPPOSITE_DIR[side]);
    const dupEnd: VirtualAnchor = { kind: 'virtual', frame: dupFrame, shapeType: dupShapeType, anchor: dupAnchor };
    this.routedCount = routeNewConnectorInto(srcSnap, dupEnd, width, 'elbow', this.routeBuf);
    return {
      kind: 'duplicate',
      side,
      dupFrame,
      startAnchor: srcSnap.normalizedAnchor,
      endAnchor: dupAnchor,
      route: this.routeBuf,
      routeCount: this.routedCount,
    };
  }

  // --- Drag ---

  /** Begin a live connector drag from `side` of `sourceId`. Returns false if not routable. */
  beginDrag(sourceId: string, side: FlowSide, sourceHandle: ObjectHandle): boolean {
    const frame = frameOf(sourceHandle);
    if (!frame) return false;
    const st = useDeviceUIStore.getState();
    this.frozenColor = st.connector.color;
    this.frozenWidth = st.connector.width;
    this.dragSourceId = sourceId;
    const dir = SIDE_DIR[side];
    this.fromSnap = buildElbowSnap(sourceId, flowAnchor(getHandleShapeType(sourceHandle), dir), frame, dir);
    this.toSnap = null;
    this.toPosition = null;
    this.prevSnap = null;
    this.routeBuf.length = 0;
    this.routedCount = 0;
    this.hover = null;
    this.phase = 'drag';
    return true;
  }

  /** Update the live connector end (cursor + snapping; Ctrl suppresses). */
  updateDrag(worldX: number, worldY: number): void {
    if (this.phase !== 'drag' || !this.fromSnap) return;
    const snap = isCtrlHeld()
      ? null
      : findBestSnapTarget({ cursorWorld: [worldX, worldY], prevAttach: this.prevSnap, connectorType: 'elbow' });
    const pos: Point = snap ? snap.position : [worldX, worldY];
    this.toSnap = snap;
    this.prevSnap = snap;
    this.toPosition = pos;
    this.routedCount = routeNewConnectorInto(this.fromSnap, snap ?? pos, this.frozenWidth, 'elbow', this.routeBuf);
  }

  /** Re-route while dragging (camera moved under a held drag). */
  onViewChange(): void {
    if (this.phase !== 'drag' || !this.fromSnap) return;
    const end = this.toSnap ?? this.toPosition;
    if (end) this.routedCount = routeNewConnectorInto(this.fromSnap, end, this.frozenWidth, 'elbow', this.routeBuf);
  }

  /** Commit the live connector. Returns the new id, or `null` if too short / invalid. */
  commitDrag(): string | null {
    if (this.phase !== 'drag' || !this.fromSnap || !this.toPosition || this.routedCount < 2) return null;
    const fp = this.fromSnap.position;
    if (Math.hypot(this.toPosition[0] - fp[0], this.toPosition[1] - fp[1]) <= FLOW_DROP_DIST) return null;
    const end: ConnectorEndpoint = this.toSnap ? anchorRecordFromSnap(this.toSnap) : [this.toPosition[0], this.toPosition[1]];
    return createConnector({
      // `fromSnap` carries the shape-aware source anchor built at beginDrag.
      start: anchorRecordFromSnap(this.fromSnap),
      end,
      startCap: 'none',
      endCap: 'arrow',
      connectorType: 'elbow',
      color: this.frozenColor,
      width: this.frozenWidth,
    });
  }

  /** Tear down the drag (commit done or aborted). */
  cancelDrag(): void {
    if (this.phase !== 'drag') return;
    this.phase = 'idle';
    this.fromSnap = null;
    this.toSnap = null;
    this.toPosition = null;
    this.prevSnap = null;
    this.routeBuf.length = 0;
    this.routedCount = 0;
  }

  // --- Click commit ---

  /**
   * Commit the current hover preview. Candidate → the connector id. Duplicate →
   * the new duplicate's id (one transaction for shape + connector). Drag-only or
   * no preview → `null`. Both connector commits reuse the preview's resolved
   * `startAnchor` / `endAnchor`, so what lands is exactly what was previewed.
   */
  commitHover(): string | null {
    const hover = this.hover;
    if (!hover) return null;
    const { sourceId, preview } = hover;
    const st = useDeviceUIStore.getState();
    const color = st.connector.color;
    const width = st.connector.width;

    if (preview.kind === 'candidate') {
      return createConnector({
        start: anchorRecord(sourceId, preview.startAnchor),
        end: anchorRecord(preview.targetId, preview.endAnchor),
        startCap: 'none',
        endCap: 'arrow',
        connectorType: 'elbow',
        color,
        width,
      });
    }

    if (preview.kind === 'duplicate') {
      const sourceHandle = getHandle(sourceId);
      if (!sourceHandle) return null;
      const dupFrame = preview.dupFrame;
      return (
        transact(() => {
          const [zDup, zConn] = generateNZAtTop(getZOrder().maxZ(), 2);
          const dupId = insertDuplicate(sourceHandle, dupFrame, zDup);
          if (!dupId) return null;
          insertConnector(
            {
              start: anchorRecord(sourceId, preview.startAnchor),
              end: anchorRecord(dupId, preview.endAnchor),
              startCap: 'none',
              endCap: 'arrow',
              connectorType: 'elbow',
              color,
              width,
            },
            zConn,
          );
          return dupId;
        }) ?? null
      );
    }

    return null; // dragOnly — click is a no-op (per spec)
  }

  // --- Getters (for SelectTool + the overlay) ---

  isDragging(): boolean {
    return this.phase === 'drag';
  }

  getSourceId(): string | null {
    return this.phase === 'drag' ? this.dragSourceId : (this.hover?.sourceId ?? null);
  }

  getRenderSnapshot(): FlowRenderState {
    if (this.phase === 'drag') {
      return {
        phase: 'drag',
        route: this.routeBuf,
        routeCount: this.routedCount,
        color: this.frozenColor,
        width: this.frozenWidth,
        toSnap: this.toSnap,
      };
    }
    return { phase: 'idle', preview: this.hover?.preview ?? null };
  }
}
