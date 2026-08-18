/**
 * Renderer-only fast Y.Map readers.
 *
 * Each leaf `draw*` fn in `layers/objects.ts` (and the matching scale-entry
 * branches in `renderScaleEntryLanes`) calls one reader here that pulls only the
 * keys that draw fn actually paints. Reads use Yjs's internal `_map` directly
 * via two Content-subclass-specific helpers (~10ns/key) — see `readPrim` /
 * `readY`. The public `y.get()` is ~109ns/key.
 *
 * Each reader writes into a per-kind module-level scratch and returns the same
 * reference. Safe because each `draw*` fn consumes its scratch fully before any
 * other reader is called — no cross-call hazards in `objects.ts`.
 */

import * as Y from 'yjs';
import type { ConnectorCap, FontFamily, TextAlign, TextAlignV } from '@/core/types/objects';

// One typed `_map` view per call site keeps hidden-class stable. The Item shape
// we touch is narrowed to the union of the two Content subclasses Y.Map can
// hold (ContentAny for primitives/arrays/objects, ContentType for nested Y
// types). Two helpers route to the right field by content subclass — monomorphic
// at every consumer call site.
type YInternal = Y.Map<unknown> & {
  _map: Map<string, YItem>;
};
// Only `deleted` is typed; `.content` is left to resolve to `AbstractContent`
// via the intersection with `Y.Map<unknown>`'s real `_map`. The two helpers
// below double-cast through `unknown` at each access site — required because
// `AbstractContent` doesn't structurally overlap with `ContentAny`/`ContentType`'s
// internal fields (`arr`/`type`), which aren't exported by Yjs.
interface YItem {
  deleted: boolean;
}
interface ContentAnyLike {
  arr: unknown[];
}
interface ContentTypeLike {
  type: unknown;
}

/**
 * ContentAny path. Every primitive/array/object Y.Map value. Checks `!deleted`
 * (Yjs tombstones an Item on `.delete(key)` rather than removing it from
 * `_map` — see `selection-field-table.ts` fillColor-clear, `TextTool.ts`
 * empty-label close). Bypasses `content.getContent()` to read `arr[0]`
 * directly: zero alloc, ~10ns/key. `Y.Map._map` items always have length 1
 * (merges blocked by deleted-state asymmetry — proven from Yjs source).
 */
function readPrim<T>(y: YInternal, key: string): T | undefined {
  const val = y._map.get(key);
  if (val === undefined || val.deleted) return undefined;
  return (val.content as unknown as ContentAnyLike).arr[0] as T;
}

/**
 * ContentType path. Used for nested Y types (Y.XmlFragment, Y.Text, etc.).
 * Same tombstone guard as `readPrim`. Bypasses `content.getContent()` (which
 * would allocate `[this.type]` per call) and reads `content.type` directly.
 * Caller's `instanceof` discriminant remains responsible for kind narrowing.
 */
function readY<T>(y: YInternal, key: string): T | undefined {
  const val = y._map.get(key);
  if (val === undefined || val.deleted) return undefined;
  return (val.content as unknown as ContentTypeLike).type as T;
}

// =============================================================================
// STROKE
// =============================================================================

interface StrokeRender {
  color: string;
  opacity: number;
  tool: 'pen' | 'highlighter';
}

const _strokeScratch: StrokeRender = { color: '#000', opacity: 1, tool: 'pen' };

export function readStrokeRender(y: Y.Map<unknown>): StrokeRender {
  const yi = y as YInternal;
  _strokeScratch.color = readPrim<string>(yi, 'color') ?? '#000';
  _strokeScratch.opacity = readPrim<number>(yi, 'opacity') ?? 1;
  _strokeScratch.tool = readPrim<string>(yi, 'tool') === 'highlighter' ? 'highlighter' : 'pen';
  return _strokeScratch;
}

// =============================================================================
// SHAPE
// =============================================================================

interface ShapeRender {
  shapeType: string;
  fillColor: string | undefined;
  /** undefined = no stroke (the key is absent / tombstoned) — caller skips it. */
  color: string | undefined;
  width: number;
  opacity: number;
}

const _shapeScratch: ShapeRender = { shapeType: 'rect', fillColor: undefined, color: undefined, width: 1, opacity: 1 };

export function readShapeRender(y: Y.Map<unknown>): ShapeRender {
  const yi = y as YInternal;
  _shapeScratch.shapeType = readPrim<string>(yi, 'shapeType') ?? 'rect';
  _shapeScratch.fillColor = readPrim<string>(yi, 'fillColor');
  _shapeScratch.color = readPrim<string>(yi, 'color');
  const w = readPrim<number>(yi, 'width');
  _shapeScratch.width = w !== undefined ? w : (readPrim<number>(yi, 'strokeWidth') ?? 1);
  _shapeScratch.opacity = readPrim<number>(yi, 'opacity') ?? 1;
  return _shapeScratch;
}

// =============================================================================
// SHAPE LABEL
// =============================================================================
//
// Two variants — with and without `frame`. The non-frame variant is used by the
// scale-entry path which supplies the in-flight frame from the entry's `out`.

