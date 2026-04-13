/**
 * Frame Router — single source of truth for "give me the frame of any bindable object."
 *
 * Collapses per-kind `getTextFrame`/`getCodeFrame`/`getBookmarkFrame`/`getFrame` chains
 * into one mapped dispatch. Adding a new bindable kind = one line here.
 */

import type { FrameTuple } from '@/core/types/geometry';
import type { ObjectHandle, BindableKind } from '@/core/types/objects';
import { isBindableHandle } from '@/core/types/objects';
import { getFrame } from '@/core/accessors';
import { getTextFrame } from '@/core/text/text-system';
import { getCodeFrame } from '@/core/code/code-system';
import { getBookmarkFrame } from '@/core/bookmark/bookmark-render';

type FrameResolver<K extends BindableKind> = (h: ObjectHandle & { kind: K }) => FrameTuple | null;

const FRAME_BY_KIND: { [K in BindableKind]: FrameResolver<K> } = {
  shape: (h) => getFrame(h.y),
  image: (h) => getFrame(h.y),
  text: (h) => getTextFrame(h.id),
  note: (h) => getTextFrame(h.id),
  code: (h) => getCodeFrame(h.id),
  bookmark: (h) => getBookmarkFrame(h.id),
};

/**
 * Resolve the frame of any bindable object. Returns null for unbindable kinds
 * (stroke, connector) or if the subsystem hasn't computed a frame yet.
 */
export function frameOf(handle: ObjectHandle | null | undefined): FrameTuple | null {
  if (!isBindableHandle(handle)) return null;
  // SAFETY: mapped type proves per-kind correctness; one cast per dispatch.
  return (FRAME_BY_KIND[handle.kind] as FrameResolver<BindableKind>)(handle);
}
