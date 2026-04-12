/**
 * Transform System — entry-based scale/translate with typed per-kind dispatch.
 *
 * Replaces scale-resolve.ts + transform-state.ts. All transform state lives here.
 * SelectTool delegates lifecycle, renderer reads via module getters.
 *
 * Key design:
 *   - GeoOf<K> / OutOf<K> mapped types → generics survive through indexed access
 *   - Template literal behavior table → entire matrix in one glance
 *   - Per-kind dispatch tables → no function refs stored per entry
 *   - TransformController class → encapsulates all mutable state
 */

import type * as Y from 'yjs';
import type { BBoxTuple, FrameTuple, Point } from '@/core/types/geometry';
import type { ObjectKind, TextAlign, FontFamily, TextWidth } from '@/core/types/objects';
import type { HandleId } from '@/core/types/handles';
import { isCorner, isHorzSide } from '@/core/types/handles';
import {
  scaleAround,
  uniformFactor,
  preservePosition,
  edgePinPosition1D,
  roundProp,
  computeReflowWidth,
} from '@/core/geometry/scale-system';
import {
  frameToBbox,
  copyBbox,
  offsetPoint,
  offsetBBox,
  offsetFrame as offsetFrameMut,
  offsetPoints as offsetPointsMut,
  setBBoxXYWH,
} from '@/core/geometry/bounds';
import { getHandle, transact, getObjects } from '@/runtime/room-runtime';
import { getFrame, getPoints, getWidth, getOrigin, getTextProps, getCodeProps } from '@/core/accessors';
import {
  getTextFrame,
  textLayoutCache,
  getMinCharWidth,
  layoutMeasuredContent,
  anchorFactor,
  getBaselineToTopRatio,
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
import { translateBBox } from '@/core/geometry/bounds';
import { computeConnectorTopology } from '@/stores/selection-store';
import type { ConnectorTopology, EndpointSpec, KindCounts as SelectionKindCounts } from './types';

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
  stroke: HasPoints & HasWidth & HasBBox;
  text: HasFrame &
    HasOrigin &
    HasFontSize &
    HasBBox & {
      fontFamily: FontFamily;
      align: TextAlign;
      width: TextWidth;
      measured: MeasuredContent;
      minW: number;
    };
  code: HasFrame &
    HasOrigin &
    HasFontSize &
    HasBBox & {
      width: number;
      sourceLines: string[] | null;
      lineNumbers: boolean;
      headerVisible: boolean;
      outputVisible: boolean;
      output: string | undefined;
      minW: number;
    };
  note: HasOrigin & HasScale & HasBBox;
  bookmark: HasOrigin & HasScale & HasBBox;
  connector: never;
};

