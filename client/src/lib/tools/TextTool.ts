/**
 * TextTool - Rich text creation and editing
 *
 * ARCHITECTURE:
 * - Click to create new text object at click position
 * - Mount Tiptap editor as DOM overlay
 * - Y.XmlFragment syncs editor ↔ Y.Doc via Collaboration extension
 * - Canvas skips rendering object during active editing
 * - On commit: unmount editor, canvas renders from Y.XmlFragment
 */

import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import { Placeholder } from '@tiptap/extensions';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { TextCollaboration } from '@/lib/text/extensions';
import * as Y from 'yjs';
import type { PointerTool, PreviewData } from './types';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { getVisibleWorldBounds, useCameraStore, worldToClient } from '@/stores/camera-store';
import { invalidateOverlay, invalidateWorld } from '@/canvas/invalidation-helpers';
import { getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import { getEditorHost } from '@/canvas/SurfaceManager';
import { FONT_CONFIG, getBaselineToTopRatio, anchorFactor, type TextAlign } from '@/lib/text/text-system';
import { textContextMenu } from '@/lib/text/TextContextMenu';
import { hitTestVisibleText } from '@/lib/geometry/hit-testing';
import { userProfileManager } from '@/lib/user-profile-manager';
import { ulid } from 'ulid';

interface TextToolState {
  isActive: boolean;
  pointerId: number | null;
  downWorld: [number, number] | null;
  hitTextId: string | null;
}

interface EditorState {
  container: HTMLDivElement | null;
  editor: Editor | null;
  objectId: string | null;
  originWorld: [number, number] | null;
  fontSize: number;
  color: string;
  align: TextAlign;
  isNew: boolean;
}

export class TextTool implements PointerTool {
  private state: TextToolState = {
    isActive: false,
    pointerId: null,
    downWorld: null,
    hitTextId: null,
  };

  private editorState: EditorState = {
    container: null,
    editor: null,
    objectId: null,
    originWorld: null,
    fontSize: 20,
    color: '#000000',
    align: 'left',
    isNew: false,
  };

  // Bound event handlers for cleanup
  private boundHandleKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundHandleClickOutside: ((e: MouseEvent) => void) | null = null;

  // =========================================================================
  // PointerTool Interface
  // =========================================================================

  canBegin(): boolean {
    // Can begin if not already active AND no text editing in progress
    const isEditing = useSelectionStore.getState().textEditingId !== null;
    return !this.state.isActive && !isEditing;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.state.isActive) return;

    const snapshot = getCurrentSnapshot();
    const { scale } = useCameraStore.getState();
    const hitTextId = hitTestVisibleText(worldX, worldY, snapshot, scale);

    this.state = {
      isActive: true,
      pointerId,
      downWorld: [worldX, worldY],
      hitTextId,
    };
  }

  move(_worldX: number, _worldY: number): void {
    // Text tool doesn't track movement during gesture
  }

  end(_worldX?: number, _worldY?: number): void {
    if (!this.state.isActive || !this.state.downWorld) {
      this.resetState();
      return;
    }

    if (this.state.hitTextId) {
      // Existing text → edit
      useSelectionStore.getState().beginTextEditing(this.state.hitTextId, false);
      this.mountEditor(this.state.hitTextId, false);
    } else {
      // No visible text → create new
      const [x, y] = this.state.downWorld;
      const { textSize, textColor } = useDeviceUIStore.getState();
      const objectId = this.createTextObject(x, y, textSize, textColor);
      useSelectionStore.getState().beginTextEditing(objectId, true);
      this.mountEditor(objectId, true);
    }

    this.resetState();
    invalidateOverlay();
    invalidateWorld(getVisibleWorldBounds());
  }

  cancel(): void {
    this.resetState();
    invalidateOverlay();
  }

  isActive(): boolean {
    return this.state.isActive;
  }

  getPointerId(): number | null {
    return this.state.pointerId;
  }

  getPreview(): PreviewData | null {
    // Text tool uses DOM overlay, no canvas preview needed
    return null;
  }

  onPointerLeave(): void {
    // No hover state to clear
  }

  onViewChange(): void {
    // Reposition editor on pan/zoom
    this.repositionEditor();
  }

  destroy(): void {
    this.commitAndClose();
    this.resetState();
  }

  // =========================================================================
  // Public Methods (for external triggers like clicking existing text)
  // =========================================================================

  /**
   * Start editing an existing text object.
   * Called by SelectTool (double-click on text) with the click position for cursor placement.
   */
  startEditing(objectId: string, entryPoint: [number, number]): void {
    this.state.downWorld = entryPoint;
    useSelectionStore.getState().beginTextEditing(objectId, false);
    this.mountEditor(objectId, false);
  }

  /**
   * Check if editor is currently mounted.
   */
  isEditorMounted(): boolean {
    return this.editorState.editor !== null;
  }

  // =========================================================================
  // Private: Object Creation
  // =========================================================================

  private createTextObject(worldX: number, worldY: number, fontSize: number, color: string): string {
    const roomDoc = getActiveRoomDoc();
    const objectId = ulid();
    const userId = userProfileManager.getIdentity().userId;
    const align = useDeviceUIStore.getState().textAlign;

    roomDoc.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      const yObj = new Y.Map<unknown>();
      yObj.set('id', objectId);
      yObj.set('kind', 'text');
      yObj.set('origin', [worldX, worldY]);
      yObj.set('fontSize', fontSize);
      yObj.set('color', color);
      yObj.set('align', align);
      yObj.set('widthMode', 'auto');
      // Create empty Y.XmlFragment - Tiptap Collaboration will initialize it
      yObj.set('content', new Y.XmlFragment());
      yObj.set('ownerId', userId);
      yObj.set('createdAt', Date.now());

      objects.set(objectId, yObj);
    });

    return objectId;
  }

  // =========================================================================
  // Private: Editor Mounting
  // =========================================================================

  private mountEditor(objectId: string, isNew: boolean): void {
    // Get editor host
    const host = getEditorHost();
    if (!host) {
      console.error('[TextTool] No editor host available');
      return;
    }

    // Get Y.XmlFragment + properties from object
    const roomDoc = getActiveRoomDoc();
    const snapshot = roomDoc.currentSnapshot;
    const handle = snapshot.objectsById.get(objectId);
    if (!handle) {
      console.error('[TextTool] Object not found:', objectId);
      return;
    }

    const fragment = handle.y.get('content') as Y.XmlFragment;
    if (!fragment) {
      console.error('[TextTool] No content fragment:', objectId);
      return;
    }

    // Read all properties from Y.Map
    const origin = handle.y.get('origin') as [number, number];
    const fontSize = (handle.y.get('fontSize') as number) ?? 20;
    const color = (handle.y.get('color') as string) ?? '#000000';
    const align: TextAlign = (handle.y.get('align') as TextAlign) ?? 'left';

    // Create container div
    const container = document.createElement('div');
    container.className = 'text-editor-container';

    // Calculate screen position
    const [screenX, screenY] = worldToClient(origin[0], origin[1]);
    const scale = useCameraStore.getState().scale;
    const scaledFontSize = fontSize * scale;

    // Position container: baseline aligns with origin
    // Uses precomputed ratio that accounts for CSS line-height leading
    const containerTop = screenY - scaledFontSize * getBaselineToTopRatio();
    const containerLeft = screenX;

    // POSITIONING
    container.style.position = 'absolute';
    container.style.left = `${containerLeft}px`;
    container.style.top = `${containerTop}px`;

    // FONT SIZE/LINE HEIGHT - inline for performance (changes every frame on zoom)
    container.style.fontSize = `${scaledFontSize}px`;
    container.style.lineHeight = `${scaledFontSize * FONT_CONFIG.lineHeightMultiplier}px`;

    container.style.setProperty('--text-color', color);

    // ALIGNMENT - CSS custom properties for transform-based anchor positioning
    container.style.setProperty('--text-align', align);
    container.style.setProperty(
      '--text-anchor-tx',
      align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%'
    );

    // Append to host
    host.appendChild(container);

    // Capture click coords for cursor positioning (before resetState clears downWorld)
    const clickWorld = this.state.downWorld;
    const clientCoords = !isNew && clickWorld
      ? worldToClient(clickWorld[0], clickWorld[1])
      : null;

    // Create Tiptap Editor with CSS class-based styling
    const editor = new Editor({
      element: container,
      extensions: [
        Document,
        Placeholder.configure({
          placeholder: 'Type something...',
        }),
        Paragraph.configure({
          HTMLAttributes: { class: 'tiptap-paragraph' },
        }),
        Text,
        Bold.configure({
          HTMLAttributes: { class: 'tiptap-bold' },
        }),
        Italic.configure({
          HTMLAttributes: { class: 'tiptap-italic' },
        }),
        TextCollaboration.configure({
          fragment,
        }),
      ],
      autofocus: isNew ? 'end' : false,
      editorProps: {
        attributes: {
          class: 'tiptap',
        },
      },
    });

    // For existing text, place cursor at click position
    if (!isNew && clientCoords) {
      requestAnimationFrame(() => {
        if (!this.editorState.editor) return;
        const pos = this.editorState.editor.view.posAtCoords({ left: clientCoords[0], top: clientCoords[1] });
        this.editorState.editor.commands.focus(pos ? pos.pos : 'end');
      });
    }

    // Store state
    this.editorState = {
      container,
      editor,
      objectId,
      originWorld: origin,
      fontSize,
      color,
      align,
      isNew,
    };

    // Setup event handlers
    this.setupEditorHandlers();

    // Mount context menu
    textContextMenu.mount(host, container, editor, objectId);

    // Mark text editing active in UI store
    useDeviceUIStore.getState().setIsTextEditing(true);
  }

  private setupEditorHandlers(): void {
    // Escape key to commit
    this.boundHandleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.commitAndClose();
      }
    };

    // Click outside to commit
    this.boundHandleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const container = this.editorState.container;

      // Check if click is inside editor container
      if (container && container.contains(target)) return;

      // Check if click is inside context menu
      const menuElement = document.querySelector('.text-context-menu');
      if (menuElement && menuElement.contains(target)) return;

      // Click is outside both - commit and close
      this.commitAndClose();
    };

    document.addEventListener('keydown', this.boundHandleKeyDown, true);

    // Delay click handler to avoid catching the initial click
    setTimeout(() => {
      if (this.boundHandleClickOutside) {
        document.addEventListener('mousedown', this.boundHandleClickOutside, true);
      }
    }, 100);
  }

  private removeEditorHandlers(): void {
    if (this.boundHandleKeyDown) {
      document.removeEventListener('keydown', this.boundHandleKeyDown, true);
      this.boundHandleKeyDown = null;
    }
    if (this.boundHandleClickOutside) {
      document.removeEventListener('mousedown', this.boundHandleClickOutside, true);
      this.boundHandleClickOutside = null;
    }
  }

  // =========================================================================
  // Private: Editor Repositioning
  // =========================================================================

  private repositionEditor(): void {
    if (!this.editorState.container || !this.editorState.originWorld) return;

    const [worldX, worldY] = this.editorState.originWorld;
    const [screenX, screenY] = worldToClient(worldX, worldY);
    const scale = useCameraStore.getState().scale;
    const scaledFontSize = this.editorState.fontSize * scale;

    // Update position
    this.editorState.container.style.left = `${screenX}px`;
    this.editorState.container.style.top = `${screenY - scaledFontSize * getBaselineToTopRatio()}px`;

    // Update font size/line height - inline for performance
    this.editorState.container.style.fontSize = `${scaledFontSize}px`;
    this.editorState.container.style.lineHeight = `${scaledFontSize * FONT_CONFIG.lineHeightMultiplier}px`;

    // Context menu handles its own positioning via camera subscription
    textContextMenu.onViewChange();
  }

  // =========================================================================
  // Private: Commit and Close
  // =========================================================================

  private commitAndClose(): void {
    const { editor, container, objectId, isNew } = this.editorState;

    if (!editor || !objectId) return;

    // Check if text is empty and this is a new object
    const isEmpty = editor.isEmpty;

    if (isEmpty && isNew) {
      // Delete the empty text object
      const roomDoc = getActiveRoomDoc();
      roomDoc.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;
        objects.delete(objectId);
      });
    }

    // Destroy context menu first (before editor)
    textContextMenu.destroy();

    // Remove event handlers
    this.removeEditorHandlers();

    // Capture UndoManager ref before destroy (view.state inaccessible after)
    const undoManager = yUndoPluginKey.getState(editor.view.state)?.undoManager;

    editor.destroy();
    (editor as any).editorState = null; // Tiptap doesn't null this — release EditorState + all plugin states

    // Clear undo/redo stacks to release CRDT-level GC protection + ProsemirrorBinding refs
    if (undoManager) {
      undoManager.clear();
    }

    // Remove container from DOM
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }

    // Clear editor state
    this.editorState = {
      container: null,
      editor: null,
      objectId: null,
      originWorld: null,
      fontSize: 20,
      color: '#000000',
      align: 'left',
      isNew: false,
    };

    // End text editing in selection store
    useSelectionStore.getState().endTextEditing();

    // Mark text editing inactive in UI store
    useDeviceUIStore.getState().setIsTextEditing(false);
    invalidateWorld(getVisibleWorldBounds());
    // Invalidate overlay to update UI state
    // Note: World invalidation must be done by us because Unmounting the editor does not cause a Yjs mutation.
    invalidateOverlay();
  }

  // =========================================================================
  // Public Methods: Live Editing Updates
  // =========================================================================

  /**
   * Update the color of the current text object.
   * Called by context menu when user picks a new color.
   */
  updateColor(newColor: string): void {
    const { objectId, container } = this.editorState;
    if (!objectId || !container) return;

    // 1. Update Y.Map (triggers observer → cache is fine, color not cached)
    const roomDoc = getActiveRoomDoc();
    roomDoc.mutate(() => {
      const snapshot = roomDoc.currentSnapshot;
      const handle = snapshot.objectsById.get(objectId);
      if (handle) {
        handle.y.set('color', newColor);
      }
    });

    // 2. Update CSS variable immediately for DOM overlay
    container.style.setProperty('--text-color', newColor);
    this.editorState.color = newColor;

    // 3. Update UI store for consistency
    useDeviceUIStore.getState().setTextColor(newColor);
  }

  /**
   * Update the fontSize of the current text object.
   * Called by context menu when user picks a new size.
   */
  updateFontSize(newSize: number): void {
    const { objectId, container, originWorld } = this.editorState;
    if (!objectId || !container || !originWorld) return;

    // 1. Update Y.Map (triggers observer → invalidateLayout)
    const roomDoc = getActiveRoomDoc();
    roomDoc.mutate(() => {
      const snapshot = roomDoc.currentSnapshot;
      const handle = snapshot.objectsById.get(objectId);
      if (handle) {
        handle.y.set('fontSize', newSize);
      }
    });

    // 2. Update editor state
    this.editorState.fontSize = newSize;

    // 3. Update CSS for DOM overlay (scale-adjusted)
    const scale = useCameraStore.getState().scale;
    const scaledFontSize = newSize * scale;
    container.style.fontSize = `${scaledFontSize}px`;
    container.style.lineHeight = `${scaledFontSize * FONT_CONFIG.lineHeightMultiplier}px`;

    // 4. Reposition editor (baseline position changes with font size)
    this.repositionEditor();

    // 5. Invalidate world to update any non-editing canvas rendering
    invalidateWorld(getVisibleWorldBounds());
  }

  /**
   * Apply alignment CSS to the editor container.
   * Sets CSS custom properties for transform-based anchor positioning.
   */
  private applyAlignCSS(align: TextAlign): void {
    const container = this.editorState.container;
    if (!container) return;
    container.style.setProperty('--text-align', align);
    container.style.setProperty(
      '--text-anchor-tx',
      align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%'
    );
  }

  /**
   * Update the alignment of the current text object.
   * Called by context menu when user picks a new alignment.
   * Adjusts origin.x to preserve the text's left edge position.
   */
  updateTextAlign(newAlign: TextAlign): void {
    const { objectId, container, originWorld } = this.editorState;
    if (!objectId || !container || !originWorld) return;

    const roomDoc = getActiveRoomDoc();
    const snapshot = roomDoc.currentSnapshot;
    const handle = snapshot.objectsById.get(objectId);
    if (!handle) return;

    const oldAlign = (handle.y.get('align') as TextAlign) ?? 'left';
    if (oldAlign === newAlign) return;

    // Measure current width from DOM
    const scale = useCameraStore.getState().scale;
    const W = container.getBoundingClientRect().width / scale;

    // Compute new origin.x to preserve left edge position
    const oldF = anchorFactor(oldAlign);
    const newF = anchorFactor(newAlign);
    const leftX = originWorld[0] - oldF * W;
    const newOriginX = leftX + newF * W;

    // Update Yjs atomically
    roomDoc.mutate(() => {
      handle.y.set('origin', [newOriginX, originWorld[1]]);
      handle.y.set('align', newAlign);
    });

    // Update local state
    this.editorState.originWorld = [newOriginX, originWorld[1]];
    this.editorState.align = newAlign;

    // Update CSS
    this.applyAlignCSS(newAlign);

    // Reposition (origin changed)
    this.repositionEditor();

    invalidateWorld(getVisibleWorldBounds());
  }

  /**
   * Get the current editor state for external access (e.g., context menu).
   */
  getEditorState(): EditorState {
    return this.editorState;
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private resetState(): void {
    this.state = {
      isActive: false,
      pointerId: null,
      downWorld: null,
      hitTextId: null,
    };
  }

  // =========================================================================
  // Public Getters (for external access, e.g., context menu)
  // =========================================================================

  /**
   * Get the active editor container element.
   */
  getEditorContainer(): HTMLDivElement | null {
    return this.editorState.container;
  }

  /**
   * Get the active Tiptap editor instance.
   */
  getTiptapEditor(): Editor | null {
    return this.editorState.editor;
  }
}

// Create singleton instance for external access
let textToolInstance: TextTool | null = null;

/**
 * Set the TextTool instance for external access.
 * Called by tool-registry when creating the tool.
 */
export function setTextToolInstance(tool: TextTool): void {
  textToolInstance = tool;
}

/**
 * Get the TextTool instance.
 * Used by context menu to call updateColor/updateFontSize methods.
 */
export function getTextToolInstance(): TextTool | null {
  return textToolInstance;
}

/**
 * Get the active editor container element.
 */
export function getActiveEditorContainer(): HTMLDivElement | null {
  return textToolInstance?.getEditorContainer() ?? null;
}

/**
 * Get the active Tiptap editor instance.
 */
export function getActiveTiptapEditor(): Editor | null {
  return textToolInstance?.getTiptapEditor() ?? null;
}
