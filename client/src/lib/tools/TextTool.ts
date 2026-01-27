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
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';

import type { PointerTool, PreviewData } from './types';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { getVisibleWorldBounds, useCameraStore, worldToClient } from '@/stores/camera-store';
import { invalidateOverlay, invalidateWorld } from '@/canvas/invalidation-helpers';
import { getActiveRoomDoc } from '@/canvas/room-runtime';
import { getEditorHost } from '@/canvas/SurfaceManager';
import { FONT_CONFIG, getBaselineToTopRatio } from '@/lib/text/text-system';
import { userProfileManager } from '@/lib/user-profile-manager';
import { ulid } from 'ulid';

interface TextToolState {
  isActive: boolean;
  pointerId: number | null;
  downWorld: [number, number] | null;
}

interface EditorState {
  container: HTMLDivElement | null;
  editor: Editor | null;
  objectId: string | null;
  originWorld: [number, number] | null;
  fontSize: number;
  color: string;
  isNew: boolean;
}

export class TextTool implements PointerTool {
  private state: TextToolState = {
    isActive: false,
    pointerId: null,
    downWorld: null,
  };

  private editorState: EditorState = {
    container: null,
    editor: null,
    objectId: null,
    originWorld: null,
    fontSize: 20,
    color: '#000000',
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

    this.state = {
      isActive: true,
      pointerId,
      downWorld: [worldX, worldY],
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

    const [x, y] = this.state.downWorld;

    // Get current settings
    const uiState = useDeviceUIStore.getState();
    const textSize = uiState.textSize;
    const color = uiState.drawingSettings.color;

    // Create text object in Y.Doc
    const objectId = this.createTextObject(x, y, textSize, color);

    // Begin text editing in selection store
    useSelectionStore.getState().beginTextEditing(objectId, true);

    // Mount Tiptap editor
    this.mountEditor(objectId, x, y, textSize, color, true);

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
   * Edit an existing text object.
   * Called by SelectTool when clicking on a text object.
   */
  editExistingText(objectId: string): void {
    const roomDoc = getActiveRoomDoc();
    const snapshot = roomDoc.currentSnapshot;
    const handle = snapshot.objectsById.get(objectId);

    if (!handle || handle.kind !== 'text') return;

    const origin = handle.y.get('origin') as [number, number] | undefined;
    const fontSize = (handle.y.get('fontSize') as number) ?? 20;
    const color = (handle.y.get('color') as string) ?? '#000000';

    if (!origin) return;

    // Begin text editing
    useSelectionStore.getState().beginTextEditing(objectId, false);

    // Mount editor for existing text
    this.mountEditor(objectId, origin[0], origin[1], fontSize, color, false);
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

    roomDoc.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      const yObj = new Y.Map<unknown>();
      yObj.set('id', objectId);
      yObj.set('kind', 'text');
      yObj.set('origin', [worldX, worldY]);
      yObj.set('fontSize', fontSize);
      yObj.set('color', color);
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

  private mountEditor(
    objectId: string,
    worldX: number,
    worldY: number,
    fontSize: number,
    color: string,
    isNew: boolean
  ): void {
    // Get editor host
    const host = getEditorHost();
    if (!host) {
      console.error('[TextTool] No editor host available');
      return;
    }

    // Get Y.XmlFragment from object
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

    // Create container div
    const container = document.createElement('div');
    container.className = 'text-editor-container';

    // Calculate screen position
    const [screenX, screenY] = worldToClient(worldX, worldY);
    const scale = useCameraStore.getState().scale;
    const scaledFontSize = fontSize * scale;

    // Position container: baseline aligns with origin
    // Uses precomputed ratio that accounts for CSS line-height leading
    const containerTop = screenY - scaledFontSize * getBaselineToTopRatio();
    const containerLeft = screenX;

    // Apply styles
    Object.assign(container.style, {
      position: 'absolute',
      left: `${containerLeft}px`,
      top: `${containerTop}px`,
      fontFamily: FONT_CONFIG.fallback,
      fontWeight: String(FONT_CONFIG.weightNormal),
      fontSize: `${scaledFontSize}px`,
      lineHeight: `${scaledFontSize * FONT_CONFIG.lineHeightMultiplier}px`,
      color: color,
      background: 'transparent',
      border: 'none',
      padding: '0',
      margin: '0',
      whiteSpace: 'pre-wrap',
      minWidth: '3px',
      pointerEvents: 'auto',
      outline: 'none',
      zIndex: '1000',
    });

    // Append to host
    host.appendChild(container);

    // Create Tiptap Editor
    const editor = new Editor({
      element: container,
      extensions: [
        Document,
        Paragraph.configure({
          HTMLAttributes: { style: 'margin: 0; padding: 0;' },
        }),
        Text,
        Bold.configure({
          HTMLAttributes: { style: `font-weight: ${FONT_CONFIG.weightBold};` },
        }),
        Italic,
        Collaboration.configure({
          fragment,
        }),
      ],
      autofocus: 'end',
      editorProps: {
        attributes: {
          style: 'outline: none;',
        },
      },
    });

    // Store state
    this.editorState = {
      container,
      editor,
      objectId,
      originWorld: [worldX, worldY],
      fontSize,
      color,
      isNew,
    };

    // Setup event handlers
    this.setupEditorHandlers();

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
      if (this.editorState.container && !this.editorState.container.contains(e.target as Node)) {
        // Small delay to allow focus events to settle
        // EDIT: no need for delay, just commit and close(Delay causes flicker for canvas paint)
        this.commitAndClose();
      }
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

    // Update position (uses precomputed ratio for CSS line-height leading)
    this.editorState.container.style.left = `${screenX}px`;
    this.editorState.container.style.top = `${screenY - scaledFontSize * getBaselineToTopRatio()}px`;

    // Update font size for crisp rendering
    this.editorState.container.style.fontSize = `${scaledFontSize}px`;
    this.editorState.container.style.lineHeight = `${scaledFontSize * FONT_CONFIG.lineHeightMultiplier}px`;
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
    //useSelectionStore.getState().endTextEditing();
    //invalidateWorld(getVisibleWorldBounds());
    // Remove event handlers
    this.removeEditorHandlers();

    // Destroy editor
    editor.destroy();
    //useSelectionStore.getState().endTextEditing();
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
  // Private Helpers
  // =========================================================================

  private resetState(): void {
    this.state = {
      isActive: false,
      pointerId: null,
      downWorld: null,
    };
  }
}
