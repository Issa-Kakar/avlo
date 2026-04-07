/**
 * Typed Y.Map Accessor Functions
 *
 * Pure functions providing type-safe access to Y.Map object properties.
 * Types are defined in @/core/types/objects.
 *
 * @module core/accessors
 */

import * as Y from 'yjs';
import type { FrameTuple, Frame } from './types/geometry';
import type {
  StoredAnchor,
  TextAlign,
  TextAlignV,
  TextWidth,
  FontFamily,
  TextProps,
  CodeLanguage,
  CodeProps,
  StrokeProps,
  ShapeProps,
  NoteProps,
  ImageProps,
  BookmarkProps,
} from './types/objects';

// Re-export types for backwards compatibility
export type {
  Dir,
  StoredAnchor,
  TextAlign,
  TextAlignV,
  TextWidth,
  FontFamily,
} from './types/objects';
export type { CodeLanguage, CodeProps, TextProps, StrokeProps, ShapeProps } from './types/objects';
export type { NoteProps, ImageProps, BookmarkProps } from './types/objects';

// ============================================================================
// COMMON ACCESSORS (all object kinds)
// ============================================================================

export function getColor(y: Y.Map<unknown>, fallback = '#000'): string {
  return (y.get('color') as string | undefined) ?? fallback;
}

export function getOpacity(y: Y.Map<unknown>, fallback = 1): number {
  return (y.get('opacity') as number | undefined) ?? fallback;
}

export function getWidth(y: Y.Map<unknown>, fallback = 2): number {
  const width = y.get('width') as number | undefined;
  if (width !== undefined) return width;
  return (y.get('strokeWidth') as number | undefined) ?? fallback;
}

// ============================================================================
// GEOMETRY ACCESSORS
// ============================================================================

export function getPoints(y: Y.Map<unknown>): [number, number][] {
  return (y.get('points') as [number, number][] | undefined) ?? [];
}

export function getFrame(y: Y.Map<unknown>): FrameTuple | null {
  return (y.get('frame') as FrameTuple | undefined) ?? null;
}

export function getFrameObject(y: Y.Map<unknown>): Frame | null {
  const frame = getFrame(y);
  if (!frame) return null;
  return { x: frame[0], y: frame[1], w: frame[2], h: frame[3] };
}

// ============================================================================
// SHAPE-SPECIFIC ACCESSORS
// ============================================================================

export function getShapeType(y: Y.Map<unknown>): string {
  return (y.get('shapeType') as string | undefined) ?? 'rect';
}

export function getFillColor(y: Y.Map<unknown>): string | undefined {
  return y.get('fillColor') as string | undefined;
}

export function getLabelColor(y: Y.Map<unknown>, fallback = '#000'): string {
  return (y.get('labelColor') as string | undefined) ?? fallback;
}

export function hasLabel(y: Y.Map<unknown>): boolean {
  return y.get('content') instanceof Y.XmlFragment;
}

// ============================================================================
// CONNECTOR-SPECIFIC ACCESSORS
// ============================================================================

export function getStart(y: Y.Map<unknown>): [number, number] | undefined {
  return y.get('start') as [number, number] | undefined;
}

export function getEnd(y: Y.Map<unknown>): [number, number] | undefined {
  return y.get('end') as [number, number] | undefined;
}

export function getStartAnchor(y: Y.Map<unknown>): StoredAnchor | undefined {
  return y.get('startAnchor') as StoredAnchor | undefined;
}

export function getEndAnchor(y: Y.Map<unknown>): StoredAnchor | undefined {
  return y.get('endAnchor') as StoredAnchor | undefined;
}

export function getStartCap(y: Y.Map<unknown>): 'arrow' | 'none' {
  const cap = y.get('startCap') as string | undefined;
  return cap === 'arrow' ? 'arrow' : 'none';
}

export function getEndCap(y: Y.Map<unknown>): 'arrow' | 'none' {
  const cap = y.get('endCap') as string | undefined;
  return cap === 'arrow' ? 'arrow' : 'none';
}

