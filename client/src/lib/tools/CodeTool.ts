/**
 * CodeTool — Click-to-place code blocks + CodeMirror DOM overlay editing.
 *
 * Phase 1: Creates code objects and renders on canvas.
 * Phase 2: CodeMirror overlay with y-codemirror.next for collaborative editing.
 */

import * as Y from 'yjs';
import { ulid } from 'ulid';
import { getActiveRoomDoc, getCurrentSnapshot } from '@/canvas/room-runtime';
import {
  getCanvasElement,
  getVisibleWorldBounds,
  useCameraStore,
  worldToClient,
} from '@/stores/camera-store';
import { invalidateOverlay, invalidateWorld } from '@/canvas/invalidation-helpers';
import { getEditorHost } from '@/canvas/SurfaceManager';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { getCodeProps } from '@avlo/shared';
import {
  DEFAULT_FONT_SIZE,
  getDefaultWidth,
  getCodeFrame,
  PADDING_TOP,
  PADDING_BOTTOM,
  CODE_FONT,
  LINE_HEIGHT_MULT,
  lineHeight as lineHeightFn,
  getCodeMirrorExtensions,
} from '@/lib/code/code-system';
import type { Snapshot } from '@avlo/shared';
import type { PointerTool, PreviewData } from './types';

/**
 * Hit test for code blocks at a world position.
 */
function hitTestCode(
  worldX: number,
  worldY: number,
  snapshot: Snapshot,
  scale: number,
): string | null {
  const radius = 8 / scale;
  const index = snapshot.spatialIndex;
  if (!index) return null;

  const results = index.query({
    minX: worldX - radius,
    minY: worldY - radius,
    maxX: worldX + radius,
    maxY: worldY + radius,
  });

  // Sort by ULID descending (topmost first)
  const sorted = [...results].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

  for (const entry of sorted) {
    if (entry.kind !== 'code') continue;
    const frame = getCodeFrame(entry.id);
    if (!frame) continue;
    const [x, y, w, h] = frame;
    if (worldX >= x && worldX <= x + w && worldY >= y && worldY <= y + h) {
      return entry.id;
    }
  }

  return null;
}

export class CodeTool implements PointerTool {
  private gestureActive = false;
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private hitCodeId: string | null = null;

  // Editor state
  objectId: string | null = null;
  private container: HTMLDivElement | null = null;
  private editorView: unknown | null = null; // EditorView — typed as unknown to keep imports lazy
  private sessionUM: Y.UndoManager | null = null;
  private boundHandleKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundHandleClickOutside: ((e: PointerEvent) => void) | null = null;

  canBegin(): boolean {
    return !this.gestureActive;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    this.gestureActive = true;
    this.pointerId = pointerId;
    this.downWorld = [worldX, worldY];

    // Hit test for existing code blocks
    const roomDoc = getActiveRoomDoc();
    const snapshot = roomDoc.currentSnapshot;
    const scale = useCameraStore.getState().scale;
    this.hitCodeId = hitTestCode(worldX, worldY, snapshot, scale);
  }

  move(_worldX: number, _worldY: number): void {
    // No preview during gesture
  }

  end(worldX?: number, worldY?: number): void {
    if (!this.gestureActive) return;

    const x = worldX ?? this.downWorld?.[0] ?? 0;
    const y = worldY ?? this.downWorld?.[1] ?? 0;

    if (this.hitCodeId) {
      this.mountEditor(this.hitCodeId);
    } else {
      this.createCodeObject(x, y);
    }

    this.resetGesture();
  }

  cancel(): void {
    this.resetGesture();
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

  // Public API for SelectTool double-click-to-edit
  startEditing(objectId: string): void {
    this.mountEditor(objectId);
  }

  isEditorMounted(): boolean {
    return this.editorView !== null;
  }

  // =========================================================================
  // Private: Gesture
  // =========================================================================

  private resetGesture(): void {
    this.gestureActive = false;
    this.pointerId = null;
    this.downWorld = null;
    this.hitCodeId = null;
  }

  // =========================================================================
  // Private: Object creation — center placement
  // =========================================================================

  private createCodeObject(worldX: number, worldY: number): void {
    const roomDoc = getActiveRoomDoc();
    const fontSize = DEFAULT_FONT_SIZE;
    const width = getDefaultWidth(fontSize);
    const lh = lineHeightFn(fontSize);

    // Center placement: origin = click minus half block size
    const originX = worldX - width / 2;
    const originY = worldY - (PADDING_TOP + lh + PADDING_BOTTOM) / 2;

    let createdId: string | null = null;

    roomDoc.mutate((ydoc) => {
      const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;
      const id = ulid();
      const yObj = new Y.Map<unknown>();

      yObj.set('id', id);
      yObj.set('kind', 'code');
      yObj.set('origin', [originX, originY]);
      yObj.set('content', new Y.Text());
      yObj.set('language', 'javascript');
      yObj.set('fontSize', fontSize);
      yObj.set('width', width);
      yObj.set('ownerId', '');
      yObj.set('createdAt', Date.now());

      objects.set(id, yObj);
      createdId = id;
    });

    // Mount editor after rAF so observer has created the ObjectHandle
    if (createdId) {
      const id = createdId;
      requestAnimationFrame(() => this.mountEditor(id));
    }
  }

  // =========================================================================
  // Private: Editor Mounting
  // =========================================================================

  private async mountEditor(objectId: string): Promise<void> {
    // Close existing editor if open
    if (this.editorView) this.commitAndClose();

    const host = getEditorHost();
    if (!host) return;

    const snapshot = getCurrentSnapshot();
    const handle = snapshot.objectsById.get(objectId);
    if (!handle || handle.kind !== 'code') return;

    const props = getCodeProps(handle.y);
    if (!props) return;

    const scale = useCameraStore.getState().scale;
    const { origin, fontSize, width } = props;

    // Create container div
    const container = document.createElement('div');
    container.className = 'code-editor';
    container.style.position = 'absolute';

    // Position
    const [sx, sy] = worldToClient(origin[0], origin[1]);
    container.style.left = `${sx}px`;
    container.style.top = `${sy}px`;
    container.style.width = `${width * scale}px`;
    container.style.fontSize = `${fontSize * scale}px`;
    container.style.lineHeight = `${LINE_HEIGHT_MULT}`;
    container.style.fontFamily = CODE_FONT;

    host.appendChild(container);

    // Load CodeMirror modules lazily (parallel)
    const [cmState, cmView, cmCommands, cmLang, cmJS, cmPython, cmYCollab, themeExts] =
      await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/language'),
        import('@codemirror/lang-javascript'),
        import('@codemirror/lang-python'),
        import('y-codemirror.next'),
        getCodeMirrorExtensions(),
      ]);

