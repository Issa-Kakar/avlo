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

import { generateZAtTop } from '@avlo/shared';
import { Editor } from '@tiptap/core';
import Bold from '@tiptap/extension-bold';
import Document from '@tiptap/extension-document';
import Highlight from '@tiptap/extension-highlight';
import Italic from '@tiptap/extension-italic';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder } from '@tiptap/extensions';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { FontFamily, TextAlign, TextAlignV } from '@/core/accessors';
import {
  getAlign,
  getAlignV,
  getColor,
  getContent,
  getFillColor,
  getFontFamily,
  getFontSize,
  getFrame,
  getLabelColor,
  getNoteProps,
  getShapeType,
  getTextProps,
  getTextWidth,
  hasLabel,
} from '@/core/accessors';
import { pickTopmostOfKind } from '@/core/spatial/object-query';
import { TextCollaboration } from '@/core/text/extensions';
import { computeLabelTextBox } from '@/core/text/shape-label';
import {
  getNoteContentWidth,
  getNoteDerivedFontSize,
  getNoteLayout,
  getNotePadding,
  getStickyNoteTextColor,
  NOTE_WIDTH,
} from '@/core/text/sticky-note';
import { getBaselineToTopRatio, getMeasuredAscentRatio } from '@/core/text/text-measure';
import { anchorFactor, FONT_FAMILIES } from '@/core/text/text-system';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { invalidateWorldAll } from '@/renderer/RenderLoop';
import { getActiveRoomDoc, getHandle, getHandleKind, getObjects, getZOrder, transact } from '@/runtime/room-runtime';
import { getEditorHost } from '@/runtime/SurfaceManager';
import { getUserId } from '@/stores/auth-store';
import { getCanvasElement, useCameraStore, worldToClient } from '@/stores/camera-store';
import { closeStickyPanel, setCursorOverride, useDeviceUIStore } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import { dispose } from '@/utils/dispose';
import type { PointerTool, PreviewData } from './types';

/** Toolbar drag-place: release within this screen distance of pointerdown = plain click, create nothing. */
const PLACE_CLICK_MAX_PX = 5;

/** Sync TipTap editor inline styles (bold/italic/highlight) into the selection store. */
function syncInlineStylesToStore(editor: Editor): void {
  useSelectionStore.getState().setInlineStyles({
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    highlightColor: editor.isActive('highlight') ? ((editor.getAttributes('highlight').color as string | undefined) ?? '#ffd43b') : null,
  });
}

export class TextTool implements PointerTool {
  // Gesture state
  private gestureActive = false;
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private hitTextId: string | null = null;

  // Toolbar drag-place state (entered via beginPlace; pointerdown was on a palette
  // swatch and the canvas holds pointer capture). placePos null until first move.
  private placing = false;
  private placePos: [number, number] | null = null;
  private placeFill = '';

  // Editor state
  private container: HTMLDivElement | null = null;
  private editor: Editor | null = null;
  objectId: string | null = null; // public — mirrors textEditingId

  justClosedLabelId: string | null = null;

  // Event handler refs
  private boundHandleKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundHandleClickOutside: ((e: PointerEvent) => void) | null = null;

  // Re-entrancy guard for commitAndClose — see commitAndClose() for why.
  private closing = false;

  // =========================================================================
  // PointerTool Interface
  // =========================================================================

  canBegin(): boolean {
    const isEditing = useSelectionStore.getState().textEditingId !== null;
    return !this.gestureActive && !isEditing;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (this.gestureActive) return;

    this.gestureActive = true;
    this.pointerId = pointerId;
    this.downWorld = [worldX, worldY];
    const tool = useDeviceUIStore.getState().tool.active;
    // A note-tool press on the canvas is a create/edit gesture (panning takes a
    // separate path) — dismiss the sticky palette so it isn't left hanging.
    if (tool === 'note') closeStickyPanel();
    this.hitTextId = pickTopmostOfKind([worldX, worldY], { px: 8 }, tool === 'note' ? 'note' : 'text');
  }

  /** Toolbar drag-place gesture — sticky-note preview follows the cursor, drop creates + edits. */
  beginPlace(pointerId: number, worldX: number, worldY: number): void {
    this.gestureActive = true;
    this.placing = true;
    this.pointerId = pointerId;
    this.downWorld = [worldX, worldY];
    this.placePos = null;
    this.placeFill = useDeviceUIStore.getState().note.fillColor; // caller set it just before
  }

