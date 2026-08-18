/**
 * Transform system — module-level SoA gesture engine (no class, no controller).
 *
 * Every gesture entry lives in ONE interleaved Float64Array (`_lanes`, stride
 * 16 — layout in `transform-kernels.ts`), partitioned into contiguous op
 * ranges at begin (counting sort over `OP_LUT[kind, behavior]`). Per
 * pointermove: hoist gesture globals once, run one straight-line kernel per
 * non-empty op range, rebake connector topology, push OLD+NEW damage rects
 * into the batch accumulator, flush once. Steady-state begin/update/commit
 * allocates nothing except reflow-sidecar field writes and cold pool growth.
 *
 * ROUTING — `_slotGesture: Int32Array` (sparse, slot-keyed, −1 default):
 *   −1              not in gesture
 *   gi              gesture entry (index into lanes/meta/gslot)
 *   TOPO_TAG | ti   topology connector (index into `topology.entries`)
 *   EPDRAG_TAG      the endpoint-drag connector
 * The renderer pack loop skips `sg[slot] >= 0` in one load + sign test; the
 * inject cull re-validates every inject slot against the map (a tag mismatch
 * means the slot was evicted mid-gesture — prevents recycled-slot aliasing
 * AND double-pack).
 *
 * EVICTION — `transformEvictSlot(slot)` (RoomDocManager: Phase A pre-
 * releaseSlot + the kind-keychange branch) clears the slot's map cell, flags
 * gesture entries DEAD (meta bit; commit-skip only — hot loops never test
 * it), and pushes the evicted preview rect + flushes — the release-without-
 * another-move path has no later pushAllDamage to erase those pixels.
 *
 * LIFECYCLE — commit derenders FIRST (mode→0 + map reset) so the renderer
 * sees idle state before the observer repaints (the old clear-visual-state-
 * first glitch guard), then runs ONE transact over live, unlocked entries;
 * buffers persist at high-water across gestures; `_gy` refs and sidecar
 * measured/source refs are released at dispose so deleted Y.Maps aren't
 * rooted.
 *
 * Buffer getters follow the FlatRTree `results` idiom: refs are valid within
 * a frame; refetch per frame (arrays swap only at begin/growth).
 */

import type * as Y from 'yjs';
import { getCodeProps, getFrame, getOrigin, getPoints, getTextProps, getWidth } from '@/core/accessors';
import {
  type CodeLayout,
  type CodeSource,
  blockHeight as codeBlockHeight,
  createCodeLayout,
  getCodeFrame,
  getMinWidth as getCodeMinWidth,
  getCodeSource,
  layoutCodeSourceInto,
} from '@/core/code/code-system';
import { anchorRecordFromSnap } from '@/core/connectors/anchor-atoms';
import { unionConnectorLabelRectInto } from '@/core/connectors/connector-label';
import {
  buildRouteContext,
  type EndpointDragOverride,
  type RouteContext,
  rerouteEndpointDragInto,
  type Slot,
  slotKey,
  slotPointIndex,
} from '@/core/connectors/reroute-connector';
import type { SnapTarget } from '@/core/connectors/types';
import { copyBbox } from '@/core/geometry/bounds';
import { getLockedFlags, getLockOwners, isLockedObject } from '@/core/locks/lock-table';
import { getBBoxColumn, slotHighWater } from '@/core/slots/slot-table';
import { getItalicOverhangPad, getMinCharWidth } from '@/core/text/text-measure';
import {
  anchorFactor,
  createTextLayout,
  getTextFrame,
  layoutMeasuredContent,
  type TextLayout,
  textLayoutCache,
} from '@/core/text/text-system';
import type { BBoxTuple, Point } from '@/core/types/geometry';
import type { HandleId } from '@/core/types/handles';
import { isCorner, isHorzSide } from '@/core/types/handles';
import type { ConnectorEndpoint, ObjectHandle } from '@/core/types/objects';
import { isBindableKind, K_CODE, K_IMAGE, K_SHAPE, K_STROKE, K_TEXT, KIND_CODE } from '@/core/types/objects';
import { invalidateWorldAll } from '@/renderer/RenderLoop';
import { getHandle, getObjects, transact } from '@/runtime/room-runtime';
import {
  type ConnectorEntry,
  type ConnectorTopology,
  cancelTopology,
  commitTopology,
  type EndpointDragEntry,
  newTopologyBuilder,
  runTopologyScale,
  runTopologyTranslate,
} from './connector-topology';
import { flushDamage, pushDamage } from './transform-damage';
import {
  applyEdgePinRange,
  applyFrameEdgesRange,
  applyFrameUniformRange,
  applyOffsetRange,
  applyOriginUniformRange,
  applyStrokeUniformRange,
  BEH_UNIFORM,
  BEHAVIOR_LUT,
  CAT_CORNER,
  CAT_HSIDE,
  CAT_VSIDE,
  EPDRAG_TAG,
  fillUniformPack,
  G_STRIDE,
  GIDX_MASK,
  META_CODE_HEADER_VISIBLE,
  META_CODE_LINE_NUMBERS,
  META_CODE_OUTPUT_VISIBLE,
  META_DEAD,
  META_KIND_MASK,
  META_OP_MASK,
  META_OP_SHIFT,
  OP_COUNT,
  OP_FRAME_EDGES,
  OP_FRAME_UNIFORM,
  OP_LUT,
  OP_OFFSET,
  OP_ORIGIN_UNIFORM,
  OP_REFLOW_CODE,
  OP_REFLOW_TEXT,
  OP_STROKE_UNIFORM,
  reflowLeftWidth,
  reflowOut,
  TOPO_TAG,
} from './transform-kernels';
import type { ScaleCtx } from './types';

type MeasuredContent = NonNullable<ReturnType<typeof textLayoutCache.getMeasuredContent>>;

// ============================================================================
// Module state
// ============================================================================

const MODE_NONE = 0;
const MODE_SCALE = 1;
const MODE_TRANSLATE = 2;
const MODE_EP_DRAG = 3;

let _mode = MODE_NONE;
let _sx = 1;
let _sy = 1;
let _dx = 0;
let _dy = 0;

let _count = 0;
const _opStart = new Int32Array(OP_COUNT);
const _opCount = new Int32Array(OP_COUNT);
const _opCursor = new Int32Array(OP_COUNT);