    // Per-session UndoManager for the Y.Text
    const yText = props.content;
    this.sessionUM = new Y.UndoManager(yText, { captureTimeout: 500 });

    // Tab normalizer: replace \t with 4 spaces in all insertions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabNormalizer = cmState.EditorState.transactionFilter.of((tr: any) => {
      if (!tr.docChanged) return tr;
      const edits: { from: number; to: number; insert: string }[] = [];
      tr.changes.iterChanges(
        (
          _fA: number,
          _tA: number,
          fromB: number,
          toB: number,
          inserted: { toString(): string },
        ) => {
          const t = inserted.toString();
          if (t.includes('\t')) {
            edits.push({ from: fromB, to: toB, insert: t.replace(/\t/g, '    ') });
          }
        },
      );
      if (edits.length === 0) return tr;
      return [tr, { changes: edits }];
    });

    // Language extension
    const langExt =
      props.language === 'python'
        ? cmPython.python()
        : cmJS.javascript({ typescript: true, jsx: true });

    const state = cmState.EditorState.create({
      doc: yText.toString(),
      extensions: [
        cmView.lineNumbers(),
        langExt,
        cmLang.indentUnit.of('    '),
        cmView.keymap.of([cmCommands.indentWithTab]),
        cmYCollab.yCollab(yText, null, { undoManager: this.sessionUM }),
        ...(themeExts as import('@codemirror/state').Extension[]),
        tabNormalizer,
        cmView.EditorView.theme({
          '&': { fontSize: `${fontSize * scale}px` },
          '.cm-content': { fontFamily: CODE_FONT },
        }),
      ],
    });

    const view = new cmView.EditorView({ state, parent: container });
    view.focus();

    this.editorView = view;
    this.container = container;
    this.objectId = objectId;

    // Selection store
    useSelectionStore.getState().beginCodeEditing(objectId);

    // Main UM: widen capture window to avoid merging editor edits
    const mainUM = getActiveRoomDoc().getUndoManager();
    if (mainUM) {
      mainUM.stopCapturing();
      (mainUM as unknown as { captureTimeout: number }).captureTimeout = 600_000;
    }

    this.setupEditorHandlers();
  }

  // =========================================================================
  // Private: Editor Handlers
  // =========================================================================

  private setupEditorHandlers(): void {
    this.boundHandleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.commitAndClose();
      }
    };

    this.boundHandleClickOutside = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Node;
      if (this.container && this.container.contains(target)) return;
      const menuElement = document.querySelector('.ctx-menu');
      if (menuElement && menuElement.contains(target)) return;
      this.commitAndClose();
      // Consume canvas clicks when code tool is active
      if (useDeviceUIStore.getState().activeTool === 'code') {
        const canvas = getCanvasElement();
        if (canvas && canvas.contains(target)) {
          e.stopPropagation();
        }
      }
    };

    document.addEventListener('keydown', this.boundHandleKeyDown, true);
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
  // Private: Editor Positioning
  // =========================================================================

  private positionEditor(): void {
    if (!this.container || !this.objectId) return;
    const handle = getCurrentSnapshot().objectsById.get(this.objectId);
    if (!handle) return;

    const props = getCodeProps(handle.y);
    if (!props) return;

    const scale = useCameraStore.getState().scale;
    const [sx, sy] = worldToClient(props.origin[0], props.origin[1]);

    this.container.style.left = `${sx}px`;
    this.container.style.top = `${sy}px`;
    this.container.style.width = `${props.width * scale}px`;
    this.container.style.fontSize = `${props.fontSize * scale}px`;
  }

  // =========================================================================
  // Private: Commit and Close
  // =========================================================================

  commitAndClose(): void {
    if (!this.editorView || !this.objectId) return;

    this.removeEditorHandlers();

    // Destroy EditorView
    (this.editorView as { destroy(): void }).destroy();

    // Main UM: restore normal capture timeout
    const mainUM = getActiveRoomDoc().getUndoManager();
    if (mainUM) {
      mainUM.stopCapturing();
      (mainUM as unknown as { captureTimeout: number }).captureTimeout = 500;
    }

    // Clear per-session UM
    if (this.sessionUM) {
      this.sessionUM.clear();
      this.sessionUM = null;
    }

    // Remove container
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    this.container = null;
    this.editorView = null;
    this.objectId = null;

    useSelectionStore.getState().endCodeEditing();
    invalidateWorld(getVisibleWorldBounds());
    invalidateOverlay();
  }
}
