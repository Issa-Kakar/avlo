/**
 * Shared lazy Tiptap base chunk — the minimal ProseMirror surface used by BOTH
 * the editor (`tiptap-editor.ts`) and the clipboard's external-HTML paste
 * (`clipboard-actions.ts`).
 *
 * `generateJSON` reaches pm-**model** only (no pm-view, no y-tiptap), so external
 * paste loads just this chunk — not the full editor stack. Reachability-based
 * splitting (Rollup) keeps `tiptap-editor` (Editor + Placeholder + y-tiptap) in a
 * separate async chunk that depends on this one.
 *
 * Eagerly imported by NOTHING — only reached via dynamic `import()` (the loaders
 * in `tiptap-loader.ts`). Keep it free of any value that drags `Editor` in.
 */
export { generateJSON } from '@tiptap/core';
export { default as Bold } from '@tiptap/extension-bold';
export { default as Document } from '@tiptap/extension-document';
export { default as Highlight } from '@tiptap/extension-highlight';
export { default as Italic } from '@tiptap/extension-italic';
export { default as Paragraph } from '@tiptap/extension-paragraph';
export { default as Text } from '@tiptap/extension-text';