let _lanes = new Float64Array(64 * G_STRIDE);
let _meta = new Uint32Array(64);
let _gslot = new Uint32Array(64);
/** Y refs for commit; length = 0 after commit/cancel so deleted maps aren't rooted. */
const _gy: (Y.Map<unknown> | null)[] = [];

/** Sparse slot→gesture map; capacity ensured ≥ slotHighWater at begin AND by
 *  the renderer-facing getter each frame (peers mint slots mid-gesture). */
let _slotGesture = new Int32Array(0);
let _injectSlots = new Uint32Array(64);
let _injectSlotCount = 0;
/** Lock-acquisition ids ONLY (selection-store's acquireTransformLocks) — the
 *  renderer never sees this. Same push rules as the old controller: all
 *  non-locked selected ids incl. freeze-bailed ones, + attached connector
 *  ids (the FULL attached set — an attached connector whose entry
 *  construction bailed is still lock-acquired), or the epDrag id. */
const _injectIds: string[] = [];

/** Persistent ScaleCtx — `origin`/`selBounds` are OWNED arrays COPIED at
 *  begin (a single-selected handle's live bbox must not alias the gesture
 *  baseline: RDM's copyBbox would drift it under remote edits mid-gesture);
 *  sx/sy mutated per frame. Threaded to topology + overlay. */
const _scaleCtx: ScaleCtx = { sx: 1, sy: 1, origin: [0, 0], selBounds: [0, 0, 0, 0], handleId: 'se' };
let _single = false;
let _cat = CAT_CORNER;
let _corner = false;
/** Computed once at end of beginScale — behaviors are fixed at begin. */
let _overlayUniform = false;

const _translateSelBounds: BBoxTuple = [0, 0, 0, 0];
let _hasTranslateBounds = false;

let _topology: ConnectorTopology | null = null;

/** Frozen stroke points, packed x,y pairs; per-entry [off, count] in fAux. */
let _strokePool = new Float64Array(256);
let _strokePoolLen = 0;

interface TextSidecar {
  measured: MeasuredContent | null;
  minW: number;
  anchor: number;
  readonly layout: TextLayout;
}
interface CodeSidecar {
  source: CodeSource | null;
  minW: number;
  output: string | undefined;
  readonly layout: CodeLayout;
}
/** Reflow sidecars — op-contiguity gives the dense index `gi - opStart[op]`.
 *  Pooled, grown high-water; layout allocated once per pool slot. */
const _textSidecars: TextSidecar[] = [];
const _codeSidecars: CodeSidecar[] = [];

// --- endpoint drag ---
let _epSlot = -1; // object slot of the dragged connector (−1 = idle)
let _epDragSlotArg: Slot = 0; // which endpoint moves (0 = start, 1 = end)
let _epRouteCtx: RouteContext | null = null;
const _epDragPrevBbox: BBoxTuple = [0, 0, 0, 0];
/** Reused scratch reassigned per gesture — `id`/`slot` written per begin,
 *  `currBbox`/`pointsBuf`/`validCount` mutated per frame. */
const _epDragEntryScratch: EndpointDragEntry = {
  mode: 'reroute',
  id: '',
  slot: 0,
  currBbox: [0, 0, 0, 0],
  pointsBuf: [],
  validCount: 0,
};

// --- freeze scratch (pass 1 → pass 2; module-reused) ---
let _fSlots = new Int32Array(64);
let _fOps = new Uint8Array(64);
let _fKinds = new Uint8Array(64);
const _fHandles: ObjectHandle[] = [];

// ============================================================================
// Capacity management (cold paths)
// ============================================================================

function ensureSlotMapCapacity(): void {
  const hw = slotHighWater();
  if (_slotGesture.length >= hw) return;
  let cap = Math.max(256, _slotGesture.length);
  while (cap < hw) cap *= 2;
  const next = new Int32Array(cap).fill(-1);
  next.set(_slotGesture); // live tags must survive mid-gesture growth
  _slotGesture = next;
}

function ensureGestureCapacity(n: number): void {
  if (n * G_STRIDE <= _lanes.length) return;
  let cap = _lanes.length / G_STRIDE;
  while (cap < n) cap *= 2;
  _lanes = new Float64Array(cap * G_STRIDE);
  _meta = new Uint32Array(cap);
  _gslot = new Uint32Array(cap);
}

function ensureInjectCapacity(n: number): void {
  if (n <= _injectSlots.length) return;
  let cap = _injectSlots.length;
  while (cap < n) cap *= 2;
  const next = new Uint32Array(cap);
  next.set(_injectSlots);
  _injectSlots = next;
}

function ensureFreezeCapacity(n: number): void {
  if (n <= _fSlots.length) return;
  let cap = _fSlots.length;
  while (cap < n) cap *= 2;
  _fSlots = new Int32Array(cap);
  _fOps = new Uint8Array(cap);
  _fKinds = new Uint8Array(cap);
}

function packStrokePoints(pts: readonly Point[]): number {
  const need = _strokePoolLen + pts.length * 2;
  if (need > _strokePool.length) {
    let cap = _strokePool.length;
    while (cap < need) cap *= 2;
    const next = new Float64Array(cap);
    next.set(_strokePool);
    _strokePool = next;
  }
  const off = _strokePoolLen;
  for (let i = 0; i < pts.length; i++) {
    _strokePool[off + i * 2] = pts[i][0];
    _strokePool[off + i * 2 + 1] = pts[i][1];
  }
  _strokePoolLen = need;
  return off;
}

function textSidecarAt(j: number): TextSidecar {
  while (_textSidecars.length <= j) _textSidecars.push({ measured: null, minW: 0, anchor: 0, layout: createTextLayout() });
  return _textSidecars[j];
}

function codeSidecarAt(j: number): CodeSidecar {
  while (_codeSidecars.length <= j) _codeSidecars.push({ source: null, minW: 0, output: undefined, layout: createCodeLayout() });
  return _codeSidecars[j];
}

// ============================================================================
// Shared teardown
// ============================================================================

