/**
 * Transform System — entry-based scale/translate with typed per-kind dispatch.
 *
 * Atom-based: arithmetic primitives live in `core/geometry/scale-system.ts`. transform.ts
 * orchestrates lifecycle, dispatch, and freeze/commit. EdgePin and translate share one
 * offset pipeline (`applyOffset`); the only difference is whether the delta comes from
 * gesture state or `edgePinDelta(bbox, ctx)`.
 */

import type * as Y from 'yjs';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectKind, TextAlign, TextWidth } from '@/core/types/objects';
import { OBJECT_KINDS } from '@/core/types/objects';
import type { HandleId } from '@/core/types/handles';
import { isCorner, isHorzSide } from '@/core/types/handles';
import {
  scaleAround,
  scaleBBoxUniform,
  scaleBBoxEdges,
  edgePinDelta,
  derivePaddedFrame,
  roundProp,
  computeReflowWidth,
} from '@/core/geometry/scale-system';
import {
  frameToBbox,
  bboxToFrame,
  bboxCenter,
  copyBbox,
  offsetPoint,
  offsetBBox,
  offsetFrame as offsetFrameMut,
  offsetPoints as offsetPointsMut,
  setBBoxXYWH,
  translateBBox,
} from '@/core/geometry/bounds';
import { getHandle, transact, getObjects } from '@/runtime/room-runtime';
import { getFrame, getPoints, getWidth, getOrigin, getTextProps, getCodeProps } from '@/core/accessors';
import {
  getTextFrame,
  textLayoutCache,
  getMinCharWidth,
  layoutMeasuredContent,
  anchorFactor,
  type TextLayout,
} from '@/core/text/text-system';
import {
  getCodeFrame,
  codeSystem,
  computeLayout as computeCodeLayout,
  blockHeight as codeBlockHeight,
  getMinWidth as getCodeMinWidth,
  type CodeLayout,
} from '@/core/code/code-system';
import { invalidateWorldBBox } from '@/renderer/RenderLoop';
import { rerouteConnector, type EndpointOverrideValue } from '@/core/connectors/reroute-connector';
import { computeConnectorTopology } from './connector-topology';
import type { ConnectorTopology, EndpointSpec, KindCounts as SelectionKindCounts, ScaleCtx } from './types';

// ============================================================================
// Structural Traits — field-set atoms for generic function signatures
// ============================================================================

type HasOrigin = { origin: Point };
type HasBBox = { bbox: BBoxTuple };
type HasFrame = { frame: FrameTuple };
type HasScale = { scale: number };
type HasFontSize = { fontSize: number };
type HasWidth = { width: number };
type HasPoints = { points: Point[] };

// ============================================================================
// Mapped Types — Single Source of Truth (composed from traits)
// ============================================================================

type ScalableKind = Exclude<ObjectKind, 'connector'>;
type MeasuredContent = ReturnType<typeof textLayoutCache.getMeasuredContent>;

type GeoMap = {
  shape: HasFrame & HasBBox;
  image: HasFrame & HasBBox;
  // width is uniform-only (used by commitStrokeUniform). Translate/edgePin freeze omits it.
  stroke: HasPoints & HasBBox & { width?: number };
  // fontSize/width are uniform+reflow only; align/measured/minW are reflow-only.
  text: HasOrigin &
    HasBBox & {
      fontSize?: number;
      width?: TextWidth;
      align?: TextAlign;
      measured?: MeasuredContent | null;
      minW?: number;
    };
  // fontSize/width are uniform+reflow only; the rest are reflow-only.
  code: HasOrigin &
    HasBBox & {
      fontSize?: number;
      width?: number;
      sourceLines?: string[] | null;
      lineNumbers?: boolean;
      headerVisible?: boolean;
      outputVisible?: boolean;
      output?: string | undefined;
      minW?: number;
    };
  note: HasOrigin & HasBBox & { scale?: number };
  bookmark: HasOrigin & HasBBox & { scale?: number };
  connector: never;
};

type OutMap = {
  shape: HasFrame & HasBBox;
  image: HasFrame & HasBBox;
  // No points/width — gestures only update bbox; commitStrokeOffset/Uniform read frozen.
  stroke: HasBBox & { factor: number; fcx: number; fcy: number };
  text: HasOrigin & HasFontSize & HasWidth & HasBBox & { layout: TextLayout | null };
  code: HasOrigin & HasFontSize & HasWidth & HasBBox & { layout: CodeLayout | null };
  note: HasOrigin & HasScale & HasBBox;
  bookmark: HasOrigin & HasScale & HasBBox;
  connector: never;
};