type OutMap = {
  shape: HasFrame & HasBBox;
  image: HasFrame & HasBBox;
  stroke: HasPoints & HasWidth & HasBBox & { factor: number; fcx: number; fcy: number };
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
// Scale Context + Behavior
// ============================================================================

export interface ScaleCtx {
  sx: number;
  sy: number;
  origin: Point;
  selBounds: BBoxTuple;
  handleId: HandleId;
}

export type ScaleBehavior = 'uniform' | 'nonUniform' | 'edgePin' | 'reflow';

// ============================================================================
// Behavior Table — Template Literal Keys
// ============================================================================

type HandleCat = 'corner' | 'hSide' | 'vSide';
type Comp = 'only' | 'mixed';
type BKey = `${ScalableKind}_${HandleCat}_${Comp}`;

const DEFAULT_BEHAVIOR: Record<HandleCat, Record<Comp, ScaleBehavior>> = {
  corner: { only: 'uniform', mixed: 'uniform' },
  hSide: { only: 'uniform', mixed: 'edgePin' },
  vSide: { only: 'uniform', mixed: 'edgePin' },
};

/** Exceptions: shapes do nonUniform everywhere except corner+mixed, text/code reflow on E/W always */
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

// ============================================================================
// KindCounts adapter
// ============================================================================

type KindCounts = Record<ObjectKind, number>;

function toKindCounts(c: SelectionKindCounts): KindCounts {
  return {
    stroke: c.strokes,
    shape: c.shapes,
    text: c.text,
    connector: c.connectors,
    code: c.code,
    note: c.notes,
    image: c.images,
    bookmark: c.bookmarks,
  };
}

function countKinds(c: KindCounts): number {
  let n = 0;
  for (const k in c) if (c[k as ObjectKind] > 0) n++;
  return n;
}

// ============================================================================
// Shared Math Helpers
// ============================================================================

function uniformMath(cx: number, cy: number, ctx: ScaleCtx): [ncx: number, ncy: number, af: number] {
  const uf = uniformFactor(ctx.sx, ctx.sy, ctx.handleId);
  const [ncx, ncy] = preservePosition(cx, cy, ctx.selBounds, ctx.origin, uf);
  return [ncx, ncy, Math.abs(uf)];
}

function edgePinCtx(bbox: BBoxTuple, ctx: ScaleCtx): Point {
  return [
    edgePinPosition1D(bbox[0], bbox[2], ctx.origin[0], ctx.sx) - bbox[0],
    edgePinPosition1D(bbox[1], bbox[3], ctx.origin[1], ctx.sy) - bbox[1],
  ];
}

// ============================================================================
// Scale Apply Functions — Direct Field Access, No Factories
// ============================================================================

function scaleFrameUniform(f: HasFrame & HasBBox, ctx: ScaleCtx, o: HasFrame & HasBBox): void {
  // Padding is constant (strokeWidth/2 + 1 per side for shapes; 0 for images)
  const padL = f.frame[0] - f.bbox[0];
  const padT = f.frame[1] - f.bbox[1];

  // Scale using bbox center (= frame center for symmetric padding)
  const bcx = (f.bbox[0] + f.bbox[2]) / 2;
  const bcy = (f.bbox[1] + f.bbox[3]) / 2;
  const [ncx, ncy, af] = uniformMath(bcx, bcy, ctx);

  // Scale bbox dimensions to derive position + frame
  const bw = (f.bbox[2] - f.bbox[0]) * af;
  const bh = (f.bbox[3] - f.bbox[1]) * af;
  const bx = ncx - bw / 2;
  const by = ncy - bh / 2;

  // Derive frame from scaled bbox (constant padding inset, clamp at 0)
  o.frame[2] = Math.max(0, bw - 2 * padL);
  o.frame[3] = Math.max(0, bh - 2 * padT);
  o.frame[0] = bx + padL;
  o.frame[1] = by + padT;

  // Output bbox = frame + constant padding (stroke width doesn't scale)
  o.bbox[0] = o.frame[0] - padL;
  o.bbox[1] = o.frame[1] - padT;
  o.bbox[2] = o.frame[0] + o.frame[2] + padL;
  o.bbox[3] = o.frame[1] + o.frame[3] + padT;
}

// Shape non-uniform: scale bbox edges around origin, derive frame
function scaleFrameNonUniform(f: HasFrame & HasBBox, ctx: ScaleCtx, o: HasFrame & HasBBox): void {
  const padL = f.frame[0] - f.bbox[0];
  const padT = f.frame[1] - f.bbox[1];

  // Scale bbox edges around origin (origin IS a bbox corner → stays fixed)
  const bx1 = scaleAround(f.bbox[0], ctx.origin[0], ctx.sx);
  const by1 = scaleAround(f.bbox[1], ctx.origin[1], ctx.sy);
  const bx2 = scaleAround(f.bbox[2], ctx.origin[0], ctx.sx);
  const by2 = scaleAround(f.bbox[3], ctx.origin[1], ctx.sy);

  const sMinX = Math.min(bx1, bx2);
  const sMinY = Math.min(by1, by2);
  const sBw = Math.abs(bx2 - bx1);
  const sBh = Math.abs(by2 - by1);

  // Derive frame (constant padding inset, clamp at 0)
  o.frame[2] = Math.max(0, sBw - 2 * padL);
  o.frame[3] = Math.max(0, sBh - 2 * padT);
  o.frame[0] = sMinX + padL;
  o.frame[1] = sMinY + padT;

  // Output bbox = frame + constant padding (stroke width doesn't scale)
  o.bbox[0] = o.frame[0] - padL;
  o.bbox[1] = o.frame[1] - padT;
  o.bbox[2] = o.frame[0] + o.frame[2] + padL;
  o.bbox[3] = o.frame[1] + o.frame[3] + padT;
}

function edgePinFrame(f: HasFrame & HasBBox, ctx: ScaleCtx, o: HasFrame & HasBBox): void {
  const [dx, dy] = edgePinCtx(f.bbox, ctx);
  offsetFrameMut(o.frame, f.frame, dx, dy);
  offsetBBox(o.bbox, f.bbox, dx, dy);
}

function scaleOriginScale(f: HasOrigin & HasScale & HasBBox, ctx: ScaleCtx, o: HasOrigin & HasScale & HasBBox): void {
  const [bx0, by0, bx1, by1] = f.bbox;
  const [ncx, ncy, af] = uniformMath((bx0 + bx1) / 2, (by0 + by1) / 2, ctx);
  const [rounded, ef] = roundProp(f.scale, af);
  o.scale = rounded;
  const bw = (bx1 - bx0) * ef,
    bh = (by1 - by0) * ef;
  const nbx = ncx - bw / 2,
    nby = ncy - bh / 2;
  o.origin[0] = nbx + (f.origin[0] - bx0) * ef;
  o.origin[1] = nby + (f.origin[1] - by0) * ef;
  setBBoxXYWH(o.bbox, nbx, nby, bw, bh);
}

/** Edge-pin core: offset origin + bbox. Used directly for note/bookmark, composed by text/code. */
function edgePinOriginBbox(f: HasOrigin & HasBBox, ctx: ScaleCtx, o: HasOrigin & HasBBox): void {
  const [dx, dy] = edgePinCtx(f.bbox, ctx);
  offsetPoint(o.origin, f.origin, dx, dy);
  offsetBBox(o.bbox, f.bbox, dx, dy);
}

/** BBox-based uniform scale for strokes: no per-frame point mutation, ctx.scale rendering. */
function scaleStrokeBBox(f: GeoOf<'stroke'>, ctx: ScaleCtx, o: OutOf<'stroke'>): void {
  const cx = (f.bbox[0] + f.bbox[2]) / 2,
    cy = (f.bbox[1] + f.bbox[3]) / 2;
  const [ncx, ncy, af] = uniformMath(cx, cy, ctx);
  o.factor = af;
  o.fcx = cx;
  o.fcy = cy;
  const bw = (f.bbox[2] - f.bbox[0]) * af,
    bh = (f.bbox[3] - f.bbox[1]) * af;
  setBBoxXYWH(o.bbox, ncx - bw / 2, ncy - bh / 2, bw, bh);
}

function edgePinPoints(f: HasPoints & HasWidth & HasBBox, ctx: ScaleCtx, o: HasPoints & HasWidth & HasBBox): void {
  const [dx, dy] = edgePinCtx(f.bbox, ctx);
  offsetPointsMut(o.points, f.points, dx, dy);
  o.width = f.width;
  offsetBBox(o.bbox, f.bbox, dx, dy);
}

function scaleTextUniform(f: GeoOf<'text'>, ctx: ScaleCtx, o: OutOf<'text'>): void {
  const [x, y, w, h] = f.frame;
  const [ncx, ncy, af] = uniformMath(x + w / 2, y + h / 2, ctx);
  const [rounded, ef] = roundProp(f.fontSize, af);
  o.fontSize = rounded;
  const nw = w * ef,
    nh = h * ef;
  const nfx = ncx - nw / 2,
    nfy = ncy - nh / 2;
  o.origin[0] = nfx + anchorFactor(f.align) * nw;
  o.origin[1] = nfy + rounded * getBaselineToTopRatio(f.fontFamily);
  o.width = typeof f.width === 'number' ? f.width * ef : NaN;
  setBBoxXYWH(o.bbox, nfx, nfy, nw, nh);
  o.layout = null;
}

function scaleCodeUniform(f: GeoOf<'code'>, ctx: ScaleCtx, o: OutOf<'code'>): void {
  const [x, y, w, h] = f.frame;
  const [ncx, ncy, af] = uniformMath(x + w / 2, y + h / 2, ctx);
  const [rounded, ef] = roundProp(f.fontSize, af);
  o.fontSize = rounded;
  const nw = w * ef,
    nh = h * ef;
  o.origin[0] = ncx - nw / 2;
  o.origin[1] = ncy - nh / 2;
  o.width = f.width * ef;
  setBBoxXYWH(o.bbox, o.origin[0], o.origin[1], nw, nh);
  o.layout = null;
}

function edgePinText(f: GeoOf<'text'>, ctx: ScaleCtx, o: OutOf<'text'>): void {
  edgePinOriginBbox(f, ctx, o);
  o.fontSize = f.fontSize;
  o.width = typeof f.width === 'number' ? f.width : 0;
  o.layout = null;
}

function edgePinCode(f: GeoOf<'code'>, ctx: ScaleCtx, o: OutOf<'code'>): void {
  edgePinOriginBbox(f, ctx, o);
  o.fontSize = f.fontSize;
  o.width = f.width;
  o.layout = null;
}

function reflowText(f: GeoOf<'text'>, ctx: ScaleCtx, o: OutOf<'text'>): void {
  const [newLeft, targetWidth] = computeReflowWidth(f.frame[0], f.frame[2], ctx.origin[0], ctx.sx, f.minW);
  const layout = layoutMeasuredContent(f.measured!, targetWidth, f.fontSize);
  o.origin[0] = newLeft + anchorFactor(f.align) * targetWidth;
  o.origin[1] = f.origin[1];
  o.width = layout.boxWidth;
  o.layout = layout;
  o.fontSize = f.fontSize;
  const nh = layout.lines.length * layout.lineHeight;
  setBBoxXYWH(o.bbox, newLeft, f.frame[1], targetWidth, nh);
}

function reflowCode(f: GeoOf<'code'>, ctx: ScaleCtx, o: OutOf<'code'>): void {
  const [newLeft, targetWidth] = computeReflowWidth(f.frame[0], f.frame[2], ctx.origin[0], ctx.sx, f.minW);
  const layout = computeCodeLayout(f.sourceLines!, f.fontSize, targetWidth, f.lineNumbers);
  o.origin[0] = newLeft;
  o.origin[1] = f.origin[1];
  o.width = layout.totalWidth;
  o.layout = layout;
  o.fontSize = f.fontSize;
  const nh = codeBlockHeight(layout, f.fontSize, f.headerVisible, f.outputVisible, f.output);
  setBBoxXYWH(o.bbox, newLeft, f.frame[1], targetWidth, nh);
}

// ============================================================================
// Translate Apply Functions
// ============================================================================

function applyTranslateFrame(f: HasFrame & HasBBox, dx: number, dy: number, o: HasFrame & HasBBox): void {
  offsetFrameMut(o.frame, f.frame, dx, dy);
  offsetBBox(o.bbox, f.bbox, dx, dy);
}

function applyTranslateOrigin(f: HasOrigin & HasBBox, dx: number, dy: number, o: HasOrigin & HasBBox): void {
  offsetPoint(o.origin, f.origin, dx, dy);
  offsetBBox(o.bbox, f.bbox, dx, dy);
}

function applyTranslatePoints(f: HasPoints & HasWidth & HasBBox, dx: number, dy: number, o: HasPoints & HasWidth & HasBBox): void {
  offsetPointsMut(o.points, f.points, dx, dy);
  o.width = f.width;
  offsetBBox(o.bbox, f.bbox, dx, dy);
}

// ============================================================================
// Dispatch Tables — Mapped Types Enforce Kind→Function Compatibility
// ============================================================================

type ScaleApplyTable = { [K in ScalableKind]: Partial<Record<ScaleBehavior, (f: GeoOf<K>, ctx: ScaleCtx, o: OutOf<K>) => void>> };
type ScaleCommitTable = {
  [K in ScalableKind]: Partial<Record<ScaleBehavior, (y: Y.Map<unknown>, o: OutOf<K>, f: Readonly<GeoOf<K>>) => void>>;
};
type TranslateApplyTable = { [K in ScalableKind]: (f: GeoOf<K>, dx: number, dy: number, o: OutOf<K>) => void };
type TranslateCommitTable = { [K in ScalableKind]: (y: Y.Map<unknown>, o: OutOf<K>) => void };

const APPLY_SCALE: ScaleApplyTable = {
  shape: { uniform: scaleFrameUniform, nonUniform: scaleFrameNonUniform },
  image: { uniform: scaleFrameUniform, edgePin: edgePinFrame },
  stroke: { uniform: scaleStrokeBBox, edgePin: edgePinPoints },
  text: { uniform: scaleTextUniform, edgePin: edgePinText, reflow: reflowText },
  code: { uniform: scaleCodeUniform, edgePin: edgePinCode, reflow: reflowCode },
  note: { uniform: scaleOriginScale, edgePin: edgePinOriginBbox },
  bookmark: { uniform: scaleOriginScale, edgePin: edgePinOriginBbox },
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
/** Stroke uniform commit: compute scaled points from frozen geometry + factor at commit time. */
function commitStrokeUniform(y: Y.Map<unknown>, o: OutOf<'stroke'>, f: Readonly<GeoOf<'stroke'>>): void {
  const ncx = (o.bbox[0] + o.bbox[2]) / 2,
    ncy = (o.bbox[1] + o.bbox[3]) / 2;
  const af = o.factor;
  y.set(
    'points',
    f.points.map(([px, py]) => [ncx + (px - o.fcx) * af, ncy + (py - o.fcy) * af]),
  );
  y.set('width', f.width * af);
}
function commitPoints(y: Y.Map<unknown>, o: HasPoints): void {
  y.set(
    'points',
    o.points.map((p) => [...p]),
  );
}

const COMMIT_SCALE: ScaleCommitTable = {
  shape: { uniform: commitFrame, nonUniform: commitFrame },
  image: { uniform: commitFrame, edgePin: commitFrame },
  stroke: { uniform: commitStrokeUniform, edgePin: commitPoints },
  text: { uniform: commitTextScale, edgePin: commitOrigin, reflow: commitReflow },
  code: { uniform: commitCodeScale, edgePin: commitOrigin, reflow: commitReflow },
  note: { uniform: commitOriginScale, edgePin: commitOrigin },
  bookmark: { uniform: commitOriginScale, edgePin: commitOrigin },
};

const TRANSLATE_APPLY: TranslateApplyTable = {
  shape: applyTranslateFrame,
  image: applyTranslateFrame,
  stroke: applyTranslatePoints,
  text: applyTranslateOrigin,
  code: applyTranslateOrigin,
  note: applyTranslateOrigin,
  bookmark: applyTranslateOrigin,
};

const TRANSLATE_COMMIT: TranslateCommitTable = {
  shape: commitFrame,
  image: commitFrame,
  stroke: commitPoints,
  text: commitOrigin,
  code: commitOrigin,
  note: commitOrigin,
  bookmark: commitOrigin,
};

// ============================================================================
// Output Factories (pre-allocation)
// ============================================================================

function createOutFor(kind: ObjectKind, frozen: any): any {
  switch (kind) {
    case 'shape':
    case 'image':
      return { frame: [0, 0, 0, 0] as FrameTuple, bbox: [0, 0, 0, 0] as BBoxTuple };
    case 'stroke':
      return {
        points: (frozen as GeoOf<'stroke'>).points.map(() => [0, 0] as Point),
        width: 0,
        factor: 1,
        fcx: 0,
        fcy: 0,
        bbox: [0, 0, 0, 0] as BBoxTuple,
      };
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
  switch (kind) {
    case 'shape':
    case 'image': {
      const frame = getFrame(y);
      return frame ? { frame: [...frame] as FrameTuple, bbox: [...bbox] as BBoxTuple } : null;
    }
    case 'stroke': {
      const pts = getPoints(y) as Point[];
      if (pts.length === 0) return null;
      return { points: pts.map((p) => [...p] as Point), width: getWidth(y), bbox: [...bbox] as BBoxTuple };
    }
    case 'text': {
      const tf = getTextFrame(id);
      const p = getTextProps(y);
      if (!tf || !p) return null;
      return {
        frame: [...tf] as FrameTuple,
        origin: [...p.origin] as Point,
        fontSize: p.fontSize,
        fontFamily: p.fontFamily,
        align: p.align,
        width: p.width,
        measured: behavior === 'reflow' ? (textLayoutCache.getMeasuredContent(id) ?? null) : null,
        minW: behavior === 'reflow' ? getMinCharWidth(p.fontSize, p.fontFamily) : 0,
        bbox: frameToBbox(tf),
      };
    }
    case 'code': {
      const cf = getCodeFrame(id);
      const p = getCodeProps(y);
      if (!cf || !p) return null;
      return {
        frame: [...cf] as FrameTuple,
        origin: [...p.origin] as Point,
        fontSize: p.fontSize,
        width: p.width,
        sourceLines: behavior === 'reflow' ? (codeSystem.getSourceLines(id) ?? null) : null,
        lineNumbers: p.lineNumbers,
        headerVisible: p.headerVisible,
        outputVisible: p.outputVisible,
        output: p.output,
        minW: behavior === 'reflow' ? getCodeMinWidth(p.fontSize) : 0,
        bbox: frameToBbox(cf),
      };
    }
    case 'note':
    case 'bookmark': {
      const origin = getOrigin(y);
      if (!origin) return null;
      const scale = (y.get('scale') as number) ?? 1;
      // For edgePin behavior, we still need scale field (output has it)
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
      const pts = getPoints(y) as Point[];
      if (pts.length === 0) return null;
      return { points: pts.map((p) => [...p] as Point), width: getWidth(y), bbox: [...bbox] as BBoxTuple };
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
    const counts = toKindCounts(kindCounts);
    const mixed = countKinds(counts) > 1;

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

      const out = createOutFor(handle.kind, frozen);
      const entry = { id, y: handle.y, frozen, out, prevBbox: [...handle.bbox] as BBoxTuple } as Entry;

      if (!this.store[handle.kind]) this.store[handle.kind] = new Map();
      (this.store[handle.kind] as Map<string, Entry>).set(id, entry);

      if (!this.behaviors[handle.kind]) {
        this.behaviors[handle.kind] = behavior;
        this.activeKinds.push(handle.kind);
      }
    }

    // Topology
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
      // Cast due to correlated union: TS can't prove APPLY_SCALE[kind] and store[kind] share the same K.
      const apply = APPLY_SCALE[kind][behavior] as ((f: any, ctx: ScaleCtx, o: any) => void) | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
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

      const out = createOutFor(handle.kind, frozen);
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

    for (const kind of this.activeKinds) {
      const map = this.store[kind]!;
      // SAFETY: TranslateApplyTable mapped type enforces kind→function compatibility at definition.
      const apply = TRANSLATE_APPLY[kind] as (f: any, dx: number, dy: number, o: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const [, e] of map) {
        apply(e.frozen, dx, dy, e.out);
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
            ? (COMMIT_SCALE[k][behavior] as ((y: Y.Map<unknown>, o: any, f: any) => void) | undefined) // eslint-disable-line @typescript-eslint/no-explicit-any
            : undefined;
          if (!commitFn) continue;
          for (const [, e] of map) commitFn(e.y, e.out, e.frozen);
        } else {
          // SAFETY: TranslateCommitTable mapped type enforces kind→function compatibility at definition.
          const commitFn = TRANSLATE_COMMIT[k] as (y: Y.Map<unknown>, o: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
          for (const [, e] of map) commitFn(e.y, e.out);
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
      const [ox, oy] = this.scaleCtx.origin;
      return [ox + (pos[0] - ox) * this.scaleCtx.sx, oy + (pos[1] - oy) * this.scaleCtx.sy];
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
      const [x0, y0, x1, y1] = entry.out.bbox;
      return [x0, y0, x1 - x0, y1 - y0];
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

export { rawScaleFactors } from '@/core/geometry/scale-system';