/** Reset everything the renderer keys off: mode, the sparse map, inject slots. */
function derender(): void {
  _mode = MODE_NONE;
  for (let gi = 0; gi < _count; gi++) _slotGesture[_gslot[gi]] = -1; // idempotent for evicted slots
  const topo = _topology;
  if (topo) {
    const entries = topo.entries;
    for (let i = 0; i < entries.length; i++) _slotGesture[entries[i].slot] = -1;
  }
  if (_epSlot >= 0) {
    _slotGesture[_epSlot] = -1;
    _epSlot = -1;
  }
  _injectSlotCount = 0;
  _hasTranslateBounds = false;
}

/** Release heap refs + reset gesture bookkeeping. Lane/pool buffers persist at high-water. */
function disposeGesture(): void {
  _gy.length = 0;
  _count = 0;
  _opCount.fill(0);
  for (let i = 0; i < _textSidecars.length; i++) _textSidecars[i].measured = null;
  for (let i = 0; i < _codeSidecars.length; i++) {
    _codeSidecars[i].source = null;
    _codeSidecars[i].output = undefined;
  }
  _topology = null;
  _injectIds.length = 0;
  _strokePoolLen = 0;
  _epRouteCtx = null;
  _fHandles.length = 0;
  _sx = 1;
  _sy = 1;
  _dx = 0;
  _dy = 0;
  _overlayUniform = false;
}

// ============================================================================
// Freeze (begin) — two passes over selectedIds (cold; double accessor reads accepted)
// ============================================================================

/**
 * Op-qualified freeze-bail predicate — OFFSET freezes are minimal (today's
 * `freezeTranslateEntry` requirements), uniform/reflow require their extra
 * inputs. A bailed id stays in `_injectIds` (locked but never painted as
 * preview → it now draws in place — ledgered) but gets no lanes.
 */
function passFreezeBail(kc: number, op: number, id: string, y: Y.Map<unknown>): boolean {
  switch (op) {
    case OP_OFFSET:
      switch (kc) {
        case K_SHAPE:
        case K_IMAGE:
          return !!getFrame(y);
        case K_STROKE:
          return (getPoints(y) as Point[]).length > 0;
        case K_TEXT:
          return !!getTextProps(y); // getTextFrame null is NOT a bail — column fallback
        case K_CODE:
          return !!getOrigin(y);
        default:
          return !!getOrigin(y); // note / bookmark
      }
    case OP_FRAME_UNIFORM:
    case OP_FRAME_EDGES:
      return !!getFrame(y);
    case OP_STROKE_UNIFORM:
      return (getPoints(y) as Point[]).length > 0;
    case OP_ORIGIN_UNIFORM:
      switch (kc) {
        case K_TEXT:
          return !!getTextProps(y) && !!getTextFrame(id);
        case K_CODE:
          return !!getCodeProps(y) && !!getCodeFrame(id); // vestigial frame bail — kept (parity)
        default:
          return !!getOrigin(y);
      }
    case OP_REFLOW_TEXT:
      return !!getTextProps(y) && !!getTextFrame(id) && textLayoutCache.getMeasuredContent(id) != null;
    case OP_REFLOW_CODE:
      return !!getCodeProps(y) && !!getCodeFrame(id) && !!getCodeSource(id);
    default:
      return false;
  }
}

/**
 * Fill fBBox/fAux for `gi`, seed oBBox/oAux, populate reflow sidecars.
 * Accessors return LIVE Yjs refs — the lane writes ARE the copy. Bail
 * predicates already held in pass 1, so `!` assertions are sound.
 * Returns the code-flag meta bits (0 for everything else).
 */
function freezeLanes(gi: number, kc: number, op: number, slot: number, handle: ObjectHandle, col: Float64Array): number {
  const lanes = _lanes;
  const b = gi * G_STRIDE;
  const y = handle.y;
  const o4 = slot * 4;
  let fb0 = col[o4];
  let fb1 = col[o4 + 1];
  let fb2 = col[o4 + 2];
  let fb3 = col[o4 + 3];
  let flags = 0;

  switch (kc) {
    case K_SHAPE:
    case K_IMAGE: {
      const fr = getFrame(y)!;
      lanes[b + 4] = fr[0];
      lanes[b + 5] = fr[1];
      lanes[b + 6] = fr[2];
      lanes[b + 7] = fr[3];
      break;
    }
    case K_STROKE: {
      const pts = getPoints(y) as Point[];
      lanes[b + 4] = packStrokePoints(pts);
      lanes[b + 5] = pts.length;
      lanes[b + 6] = getWidth(y); // always filled; OFFSET commit ignores it (uniform freeze body)
      lanes[b + 7] = 0;
      break;
    }
    case K_TEXT: {
      const p = getTextProps(y)!;
      const tf = getTextFrame(handle.id);
      // fBBox = TIGHT frame bbox (handle bbox carries italic-overhang pad).
      // OFFSET-only null-frame fallback: the PADDED column rect (today's [...bbox]).
      if (tf) {
        fb0 = tf[0];
        fb1 = tf[1];
        fb2 = tf[0] + tf[2];
        fb3 = tf[1] + tf[3];
      }
      lanes[b + 4] = p.origin[0];
      lanes[b + 5] = p.origin[1];
      lanes[b + 6] = p.fontSize;
      lanes[b + 7] = typeof p.width === 'number' ? p.width : NaN;
      if (op === OP_REFLOW_TEXT) {
        const sc = textSidecarAt(gi - _opStart[OP_REFLOW_TEXT]);
        sc.measured = textLayoutCache.getMeasuredContent(handle.id)!;
        sc.minW = getMinCharWidth(p.fontSize, p.fontFamily);
        sc.anchor = anchorFactor(p.align);
        // Empty the pooled layout: a begin→first-move repaint must paint
        // nothing (old fresh-createTextLayout parity), never a previous
        // gesture's stale glyphs.
        sc.layout.lineCount = 0;
      }
      break;
    }
    case K_CODE: {
      // fBBox = column (≡ tight — computeCodeBBox writes frameToBbox(frame)).
      if (op === OP_OFFSET) {
        const origin = getOrigin(y)!; // today's minimal getOrigin freeze
        lanes[b + 4] = origin[0];
        lanes[b + 5] = origin[1];
        lanes[b + 6] = 0;
        lanes[b + 7] = 0;
      } else {
        const p = getCodeProps(y)!;
        lanes[b + 4] = p.origin[0];
        lanes[b + 5] = p.origin[1];
        lanes[b + 6] = p.fontSize;
        lanes[b + 7] = p.width;
        if (op === OP_REFLOW_CODE) {
          const sc = codeSidecarAt(gi - _opStart[OP_REFLOW_CODE]);
          sc.source = getCodeSource(handle.id)!;
          sc.minW = getCodeMinWidth(p.fontSize);
          sc.output = p.output;
          sc.layout.visualLineCount = 0; // same stale-glyph guard as text
          flags =
            (p.lineNumbers ? META_CODE_LINE_NUMBERS : 0) |
            (p.headerVisible ? META_CODE_HEADER_VISIBLE : 0) |
            (p.outputVisible ? META_CODE_OUTPUT_VISIBLE : 0);
        }
      }
      break;
    }
    default: {
      // K_NOTE / K_BOOKMARK
      const origin = getOrigin(y)!;
      lanes[b + 4] = origin[0];
      lanes[b + 5] = origin[1];
      lanes[b + 6] = (y.get('scale') as number) ?? 1;
      lanes[b + 7] = 0;
      break;
    }
  }

  lanes[b] = fb0;
  lanes[b + 1] = fb1;
  lanes[b + 2] = fb2;
  lanes[b + 3] = fb3;
  // Seed out = frozen — first-frame overlay/cull reads are exact at rest.
  lanes[b + 8] = fb0;
  lanes[b + 9] = fb1;
  lanes[b + 10] = fb2;
  lanes[b + 11] = fb3;
  if (op === OP_STROKE_UNIFORM) {
    // The renderer's stroke arm reads oAux as fcx/fcy/factor from the first
    // overlapping repaint in the begin→first-move window — a blind fAux copy
    // would paint the stroke scaled `width`× around (ptsOff, ptsCount).
    lanes[b + 12] = (fb0 + fb2) / 2;
    lanes[b + 13] = (fb1 + fb3) / 2;
    lanes[b + 14] = 1;
    lanes[b + 15] = 0;
  } else {
    lanes[b + 12] = lanes[b + 4];
    lanes[b + 13] = lanes[b + 5];
    lanes[b + 14] = lanes[b + 6];
    lanes[b + 15] = lanes[b + 7];
  }
  return flags;
}

