/**
 * Lazy Tiptap editor chunk — the DOM-overlay editor surface, loaded on text/note
 * tool select (warmed by `tiptap-loader.ts`) and on the first edit.
 *
 * Owns the editor-only dependencies: `Editor` (pm-view/state) + `Placeholder` +
 * `TextCollaboration` (y-tiptap) + the `.tiptap` CSS. The base extension defs come
 * from `./tiptap-base` (the shared chunk), so this chunk adds only the editor stack
 * on top of base. The CSS import rides this chunk; Vite's dynamic-import preload
 * helper inserts + awaits the `<style>` before the `import()` promise resolves, so
 * the styled `.tiptap` node never hits the DOM unstyled (FOUC-safe).
 */
import './tiptap.css';
import { Editor, type Extensions } from '@tiptap/core';
import { Placeholder } from '@tiptap/extensions';
import { TextCollaboration, type TextCollaborationOptions } from './extensions';
import { Bold, Document, Highlight, Italic, Paragraph, Text } from './tiptap-base';

export { Editor };

export interface BuildTextExtensionsOpts extends TextCollaborationOptions {
  /** Shape labels skip the placeholder (the shape body is the visual cue). */
  isLabel: boolean;
}

/** Build the editor extension set. Labels drop Placeholder; everything else shares
 *  the base marks/nodes + the collaborative binding. Mirrors the array TextTool
 *  built inline before the lazy split. */
export function buildTextExtensions(opts: BuildTextExtensionsOpts): Extensions {
  const { isLabel, ...collab } = opts;
  return [
    Document,
    ...(isLabel ? [] : [Placeholder.configure({ placeholder: 'Type something...' })]),
    Paragraph,
    Text,
    Bold,
    Italic,
    Highlight.configure({ multicolor: true }),
    TextCollaboration.configure(collab),
  ];
}