export type GeoOf<K extends ObjectKind> = GeoMap[K];
export type OutOf<K extends ObjectKind> = OutMap[K];

// ============================================================================
// Entry + Store — Generics Survive Through Indexed Access
// ============================================================================

export interface Entry<K extends ObjectKind = ObjectKind> {
  readonly id: string;
  readonly y: Y.Map<unknown>;
  readonly frozen: Readonly<GeoOf<K>>;
  out: OutOf<K>;
  prevBbox: BBoxTuple;
}

type EntryStore = { [K in ObjectKind]?: Map<string, Entry<K>> };

// ============================================================================
// Behavior Resolution
// ============================================================================

export type ScaleBehavior = 'uniform' | 'nonUniform' | 'edgePin' | 'reflow';

type HandleCat = 'corner' | 'hSide' | 'vSide';
type Comp = 'only' | 'mixed';
type BKey = `${ScalableKind}_${HandleCat}_${Comp}`;

const DEFAULT_BEHAVIOR: Record<HandleCat, Record<Comp, ScaleBehavior>> = {
  corner: { only: 'uniform', mixed: 'uniform' },
  hSide: { only: 'uniform', mixed: 'edgePin' },
  vSide: { only: 'uniform', mixed: 'edgePin' },
};

/** Exceptions: shapes do nonUniform everywhere, text/code reflow on E/W always. */
const BEHAVIOR_OVERRIDES: Partial<Record<BKey, ScaleBehavior>> = {
  shape_corner_only: 'nonUniform',
  shape_hSide_only: 'nonUniform',
  shape_hSide_mixed: 'nonUniform',
  shape_vSide_only: 'nonUniform',
  shape_vSide_mixed: 'nonUniform',
  text_hSide_only: 'reflow',
  text_hSide_mixed: 'reflow',
  code_hSide_only: 'reflow',
  code_hSide_mixed: 'reflow',
};

function resolveBehavior(kind: ScalableKind, handleId: HandleId, mixed: boolean): ScaleBehavior {
  const cat: HandleCat = isCorner(handleId) ? 'corner' : isHorzSide(handleId) ? 'hSide' : 'vSide';
  return BEHAVIOR_OVERRIDES[`${kind}_${cat}_${mixed ? 'mixed' : 'only'}`] ?? DEFAULT_BEHAVIOR[cat][mixed ? 'mixed' : 'only'];
}

function countKinds(c: SelectionKindCounts): number {
  let n = 0;
  for (const k of OBJECT_KINDS) if (c[k] > 0) n++;
  return n;
}

// ============================================================================
// Scale Apply Functions — atoms compose atoms
// ============================================================================

/** Shape/image: scale bbox uniformly, derive frame with constant stroke padding. */
function scaleFrameUniform(f: HasFrame & HasBBox, ctx: ScaleCtx, o: HasFrame & HasBBox): void {
  scaleBBoxUniform(o.bbox, f.bbox, ctx);
  derivePaddedFrame(o.frame, o.bbox, f.frame, f.bbox);
}

/** Shape: scale bbox edges independently, derive frame with constant stroke padding. */
function scaleFrameNonUniform(f: HasFrame & HasBBox, ctx: ScaleCtx, o: HasFrame & HasBBox): void {
  scaleBBoxEdges(o.bbox, f.bbox, ctx);
  derivePaddedFrame(o.frame, o.bbox, f.frame, f.bbox);
}

/** Stroke uniform: bbox-only update; renderer uses ctx.scale around frozen center. */
function scaleStrokeBBox(f: GeoOf<'stroke'>, ctx: ScaleCtx, o: OutOf<'stroke'>): void {
  const [fcx, fcy] = bboxCenter(f.bbox);
  o.fcx = fcx;
  o.fcy = fcy;
  o.factor = scaleBBoxUniform(o.bbox, f.bbox, ctx);
}

/**
 * Origin-based uniform scale shared by text/code/note/bookmark.
 * Invariant: new_origin = new_bbox_min + (frozen_origin - frozen_bbox_min) * effective_factor.
 * Returns [rounded, ef] so callers write the prop and apply ef to derived width/etc.
 */