/** Shared begin body — pass 1 (validate + count), prefix sum, pass 2 (fill), topology. */
function beginGesture(selectedIds: ReadonlySet<string>, isScale: boolean): void {
  ensureSlotMapCapacity();
  const builder = newTopologyBuilder(isScale ? 'scale' : 'translate', selectedIds);
  const lo = getLockOwners();
  const lf = getLockedFlags();
  ensureFreezeCapacity(selectedIds.size);

  // --- pass 1: validate + count per op ---
  let n = 0;
  let allUniform = true;
  for (const id of selectedIds) {
    const handle = getHandle(id);
    // Remote- or durably-locked ids never enter the gesture: no injectIds push
    // (renderer draws them in place), no freeze, no topology entry.
    if (!handle || lo[handle.slot] > 1 || lf[handle.slot] === 1) continue;
    _injectIds.push(id);
    if (handle.kind === 'connector') {
      builder.onSelectedConnector(id, handle);
      continue;
    }
    const kc = KIND_CODE[handle.kind];
    let op: number;
    let beh = BEH_UNIFORM;
    if (isScale) {
      beh = BEHAVIOR_LUT[kc * 8 + _cat * 2 + (_single ? 1 : 0)];
      op = OP_LUT[kc * 4 + beh]; // never 0xFF — BEHAVIOR_LUT can't produce an unpopulated cell
    } else {
      op = OP_OFFSET;
    }
    if (!passFreezeBail(kc, op, id, handle.y)) continue;
    if (beh !== BEH_UNIFORM) allUniform = false;
    _fSlots[n] = handle.slot;
    _fOps[n] = op;
    _fKinds[n] = kc;
    _fHandles[n] = handle;
    n++;
    _opCount[op]++;
  }

  // --- prefix sum → contiguous op ranges ---
  let acc = 0;
  for (let op = 0; op < OP_COUNT; op++) {
    _opStart[op] = acc;
    acc += _opCount[op];
    _opCursor[op] = 0;
  }
  _count = acc;
  ensureGestureCapacity(acc);
  ensureInjectCapacity(acc);

  // --- pass 2: lane fill + registration ---
  const col = getBBoxColumn();
  for (let i = 0; i < n; i++) {
    const op = _fOps[i];
    const gi = _opStart[op] + _opCursor[op]++;
    const handle = _fHandles[i];
    const slot = _fSlots[i];
    const kc = _fKinds[i];
    _gslot[gi] = slot;
    _gy[gi] = handle.y;
    _meta[gi] = kc | (op << META_OP_SHIFT) | freezeLanes(gi, kc, op, slot, handle, col);
    _slotGesture[slot] = gi;
    _injectSlots[_injectSlotCount++] = slot;
    if (isBindableKind(handle.kind)) builder.onSelectedBindable(handle.id, handle.kind, gi, handle);
  }
  _fHandles.length = 0; // don't root handles past begin

  // --- topology ---
  _topology = builder.finalize();
  if (_topology) {
    const entries = _topology.entries;
    ensureInjectCapacity(_injectSlotCount + entries.length);
    for (let ti = 0; ti < entries.length; ti++) {
      const s = entries[ti].slot;
      _slotGesture[s] = TOPO_TAG | ti;
      _injectSlots[_injectSlotCount++] = s;
    }
    // Lock set from the FULL attached set, NOT from `entries` — an attached
    // connector whose entry construction bailed is still lock-acquired today.
    for (const cid of _topology.attachedConnectorIds) _injectIds.push(cid);
  }

  // Overlay rect math: uniformFactor iff every active behavior is uniform, or
  // (all-connector selection) topology on a corner — mirrors the free-endpoint
  // resolver. Behaviors are fixed at begin, so compute once.
  _overlayUniform = isScale && (_count === 0 ? _topology !== null && _corner : allUniform);
}

// ============================================================================
// Scale lifecycle
// ============================================================================