  move(worldX: number, worldY: number): void {
    if (!this.placing) return;
    if (this.placePos) {
      this.placePos[0] = worldX;
      this.placePos[1] = worldY;
    } else {
      this.placePos = [worldX, worldY];
    }
    invalidateOverlay();
  }

  end(worldX?: number, worldY?: number): void {
    if (this.placing) {
      this.endPlace(worldX, worldY);
      return;
    }

    if (!this.gestureActive || !this.downWorld) {
      this.resetGesture();
      return;
    }

    if (this.hitTextId) {
      useSelectionStore.getState().beginTextEditing(this.hitTextId);
      this.mountEditor(this.hitTextId, false);
    } else {
      let [x, y] = this.downWorld;
      if (useDeviceUIStore.getState().tool.active === 'note') {
        x -= NOTE_WIDTH / 2;
        y -= NOTE_WIDTH / 2;
      }
      const objectId = this.createTextObject(x, y);
      useSelectionStore.getState().beginTextEditing(objectId);
      this.mountEditor(objectId, true);
    }

    this.resetGesture();
    invalidateOverlay();
    invalidateWorldAll();
  }

  private endPlace(worldX?: number, worldY?: number): void {
    setCursorOverride(null);
    closeStickyPanel(); // click AND drop both dismiss (parity with pickColor / begin())
    const down = this.downWorld!;
    const scale = useCameraStore.getState().scale;
    if (worldX === undefined || worldY === undefined || Math.hypot(worldX - down[0], worldY - down[1]) * scale < PLACE_CLICK_MAX_PX) {
      this.resetGesture(); // plain click — color already applied at pointerdown
      invalidateOverlay();
      return;
    }

    const objectId = this.createTextObject(worldX - NOTE_WIDTH / 2, worldY - NOTE_WIDTH / 2);
    useSelectionStore.getState().beginTextEditing(objectId);
    this.mountEditor(objectId, true); // same create+edit flow as click-create

    this.resetGesture();
    invalidateOverlay();
    invalidateWorldAll();
  }