function scaleBBoxOriginProp(
  f: HasOrigin & HasBBox,
  ctx: ScaleCtx,
  o: HasOrigin & HasBBox,
  propVal: number,
): [rounded: number, ef: number] {
  const af = scaleBBoxUniform(o.bbox, f.bbox, ctx);
  const [rounded, ef] = roundProp(propVal, af);
  o.origin[0] = o.bbox[0] + (f.origin[0] - f.bbox[0]) * ef;
  o.origin[1] = o.bbox[1] + (f.origin[1] - f.bbox[1]) * ef;
  return [rounded, ef];
}

/**
 * Uniform scale for text + code. Shared because both are origin+fontSize+width with the
 * same math. The typeof guard handles text's `'auto' | number` width — code's width is
 * always number at runtime, so it falls through the same branch.
 * (`o.layout` stays null throughout a uniform gesture — createOutFor initializes it null
 * and only `reflow` behavior writes a layout, so no reset is needed here.)
 */
function scaleOriginFontSize(
  f: HasOrigin & HasBBox & { fontSize?: number; width?: TextWidth | number },
  ctx: ScaleCtx,
  o: HasOrigin & HasFontSize & HasWidth & HasBBox,
): void {
  const [rounded, ef] = scaleBBoxOriginProp(f, ctx, o, f.fontSize!);
  o.fontSize = rounded;
  o.width = typeof f.width === 'number' ? f.width * ef : NaN;
}

function scaleOriginScale(f: HasOrigin & HasBBox & { scale?: number }, ctx: ScaleCtx, o: HasOrigin & HasScale & HasBBox): void {
  const [rounded] = scaleBBoxOriginProp(f, ctx, o, f.scale!);
  o.scale = rounded;
}

function reflowText(f: GeoOf<'text'>, ctx: ScaleCtx, o: OutOf<'text'>): void {
  const fx = f.bbox[0];
  const fw = f.bbox[2] - f.bbox[0];
  const [newLeft, targetWidth] = computeReflowWidth(fx, fw, ctx.origin[0], ctx.sx, f.minW!);
  const layout = layoutMeasuredContent(f.measured!, targetWidth, f.fontSize!);
  o.origin[0] = newLeft + anchorFactor(f.align!) * targetWidth;
  o.origin[1] = f.origin[1];
  o.width = layout.boxWidth;
  o.layout = layout;
  o.fontSize = f.fontSize!;
  const nh = layout.lines.length * layout.lineHeight;
  setBBoxXYWH(o.bbox, newLeft, f.bbox[1], targetWidth, nh);
}

function reflowCode(f: GeoOf<'code'>, ctx: ScaleCtx, o: OutOf<'code'>): void {
  const fx = f.bbox[0];
  const fw = f.bbox[2] - f.bbox[0];
  const [newLeft, targetWidth] = computeReflowWidth(fx, fw, ctx.origin[0], ctx.sx, f.minW!);
  const layout = computeCodeLayout(f.sourceLines!, f.fontSize!, targetWidth, f.lineNumbers!);
  o.origin[0] = newLeft;
  o.origin[1] = f.origin[1];
  o.width = layout.totalWidth;
  o.layout = layout;
  o.fontSize = f.fontSize!;
  const nh = codeBlockHeight(layout, f.fontSize!, f.headerVisible!, f.outputVisible!, f.output);
  setBBoxXYWH(o.bbox, newLeft, f.bbox[1], targetWidth, nh);
}

// ============================================================================
// Unified Offset Pipeline — translate AND scale-edgePin share one apply
// ============================================================================

/** Field-presence-checked offset apply. Used by both translate and edgePin. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyOffset(f: any, dx: number, dy: number, o: any): void {
  if ('frame' in o) offsetFrameMut(o.frame, f.frame, dx, dy);
  if ('origin' in o) offsetPoint(o.origin, f.origin, dx, dy);
  offsetBBox(o.bbox, f.bbox, dx, dy);
}

/** EdgePin scale: derive delta from bbox, dispatch to applyOffset. */
function edgePinOffset(f: HasBBox, ctx: ScaleCtx, o: HasBBox): void {
  const [dx, dy] = edgePinDelta(f.bbox, ctx);
  applyOffset(f, dx, dy, o);
}

// ============================================================================
// Dispatch Tables
// ============================================================================