export function beginScale(selectedIds: ReadonlySet<string>, handleId: HandleId, origin: Point, selBounds: BBoxTuple): void {
  clearTransform();
  _mode = MODE_SCALE;
  _single = selectedIds.size === 1; // Set size incl. connectors — today's rule
  _corner = isCorner(handleId);
  _cat = _corner ? CAT_CORNER : isHorzSide(handleId) ? CAT_HSIDE : CAT_VSIDE;
  _scaleCtx.sx = 1;
  _scaleCtx.sy = 1;
  _scaleCtx.origin[0] = origin[0];
  _scaleCtx.origin[1] = origin[1];
  copyBbox(selBounds, _scaleCtx.selBounds); // OWNED copy — see _scaleCtx doc
  _scaleCtx.handleId = handleId;
  beginGesture(selectedIds, true);
}

/** OLD + NEW damage: every entry's current oBBox, text padded by the italic
 *  overhang (±2 vertical). Called before AND after the kernels each frame —
 *  two rects per entry per frame (union rejected: it inflates repaint on fast
 *  drags). Dead entries' stale lanes are pushed too (erases their last
 *  preview). Known divergence, accepted: under translate these rects are
 *  frozen+delta while paint/cull track live+delta — they differ only when a
 *  peer edit lands in the lock-race window, and the loser's commit heal
 *  repaints both rects at pointerup. */
function pushAllDamage(): void {
  const lanes = _lanes;
  const meta = _meta;
  for (let gi = 0; gi < _count; gi++) {
    const b = gi * G_STRIDE;
    if ((meta[gi] & META_KIND_MASK) === K_TEXT) {
      const padH = getItalicOverhangPad(lanes[b + 14]); // oAux2 = live fontSize
      pushDamage(lanes[b + 8] - padH, lanes[b + 9] - 2, lanes[b + 10] + padH, lanes[b + 11] + 2);
    } else {
      pushDamage(lanes[b + 8], lanes[b + 9], lanes[b + 10], lanes[b + 11]);
    }
  }
}

/** Commit-skip / evict damage: one entry rect at lane offset `o` (0 = frozen
 *  fBBox, 8 = current oBBox), text-padded like pushAllDamage — the fontSize
 *  lane rides at `o + 6` in both banks. Cold paths only. */
function pushEntryRect(gi: number, o: number): void {
  const lanes = _lanes;
  const b = gi * G_STRIDE + o;
  if ((_meta[gi] & META_KIND_MASK) === K_TEXT) {
    const padH = getItalicOverhangPad(lanes[b + 6]);
    pushDamage(lanes[b] - padH, lanes[b + 1] - 2, lanes[b + 2] + padH, lanes[b + 3] + 2);
  } else {
    pushDamage(lanes[b], lanes[b + 1], lanes[b + 2], lanes[b + 3]);
  }
}

/** Canonical column rect for `slot` — the no-write epDrag exits (lock heal,
 *  failed route, cancel) must repaint the route the gesture's first move
 *  erased; a successful commit gets this from the observer instead. */
function pushSlotCanonicalRect(slot: number): void {
  const col = getBBoxColumn();
  const o4 = slot * 4;
  pushDamage(col[o4], col[o4 + 1], col[o4 + 2], col[o4 + 3]);
}

function applyReflowTextRange(start: number, end: number, ox: number, sx: number): void {
  const lanes = _lanes;
  for (let gi = start; gi < end; gi++) {
    const b = gi * G_STRIDE;
    const sc = _textSidecars[gi - start];
    const fb0 = lanes[b];
    const fb1 = lanes[b + 1];
    reflowLeftWidth(fb0, lanes[b + 2] - fb0, ox, sx, sc.minW);
    const newLeft = reflowOut[0];
    const targetWidth = reflowOut[1];
    const fontSize = lanes[b + 6];
    const layout = layoutMeasuredContent(sc.measured!, targetWidth, fontSize, sc.layout);
    lanes[b + 12] = newLeft + sc.anchor * targetWidth;
    lanes[b + 13] = lanes[b + 5];
    lanes[b + 14] = fontSize;
    lanes[b + 15] = layout.boxWidth;
    lanes[b + 8] = newLeft;
    lanes[b + 9] = fb1;
    lanes[b + 10] = newLeft + targetWidth;
    lanes[b + 11] = fb1 + layout.lineCount * layout.lineHeight;
  }
}

function applyReflowCodeRange(start: number, end: number, ox: number, sx: number): void {
  const lanes = _lanes;
  const meta = _meta;
  for (let gi = start; gi < end; gi++) {
    const b = gi * G_STRIDE;
    const sc = _codeSidecars[gi - start];
    const fb0 = lanes[b];
    const fb1 = lanes[b + 1];
    reflowLeftWidth(fb0, lanes[b + 2] - fb0, ox, sx, sc.minW);
    const newLeft = reflowOut[0];
    const targetWidth = reflowOut[1];
    const fontSize = lanes[b + 6];
    const m = meta[gi];
    const layout = layoutCodeSourceInto(sc.source!, fontSize, targetWidth, (m & META_CODE_LINE_NUMBERS) !== 0, sc.layout);
    lanes[b + 12] = newLeft;
    lanes[b + 13] = lanes[b + 5];
    lanes[b + 14] = fontSize;
    lanes[b + 15] = layout.totalWidth;
    // blockHeight WITHOUT outputCache — today's transform path (parity over the micro-win).
    const nh = codeBlockHeight(layout, fontSize, (m & META_CODE_HEADER_VISIBLE) !== 0, (m & META_CODE_OUTPUT_VISIBLE) !== 0, sc.output);
    lanes[b + 8] = newLeft;
    lanes[b + 9] = fb1;
    lanes[b + 10] = newLeft + targetWidth;
    lanes[b + 11] = fb1 + nh;
  }
}