  cancel(): void {
    if (this.placing) {
      setCursorOverride(null);
      closeStickyPanel();
    }
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
    if (this.placing && this.placePos) {
      return { kind: 'note', x: this.placePos[0] - NOTE_WIDTH / 2, y: this.placePos[1] - NOTE_WIDTH / 2, fillColor: this.placeFill };
    }
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
   * SelectTool (click) passes the click position for cursor placement; keyboard Enter
   * omits it so the cursor lands at the end of the document.
   */
  startEditing(objectId: string, entryPoint?: [number, number]): void {
    const handle = getHandle(objectId);
    if (!handle) return;

    // Create label fields if shape without label
    const isNewLabel = handle.kind === 'shape' && !hasLabel(handle.y);
    if (isNewLabel) {
      const { text, shape } = useDeviceUIStore.getState();
      transact(() => {
        handle.y.set('content', new Y.XmlFragment());
        handle.y.set('fontSize', text.size);
        handle.y.set('fontFamily', text.fontFamily);
        handle.y.set('labelColor', text.color);
        handle.y.set('align', shape.align);
        handle.y.set('alignV', shape.alignV);
      });
    }

    this.downWorld = entryPoint ?? null;
    useSelectionStore.getState().beginTextEditing(objectId);
    invalidateWorldAll();
    this.mountEditor(objectId, isNewLabel);
  }

  /**
   * Re-skin the mounted editor after the edited object's kind flipped in place
   * (cross-kind conversion). Called by selection-store's observer bridge AFTER
   * the deep observer rebuilt the subsystem caches — reads fresh state,
   * idempotent. The editor, fragment binding, caret, and undo session all
   * survive: same Y.XmlFragment instance, no remount. onTransaction's closure
   * `handle` self-corrects (kind was mutated in place on the same object).
   */
  onEditingKindChanged(): void {
    if (!this.container || !this.objectId) return;
    const handle = getHandle(this.objectId);
    if (!handle) return;
    const c = this.container;

    // Reset cross-mode residue — each target mode rewrites only its own subset.
    // (--text-anchor-tx / --text-align are rewritten by every target path.)
    c.style.width = '';
    c.style.maxWidth = '';
    c.style.maxHeight = '';
    c.style.backgroundColor = '';
    c.style.setProperty('--text-anchor-ty', '0%');

    if (handle.kind === 'shape') {
      c.dataset.widthMode = 'label';
      c.style.setProperty('--text-color', getLabelColor(handle.y));
    } else if (handle.kind === 'note') {
      c.dataset.widthMode = 'note';
      const props = getNoteProps(handle.y);
      if (props) {
        getNoteLayout(this.objectId, props.content, props.fontFamily); // defensive — cheap tier-1 hit
        c.style.setProperty('--text-color', getStickyNoteTextColor(props.fillColor));
      }
    } else {
      c.dataset.widthMode = typeof getTextWidth(handle.y) === 'number' ? 'fixed' : 'auto';
      c.style.setProperty('--text-color', getColor(handle.y));
      applyAlignCSS(c, getAlign(handle.y));
      const fillColor = getFillColor(handle.y);
      if (fillColor) c.style.backgroundColor = fillColor;
    }

    // Covers position / fontSize / lineHeight / fontFamily / --hl-pad / per-mode
    // dims (note branch reads derived·scale automatically).
    this.positionEditor();
    invalidateOverlay(); // handle-visibility rules differ per kind while editing
  }

  isEditorMounted(): boolean {
    return this.editor !== null;
  }

  isEditingLabel(): boolean {
    if (!this.objectId) return false;
    const kind = getHandleKind(this.objectId);
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
    const objectId = ulid();
    const userId = getUserId();
    const ui = useDeviceUIStore.getState();
    const isNoteMode = ui.tool.active === 'note';

    transact(() => {
      const yObj = new Y.Map<unknown>();
      yObj.set('id', objectId);
      yObj.set('origin', [worldX, worldY]);
      yObj.set('content', new Y.XmlFragment());
      yObj.set('ownerId', userId);
      yObj.set('createdAt', Date.now());

      if (isNoteMode) {
        yObj.set('kind', 'note');
        yObj.set('scale', 1);
        yObj.set('fontFamily', ui.note.fontFamily);
        yObj.set('align', ui.note.align);
        yObj.set('alignV', ui.note.alignV);
        yObj.set('fillColor', ui.note.fillColor);
      } else {
        yObj.set('kind', 'text');
        yObj.set('fontSize', ui.text.size);
        yObj.set('fontFamily', ui.text.fontFamily);
        yObj.set('color', ui.text.color);
        yObj.set('align', ui.text.align);
        yObj.set('width', 'auto');
        if (ui.text.fillColor) yObj.set('fillColor', ui.text.fillColor);
      }

      yObj.set('z', generateZAtTop(getZOrder().maxZ()));
      getObjects().set(objectId, yObj);
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

    const handle = getHandle(objectId);
    if (!handle) {
      console.error('[TextTool] Object not found:', objectId);
      return;
    }

    const isLabel = handle.kind === 'shape';

    // Read shared properties
    let fragment: Y.XmlFragment | null;
    let fontSize: number;
    let fontFamily: FontFamily;

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
      getNoteLayout(objectId, np.content, np.fontFamily);
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
    container.style.setProperty('--hl-pad', `${getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)}em`);

    const isNoteObj = !isLabel && handle.kind === 'note';

    if (isLabel) {
      // Label: alignment-aware positioning within text box
      const frame = getFrame(handle.y)!;
      const textBox = computeLabelTextBox(getShapeType(handle.y), frame);
      const [tbx, tby, tbw, tbh] = textBox;
      const align = getAlign(handle.y, 'center');
      const alignV: TextAlignV = getAlignV(handle.y);

      // Horizontal anchor
      const anchorX = tbx + anchorFactor(align) * tbw;
      container.style.setProperty('--text-anchor-tx', align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%');
      container.style.setProperty('--text-align', align);

      // Vertical anchor + clamp
      const vFactor = alignV === 'top' ? 0 : alignV === 'middle' ? 0.5 : 1;
      const anchorY = tby + vFactor * tbh;
      const maxTy = vFactor * tbh * scale;
      container.style.setProperty('--text-anchor-ty', alignV === 'top' ? '0%' : `clamp(${-maxTy}px, ${-vFactor * 100}%, 0px)`);

      const [sx, sy] = worldToClient(anchorX, anchorY);
      container.style.left = `${sx}px`;
      container.style.top = `${sy}px`;
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
      container.style.setProperty('--text-anchor-tx', align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%');
      container.style.setProperty('--text-align', align);

      // Vertical: position at vFactor anchor, clamp translateY
      const vFactor = alignV === 'top' ? 0 : alignV === 'middle' ? 0.5 : 1;
      const topWorldY = origin[1] + padding + vFactor * maxContentH;
      const maxTy = vFactor * maxContentH * scale;
      container.style.setProperty('--text-anchor-ty', alignV === 'top' ? '0%' : `clamp(${-maxTy}px, ${-vFactor * 100}%, 0px)`);

      const [sx, sy] = worldToClient(anchorX, topWorldY);
      container.style.left = `${sx}px`;
      container.style.top = `${sy}px`;
      container.style.maxWidth = `${contentWidth * scale}px`;
      container.style.maxHeight = `${maxContentH * scale}px`;
      container.dataset.widthMode = 'note';
      container.style.setProperty('--text-color', getStickyNoteTextColor(props.fillColor));
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
        userId: getUserId(),
        mainUndoManager: getActiveRoomDoc().getUndoManager(),
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

    // For existing text, place cursor at click position when provided, else at end.
    // Deferred to next frame — ProseMirror needs a layout pass before posAtCoords works.
    if (!isNew) {
      requestAnimationFrame(() => {
        if (!this.editor) return;
        const hit = clientCoords ? this.editor.view.posAtCoords({ left: clientCoords[0], top: clientCoords[1] }) : null;
        this.editor.commands.focus(hit ? hit.pos : 'end');
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
      if (this.container?.contains(target)) return;
      const menuElement = document.querySelector('.ctx-menu');
      if (menuElement?.contains(target)) return;

      // Niche guard for shape/note labels: this same pointerdown is about to reach
      // SelectTool, which would re-enter editing on pointerup. Capture id/kind
      // BEFORE commitAndClose nulls objectId, then arm justClosedLabelId for
      // SelectTool's pointerup to consume. Escape and programmatic closes don't
      // go through here, so they never arm the guard.
      const closingId = this.objectId;
      const closingKind = closingId ? getHandle(closingId)?.kind : null;

      this.commitAndClose();

      if (closingId && (closingKind === 'shape' || closingKind === 'note')) {
        this.justClosedLabelId = closingId;
      }

      // Only consume canvas clicks when text tool is active — prevents creating
      // a new text object on click-off. Other tools (select, draw, etc.) should
      // receive the event so the click-off also starts their gesture.
      const tool = useDeviceUIStore.getState().tool.active;
      if (tool === 'text' || tool === 'note') {
        const canvas = getCanvasElement();
        if (canvas?.contains(target)) {
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
    this.boundHandleKeyDown = dispose(this.boundHandleKeyDown, (h) => document.removeEventListener('keydown', h, true));
    this.boundHandleClickOutside = dispose(this.boundHandleClickOutside, (h) => document.removeEventListener('pointerdown', h, true));
  }

  // =========================================================================
  // Private: Editor Positioning — reads fresh from Y.Map every call
  // =========================================================================

  private positionEditor(): void {
    if (!this.container || !this.objectId) return;
    const handle = getHandle(this.objectId);
    if (!handle) return;

    const scale = useCameraStore.getState().scale;

    if (handle.kind === 'shape') {
      const frame = getFrame(handle.y);
      if (!frame) return;
      const fontSize = getFontSize(handle.y);
      const fontFamily = getFontFamily(handle.y);
      const textBox = computeLabelTextBox(getShapeType(handle.y), frame);
      const [tbx, tby, tbw, tbh] = textBox;
      const align = getAlign(handle.y, 'center');
      const alignV: TextAlignV = getAlignV(handle.y);

      // Horizontal anchor
      const anchorX = tbx + anchorFactor(align) * tbw;
      this.container.style.setProperty('--text-anchor-tx', align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%');
      this.container.style.setProperty('--text-align', align);

      // Vertical anchor + clamp
      const vFactor = alignV === 'top' ? 0 : alignV === 'middle' ? 0.5 : 1;
      const anchorY = tby + vFactor * tbh;
      const maxTy = vFactor * tbh * scale;
      this.container.style.setProperty('--text-anchor-ty', alignV === 'top' ? '0%' : `clamp(${-maxTy}px, ${-vFactor * 100}%, 0px)`);

      const [sx, sy] = worldToClient(anchorX, anchorY);
      const sf = fontSize * scale;
      this.container.style.left = `${sx}px`;
      this.container.style.top = `${sy}px`;
      this.container.style.maxWidth = `${tbw * scale}px`;
      this.container.style.maxHeight = `${tbh * scale}px`;
      this.container.style.fontSize = `${sf}px`;
      this.container.style.lineHeight = `${sf * FONT_FAMILIES[fontFamily].lineHeightMultiplier}px`;
      this.container.style.fontFamily = FONT_FAMILIES[fontFamily].fallback;
      this.container.style.setProperty('--hl-pad', `${getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)}em`);
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
      this.container.style.setProperty('--text-anchor-tx', align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%');
      this.container.style.setProperty('--text-align', align);

      // Vertical anchor + clamp
      const vFactor = alignV === 'top' ? 0 : alignV === 'middle' ? 0.5 : 1;
      const topWorldY = origin[1] + padding + vFactor * maxContentH;
      const maxTy = vFactor * maxContentH * scale;
      this.container.style.setProperty('--text-anchor-ty', alignV === 'top' ? '0%' : `clamp(${-maxTy}px, ${-vFactor * 100}%, 0px)`);

      const [sx, sy] = worldToClient(anchorX, topWorldY);
      this.container.style.left = `${sx}px`;
      this.container.style.top = `${sy}px`;
      this.container.style.maxWidth = `${contentWidth * scale}px`;
      this.container.style.maxHeight = `${maxContentH * scale}px`;
      this.container.style.fontSize = `${sf}px`;
      this.container.style.lineHeight = `${sf * FONT_FAMILIES[fontFamily].lineHeightMultiplier}px`;
      this.container.style.fontFamily = FONT_FAMILIES[fontFamily].fallback;
      this.container.style.setProperty('--hl-pad', `${getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)}em`);
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
      this.container.style.setProperty('--hl-pad', `${getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)}em`);
      if (typeof width === 'number') this.container.style.width = `${width * scale}px`;
    }
  }

  // =========================================================================
  // Public: Commit and Close — safe to call when nothing is mounted (no-op DOM teardown,
  // still syncs store state). Selection store calls this when the editing object is
  // deleted by a remote peer or local action.
  // =========================================================================

  commitAndClose(): void {
    // Re-entrancy guard. The empty-text branch below calls `transact(getObjects().delete(...))`,
    // and the room deep observer fires synchronously inside that transact → Phase A bridge in
    // selection-store.onObjectsDeleted calls this same method recursively. Without the guard,
    // the inner call tears down the editor + nulls fields, then the outer call hits
    // `this.editor.destroy()` on a null editor and throws. The throw escapes
    // boundHandleClickOutside before its `e.stopPropagation()` runs, so the canvas pointerdown
    // proceeds and spawns a fresh text object. The outer call owns the teardown; the inner is
    // a no-op (re-tearing is unsafe and unnecessary — selection-store's only purpose calling
    // us here is editor unmount, which the outer call already guarantees).
    if (this.closing) return;
    this.closing = true;
    try {
      if (this.editor && this.objectId) {
        const handle = getHandle(this.objectId);

        // Delete empty content on close — only when object still exists (otherwise the
        // remote/local delete already removed it). Sticky notes keep empty content.
        if (this.editor.isEmpty && handle) {
          if (handle.kind === 'shape') {
            // Shape label: remove label fields, keep shape
            transact(() => {
              handle.y.delete('content');
              handle.y.delete('fontSize');
              handle.y.delete('fontFamily');
              handle.y.delete('labelColor');
              handle.y.delete('align');
              handle.y.delete('alignV');
            });
          } else if (handle.kind !== 'note') {
            // Regular text object: delete entirely
            transact(() => {
              getObjects().delete(this.objectId!);
            });
          }
        }

        this.removeEditorHandlers();

        // ProseMirror's DOMObserver intermittently leaks one `selectionchange` listener on
        // `document` per destroy — the bound handler's `this` retains `view`, which retains
        // `view.dom` (the entire detached editor DOM tree). Heap retainer chain confirmed
        // 1:1 with this listener. PM's start/stop is reference-counted and our onTransaction
        // sync re-enters it overlapping with a mid-flight selection, leaving one `start`
        // unmatched. Snapshot the bound handler before destroy(), force-remove after — no-op
        // when PM removed it correctly.
        // biome-ignore lint/suspicious/noExplicitAny: ProseMirror domObserver is internal
        const onSelectionChange = (this.editor.view as any).domObserver?.onSelectionChange as ((e: Event) => void) | undefined;

        // Destroy triggers extension onDestroy → seals undo session, clears per-session UM
        this.editor.destroy();
        // biome-ignore lint/suspicious/noExplicitAny: release Tiptap internal EditorState + plugin states
        (this.editor as any).editorState = null; // Tiptap doesn't null this — release EditorState + plugin states

        if (onSelectionChange) {
          document.removeEventListener('selectionchange', onSelectionChange);
        }

        if (this.container?.parentNode) {
          this.container.parentNode.removeChild(this.container);
        }

        this.container = null;
        this.editor = null;
        this.objectId = null;

        // World invalidation required — unmounting the editor doesn't trigger a Yjs mutation
        invalidateWorldAll();
        invalidateOverlay();
      }

      useSelectionStore.getState().endTextEditing();
    } finally {
      this.closing = false;
    }
  }

  // =========================================================================
  // Private: Y.Map → DOM sync (called by extension observer on undo/redo)
  // =========================================================================

  private syncProps(keys: Set<string>): void {
    if (!this.container || !this.objectId) return;

    const handle = getHandle(this.objectId);
    if (!handle) return;

    // Kind conversion in flight: this extension observer fires BEFORE the deep
    // observer's kind branch, so `handle.kind` is still the OLD kind and every
    // branch below would mis-dispatch. Bail — the store bridge calls
    // onEditingKindChanged() after caches + the handle mirror are rebuilt.
    if (keys.has('kind')) return;

    if (handle.kind === 'shape') {
      if (keys.has('labelColor')) this.container.style.setProperty('--text-color', getLabelColor(handle.y));
      if (
        keys.has('frame') ||
        keys.has('shapeType') ||
        keys.has('fontSize') ||
        keys.has('fontFamily') ||
        keys.has('align') ||
        keys.has('alignV')
      )
        this.positionEditor();
    } else {
      if (keys.has('color')) this.container.style.setProperty('--text-color', getColor(handle.y));

      if (handle.kind === 'note') {
        // Notes paint their body on canvas, so fillColor drives the contrast
        // text-color CSS var rather than a DOM background.
        if (keys.has('fillColor')) {
          const fill = getFillColor(handle.y) ?? '#FEF3AC';
          this.container.style.setProperty('--text-color', getStickyNoteTextColor(fill));
        }
        // fontFamily change: repopulate cache before positionEditor reads it
        // (this observer fires before the deep observer's computeNoteBBox)
        if (keys.has('fontFamily')) {
          const content = getContent(handle.y);
          const ff = getFontFamily(handle.y);
          if (content) getNoteLayout(this.objectId!, content, ff);
        }
        if (keys.has('align') || keys.has('alignV') || keys.has('origin') || keys.has('scale') || keys.has('fontFamily'))
          this.positionEditor();
      } else {
        if (keys.has('fillColor')) this.container.style.backgroundColor = getFillColor(handle.y) ?? '';
        if (keys.has('align')) applyAlignCSS(this.container, (handle.y.get('align') as TextAlign) ?? 'left');
        if (keys.has('origin') || keys.has('fontSize') || keys.has('fontFamily') || keys.has('width')) this.positionEditor();
      }
    }
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private updateNoteAutoSize(): void {
    if (!this.container || !this.objectId) return;
    const handle = getHandle(this.objectId);
    if (!handle) return;
    const props = getNoteProps(handle.y);
    if (!props) return;

    // Deep observer already invalidated cache → force repopulation
    getNoteLayout(this.objectId, props.content, props.fontFamily);
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
    this.placing = false;
    this.placePos = null;
  }
}

// =========================================================================
// Helpers
// =========================================================================

/** Set CSS custom properties for transform-based anchor positioning. */
function applyAlignCSS(container: HTMLDivElement, align: TextAlign): void {
  container.style.setProperty('--text-align', align);
  container.style.setProperty('--text-anchor-tx', align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%');
}