type ScaleApplyTable = {
  [K in ScalableKind]: Partial<Record<ScaleBehavior, (f: GeoOf<K>, ctx: ScaleCtx, o: OutOf<K>) => void>>;
};
type ScaleCommitTable = {
  [K in ScalableKind]: Partial<Record<ScaleBehavior, (y: Y.Map<unknown>, o: OutOf<K>, f: Readonly<GeoOf<K>>) => void>>;
};
type TranslateCommitTable = {
  [K in ScalableKind]: (y: Y.Map<unknown>, o: OutOf<K>, f: Readonly<GeoOf<K>>) => void;
};

const APPLY_SCALE: ScaleApplyTable = {
  shape: { uniform: scaleFrameUniform, nonUniform: scaleFrameNonUniform },
  image: { uniform: scaleFrameUniform, edgePin: edgePinOffset },
  stroke: { uniform: scaleStrokeBBox, edgePin: edgePinOffset },
  text: { uniform: scaleOriginFontSize, edgePin: edgePinOffset, reflow: reflowText },
  code: { uniform: scaleOriginFontSize, edgePin: edgePinOffset, reflow: reflowCode },
  note: { uniform: scaleOriginScale, edgePin: edgePinOffset },
  bookmark: { uniform: scaleOriginScale, edgePin: edgePinOffset },
};

// ============================================================================
// Commit Functions
// ============================================================================

function commitFrame(y: Y.Map<unknown>, o: HasFrame): void {
  y.set('frame', [...o.frame]);
}
function commitOrigin(y: Y.Map<unknown>, o: HasOrigin): void {
  y.set('origin', [...o.origin]);
}
function commitOriginScale(y: Y.Map<unknown>, o: HasOrigin & HasScale): void {
  y.set('origin', [...o.origin]);
  y.set('scale', o.scale);
}
function commitTextScale(y: Y.Map<unknown>, o: OutOf<'text'>): void {
  y.set('origin', [...o.origin]);
  y.set('fontSize', o.fontSize);
  if (!isNaN(o.width)) y.set('width', o.width);
}
function commitCodeScale(y: Y.Map<unknown>, o: OutOf<'code'>): void {
  y.set('origin', [...o.origin]);
  y.set('fontSize', o.fontSize);
  y.set('width', o.width);
}
function commitReflow(y: Y.Map<unknown>, o: HasOrigin & HasWidth): void {
  y.set('origin', [...o.origin]);
  y.set('width', o.width);
}

/** Stroke uniform commit: scale points around new center using factor stored on output. */
function commitStrokeUniform(y: Y.Map<unknown>, o: OutOf<'stroke'>, f: Readonly<GeoOf<'stroke'>>): void {
  const [ncx, ncy] = bboxCenter(o.bbox);
  const af = o.factor;
  y.set(
    'points',
    f.points.map(([px, py]) => [ncx + (px - o.fcx) * af, ncy + (py - o.fcy) * af]),
  );
  y.set('width', f.width! * af);
}

/** Stroke offset commit: translate frozen points by bbox delta (edgePin + translate). */
function commitStrokeOffset(y: Y.Map<unknown>, o: OutOf<'stroke'>, f: Readonly<GeoOf<'stroke'>>): void {
  const dx = o.bbox[0] - f.bbox[0];
  const dy = o.bbox[1] - f.bbox[1];
  y.set(
    'points',
    f.points.map(([px, py]) => [px + dx, py + dy]),
  );
}

const COMMIT_SCALE: ScaleCommitTable = {
  shape: { uniform: commitFrame, nonUniform: commitFrame },
  image: { uniform: commitFrame, edgePin: commitFrame },
  stroke: { uniform: commitStrokeUniform, edgePin: commitStrokeOffset },
  text: { uniform: commitTextScale, edgePin: commitOrigin, reflow: commitReflow },
  code: { uniform: commitCodeScale, edgePin: commitOrigin, reflow: commitReflow },
  note: { uniform: commitOriginScale, edgePin: commitOrigin },
  bookmark: { uniform: commitOriginScale, edgePin: commitOrigin },
};

const TRANSLATE_COMMIT: TranslateCommitTable = {
  shape: commitFrame,
  image: commitFrame,
  stroke: commitStrokeOffset,
  text: commitOrigin,
  code: commitOrigin,
  note: commitOrigin,
  bookmark: commitOrigin,
};