export function updateScale(sx: number, sy: number): void {
  if (_mode !== MODE_SCALE) return;
  _sx = sx;
  _sy = sy;
  _scaleCtx.sx = sx;
  _scaleCtx.sy = sy;
  const sel = _scaleCtx.selBounds;
  const ox = _scaleCtx.origin[0];
  const oy = _scaleCtx.origin[1];
  const lanes = _lanes;

  pushAllDamage(); // OLD rects

  if (_opCount[OP_OFFSET] > 0) {
    applyEdgePinRange(
      lanes,
      _opStart[OP_OFFSET],
      _opStart[OP_OFFSET] + _opCount[OP_OFFSET],
      ox,
      oy,
      sx,
      sy,
      sel[0],
      sel[1],
      sel[2],
      sel[3],
    );
  }
  if (_opCount[OP_FRAME_UNIFORM] + _opCount[OP_STROKE_UNIFORM] + _opCount[OP_ORIGIN_UNIFORM] > 0) {
    const U = fillUniformPack(sx, sy, _scaleCtx.handleId, sel[0], sel[1], sel[2], sel[3], ox, oy);
    if (_opCount[OP_FRAME_UNIFORM] > 0) {
      applyFrameUniformRange(lanes, _opStart[OP_FRAME_UNIFORM], _opStart[OP_FRAME_UNIFORM] + _opCount[OP_FRAME_UNIFORM], U);
    }
    if (_opCount[OP_STROKE_UNIFORM] > 0) {
      applyStrokeUniformRange(lanes, _opStart[OP_STROKE_UNIFORM], _opStart[OP_STROKE_UNIFORM] + _opCount[OP_STROKE_UNIFORM], U);
    }
    if (_opCount[OP_ORIGIN_UNIFORM] > 0) {
      applyOriginUniformRange(lanes, _opStart[OP_ORIGIN_UNIFORM], _opStart[OP_ORIGIN_UNIFORM] + _opCount[OP_ORIGIN_UNIFORM], U);
    }
  }
  if (_opCount[OP_FRAME_EDGES] > 0) {
    applyFrameEdgesRange(lanes, _opStart[OP_FRAME_EDGES], _opStart[OP_FRAME_EDGES] + _opCount[OP_FRAME_EDGES], ox, oy, sx, sy);
  }
  if (_opCount[OP_REFLOW_TEXT] > 0) {
    applyReflowTextRange(_opStart[OP_REFLOW_TEXT], _opStart[OP_REFLOW_TEXT] + _opCount[OP_REFLOW_TEXT], ox, sx);
  }
  if (_opCount[OP_REFLOW_CODE] > 0) {
    applyReflowCodeRange(_opStart[OP_REFLOW_CODE], _opStart[OP_REFLOW_CODE] + _opCount[OP_REFLOW_CODE], ox, sx);
  }

  if (_topology) runTopologyScale(_topology, _scaleCtx, lanes);

  pushAllDamage(); // NEW rects — without this the preview trails/vanishes (RenderLoop clips to dirty rects)
  flushDamage();
}

// ============================================================================
// Translate lifecycle
// ============================================================================

export function beginTranslate(selectedIds: ReadonlySet<string>, selBounds: BBoxTuple): void {
  clearTransform();
  _mode = MODE_TRANSLATE;
  copyBbox(selBounds, _translateSelBounds); // owned copy — same aliasing hazard as _scaleCtx
  _hasTranslateBounds = true;
  beginGesture(selectedIds, false);
}

export function updateTranslate(dx: number, dy: number): void {
  if (_mode !== MODE_TRANSLATE) return;
  _dx = dx;
  _dy = dy;
  pushAllDamage(); // OLD rects
  applyOffsetRange(_lanes, 0, _count, dx, dy); // translate ignores ops — one branchless loop
  if (_topology) runTopologyTranslate(_topology, dx, dy, _lanes);
  pushAllDamage(); // NEW rects
  flushDamage();
}

// ============================================================================
// Endpoint drag lifecycle — ported, slot-registered
// ============================================================================

/**
 * Begin an endpoint-drag gesture. Builds RouteContext, seeds the reused
 * scratches (bbox seeds read the COLUMN, not handle.bbox), registers the
 * connector's slot under EPDRAG_TAG. Returns false when `buildRouteContext`
 * fails (partially-built connector); SelectTool stays idle. Zero per-gesture
 * allocation.
 */
export function beginEndpointDrag(connectorId: string, slot: Slot, handle: ObjectHandle): boolean {
  clearTransform();
  if (getLockOwners()[handle.slot] > 1 || isLockedObject(handle)) return false; // remote-/durably-locked — stay idle
  const routeCtx = buildRouteContext(connectorId, handle.y);
  if (!routeCtx) return false;
  _mode = MODE_EP_DRAG;
  ensureSlotMapCapacity();
  const e = _epDragEntryScratch;
  e.id = connectorId;
  e.slot = handle.slot;
  const col = getBBoxColumn();
  const o4 = handle.slot * 4;
  e.currBbox[0] = col[o4];
  e.currBbox[1] = col[o4 + 1];
  e.currBbox[2] = col[o4 + 2];
  e.currBbox[3] = col[o4 + 3];
  // validCount = 0 alone resets visible state — pointsBuf keeps its high-water
  // tuples (buffer-length contract: consumers iterate by count, the reroute
  // reuses tuples find-or-push; truncating would just re-allocate them).
  e.validCount = 0;
  copyBbox(e.currBbox, _epDragPrevBbox);
  _epRouteCtx = routeCtx;
  _epDragSlotArg = slot;
  _epSlot = handle.slot;
  _slotGesture[handle.slot] = EPDRAG_TAG;
  _injectSlots[0] = handle.slot;
  _injectSlotCount = 1;
  _injectIds.push(connectorId);
  return true;
}

/** Per-event endpoint-drag update. `snap` is null when unsnapped (free position). */
export function updateEndpointDrag(worldX: number, worldY: number, snap: SnapTarget | null): void {
  if (_mode !== MODE_EP_DRAG || !_epRouteCtx) return;
  const e = _epDragEntryScratch;
  // Snapshot CURRENT (just-painted) bbox into prevBbox BEFORE the reroute mutates currBbox.
  copyBbox(e.currBbox, _epDragPrevBbox);
  pushDamage(_epDragPrevBbox[0], _epDragPrevBbox[1], _epDragPrevBbox[2], _epDragPrevBbox[3]); // OLD
  const override: EndpointDragOverride = snap ?? [worldX, worldY];
  const count = rerouteEndpointDragInto(_epRouteCtx, _epDragSlotArg, override, e.currBbox, e.pointsBuf);
  e.validCount = count;
  if (count > 0) {
    // Union the label rect at the new midpoint so the dirty rect covers the
    // glyphs as the dragged endpoint reshapes the route.
    unionConnectorLabelRectInto(e.id, e.pointsBuf, count, e.currBbox);
    pushDamage(e.currBbox[0], e.currBbox[1], e.currBbox[2], e.currBbox[3]); // NEW
  }
  flushDamage();
}

/**
 * Commit endpoint drag. Returns true when a Y.Map write happened (validCount
 * ≥ 2); false on failed routes. Always tears down (sparse slot cleared on
 * EVERY exit).
 */
