/**
 * Eager loader for the lazy Tiptap chunks — the single point of dynamic-import
 * truth. Contains NO `@tiptap/*` value import (only `import type`), so it ships in
 * the eager bundle while keeping `tiptap-editor` / `tiptap-base` in their own async
 * chunks.
 *
 * - `loadTiptapEditor()` — cached `import('./tiptap-editor')`; used by TextTool.
 * - `loadTiptapBase()` — cached `import('./tiptap-base')`; used by the clipboard's
 *   external-HTML paste (generateJSON needs only the base chunk).
 *
 * Preload: a one-time subscription warms the editor chunk when the user selects the
 * text/note tool, so the first edit is instant. Wired at app load because TextTool
 * (eager via tool-registry) imports this module.
 */
import { useDeviceUIStore } from '@/stores/device-ui-store';
import type * as TiptapBaseModule from './tiptap-base';
import type * as TiptapEditorModule from './tiptap-editor';

let editorPromise: Promise<typeof TiptapEditorModule> | null = null;
let basePromise: Promise<typeof TiptapBaseModule> | null = null;

export function loadTiptapEditor(): Promise<typeof TiptapEditorModule> {
  editorPromise ??= import('./tiptap-editor');
  return editorPromise;
}

export function loadTiptapBase(): Promise<typeof TiptapBaseModule> {
  basePromise ??= import('./tiptap-base');
  return basePromise;
}

// Warm the editor chunk on text/note tool select (fire-and-forget). By the time the
// user clicks to create/edit, the chunk is resolved and the mount is synchronous.
useDeviceUIStore.subscribe(
  (s) => s.tool.active,
  (active) => {
    if (active === 'text' || active === 'note') void loadTiptapEditor();
  },
);