// ============================================================================
// Output Factories (pre-allocation)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createOutFor(kind: ObjectKind): any {
  switch (kind) {
    case 'shape':
    case 'image':
      return { frame: [0, 0, 0, 0] as FrameTuple, bbox: [0, 0, 0, 0] as BBoxTuple };
    case 'stroke':
      // No points array allocation — gestures only update bbox.
      return { bbox: [0, 0, 0, 0] as BBoxTuple, factor: 1, fcx: 0, fcy: 0 };
    case 'text':
      return { origin: [0, 0] as Point, fontSize: 0, width: 0, bbox: [0, 0, 0, 0] as BBoxTuple, layout: null };
    case 'code':
      return { origin: [0, 0] as Point, fontSize: 0, width: 0, bbox: [0, 0, 0, 0] as BBoxTuple, layout: null };
    case 'note':
    case 'bookmark':
      return { origin: [0, 0] as Point, scale: 1, bbox: [0, 0, 0, 0] as BBoxTuple };
    default:
      return { bbox: [0, 0, 0, 0] as BBoxTuple };
  }
}

// ============================================================================
// Freeze Functions
// ============================================================================

function freezeScaleEntry(kind: ObjectKind, behavior: ScaleBehavior, id: string, y: Y.Map<unknown>, bbox: BBoxTuple): unknown | null {
  // EdgePin needs exactly what translate needs — same minimal frozen set.
  if (behavior === 'edgePin') return freezeTranslateEntry(kind, id, y, bbox);

  switch (kind) {
    case 'shape':
    case 'image':
      // uniform / nonUniform — same shape as translate freeze (frame + bbox)
      return freezeTranslateEntry(kind, id, y, bbox);

    case 'stroke': {
      // uniform only — needs width for commitStrokeUniform
      const pts = getPoints(y) as Point[];
      if (pts.length === 0) return null;
      return {
        points: pts.map((p) => [...p] as Point),
        width: getWidth(y),
        bbox: [...bbox] as BBoxTuple,
      };
    }

    case 'text': {
      const p = getTextProps(y);
      const tf = getTextFrame(id);
      if (!p || !tf) return null;
      const b = frameToBbox(tf);
      if (behavior === 'reflow') {
        return {
          origin: [...p.origin] as Point,
          bbox: b,
          fontSize: p.fontSize,
          width: p.width,
          align: p.align,
          measured: textLayoutCache.getMeasuredContent(id) ?? null,
          minW: getMinCharWidth(p.fontSize, p.fontFamily),
        };
      }
      // uniform: drop fontFamily, align, frame
      return {
        origin: [...p.origin] as Point,
        bbox: b,
        fontSize: p.fontSize,
        width: p.width,
      };
    }

    case 'code': {
      const p = getCodeProps(y);
      const cf = getCodeFrame(id);
      if (!p || !cf) return null;
      const b = frameToBbox(cf);
      if (behavior === 'reflow') {
        return {
          origin: [...p.origin] as Point,
          bbox: b,
          fontSize: p.fontSize,
          width: p.width,
          sourceLines: codeSystem.getSourceLines(id) ?? null,
          lineNumbers: p.lineNumbers,
          headerVisible: p.headerVisible,
          outputVisible: p.outputVisible,
          output: p.output,
          minW: getCodeMinWidth(p.fontSize),
        };
      }
      // uniform: drop reflow-only fields and frame
      return {
        origin: [...p.origin] as Point,
        bbox: b,
        fontSize: p.fontSize,
        width: p.width,
      };
    }

    case 'note':
    case 'bookmark': {
      const origin = getOrigin(y);
      if (!origin) return null;
      // uniform — needs scale for ratio computation in renderer + commit
      const scale = (y.get('scale') as number) ?? 1;
      return { origin: [...origin] as Point, scale, bbox: [...bbox] as BBoxTuple };
    }

    default:
      return null;
  }
}