export function commitEndpointDrag(snap: SnapTarget | null): boolean {
  if (_mode !== MODE_EP_DRAG) return false;
  const e = _epDragEntryScratch;
  pushDamage(_epDragPrevBbox[0], _epDragPrevBbox[1], _epDragPrevBbox[2], _epDragPrevBbox[3]);
  if (e.validCount >= 2) pushDamage(e.currBbox[0], e.currBbox[1], e.currBbox[2], e.currBbox[3]);
  flushDamage();
  if (e.validCount < 2) {
    pushSlotCanonicalRect(e.slot); // no write coming — repaint the canonical route
    flushDamage();
    derender();
    disposeGesture();
    return false;
  }
  const epSlot = _epDragSlotArg;
  const validCount = e.validCount;
  const id = e.id;
  // Lost first-wins arbitration mid-drag (peer key overwrote our optimistic
  // claim) — heal by dropping the commit. Id-keyed recheck: slots recycle, ids don't.
  const h = getHandle(id);
  if (h && (getLockOwners()[h.slot] > 1 || isLockedObject(h))) {
    pushSlotCanonicalRect(h.slot); // dropped commit — same canonical repaint as the failed-route exit
    flushDamage();
    derender();
    disposeGesture();
    return false;
  }
  const src = e.pointsBuf[slotPointIndex(epSlot, validCount)];
  const value: ConnectorEndpoint = snap ? anchorRecordFromSnap(snap) : ([src[0], src[1]] as Point);
  transact(() => {
    const yMap = getObjects().get(id);
    if (!yMap) return;
    yMap.set(slotKey(epSlot), value);
  });
  derender();
  disposeGesture();
  return true;
}

// ============================================================================
// Shared lifecycle
// ============================================================================

/** Build + write commit values for one live, unlocked entry. */
function commitEntry(gi: number, m: number): void {
  const y = _gy[gi]!;
  const lanes = _lanes;
  const b = gi * G_STRIDE;
  const op = (m >>> META_OP_SHIFT) & META_OP_MASK;
  switch (op) {
    case OP_OFFSET: {
      const kc = m & META_KIND_MASK;
      if (kc === K_SHAPE || kc === K_IMAGE) {
        y.set('frame', [lanes[b + 12], lanes[b + 13], lanes[b + 14], lanes[b + 15]]);
      } else if (kc === K_STROKE) {
        const off = lanes[b + 4] | 0;
        const cnt = lanes[b + 5] | 0;
        const dx = lanes[b + 8] - lanes[b];
        const dy = lanes[b + 9] - lanes[b + 1];
        const pts: Point[] = new Array(cnt);
        for (let i = 0; i < cnt; i++) pts[i] = [_strokePool[off + i * 2] + dx, _strokePool[off + i * 2 + 1] + dy];
        y.set('points', pts);
      } else {
        y.set('origin', [lanes[b + 12], lanes[b + 13]]); // origin ONLY — old commitOrigin
      }
      break;
    }
    case OP_FRAME_UNIFORM:
    case OP_FRAME_EDGES:
      y.set('frame', [lanes[b + 12], lanes[b + 13], lanes[b + 14], lanes[b + 15]]);
      break;
    case OP_STROKE_UNIFORM: {
      const off = lanes[b + 4] | 0;
      const cnt = lanes[b + 5] | 0;
      const ncx = (lanes[b + 8] + lanes[b + 10]) / 2;
      const ncy = (lanes[b + 9] + lanes[b + 11]) / 2;
      const fcx = lanes[b + 12];
      const fcy = lanes[b + 13];
      const af = lanes[b + 14];
      const pts: Point[] = new Array(cnt);
      for (let i = 0; i < cnt; i++) {
        pts[i] = [ncx + (_strokePool[off + i * 2] - fcx) * af, ncy + (_strokePool[off + i * 2 + 1] - fcy) * af];
      }
      y.set('points', pts);
      y.set('width', lanes[b + 6] * af);
      break;
    }
    case OP_ORIGIN_UNIFORM: {
      const kc = m & META_KIND_MASK;
      y.set('origin', [lanes[b + 12], lanes[b + 13]]);
      if (kc === K_TEXT) {
        y.set('fontSize', lanes[b + 14]);
        if (!Number.isNaN(lanes[b + 15])) y.set('width', lanes[b + 15]); // 'auto' flows as NaN — skip
      } else if (kc === K_CODE) {
        y.set('fontSize', lanes[b + 14]);
        y.set('width', lanes[b + 15]);
      } else {
        y.set('scale', lanes[b + 14]); // note / bookmark
      }
      break;
    }
    case OP_REFLOW_TEXT:
    case OP_REFLOW_CODE:
      // origin + width ONLY (no fontSize) — old commitReflow.
      y.set('origin', [lanes[b + 12], lanes[b + 13]]);
      y.set('width', lanes[b + 15]);
      break;
  }
}

/** Commit scale/translate: derender first (renderer sees idle before the
 *  observer repaints), then ONE transact over live, unlocked entries. */
export function commitTransform(): void {
  const n = _count;
  const mode = _mode;
  const dx = _dx;
  const dy = _dy;
  const topology = _topology;
  derender();
  const lo = getLockOwners();
  const lf = getLockedFlags();
  transact(() => {
    for (let gi = 0; gi < n; gi++) {
      const m = _meta[gi];
      // Dead FIRST — a recycled slot's lock lanes belong to someone else.
      // No damage here: transformEvictSlot already erased the dead preview.
      if (m & META_DEAD) continue;
      const slot = _gslot[gi];
      if (lo[slot] > 1 || lf[slot] === 1) {
        // Loser's heal — peer won first-wins mid-gesture. The skip means no
        // write, so no observer repaint: erase the preview (oBBox) and restore
        // the canonical rect (fBBox) that the first pushAllDamage erased.
        pushEntryRect(gi, 8);
        pushEntryRect(gi, 0);
        continue;
      }
      commitEntry(gi, m);
    }
    if (topology && (mode === MODE_SCALE || mode === MODE_TRANSLATE)) {
      commitTopology(topology, mode === MODE_SCALE ? 'scale' : 'translate', dx, dy);
    }
  });
  flushDamage(); // skip-path rects (ours + commitTopology's lockedElsewhere) — no-op when none pushed
  disposeGesture();
}

