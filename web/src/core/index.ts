// core/index.ts — SAFE: export type is erased at compile time
export type { BBoxTuple, Frame, FrameTuple, Point, WorldBounds } from './types/geometry';
export type {
  BindableHandle,
  BindableKind,
  BookmarkProps,
  CodeLanguage,
  CodeProps,
  Dir,
  FontFamily,
  ImageProps,
  NoteProps,
  ObjectHandle,
  ObjectKind,
  ShapeProps,
  StoredAnchor,
  StrokeProps,
  TextAlign,
  TextAlignV,
  TextProps,
  TextWidth,
} from './types/objects';
export { BINDABLE_KINDS, isBindableHandle, isBindableKind } from './types/objects';
