import type * as Y from 'yjs';
import type { BBoxTuple, FrameTuple } from './geometry';

// Object types - STRICT SEMANTIC SEPARATION
// stroke = pen/highlighter (ALWAYS Perfect Freehand polygon)
// shape = geometric shapes (ALWAYS polyline: rect/ellipse/line)
// text = text blocks (frame-based positioning)
// connector = connection lines/arrows (ALWAYS polyline)
export const OBJECT_KINDS = ['stroke', 'shape', 'text', 'connector', 'code', 'image', 'note', 'bookmark'] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

// Lightweight handle pointing to Y.Map
export interface ObjectHandle {
  id: string;
  kind: ObjectKind;
  y: Y.Map<unknown>; // Direct Y.Map reference
  bbox: BBoxTuple; // Computed locally, NOT stored in Y.Map
}

// Spatial index entry (minimal)
export interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  kind: ObjectKind;
  // NO data field - lookup via objectsById
}

// ============================================================================
// COMMON TYPES
// ============================================================================

/** Cardinal direction type */
export type Dir = 'N' | 'E' | 'S' | 'W';

/** Anchor data stored in Y.map for connected endpoints */
export interface StoredAnchor {
  id: string;
  side: Dir;
  anchor: [number, number];
}

// ============================================================================
// TEXT TYPES
// ============================================================================

export type TextAlign = 'left' | 'center' | 'right';
export type TextAlignV = 'top' | 'middle' | 'bottom';
export type TextWidth = 'auto' | number;
export type FontFamily = 'Grandstander' | 'Inter' | 'Lora' | 'JetBrains Mono';

export interface TextProps {
  content: Y.XmlFragment;
  origin: [number, number];
  fontSize: number;
  fontFamily: FontFamily;
  align: TextAlign;
  width: TextWidth;
}

// ============================================================================
// CODE TYPES
// ============================================================================

export type CodeLanguage = 'javascript' | 'typescript' | 'python';

export interface CodeProps {
  content: Y.Text;
  origin: [number, number];
  fontSize: number;
  width: number;
  language: CodeLanguage;
  lineNumbers: boolean;
  title: string | undefined;
  headerVisible: boolean;
  outputVisible: boolean;
  output: string | undefined;
}

// ============================================================================
// STROKE TYPES
// ============================================================================

export interface StrokeProps {
  points: [number, number][];
  color: string;
  width: number;
  opacity: number;
  tool: 'pen' | 'highlighter';
}

// ============================================================================
// SHAPE TYPES
// ============================================================================

export interface ShapeProps {
  shapeType: string;
  frame: FrameTuple;
  color: string;
  width: number;
  opacity: number;
  fillColor: string | undefined;
}

// ============================================================================
// NOTE TYPES
// ============================================================================

export interface NoteProps {
  content: Y.XmlFragment;
  origin: [number, number];
  scale: number;
  fontFamily: FontFamily;
  align: TextAlign;
  alignV: TextAlignV;
  fillColor: string;
}

// ============================================================================
// IMAGE TYPES
// ============================================================================

export interface ImageProps {
  assetId: string;
  frame: FrameTuple;
  naturalWidth: number;
  naturalHeight: number;
  mimeType: string;
}

// ============================================================================
// BOOKMARK TYPES
// ============================================================================

export interface BookmarkProps {
  url: string;
  domain: string;
  origin: [number, number];
  scale: number;
  height: number;
  title?: string;
  description?: string;
  ogImageAssetId?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  faviconAssetId?: string;
}