/** Drop the gesture without committing (no-change pointerup). */
export function clearTransform(): void {
  derender();
  disposeGesture();
}

/** Cancel (Esc / kind-change / room switch). Endpoint drag uses precise dirty
 *  rects (single connector); translate/scale full-repaint — cancel is rare. */
export function cancelTransform(): void {
  if (_mode === MODE_EP_DRAG) {
    const e = _epDragEntryScratch;
    pushDamage(_epDragPrevBbox[0], _epDragPrevBbox[1], _epDragPrevBbox[2], _epDragPrevBbox[3]);
    if (e.validCount >= 2) pushDamage(e.currBbox[0], e.currBbox[1], e.currBbox[2], e.currBbox[3]);
    pushSlotCanonicalRect(e.slot); // no write on cancel — repaint the canonical route
    flushDamage();
    derender();
    disposeGesture();
    return;
  }
  invalidateWorldAll();
  if (_topology) cancelTopology(_topology);
  derender();
  disposeGesture();
}

/** True only after a meaningful update (sx/sy ≠ 1, or dx/dy ≠ 0). */
export function transformHasChange(): boolean {
  if (_mode === MODE_TRANSLATE) return _dx !== 0 || _dy !== 0;
  if (_mode === MODE_SCALE) return _sx !== 1 || _sy !== 1;
  return false;
}

// ============================================================================
// Mid-gesture eviction (RoomDocManager only)
// ============================================================================

/**
 * A slot died (Phase A delete) or converted kind mid-gesture: clear its map
 * cell; gesture entries also get the DEAD meta bit (commit-skip). Lanes/meta
 * are otherwise untouched — `pushAllDamage` keeps erasing the dead entry's
 * lanes while moves continue. The push+flush here covers the other path:
 * release (or kind-converted canonical redraw) WITHOUT another pointermove,
 * where nothing else would ever erase the last preview pixels. Fires inside
 * the synchronous observer (where invalidation is already legal), never
 * between the renderer's `ensureRanksValid()` and its pack loop.
 */
export function transformEvictSlot(slot: number): void {
  if (_mode === MODE_NONE) return;
  if (slot >= _slotGesture.length) return;
  const g = _slotGesture[slot];
  if (g < 0) return;
  _slotGesture[slot] = -1;
  if ((g & (TOPO_TAG | EPDRAG_TAG)) === 0) {
    _meta[g] |= META_DEAD;
    pushEntryRect(g, 8);
  } else if (g & TOPO_TAG) {
    const e = _topology!.entries[g & GIDX_MASK]; // TOPO tags exist ⇒ topology non-null until dispose
    pushDamage(e.currBbox[0], e.currBbox[1], e.currBbox[2], e.currBbox[3]);
  } else {
    const e = _epDragEntryScratch;
    pushDamage(e.currBbox[0], e.currBbox[1], e.currBbox[2], e.currBbox[3]);
  }
  flushDamage();
}

// ============================================================================
// Getters — renderer / overlay / store consumers
// ============================================================================

/** 0 = none, 1 = scale, 2 = translate, 3 = endpointDrag. */
export function getTransformModeCode(): number {
  return _mode;
}

/** Sparse slot→gesture map; capacity ensured ≥ slotHighWater on every fetch
 *  (peers mint slots mid-gesture). Refetch per frame. */
export function getGestureSlotMap(): Int32Array {
  ensureSlotMapCapacity();
  return _slotGesture;
}

export function getGestureLanes(): Float64Array {
  return _lanes;
}

export function getGestureMeta(): Uint32Array {
  return _meta;
}

export function getInjectSlots(): Uint32Array {
  return _injectSlots;
}

export function getInjectSlotCount(): number {
  return _injectSlotCount;
}

export function getTopoEntries(): readonly ConnectorEntry[] | null {
  return _topology ? _topology.entries : null;
}

/** Synthetic connector entry for the active endpoint-drag gesture (null otherwise). */
export function getEndpointDragEntry(): EndpointDragEntry | null {
  return _mode === MODE_EP_DRAG ? _epDragEntryScratch : null;
}

export function getTranslateDX(): number {
  return _dx;
}

export function getTranslateDY(): number {
  return _dy;
}

/** Null unless scaling — the object is persistent and must not leak stale gesture consts. */
export function getTransformScaleCtx(): ScaleCtx | null {
  return _mode === MODE_SCALE ? _scaleCtx : null;
}

/** Overlay-only: uniformFactor rect vs per-axis rect. Gated on scale mode —
 *  `_overlayUniform` is computed only at beginScale. */
export function isOverlayUniform(): boolean {
  return _mode === MODE_SCALE && _overlayUniform;
}

export function getTranslateSelBounds(): BBoxTuple | null {
  return _hasTranslateBounds ? _translateSelBounds : null;
}

/** Reflow entry's pooled layout (renderer's REFLOW_* arms). */
export function getReflowLayout(gi: number): TextLayout | CodeLayout | null {
  const op = (_meta[gi] >>> META_OP_SHIFT) & META_OP_MASK;
  if (op === OP_REFLOW_TEXT) return _textSidecars[gi - _opStart[OP_REFLOW_TEXT]].layout;
  if (op === OP_REFLOW_CODE) return _codeSidecars[gi - _opStart[OP_REFLOW_CODE]].layout;
  return null;
}

/**
 * Copy a gesture entry's out-bbox into `out` — image-manager's narrow
 * accessor. Guards: OOB slot (an `undefined < 0` compare is false and would
 * decode gi 0's lanes), non-membership, topology/epDrag tags.
 */
export function readGestureOutBBox(slot: number, out: BBoxTuple): boolean {
  if (slot >= _slotGesture.length) return false;
  const g = _slotGesture[slot];
  if (g < 0) return false;
  if ((g & (TOPO_TAG | EPDRAG_TAG)) !== 0) return false;
  const b = g * G_STRIDE;
  out[0] = _lanes[b + 8];
  out[1] = _lanes[b + 9];
  out[2] = _lanes[b + 10];
  out[3] = _lanes[b + 11];
  return true;
}

/** LOCKS ONLY — selection-store's acquireTransformLocks. Reused buffer; null when idle. */
export function getTransformInjectIds(): readonly string[] | null {
  return _mode === MODE_NONE ? null : _injectIds;
}
