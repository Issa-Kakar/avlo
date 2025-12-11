/**
 * Editor Host Registry - DOM overlay host for text editors
 *
 * Provides module-level access to the DOM element that hosts
 * text editors and other interactive overlay elements.
 *
 * Set by Canvas.tsx, read by TextTool.
 *
 * @module canvas/editor-host-registry
 */

/**
 * DOM element that hosts text editors and other overlay elements.
 * Set by Canvas.tsx, read by TextTool.
 */
let editorHost: HTMLDivElement | null = null;

/**
 * Set the editor host element.
 * Called by Canvas.tsx on mount.
 */
export function setEditorHost(el: HTMLDivElement | null): void {
  editorHost = el;
}

/**
 * Get the editor host element.
 * Returns null if Canvas not mounted.
 */
export function getEditorHost(): HTMLDivElement | null {
  return editorHost;
}