export function getConnectorType(y: Y.Map<unknown>): 'elbow' | 'straight' {
  const type = y.get('connectorType') as string | undefined;
  return type === 'straight' ? 'straight' : 'elbow';
}

// ============================================================================
// TEXT-SPECIFIC ACCESSORS
// ============================================================================

export function getFontSize(y: Y.Map<unknown>, fallback = 20): number {
  return (y.get('fontSize') as number | undefined) ?? fallback;
}

export function getOrigin(y: Y.Map<unknown>): [number, number] | null {
  return (y.get('origin') as [number, number] | undefined) ?? null;
}

export function getFontFamily(
  y: Y.Map<unknown>,
  fallback: FontFamily = 'Grandstander',
): FontFamily {
  return (y.get('fontFamily') as FontFamily | undefined) ?? fallback;
}

export function getTextProps(y: Y.Map<unknown>): TextProps | null {
  const origin = y.get('origin') as [number, number] | undefined;
  const content = y.get('content') as Y.XmlFragment | undefined;
  if (!origin || !content) return null;
  const w = y.get('width');
  return {
    content,
    origin,
    fontSize: (y.get('fontSize') as number) ?? 20,
    fontFamily: (y.get('fontFamily') as FontFamily) ?? 'Grandstander',
    align: (y.get('align') as TextAlign) ?? 'left',
    width: typeof w === 'number' ? w : 'auto',
  };
}

export function getTextWidth(y: Y.Map<unknown>): TextWidth {
  const w = y.get('width');
  return typeof w === 'number' ? w : 'auto';
}

export function getAlign(y: Y.Map<unknown>, fallback: TextAlign = 'left'): TextAlign {
  return (y.get('align') as TextAlign | undefined) ?? fallback;
}

export function getAlignV(y: Y.Map<unknown>, fallback: TextAlignV = 'middle'): TextAlignV {
  return (y.get('alignV') as TextAlignV | undefined) ?? fallback;
}

export function getContent(y: Y.Map<unknown>): Y.XmlFragment | null {
  return (y.get('content') as Y.XmlFragment | undefined) ?? null;
}

// ============================================================================
// CODE-SPECIFIC ACCESSORS
// ============================================================================

export function getLanguage(
  y: Y.Map<unknown>,
  fallback: CodeLanguage = 'javascript',
): CodeLanguage {
  return (y.get('language') as CodeLanguage | undefined) ?? fallback;
}

export function getCodeText(y: Y.Map<unknown>): Y.Text | null {
  const content = y.get('content');
  return content instanceof Y.Text ? content : null;
}

export function getLineNumbers(y: Y.Map<unknown>, fallback = true): boolean {
  return (y.get('lineNumbers') as boolean | undefined) ?? fallback;
}

export function getCodeProps(y: Y.Map<unknown>): CodeProps | null {
  const origin = y.get('origin') as [number, number] | undefined;
  const content = y.get('content');
  if (!origin || !(content instanceof Y.Text)) return null;
  return {
    content: content as Y.Text,
    origin,
    fontSize: (y.get('fontSize') as number) ?? 14,
    width: (y.get('width') as number) ?? 570,
    language: (y.get('language') as CodeLanguage) ?? 'javascript',
    lineNumbers: (y.get('lineNumbers') as boolean) ?? true,
    title: y.get('title') as string | undefined,
    headerVisible: (y.get('headerVisible') as boolean | undefined) ?? true,
    outputVisible: (y.get('outputVisible') as boolean | undefined) ?? false,
    output: y.get('output') as string | undefined,
  };
}

export const CODE_EXTENSIONS: Record<CodeLanguage, string> = {
  javascript: 'js',
  typescript: 'ts',
  python: 'py',
};

export function getHeaderVisible(y: Y.Map<unknown>, fallback = true): boolean {
  return (y.get('headerVisible') as boolean | undefined) ?? fallback;
}

export function getOutputVisible(y: Y.Map<unknown>, fallback = false): boolean {
  return (y.get('outputVisible') as boolean | undefined) ?? fallback;
}

