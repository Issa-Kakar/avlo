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
import {
  getTextProps,
  getColor,
  getFillColor,
  getFrame,
  getShapeType,
  getContent,
  getFontSize,
  getFontFamily,
  getLabelColor,
  hasLabel,
  getNoteProps,
  type TextAlign,
} from '@avlo/shared';
import {
  FONT_FAMILIES,
  getBaselineToTopRatio,
  getMeasuredAscentRatio,
  computeLabelTextBox,
  anchorFactor,
  NOTE_WIDTH,
  NOTE_FILL_COLOR,
  getNotePadding,
  getNoteContentWidth,
  getNoteDerivedFontSize,
  textLayoutCache,
} from '@/lib/text/text-system';
import { hitTestVisibleText, hitTestVisibleNote } from '@/lib/geometry/hit-testing';
import { userProfileManager } from '@/lib/user-profile-manager';
import { ulid } from 'ulid';

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

  justClosedLabelId: string | null = null;

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
    const tool = useDeviceUIStore.getState().activeTool;
    this.hitTextId =
      tool === 'note'
        ? hitTestVisibleNote(worldX, worldY, snapshot, scale)
        : hitTestVisibleText(worldX, worldY, snapshot, scale);
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
      let [x, y] = this.downWorld;
      if (useDeviceUIStore.getState().activeTool === 'note') {
        x -= NOTE_WIDTH / 2;
        y -= NOTE_WIDTH / 2;
      }
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
    const handle = getCurrentSnapshot().objectsById.get(objectId);
    if (!handle) return;

    // Create label fields if shape without label
    const isNewLabel = handle.kind === 'shape' && !hasLabel(handle.y);
    if (isNewLabel) {
      const { textSize, textFontFamily, textColor } = useDeviceUIStore.getState();
      getActiveRoomDoc().mutate(() => {
        handle.y.set('content', new Y.XmlFragment());
        handle.y.set('fontSize', textSize);
        handle.y.set('fontFamily', textFontFamily);
        handle.y.set('labelColor', textColor);
      });
    }

    this.downWorld = entryPoint;
    useSelectionStore.getState().beginTextEditing(objectId, isNewLabel);
    invalidateWorld(getVisibleWorldBounds());
    this.mountEditor(objectId, isNewLabel);
  }

  isEditorMounted(): boolean {
    return this.editor !== null;
  }

  isEditingLabel(): boolean {
    if (!this.objectId) return false;
    const kind = getCurrentSnapshot().objectsById.get(this.objectId)?.kind;
    return kind === 'shape' || kind === 'note' || false;
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
    const store = useDeviceUIStore.getState();
    const isNoteMode = store.activeTool === 'note';

    roomDoc.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;

      const yObj = new Y.Map<unknown>();
      yObj.set('id', objectId);
      yObj.set('origin', [worldX, worldY]);
      yObj.set('content', new Y.XmlFragment());
      yObj.set('ownerId', userId);
      yObj.set('createdAt', Date.now());

      if (isNoteMode) {
        yObj.set('kind', 'note');
        yObj.set('scale', 1);
        yObj.set('fontFamily', store.noteFontFamily);
        yObj.set('align', store.noteAlign);
        yObj.set('alignV', store.noteAlignV);
        yObj.set('fillColor', NOTE_FILL_COLOR);
      } else {
        yObj.set('kind', 'text');
        yObj.set('fontSize', store.textSize);
        yObj.set('fontFamily', store.textFontFamily);
        yObj.set('color', store.textColor);
        yObj.set('align', store.textAlign);
        yObj.set('width', 'auto');
        if (store.textFillColor) yObj.set('fillColor', store.textFillColor);
      }

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

    const isLabel = handle.kind === 'shape';

    // Read shared properties
    let fragment: Y.XmlFragment | null;
    let fontSize: number;
    let fontFamily: import('@avlo/shared').FontFamily;

    if (isLabel) {
      fragment = getContent(handle.y);
      fontSize = getFontSize(handle.y);
      fontFamily = getFontFamily(handle.y);
    } else if (handle.kind === 'note') {
      const np = getNoteProps(handle.y);
      if (!np) {
        console.error('[TextTool] Note missing required properties:', objectId);
        return;
      }
      fragment = np.content;
      fontFamily = np.fontFamily;
      textLayoutCache.getNoteLayout(objectId, np.content, np.fontFamily);
      fontSize = getNoteDerivedFontSize(objectId) * np.scale;
    } else {
      const props = getTextProps(handle.y);
      if (!props) {
        console.error('[TextTool] Object missing required properties:', objectId);
        return;
      }
      fragment = props.content;
      fontSize = props.fontSize;
      fontFamily = props.fontFamily;
    }

    if (!fragment) {
      console.error('[TextTool] No content fragment:', objectId);
      return;
    }

    const familyConfig = FONT_FAMILIES[fontFamily];
    const scale = useCameraStore.getState().scale;
    const scaledFontSize = fontSize * scale;

    // Create container div
    const container = document.createElement('div');
    container.className = 'tiptap';
    container.style.position = 'absolute';
    container.style.fontSize = `${scaledFontSize}px`;
    container.style.lineHeight = `${scaledFontSize * familyConfig.lineHeightMultiplier}px`;
    container.style.fontFamily = familyConfig.fallback;
    container.style.setProperty(
      '--hl-pad',
      `${getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)}em`,
    );

    const isNoteObj = !isLabel && handle.kind === 'note';

    if (isLabel) {
      // Label: position at text box center, translate(-50%, -50%)
      const frame = getFrame(handle.y)!;
      const textBox = computeLabelTextBox(getShapeType(handle.y), frame);
      const [tbx, tby, tbw, tbh] = textBox;
      const [cx, cy] = worldToClient(tbx + tbw / 2, tby + tbh / 2);
      container.style.left = `${cx}px`;
      container.style.top = `${cy}px`;
      container.style.setProperty('--text-anchor-tx', '-50%');
      container.style.setProperty('--text-anchor-ty', '-50%');
      container.style.maxWidth = `${tbw * scale}px`;
      container.style.maxHeight = `${tbh * scale}px`;
      container.dataset.widthMode = 'label';
      container.style.setProperty('--text-color', getLabelColor(handle.y));
    } else if (isNoteObj) {
      // Sticky note: alignment-aware positioning with vertical clamp
      // fontSize/lineHeight/fontFamily already correct from the generic block above
      const props = getNoteProps(handle.y)!;
      const { origin, scale: noteScale, align, alignV } = props;
      const padding = getNotePadding(noteScale);
      const contentWidth = getNoteContentWidth(noteScale);
      const maxContentH = contentWidth; // square content box

      // Horizontal: position at alignment anchor within content area
      const anchorX = origin[0] + padding + anchorFactor(align) * contentWidth;
      container.style.setProperty(
        '--text-anchor-tx',
        align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%',
      );
      container.style.setProperty('--text-align', align);

      // Vertical: position at vFactor anchor, clamp translateY
      const vFactor = alignV === 'top' ? 0 : alignV === 'middle' ? 0.5 : 1;
      const topWorldY = origin[1] + padding + vFactor * maxContentH;
      const maxTy = vFactor * maxContentH * scale;
      container.style.setProperty(
        '--text-anchor-ty',
        alignV === 'top' ? '0%' : `clamp(${-maxTy}px, ${-vFactor * 100}%, 0px)`,
      );

      const [sx, sy] = worldToClient(anchorX, topWorldY);
      container.style.left = `${sx}px`;
      container.style.top = `${sy}px`;
      container.style.maxWidth = `${contentWidth * scale}px`;
      container.style.maxHeight = `${maxContentH * scale}px`;
      container.dataset.widthMode = 'note';
      container.style.setProperty('--text-color', '#1a1a1a');
    } else {
      // Text object: origin-based positioning
      const props = getTextProps(handle.y)!;
      const { origin, align, width } = props;
      const color = getColor(handle.y);
      const [screenX, screenY] = worldToClient(origin[0], origin[1]);
      container.style.left = `${screenX}px`;
      container.style.top = `${screenY - scaledFontSize * getBaselineToTopRatio(fontFamily)}px`;
      if (typeof width === 'number') {
        container.style.width = `${width * scale}px`;
        container.dataset.widthMode = 'fixed';
      } else {
        container.dataset.widthMode = 'auto';
      }
      container.style.setProperty('--text-color', color);
      applyAlignCSS(container, align);
      const fillColor = getFillColor(handle.y);
      if (fillColor) container.style.backgroundColor = fillColor;
    }

    host.appendChild(container);

    // Capture click coords for cursor positioning (before resetGesture clears downWorld)
    const clickWorld = this.downWorld;
    const clientCoords = !isNew && clickWorld ? worldToClient(clickWorld[0], clickWorld[1]) : null;

    // Build extensions — labels skip Placeholder
    const extensions = [
      Document,
      ...(isLabel ? [] : [Placeholder.configure({ placeholder: 'Type something...' })]),
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
    ];

    // Create Tiptap Editor
    const editor = new Editor({
      element: { mount: container },
      extensions,
      autofocus: isNew ? 'end' : false,
      onCreate: ({ editor: ed }) => {
        syncInlineStylesToStore(ed);
        useSelectionStore.setState((s) => ({ boundsVersion: s.boundsVersion + 1 }));
      },
      onTransaction: ({ editor: ed, transaction }) => {
        syncInlineStylesToStore(ed);
        if (handle.kind === 'note' && transaction.docChanged) {
          this.updateNoteAutoSize();
        }
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
      const tool = useDeviceUIStore.getState().activeTool;
      if (tool === 'text' || tool === 'note') {
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

    const scale = useCameraStore.getState().scale;

    if (handle.kind === 'shape') {
      const frame = getFrame(handle.y);
      if (!frame) return;
      const fontSize = getFontSize(handle.y);
      const fontFamily = getFontFamily(handle.y);
      const textBox = computeLabelTextBox(getShapeType(handle.y), frame);
      const [tbx, tby, tbw, tbh] = textBox;
      const [cx, cy] = worldToClient(tbx + tbw / 2, tby + tbh / 2);
      const sf = fontSize * scale;
      this.container.style.left = `${cx}px`;
      this.container.style.top = `${cy}px`;
      this.container.style.maxWidth = `${tbw * scale}px`;
      this.container.style.maxHeight = `${tbh * scale}px`;
      this.container.style.fontSize = `${sf}px`;
      this.container.style.lineHeight = `${sf * FONT_FAMILIES[fontFamily].lineHeightMultiplier}px`;
      this.container.style.fontFamily = FONT_FAMILIES[fontFamily].fallback;
      this.container.style.setProperty(
        '--hl-pad',
        `${getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)}em`,
      );
    } else if (handle.kind === 'note') {
      const props = getNoteProps(handle.y);
      if (!props) return;
      const { origin, scale: noteScale, fontFamily, align, alignV } = props;
      const derivedFS = getNoteDerivedFontSize(this.objectId!);
      const sf = derivedFS * noteScale * scale;
      const padding = getNotePadding(noteScale);
      const contentWidth = getNoteContentWidth(noteScale);
      const maxContentH = contentWidth;

      // Horizontal anchor
      const anchorX = origin[0] + padding + anchorFactor(align) * contentWidth;
      this.container.style.setProperty(
        '--text-anchor-tx',
        align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%',
      );
      this.container.style.setProperty('--text-align', align);

      // Vertical anchor + clamp
      const vFactor = alignV === 'top' ? 0 : alignV === 'middle' ? 0.5 : 1;
      const topWorldY = origin[1] + padding + vFactor * maxContentH;
      const maxTy = vFactor * maxContentH * scale;
      this.container.style.setProperty(
        '--text-anchor-ty',
        alignV === 'top' ? '0%' : `clamp(${-maxTy}px, ${-vFactor * 100}%, 0px)`,
      );

      const [sx, sy] = worldToClient(anchorX, topWorldY);
      this.container.style.left = `${sx}px`;
      this.container.style.top = `${sy}px`;
      this.container.style.maxWidth = `${contentWidth * scale}px`;
      this.container.style.maxHeight = `${maxContentH * scale}px`;
      this.container.style.fontSize = `${sf}px`;
      this.container.style.lineHeight = `${sf * FONT_FAMILIES[fontFamily].lineHeightMultiplier}px`;
      this.container.style.fontFamily = FONT_FAMILIES[fontFamily].fallback;
      this.container.style.setProperty(
        '--hl-pad',
        `${getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)}em`,
      );
    } else {
      const props = getTextProps(handle.y);
      if (!props) return;
      const { origin, fontSize, fontFamily, width } = props;
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
  }

  // =========================================================================
  // Private: Commit and Close
  // =========================================================================

  private commitAndClose(): void {
    if (!this.editor || !this.objectId) return;
    const handle = getCurrentSnapshot().objectsById.get(this.objectId);

    // Delete empty content on close (sticky notes kept — empty note is valid)
    if (this.editor.isEmpty) {
      if (handle?.kind === 'shape') {
        // Shape label: remove label fields, keep shape
        getActiveRoomDoc().mutate(() => {
          handle.y.delete('content');
          handle.y.delete('fontSize');
          handle.y.delete('fontFamily');
          handle.y.delete('labelColor');
        });
      } else if (!handle || handle.kind !== 'note') {
        // Regular text object: delete entirely
        const roomDoc = getActiveRoomDoc();
        roomDoc.mutate((ydoc) => {
          const root = ydoc.getMap('root');
          const objects = root.get('objects') as Y.Map<Y.Map<unknown>>;
          objects.delete(this.objectId!);
        });
      }
    }

    // Track shape label close for remount prevention
    if (handle?.kind === 'shape' || handle?.kind === 'note') this.justClosedLabelId = this.objectId;

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

    if (handle.kind === 'shape') {
      if (keys.has('labelColor'))
        this.container.style.setProperty('--text-color', getLabelColor(handle.y));
      if (
        keys.has('frame') ||
        keys.has('shapeType') ||
        keys.has('fontSize') ||
        keys.has('fontFamily')
      )
        this.positionEditor();
    } else {
      if (keys.has('color')) this.container.style.setProperty('--text-color', getColor(handle.y));
      if (keys.has('fillColor') && handle.kind !== 'note')
        this.container.style.backgroundColor = getFillColor(handle.y) ?? '';

      if (handle.kind === 'note') {
        // fontFamily change: repopulate cache before positionEditor reads it
        // (this observer fires before the deep observer's computeNoteBBox)
        if (keys.has('fontFamily')) {
          const content = getContent(handle.y);
          const ff = getFontFamily(handle.y);
          if (content) textLayoutCache.getNoteLayout(this.objectId!, content, ff);
        }
        if (
          keys.has('align') ||
          keys.has('alignV') ||
          keys.has('origin') ||
          keys.has('scale') ||
          keys.has('fontFamily')
        )
          this.positionEditor();
      } else {
        if (keys.has('align'))
          applyAlignCSS(this.container, (handle.y.get('align') as TextAlign) ?? 'left');
        if (
          keys.has('origin') ||
          keys.has('fontSize') ||
          keys.has('fontFamily') ||
          keys.has('width')
        )
          this.positionEditor();
      }
    }
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private updateNoteAutoSize(): void {
    if (!this.container || !this.objectId) return;
    const handle = getCurrentSnapshot().objectsById.get(this.objectId);
    if (!handle) return;
    const props = getNoteProps(handle.y);
    if (!props) return;

    // Deep observer already invalidated cache → force repopulation
    textLayoutCache.getNoteLayout(this.objectId, props.content, props.fontFamily);
    const derivedFS = getNoteDerivedFontSize(this.objectId);

    const cameraScale = useCameraStore.getState().scale;
    const sf = derivedFS * props.scale * cameraScale;
    this.container.style.fontSize = `${sf}px`;
    this.container.style.lineHeight = `${sf * FONT_FAMILIES[props.fontFamily].lineHeightMultiplier}px`;
  }

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