function freezeTranslateEntry(kind: ObjectKind, id: string, y: Y.Map<unknown>, bbox: BBoxTuple): unknown | null {
  switch (kind) {
    case 'shape':
    case 'image': {
      const frame = getFrame(y);
      return frame ? { frame: [...frame] as FrameTuple, bbox: [...bbox] as BBoxTuple } : null;
    }
    case 'stroke': {
      // No width — commitStrokeOffset reads only points + bbox.
      const pts = getPoints(y) as Point[];
      if (pts.length === 0) return null;
      return { points: pts.map((p) => [...p] as Point), bbox: [...bbox] as BBoxTuple };
    }
    case 'text': {
      const origin = getOrigin(y);
      if (!origin) return null;
      const derivedFrame = getTextFrame(id);
      const derivedBbox = derivedFrame ? frameToBbox(derivedFrame) : ([...bbox] as BBoxTuple);
      return { origin: [...origin] as Point, bbox: derivedBbox };
    }
    case 'code': {
      const origin = getOrigin(y);
      if (!origin) return null;
      const derivedFrame = getCodeFrame(id);
      const derivedBbox = derivedFrame ? frameToBbox(derivedFrame) : ([...bbox] as BBoxTuple);
      return { origin: [...origin] as Point, bbox: derivedBbox };
    }
    case 'note':
    case 'bookmark': {
      const origin = getOrigin(y);
      if (!origin) return null;
      return { origin: [...origin] as Point, bbox: [...bbox] as BBoxTuple };
    }
    default:
      return null;
  }
}

// ============================================================================
// TransformController
// ============================================================================

export class TransformController {
  private store: EntryStore = {};
  private activeKinds: ScalableKind[] = [];
  private behaviors: Partial<Record<ScalableKind, ScaleBehavior>> = {};
  private scaleCtx: ScaleCtx | null = null;
  dx = 0;
  dy = 0;
  private mode: 'none' | 'scale' | 'translate' = 'none';
  private topology: ConnectorTopology | null = null;

  // --- Scale lifecycle ---

  beginScale(
    selectedIds: ReadonlySet<string>,
    kindCounts: SelectionKindCounts,
    handleId: HandleId,
    origin: Point,
    selBounds: BBoxTuple,
  ): void {
    this.clear();
    this.mode = 'scale';
    const mixed = countKinds(kindCounts) > 1;

    this.scaleCtx = { sx: 1, sy: 1, origin, selBounds, handleId };

    for (const id of selectedIds) {
      const handle = getHandle(id);
      if (!handle || handle.kind === 'connector') continue;

      const behavior = resolveBehavior(handle.kind, handleId, mixed);

      // Reflow text/code: skip if measured/sourceLines unavailable
      if (behavior === 'reflow' && handle.kind === 'text') {
        const m = textLayoutCache.getMeasuredContent(id);
        if (!m) continue;
      }
      if (behavior === 'reflow' && handle.kind === 'code') {
        const s = codeSystem.getSourceLines(id);
        if (!s) continue;
      }

      const frozen = freezeScaleEntry(handle.kind, behavior, id, handle.y, handle.bbox);
      if (!frozen) continue;

      const out = createOutFor(handle.kind);
      const entry = { id, y: handle.y, frozen, out, prevBbox: [...handle.bbox] as BBoxTuple } as Entry;

      if (!this.store[handle.kind]) this.store[handle.kind] = new Map();
      (this.store[handle.kind] as Map<string, Entry>).set(id, entry);

      if (!this.behaviors[handle.kind]) {
        this.behaviors[handle.kind] = behavior;
        this.activeKinds.push(handle.kind);
      }
    }

    this.topology = computeConnectorTopology('scale', [...selectedIds]);
  }

  updateScale(sx: number, sy: number): void {
    if (!this.scaleCtx) return;
    this.scaleCtx.sx = sx;
    this.scaleCtx.sy = sy;

    for (const kind of this.activeKinds) {
      const map = this.store[kind]!;
      const behavior = this.behaviors[kind]!;
      // SAFETY: ScaleApplyTable mapped type enforces kind→function compatibility at definition.
      // Cast due to correlated union: TS can't prove APPLY_SCALE[kind] and store[kind] share K.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apply = APPLY_SCALE[kind][behavior] as ((f: any, ctx: ScaleCtx, o: any) => void) | undefined;
      if (!apply) continue;
      for (const [, e] of map) {
        apply(e.frozen, this.scaleCtx, e.out);
        invalidateWorldBBox(e.prevBbox);
        invalidateWorldBBox(e.out.bbox);
        copyBbox(e.out.bbox, e.prevBbox);
      }
    }

    this.updateTopologyReroutes();
  }

  // --- Translate lifecycle ---