interface ShapeLabelRender {
  content: Y.XmlFragment;
  shapeType: string;
  frame: [number, number, number, number];
  fontSize: number;
  fontFamily: FontFamily;
  align: TextAlign;
  alignV: TextAlignV;
  labelColor: string;
}

const _labelFrameScratch: [number, number, number, number] = [0, 0, 0, 0];
const _labelScratch: ShapeLabelRender = {
  content: null as unknown as Y.XmlFragment,
  shapeType: 'rect',
  frame: _labelFrameScratch,
  fontSize: 20,
  fontFamily: 'Grandstander',
  align: 'center',
  alignV: 'middle',
  labelColor: '#000',
};

/**
 * Read shape-label render fields. Returns null when content is not a Y.XmlFragment
 * (i.e. the shape has no label) — single discriminant test shared with hasLabel.
 */
export function readShapeLabelRender(y: Y.Map<unknown>): ShapeLabelRender | null {
  const yi = y as YInternal;
  const content = readY<unknown>(yi, 'content');
  if (!(content instanceof Y.XmlFragment)) return null;
  _labelScratch.content = content;
  _labelScratch.shapeType = readPrim<string>(yi, 'shapeType') ?? 'rect';
  const frame = readPrim<[number, number, number, number]>(yi, 'frame');
  if (frame) {
    _labelFrameScratch[0] = frame[0];
    _labelFrameScratch[1] = frame[1];
    _labelFrameScratch[2] = frame[2];
    _labelFrameScratch[3] = frame[3];
  }
  _labelScratch.fontSize = readPrim<number>(yi, 'fontSize') ?? 20;
  _labelScratch.fontFamily = readPrim<FontFamily>(yi, 'fontFamily') ?? 'Grandstander';
  _labelScratch.align = readPrim<TextAlign>(yi, 'align') ?? 'center';
  _labelScratch.alignV = readPrim<TextAlignV>(yi, 'alignV') ?? 'middle';
  _labelScratch.labelColor = readPrim<string>(yi, 'labelColor') ?? '#000';
  return _labelScratch;
}

interface ShapeLabelRenderNoFrame {
  content: Y.XmlFragment;
  shapeType: string;
  fontSize: number;
  fontFamily: FontFamily;
  align: TextAlign;
  alignV: TextAlignV;
  labelColor: string;
}

const _labelNoFrameScratch: ShapeLabelRenderNoFrame = {
  content: null as unknown as Y.XmlFragment,
  shapeType: 'rect',
  fontSize: 20,
  fontFamily: 'Grandstander',
  align: 'center',
  alignV: 'middle',
  labelColor: '#000',
};

/** Variant used by the scale-entry path: frame comes from `entry.out.frame`. */
export function readShapeLabelRenderNoFrame(y: Y.Map<unknown>): ShapeLabelRenderNoFrame | null {
  const yi = y as YInternal;
  const content = readY<unknown>(yi, 'content');
  if (!(content instanceof Y.XmlFragment)) return null;
  _labelNoFrameScratch.content = content;
  _labelNoFrameScratch.shapeType = readPrim<string>(yi, 'shapeType') ?? 'rect';
  _labelNoFrameScratch.fontSize = readPrim<number>(yi, 'fontSize') ?? 20;
  _labelNoFrameScratch.fontFamily = readPrim<FontFamily>(yi, 'fontFamily') ?? 'Grandstander';
  _labelNoFrameScratch.align = readPrim<TextAlign>(yi, 'align') ?? 'center';
  _labelNoFrameScratch.alignV = readPrim<TextAlignV>(yi, 'alignV') ?? 'middle';
  _labelNoFrameScratch.labelColor = readPrim<string>(yi, 'labelColor') ?? '#000';
  return _labelNoFrameScratch;
}

// =============================================================================
// TEXT
// =============================================================================
//
// fontSize/fontFamily/width/content NOT read on the hot path — they're already
// baked into the cached layout (`textLayoutCache.getLayoutById`).

interface TextRender {
  originX: number;
  originY: number;
  align: TextAlign;
  color: string;
  fillColor: string | undefined;
}

const _textScratch: TextRender = { originX: 0, originY: 0, align: 'left', color: '#000', fillColor: undefined };

export function readTextRender(y: Y.Map<unknown>): TextRender {
  const yi = y as YInternal;
  const origin = readPrim<[number, number]>(yi, 'origin');
  _textScratch.originX = origin ? origin[0] : 0;
  _textScratch.originY = origin ? origin[1] : 0;
  _textScratch.align = readPrim<TextAlign>(yi, 'align') ?? 'left';
  _textScratch.color = readPrim<string>(yi, 'color') ?? '#000';
  _textScratch.fillColor = readPrim<string>(yi, 'fillColor');
  return _textScratch;
}

// =============================================================================
// CODE
// =============================================================================
//
// content/width/language/lineNumbers NOT read — baked into cached layout.

interface CodeRender {
  originX: number;
  originY: number;
  fontSize: number;
  headerVisible: boolean;
  title: string | undefined;
  outputVisible: boolean;
  output: string | undefined;
}

