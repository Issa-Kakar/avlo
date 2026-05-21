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
 * Pure geometry helpers (`flowButtonCenters` / `hitFlowButton` / `flowButtonGate`)
 * are shared by `SelectTool` (hit) and `renderer/layers/connector-flow.ts` (draw).
 *
 * @module tools/selection/connector-flow
 */

import { generateNZAtTop, type ZKey } from '@avlo/shared';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import { getNoteProps, getShapeProps } from '@/core/accessors';
import { anchorRecordFromSnap } from '@/core/connectors/anchor-atoms';
import { createConnector, insertConnector } from '@/core/connectors/connector-actions';
import { routeNewConnectorInto } from '@/core/connectors/reroute-connector';
import { findBestSnapTarget } from '@/core/connectors/snap';
import type { Dir, ElbowSnapTarget, SnapTarget } from '@/core/connectors/types';
import { frameOf } from '@/core/geometry/frame-of';
import { shouldShowHandles } from '@/core/spatial/handle-hit';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ConnectorEndpoint, ObjectHandle, StoredElbowAnchor } from '@/core/types/objects';
import { isBindableKind } from '@/core/types/objects';
import { isCtrlHeld } from '@/runtime/InputManager';
import { getHandle, getObjects, getSpatialIndex, getZOrder, transact } from '@/runtime/room-runtime';
import { textTool } from '@/runtime/tool-registry';
import { getUserId, useDeviceUIStore } from '@/stores/device-ui-store';
import { computeSelectionBounds, useSelectionStore } from '@/stores/selection-store';

// =============================================================================
// TUNING CONSTANTS — all tunable
// =============================================================================

/** Candidate cross-center within ±25% of `crossDim` (middle-50% band). */
const FLOW_ALIGN_TOLERANCE = 0.25;
/** Candidate cutoff = `3 * flowDim` edge-to-edge (connector + shape + connector). */
const FLOW_DIST_FACTOR = 3;
/** Duplicate near edge sits `1 * flowDim` past S's edge. */
const FLOW_DUP_GAP_FACTOR = 1;
/** Float-noise tolerance on the `gap ≥ 0` direction test. */
const FLOW_EDGE_EPS = 0.5;
/** Button center offset outward from the selection box (screen px). */
export const FLOW_BTN_OFFSET_PX = 22;
/** Rest blue-dot radius (screen px). */
export const FLOW_DOT_RADIUS_PX = 3;
/** Hovered button radius (screen px). */
export const FLOW_BTN_HOVER_RADIUS_PX = 10;
/** Hit radius (screen px). */
const FLOW_BTN_HIT_PX = 14;
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
 *  - `duplicate` — no candidate, duplicable source: ghost duplicate + route.
 *  - `dragOnly`  — no candidate, non-duplicable source: nothing to preview.
 * `route` aliases the controller's pooled buffer; iterate by `routeCount`.
 */
export type FlowPreview =
  | { kind: 'candidate'; side: FlowSide; targetId: string; route: Point[]; routeCount: number }
  | { kind: 'duplicate'; side: FlowSide; dupFrame: FrameTuple; route: Point[]; routeCount: number }
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

/** Normalized anchor of the source's button-side midpoint. */
const SRC_ANCHOR: Record<FlowSide, Point> = { n: [0.5, 0], e: [1, 0.5], s: [0.5, 1], w: [0, 0.5] };
/** Normalized anchor of the *candidate's* facing (opposite) midpoint. */
const CAND_ANCHOR: Record<FlowSide, Point> = { n: [0.5, 1], e: [0, 0.5], s: [0.5, 0], w: [1, 0.5] };
/** Cardinal of the source button side (UI hint on the snap target). */
const SIDE_DIR: Record<FlowSide, Dir> = { n: 'N', e: 'E', s: 'S', w: 'W' };
/** Cardinal of the candidate's facing side. */
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
 * The 4 flow-button centers, pushed `FLOW_BTN_OFFSET_PX` outward from the
 * selection box. Returns a module scratch in `FLOW_SIDES` order — read it before
 * the next call.
 */
export function flowButtonCenters(b: Readonly<BBoxTuple>, scale: number): readonly Point[] {
  const off = FLOW_BTN_OFFSET_PX / scale;
  const cx = (b[0] + b[2]) / 2;
  const cy = (b[1] + b[3]) / 2;
  _btnCenters[0][0] = cx; // n
  _btnCenters[0][1] = b[1] - off;
  _btnCenters[1][0] = b[2] + off; // e
  _btnCenters[1][1] = cy;
  _btnCenters[2][0] = cx; // s
  _btnCenters[2][1] = b[3] + off;
  _btnCenters[3][0] = b[0] - off; // w
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
 * mode, no transform, handles visible, not full-DOM editing), else `null`.
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
  return { handle, bbox };
}

// =============================================================================
// SNAP / ANCHOR HELPERS
// =============================================================================

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

/** Stored elbow anchor literal — clones the module-constant anchor for the Y.Doc. */
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
  private dragSide: FlowSide = 'e';
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

  private computeHoverPreview(sourceId: string, side: FlowSide, sourceHandle: ObjectHandle): FlowPreview | null {
    const frame = frameOf(sourceHandle);
    if (!frame) return null;
    const width = useDeviceUIStore.getState().connector.width;
    const srcSnap = buildElbowSnap(sourceId, SRC_ANCHOR[side], frame, SIDE_DIR[side]);

    // Candidate — route source midpoint → candidate's facing midpoint.
    const candidate = findFlowCandidate(sourceHandle, side, frame);
    if (candidate) {
      const candSnap = buildElbowSnap(candidate.handle.id, CAND_ANCHOR[side], candidate.frame, OPPOSITE_DIR[side]);
      this.routedCount = routeNewConnectorInto(srcSnap, candSnap, width, 'elbow', this.routeBuf);
      return { kind: 'candidate', side, targetId: candidate.handle.id, route: this.routeBuf, routeCount: this.routedCount };
    }

    // Duplicate — only shape/note can spawn a wired-up clone.
    if (sourceHandle.kind === 'shape' || sourceHandle.kind === 'note') {
      const dupFrame = computeDupFrame(side, frame);
      const ca = CAND_ANCHOR[side];
      const dupEnd: Point = [dupFrame[0] + ca[0] * dupFrame[2], dupFrame[1] + ca[1] * dupFrame[3]];
      this.routedCount = routeNewConnectorInto(srcSnap, dupEnd, width, 'elbow', this.routeBuf);
      return { kind: 'duplicate', side, dupFrame, route: this.routeBuf, routeCount: this.routedCount };
    }

    // text / code / image / bookmark with no candidate → drag-only.
    return { kind: 'dragOnly', side };
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
    this.dragSide = side;
    this.fromSnap = buildElbowSnap(sourceId, SRC_ANCHOR[side], frame, SIDE_DIR[side]);
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
      start: anchorRecord(this.dragSourceId, SRC_ANCHOR[this.dragSide]),
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
   * no preview → `null`.
   */
  commitHover(): string | null {
    const hover = this.hover;
    if (!hover) return null;
    const { sourceId, side, preview } = hover;
    const st = useDeviceUIStore.getState();
    const color = st.connector.color;
    const width = st.connector.width;

    if (preview.kind === 'candidate') {
      return createConnector({
        start: anchorRecord(sourceId, SRC_ANCHOR[side]),
        end: anchorRecord(preview.targetId, CAND_ANCHOR[side]),
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
              start: anchorRecord(sourceId, SRC_ANCHOR[side]),
              end: anchorRecord(dupId, CAND_ANCHOR[side]),
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