  beginTranslate(selectedIds: ReadonlySet<string>): void {
    this.clear();
    this.mode = 'translate';
    this.dx = 0;
    this.dy = 0;

    for (const id of selectedIds) {
      const handle = getHandle(id);
      if (!handle || handle.kind === 'connector') continue;

      const frozen = freezeTranslateEntry(handle.kind, id, handle.y, handle.bbox);
      if (!frozen) continue;

      const out = createOutFor(handle.kind);
      const entry = { id, y: handle.y, frozen, out, prevBbox: [...handle.bbox] as BBoxTuple } as Entry;

      if (!this.store[handle.kind]) this.store[handle.kind] = new Map();
      (this.store[handle.kind] as Map<string, Entry>).set(id, entry);

      if (!this.activeKinds.includes(handle.kind)) this.activeKinds.push(handle.kind);
    }

    this.topology = computeConnectorTopology('translate', [...selectedIds]);
  }

  updateTranslate(dx: number, dy: number): void {
    this.dx = dx;
    this.dy = dy;

    // Translate is uniform across kinds — call applyOffset directly, no dispatch table.
    for (const kind of this.activeKinds) {
      const map = this.store[kind]!;
      for (const [, e] of map) {
        applyOffset(e.frozen, dx, dy, e.out);
        invalidateWorldBBox(e.prevBbox);
        invalidateWorldBBox(e.out.bbox);
        copyBbox(e.out.bbox, e.prevBbox);
      }
    }

    this.updateTopologyReroutes();
  }

  // --- Shared lifecycle ---

  commit(): void {
    const store = this.store;
    const behaviors = this.behaviors;
    const topology = this.topology;
    const mode = this.mode;

    // Clear visual state FIRST (prevents double-transform glitch)
    this.clear();

    transact(() => {
      for (const kind in store) {
        const k = kind as ScalableKind;
        const map = store[k];
        if (!map) continue;
        if (mode === 'scale') {
          const behavior = behaviors[k];
          // SAFETY: ScaleCommitTable mapped type enforces kind→function compatibility at definition.
          const commitFn = behavior
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (COMMIT_SCALE[k][behavior] as ((y: Y.Map<unknown>, o: any, f: any) => void) | undefined)
            : undefined;
          if (!commitFn) continue;
          for (const [, e] of map) commitFn(e.y, e.out, e.frozen);
        } else {
          // SAFETY: TranslateCommitTable mapped type enforces kind→function compatibility at definition.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const commitFn = TRANSLATE_COMMIT[k] as (y: Y.Map<unknown>, o: any, f: any) => void;
          for (const [, e] of map) commitFn(e.y, e.out, e.frozen);
        }
      }
      this.commitTopologyEntries(topology);
    });
  }

  cancel(): void {
    // Invalidate dirty rects
    for (const kind in this.store) {
      const map = this.store[kind as ObjectKind];
      if (!map) continue;
      for (const [, e] of map) {
        invalidateWorldBBox(e.prevBbox);
        invalidateWorldBBox(e.out.bbox);
      }
    }
    if (this.topology) {
      for (const entry of this.topology.entries) {
        const prev = this.topology.prevBboxes.get(entry.connectorId);
        if (prev) invalidateWorldBBox(prev);
        invalidateWorldBBox(entry.originalBbox);
      }
    }
    this.clear();
  }

  clear(): void {
    this.store = {};
    this.activeKinds = [];
    this.behaviors = {};
    this.scaleCtx = null;
    this.dx = 0;
    this.dy = 0;
    this.mode = 'none';
    this.topology = null;
  }

  // --- Topology ---

  private resolveTopologySpec(spec: EndpointSpec, pos: [number, number]): EndpointOverrideValue | undefined {
    if (typeof spec === 'string') {
      // Frame override from entry
      const frame = this.getEntryFrame(spec);
      if (frame) return { frame };
      // Fallback: original frame from topology
      const orig = this.topology?.originalFrames.get(spec);
      return orig ? { frame: orig } : undefined;
    }
    if (spec !== true) return undefined;
    if (this.mode === 'translate') return [pos[0] + this.dx, pos[1] + this.dy];
    if (this.scaleCtx) {
      const { origin, sx, sy } = this.scaleCtx;
      return [scaleAround(pos[0], origin[0], sx), scaleAround(pos[1], origin[1], sy)];
    }
    return undefined;
  }