const _codeScratch: CodeRender = {
  originX: 0,
  originY: 0,
  fontSize: 14,
  headerVisible: true,
  title: undefined,
  outputVisible: false,
  output: undefined,
};

export function readCodeRender(y: Y.Map<unknown>): CodeRender {
  const yi = y as YInternal;
  const origin = readPrim<[number, number]>(yi, 'origin');
  _codeScratch.originX = origin ? origin[0] : 0;
  _codeScratch.originY = origin ? origin[1] : 0;
  _codeScratch.fontSize = readPrim<number>(yi, 'fontSize') ?? 14;
  _codeScratch.headerVisible = readPrim<boolean>(yi, 'headerVisible') ?? true;
  _codeScratch.title = readPrim<string>(yi, 'title');
  _codeScratch.outputVisible = readPrim<boolean>(yi, 'outputVisible') ?? false;
  _codeScratch.output = readPrim<string>(yi, 'output');
  return _codeScratch;
}

// =============================================================================
// IMAGE
// =============================================================================
//
// frame derives from handle.bbox (image bbox === frame, no padding); assetId +
// natural dims live in imageCache. Only opacity is read off the Y.Map at draw.

export function readImageOpacity(y: Y.Map<unknown>): number {
  return readPrim<number>(y as YInternal, 'opacity') ?? 1;
}

// =============================================================================
// NOTE
// =============================================================================
//
// content NOT read — staleness handled by populator (computeNoteBBox →
// getNoteLayout via the deep observer).

interface NoteRender {
  originX: number;
  originY: number;
  scale: number;
  fontFamily: FontFamily;
  fillColor: string;
  align: TextAlign;
  alignV: TextAlignV;
}

const _noteScratch: NoteRender = {
  originX: 0,
  originY: 0,
  scale: 1,
  fontFamily: 'Grandstander',
  fillColor: '#FEF3AC',
  align: 'center',
  alignV: 'middle',
};

export function readNoteRender(y: Y.Map<unknown>): NoteRender {
  const yi = y as YInternal;
  const origin = readPrim<[number, number]>(yi, 'origin');
  _noteScratch.originX = origin ? origin[0] : 0;
  _noteScratch.originY = origin ? origin[1] : 0;
  _noteScratch.scale = readPrim<number>(yi, 'scale') ?? 1;
  _noteScratch.fontFamily = readPrim<FontFamily>(yi, 'fontFamily') ?? 'Grandstander';
  _noteScratch.fillColor = readPrim<string>(yi, 'fillColor') ?? '#FEF3AC';
  _noteScratch.align = readPrim<TextAlign>(yi, 'align') ?? 'center';
  _noteScratch.alignV = readPrim<TextAlignV>(yi, 'alignV') ?? 'middle';
  return _noteScratch;
}

// =============================================================================
// BOOKMARK
// =============================================================================
//
// url/domain/title/description/height/og+favicon ids NOT read — all in cached layout.

interface BookmarkRender {
  originX: number;
  originY: number;
  scale: number;
}

const _bookmarkScratch: BookmarkRender = { originX: 0, originY: 0, scale: 1 };

export function readBookmarkRender(y: Y.Map<unknown>): BookmarkRender {
  const yi = y as YInternal;
  const origin = readPrim<[number, number]>(yi, 'origin');
  _bookmarkScratch.originX = origin ? origin[0] : 0;
  _bookmarkScratch.originY = origin ? origin[1] : 0;
  _bookmarkScratch.scale = readPrim<number>(yi, 'scale') ?? 1;
  return _bookmarkScratch;
}

// =============================================================================
// CONNECTOR
// =============================================================================

interface ConnectorRender {
  color: string;
  width: number;
  startCap: ConnectorCap;
  endCap: ConnectorCap;
}

const _connectorScratch: ConnectorRender = { color: '#000', width: 2, startCap: 'none', endCap: 'none' };

export function readConnectorRender(y: Y.Map<unknown>): ConnectorRender {
  const yi = y as YInternal;
  _connectorScratch.color = readPrim<string>(yi, 'color') ?? '#000';
  const w = readPrim<number>(yi, 'width');
  _connectorScratch.width = w !== undefined ? w : (readPrim<number>(yi, 'strokeWidth') ?? 2);
  _connectorScratch.startCap = readPrim<string>(yi, 'startCap') === 'arrow' ? 'arrow' : 'none';
  _connectorScratch.endCap = readPrim<string>(yi, 'endCap') === 'arrow' ? 'arrow' : 'none';
  return _connectorScratch;
}

interface ConnectorBaseRender {
  color: string;
  width: number;
}

const _connectorBaseScratch: ConnectorBaseRender = { color: '#000', width: 2 };

/** Idle-paint connector: only color + width (caps + path baked into ConnectorPaths). */
export function readConnectorBaseRender(y: Y.Map<unknown>): ConnectorBaseRender {
  const yi = y as YInternal;
  _connectorBaseScratch.color = readPrim<string>(yi, 'color') ?? '#000';
  const w = readPrim<number>(yi, 'width');
  _connectorBaseScratch.width = w !== undefined ? w : (readPrim<number>(yi, 'strokeWidth') ?? 2);
  return _connectorBaseScratch;
}
