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
import Highlight from '@tiptap/extension-highlight';
import { TextCollaboration } from '@/lib/text/extensions';
import * as Y from 'yjs';
import type { PointerTool, PreviewData } from './types';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import {
  getCanvasElement,
  getVisibleWorldBounds,
  useCameraStore,
  worldToClient,
} from '@/stores/camera-store';
import { invalidateOverlay, invalidateWorld } from '@/canvas/invalidation-helpers';
import { getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import { getEditorHost } from '@/canvas/SurfaceManager';
import { getTextProps, getColor, type TextAlign } from '@avlo/shared';
import {
  FONT_FAMILIES,
  getBaselineToTopRatio,
  getMeasuredAscentRatio,
} from '@/lib/text/text-system';
import { hitTestVisibleText } from '@/lib/geometry/hit-testing';
import { userProfileManager } from '@/lib/user-profile-manager';
import { ulid } from 'ulid';

/** Temporary: force fixed-width on new text objects for WYSIWYG testing. */
const DEV_FORCE_FIXED_WIDTH = false;

/** Sync TipTap editor inline styles (bold/italic/highlight) into the selection store. */
function syncInlineStylesToStore(editor: Editor): void {
  useSelectionStore.getState().setInlineStyles({
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    highlightColor: editor.isActive('highlight')
      ? ((editor.getAttributes('highlight').color as string | undefined) ?? '#ffd43b')
      : null,
  });
}

export class TextTool implements PointerTool {
  // Gesture state
  private gestureActive = false;
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private hitTextId: string | null = null;

  // Editor state
  private container: HTMLDivElement | null = null;
  private editor: Editor | null = null;
  objectId: string | null = null; // public — mirrors textEditingId

  // Event handler refs
  private boundHandleKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundHandleClickOutside: ((e: PointerEvent) => void) | null = null;

  // =========================================================================
  // PointerTool Interface
  // =========================================================================

  canBegin(): boolean {
    const isEditing = useSelectionStore.getState().textEditingId !== null;
    return !this.gestureActive && !isEditing;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.gestureActive) return;

    const snapshot = getCurrentSnapshot();
    const { scale } = useCameraStore.getState();

    this.gestureActive = true;
    this.pointerId = pointerId;
    this.downWorld = [worldX, worldY];
    this.hitTextId = hitTestVisibleText(worldX, worldY, snapshot, scale);
  }

  move(_worldX: number, _worldY: number): void {
    // Text tool doesn't track movement during gesture
  }

  end(_worldX?: number, _worldY?: number): void {
    if (!this.gestureActive || !this.downWorld) {
      this.resetGesture();
      return;
    }

    if (this.hitTextId) {
      useSelectionStore.getState().beginTextEditing(this.hitTextId, false);
      this.mountEditor(this.hitTextId, false);
    } else {
      const [x, y] = this.downWorld;
      const objectId = this.createTextObject(x, y);
      useSelectionStore.getState().beginTextEditing(objectId, true);
      this.mountEditor(objectId, true);
    }

    this.resetGesture();
    invalidateOverlay();
    invalidateWorld(getVisibleWorldBounds());
  }

  cancel(): void {
    this.resetGesture();
    invalidateOverlay();
  }

  isActive(): boolean {
    return this.gestureActive;
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  getPreview(): PreviewData | null {
    return null;
  }

  onPointerLeave(): void {}

  onViewChange(): void {
    this.positionEditor();
  }

  destroy(): void {
    this.commitAndClose();
    this.resetGesture();
  }

  // =========================================================================
  // Public Methods
  // =========================================================================

  /**
   * Start editing an existing text object.
   * Called by SelectTool (double-click on text) with the click position for cursor placement.
   */
  startEditing(objectId: string, entryPoint: [number, number]): void {
    this.downWorld = entryPoint;
    useSelectionStore.getState().beginTextEditing(objectId, false);
    invalidateWorld(getVisibleWorldBounds());
    this.mountEditor(objectId, false);
  }

  isEditorMounted(): boolean {
    return this.editor !== null;
  }

  getEditor(): Editor | null {
    return this.editor;
  }

  getContainer(): HTMLDivElement | null {
    return this.container;
  }

  // =========================================================================
  // Private: Object Creation
  // =========================================================================

  private createTextObject(worldX: number, worldY: number): string {
    const roomDoc = getActiveRoomDoc();
    const objectId = ulid();
    const userId = userProfileManager.getIdentity().userId;
    const {
      textSize: fontSize,
      textColor: color,
      textAlign: align,
      textFontFamily: fontFamily,
    } = useDeviceUIStore.getState();

    roomDoc.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      const yObj = new Y.Map<unknown>();
      yObj.set('id', objectId);
      yObj.set('kind', 'text');
      yObj.set('origin', [worldX, worldY]);
      yObj.set('fontSize', fontSize);
      yObj.set('fontFamily', fontFamily);
      yObj.set('color', color);
      yObj.set('align', align);
      yObj.set('width', DEV_FORCE_FIXED_WIDTH ? 270 : 'auto');
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
    const host = getEditorHost();
    if (!host) {
      console.error('[TextTool] No editor host available');
      return;
    }

    const roomDoc = getActiveRoomDoc();
    const snapshot = roomDoc.currentSnapshot;
    const handle = snapshot.objectsById.get(objectId);
    if (!handle) {
      console.error('[TextTool] Object not found:', objectId);
      return;
    }

    const props = getTextProps(handle.y);
    if (!props) {
      console.error('[TextTool] Object missing required properties:', objectId);
      return;
    }

    const color = getColor(handle.y);
    const { content: fragment, origin, fontSize, fontFamily, align, width } = props;
    const familyConfig = FONT_FAMILIES[fontFamily];

    // Create container div
    const container = document.createElement('div');
    container.className = 'tiptap';

    // Calculate screen position
    const [screenX, screenY] = worldToClient(origin[0], origin[1]);
    const scale = useCameraStore.getState().scale;
    const scaledFontSize = fontSize * scale;

    // Position container: baseline aligns with origin via precomputed ratio
    // that accounts for CSS line-height leading
    container.style.position = 'absolute';
    container.style.left = `${screenX}px`;
    container.style.top = `${screenY - scaledFontSize * getBaselineToTopRatio(fontFamily)}px`;
    if (typeof width === 'number') {
      container.style.width = `${width * scale}px`;
      container.dataset.widthMode = 'fixed';
    } else {
      container.dataset.widthMode = 'auto';
    }
    container.style.fontSize = `${scaledFontSize}px`;
    container.style.lineHeight = `${scaledFontSize * familyConfig.lineHeightMultiplier}px`;
    container.style.fontFamily = familyConfig.fallback;
    container.style.setProperty('--text-color', color);
    container.style.setProperty(
      '--hl-pad',
      `${getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)}em`,
    );
    applyAlignCSS(container, align);

    host.appendChild(container);

    // Capture click coords for cursor positioning (before resetGesture clears downWorld)
    const clickWorld = this.downWorld;
    const clientCoords = !isNew && clickWorld ? worldToClient(clickWorld[0], clickWorld[1]) : null;

    // Create Tiptap Editor
    const editor = new Editor({
      element: { mount: container },
      extensions: [
        Document,
        Placeholder.configure({ placeholder: 'Type something...' }),
        Paragraph,
        Text,
        Bold,
        Italic,
        Highlight.configure({ multicolor: true }),
        TextCollaboration.configure({
          fragment,
          yObj: handle.y,
          userId: userProfileManager.getIdentity().userId,
          mainUndoManager: roomDoc.getUndoManager(),
          onPropsSync: (keys) => this.syncProps(keys),
        }),
      ],
      autofocus: isNew ? 'end' : false,
      onCreate: ({ editor: ed }) => {
        syncInlineStylesToStore(ed);
        useSelectionStore.setState((s) => ({ boundsVersion: s.boundsVersion + 1 }));
      },
      onTransaction: ({ editor: ed }) => {
        syncInlineStylesToStore(ed);
      },
    });

    // For existing text, place cursor at click position.
    // Deferred to next frame — ProseMirror needs a layout pass before posAtCoords works.
    if (!isNew && clientCoords) {
      requestAnimationFrame(() => {
        if (!this.editor) return;
        const pos = this.editor.view.posAtCoords({ left: clientCoords[0], top: clientCoords[1] });
        this.editor.commands.focus(pos ? pos.pos : 'end');
      });
    }

    // Store flat fields
    this.container = container;
    this.editor = editor;
    this.objectId = objectId;

    this.setupEditorHandlers();
  }

  private setupEditorHandlers(): void {
    // Escape to commit (capture phase to beat ProseMirror)
    this.boundHandleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.commitAndClose();
      }
    };

    // Primary-button click outside editor or context menu → commit
    // MMB/RMB are skipped so pan and right-click work while editing
    this.boundHandleClickOutside = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Node;
      if (this.container && this.container.contains(target)) return;
      const menuElement = document.querySelector('.ctx-menu');
      if (menuElement && menuElement.contains(target)) return;
      this.commitAndClose();
      // Only consume canvas clicks when text tool is active — prevents creating
      // a new text object on click-off. Other tools (select, draw, etc.) should
      // receive the event so the click-off also starts their gesture.
      if (useDeviceUIStore.getState().activeTool === 'text') {
        const canvas = getCanvasElement();
        if (canvas && canvas.contains(target)) {
          e.stopPropagation();
        }
      }
    };

    document.addEventListener('keydown', this.boundHandleKeyDown, true);

    // Delay pointerdown listener to avoid catching the initial click that opened the editor
    setTimeout(() => {
      if (this.boundHandleClickOutside) {
        document.addEventListener('pointerdown', this.boundHandleClickOutside, true);
      }
    }, 100);
  }

  private removeEditorHandlers(): void {
    if (this.boundHandleKeyDown) {
      document.removeEventListener('keydown', this.boundHandleKeyDown, true);
      this.boundHandleKeyDown = null;
    }
    if (this.boundHandleClickOutside) {
      document.removeEventListener('pointerdown', this.boundHandleClickOutside, true);
      this.boundHandleClickOutside = null;
    }
  }

  // =========================================================================
  // Private: Editor Positioning — reads fresh from Y.Map every call
  // =========================================================================

  private positionEditor(): void {
    if (!this.container || !this.objectId) return;
    const handle = getCurrentSnapshot().objectsById.get(this.objectId);
    if (!handle) return;
    const props = getTextProps(handle.y);
    if (!props) return;

    const { origin, fontSize, fontFamily, width } = props;
    const scale = useCameraStore.getState().scale;
    const sf = fontSize * scale;
    const [sx, sy] = worldToClient(origin[0], origin[1]);

    this.container.style.left = `${sx}px`;
    this.container.style.top = `${sy - sf * getBaselineToTopRatio(fontFamily)}px`;
    this.container.style.fontSize = `${sf}px`;
    this.container.style.lineHeight = `${sf * FONT_FAMILIES[fontFamily].lineHeightMultiplier}px`;
    this.container.style.fontFamily = FONT_FAMILIES[fontFamily].fallback;
    this.container.style.setProperty(
      '--hl-pad',
      `${getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)}em`,
    );
    if (typeof width === 'number') this.container.style.width = `${width * scale}px`;
  }

  // =========================================================================
  // Private: Commit and Close
  // =========================================================================

  private commitAndClose(): void {
    if (!this.editor || !this.objectId) return;

    // Delete empty text objects on close (avoids invisible fixed-width rects)
    if (this.editor.isEmpty) {
      const roomDoc = getActiveRoomDoc();
      roomDoc.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;
        objects.delete(this.objectId!);
      });
    }

    this.removeEditorHandlers();

    // Destroy triggers extension onDestroy → seals undo session, clears per-session UM
    this.editor.destroy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.editor as any).editorState = null; // Tiptap doesn't null this — release EditorState + plugin states

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    this.container = null;
    this.editor = null;
    this.objectId = null;

    useSelectionStore.getState().endTextEditing();
    // World invalidation required — unmounting the editor doesn't trigger a Yjs mutation
    invalidateWorld(getVisibleWorldBounds());
    invalidateOverlay();
  }

  // =========================================================================
  // Private: Y.Map → DOM sync (called by extension observer on undo/redo)
  // =========================================================================

  private syncProps(keys: Set<string>): void {
    if (!this.container || !this.objectId) return;

    const handle = getCurrentSnapshot().objectsById.get(this.objectId);
    if (!handle) return;

    if (keys.has('color')) this.container.style.setProperty('--text-color', getColor(handle.y));
    if (keys.has('align'))
      applyAlignCSS(this.container, (handle.y.get('align') as TextAlign) ?? 'left');
    if (keys.has('origin') || keys.has('fontSize') || keys.has('fontFamily') || keys.has('width'))
      this.positionEditor();
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private resetGesture(): void {
    this.gestureActive = false;
    this.pointerId = null;
    this.downWorld = null;
    this.hitTextId = null;
  }
}

// =========================================================================
// Helpers
// =========================================================================

/** Set CSS custom properties for transform-based anchor positioning. */
function applyAlignCSS(container: HTMLDivElement, align: TextAlign): void {
  container.style.setProperty('--text-align', align);
  container.style.setProperty(
    '--text-anchor-tx',
    align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%',
  );
}