  private updateTopologyReroutes(): void {
    const topology = this.topology;
    if (!topology) return;

    for (const entry of topology.entries) {
      if (entry.strategy === 'translate') {
        const dx = this.dx,
          dy = this.dy;
        offsetPointsMut(entry.translatedPoints, entry.originalPoints, dx, dy);
        topology.reroutes.set(entry.connectorId, entry.translatedPoints);

        const prev = topology.prevBboxes.get(entry.connectorId);
        if (prev) invalidateWorldBBox(prev);
        const translated = translateBBox(entry.originalBbox, dx, dy);
        invalidateWorldBBox(entry.originalBbox);
        invalidateWorldBBox(translated);
        topology.prevBboxes.set(entry.connectorId, translated);
        continue;
      }

      // Reroute entries
      const overrides: Record<string, EndpointOverrideValue> = {};
      const s = this.resolveTopologySpec(entry.startSpec, entry.originalPoints[0]);
      const e = this.resolveTopologySpec(entry.endSpec, entry.originalPoints[entry.originalPoints.length - 1]);
      if (s) overrides.start = s;
      if (e) overrides.end = e;

      const hasOverrides = overrides.start !== undefined || overrides.end !== undefined;
      const result = rerouteConnector(entry.connectorId, hasOverrides ? overrides : undefined);
      topology.reroutes.set(entry.connectorId, result?.points ?? null);

      const prev = topology.prevBboxes.get(entry.connectorId);
      if (prev) invalidateWorldBBox(prev);
      if (result) {
        invalidateWorldBBox(result.bbox);
        topology.prevBboxes.set(entry.connectorId, result.bbox);
      }
    }
  }

  private commitTopologyEntries(topology: ConnectorTopology | null): void {
    if (!topology) return;
    const objects = getObjects();
    for (const entry of topology.entries) {
      const yMap = objects.get(entry.connectorId);
      if (!yMap) continue;

      if (entry.strategy === 'translate') {
        const pts = entry.translatedPoints.map((p) => [...p] as [number, number]);
        yMap.set('points', pts);
        yMap.set('start', [...entry.translatedPoints[0]] as [number, number]);
        yMap.set('end', [...entry.translatedPoints[entry.translatedPoints.length - 1]] as [number, number]);
      } else {
        const points = topology.reroutes.get(entry.connectorId);
        if (!points || points.length < 2) continue;
        yMap.set('points', points);
        yMap.set('start', points[0]);
        yMap.set('end', points[points.length - 1]);
      }
    }
  }

  // --- Accessors ---

  getEntryFrame(id: string): FrameTuple | null {
    for (const kind in this.store) {
      const map = this.store[kind as ObjectKind];
      if (!map) continue;
      const entry = map.get(id);
      if (!entry) continue;
      if ('frame' in entry.out) return (entry.out as { frame: FrameTuple }).frame;
      return bboxToFrame(entry.out.bbox);
    }
    return null;
  }

  getMode(): 'none' | 'scale' | 'translate' {
    return this.mode;
  }

  getScaleCtx(): ScaleCtx | null {
    return this.scaleCtx;
  }

  getTopology(): ConnectorTopology | null {
    return this.topology;
  }

  getMap<K extends ObjectKind>(kind: K): Map<string, Entry<K>> | undefined {
    return this.store[kind];
  }

  getBehavior(kind: ScalableKind): ScaleBehavior | undefined {
    return this.behaviors[kind];
  }

  hasChange(): boolean {
    if (this.mode === 'translate') return this.dx !== 0 || this.dy !== 0;
    if (this.mode === 'scale' && this.scaleCtx) return this.scaleCtx.sx !== 1 || this.scaleCtx.sy !== 1;
    return false;
  }
}

// ============================================================================
// Module Singleton + Renderer Getters
// ============================================================================

let ctrl: TransformController | null = null;

export function getController(): TransformController {
  if (!ctrl) ctrl = new TransformController();
  return ctrl;
}

export function getScaleEntry<K extends ObjectKind>(kind: K, id: string): Entry<K> | undefined {
  return ctrl?.getMap(kind)?.get(id);
}

export function getScaleBehavior(kind: ScalableKind): ScaleBehavior | undefined {
  return ctrl?.getBehavior(kind);
}

export function getTransformMode(): 'none' | 'scale' | 'translate' {
  return ctrl?.getMode() ?? 'none';
}

export function getTranslateDelta(): [number, number] | null {
  if (!ctrl || ctrl.getMode() !== 'translate') return null;
  return [ctrl.dx, ctrl.dy];
}

export function getTransformTopology(): ConnectorTopology | null {
  return ctrl?.getTopology() ?? null;
}

export function getTransformScaleCtx(): ScaleCtx | null {
  return ctrl?.getScaleCtx() ?? null;
}