export function getCodeOutput(y: Y.Map<unknown>): string | undefined {
  return y.get('output') as string | undefined;
}

// ============================================================================
// IMAGE-SPECIFIC ACCESSORS
// ============================================================================

export function getAssetId(y: Y.Map<unknown>): string | null {
  return (y.get('assetId') as string | undefined) ?? null;
}

export function getNaturalDimensions(y: Y.Map<unknown>): [number, number] | null {
  const w = y.get('naturalWidth') as number | undefined;
  const h = y.get('naturalHeight') as number | undefined;
  if (w === undefined || h === undefined) return null;
  return [w, h];
}

export function getImageProps(y: Y.Map<unknown>): ImageProps | null {
  const assetId = y.get('assetId') as string | undefined;
  const frame = y.get('frame') as FrameTuple | undefined;
  const naturalWidth = y.get('naturalWidth') as number | undefined;
  const naturalHeight = y.get('naturalHeight') as number | undefined;
  if (!assetId || !frame || naturalWidth === undefined || naturalHeight === undefined) return null;
  return {
    assetId,
    frame,
    naturalWidth,
    naturalHeight,
    mimeType: (y.get('mimeType') as string | undefined) ?? 'image/png',
  };
}

// ============================================================================
// NOTE-SPECIFIC ACCESSORS
// ============================================================================

export function getNoteProps(y: Y.Map<unknown>): NoteProps | null {
  const origin = y.get('origin') as [number, number] | undefined;
  const content = y.get('content');
  if (!origin || !(content instanceof Y.XmlFragment)) return null;
  return {
    content,
    origin,
    scale: (y.get('scale') as number) ?? 1,
    fontFamily: (y.get('fontFamily') as FontFamily) ?? 'Grandstander',
    align: (y.get('align') as TextAlign) ?? 'center',
    alignV: (y.get('alignV') as TextAlignV) ?? 'middle',
    fillColor: (y.get('fillColor') as string) ?? '#FEF3AC',
  };
}

// ============================================================================
// BOOKMARK-SPECIFIC ACCESSORS
// ============================================================================

export function getBookmarkProps(y: Y.Map<unknown>): BookmarkProps | null {
  const url = y.get('url') as string | undefined;
  const origin = y.get('origin') as [number, number] | undefined;
  const height = y.get('height') as number | undefined;
  if (!url || !origin || !height) return null;
  return {
    url,
    domain: (y.get('domain') as string | undefined) ?? '',
    origin,
    scale: (y.get('scale') as number) ?? 1,
    height,
    title: y.get('title') as string | undefined,
    description: y.get('description') as string | undefined,
    ogImageAssetId: y.get('ogImageAssetId') as string | undefined,
    ogImageWidth: y.get('ogImageWidth') as number | undefined,
    ogImageHeight: y.get('ogImageHeight') as number | undefined,
    faviconAssetId: y.get('faviconAssetId') as string | undefined,
  };
}

export function getBookmarkUrl(y: Y.Map<unknown>): string | null {
  return (y.get('url') as string | undefined) ?? null;
}

// ============================================================================
// STROKE-SPECIFIC ACCESSORS
// ============================================================================

export function getStrokeTool(y: Y.Map<unknown>): 'pen' | 'highlighter' {
  const tool = y.get('tool') as string | undefined;
  return tool === 'highlighter' ? 'highlighter' : 'pen';
}

export function getStrokeProps(y: Y.Map<unknown>): StrokeProps | null {
  const points = getPoints(y);
  if (points.length === 0) return null;
  return {
    points,
    color: getColor(y),
    width: getWidth(y),
    opacity: getOpacity(y),
    tool: getStrokeTool(y),
  };
}

export function getShapeProps(y: Y.Map<unknown>): ShapeProps | null {
  const frame = getFrame(y);
  if (!frame) return null;
  return {
    shapeType: getShapeType(y),
    frame,
    color: getColor(y),
    width: getWidth(y, 1),
    opacity: getOpacity(y),
    fillColor: getFillColor(y),
  };
}
