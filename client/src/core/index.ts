// core/index.ts — SAFE: export type is erased at compile time
export type { Point, BBoxTuple, FrameTuple, WorldBounds, Frame } from './types/geometry';
export type {
  ObjectKind,
  ObjectHandle,
  IndexEntry,
  Dir,
  StoredAnchor,
  TextAlign,
  TextAlignV,
  TextWidth,
  FontFamily,
  CodeLanguage,
  StrokeProps,
  ShapeProps,
  TextProps,
  CodeProps,
  NoteProps,
  ImageProps,
  BookmarkProps,
  BindableKind,
  BindableHandle,
} from './types/objects';
export { isBindableKind, isBindableHandle, BINDABLE_KINDS } from './types/objects';
