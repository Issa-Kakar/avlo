/**
 * CodeTool — Click-to-place code blocks + CodeMirror DOM overlay editing.
 *
 * Screen-space rendering: all dimensions computed as world * scale in px.
 * No CSS transform: scale() — text stays crisp at all zoom levels.
 * All CM padding/sizing via CSS custom properties (--c-*) set as exact px.
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
  getDefaultWidth,
  getCodeFrame,
  padTop,
  padBottom,
  padLeft,
  padRight,
  gutterPad,
  charWidth,
  CODE_FONT_FAMILY,
  BORDER_RADIUS,
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
    invalidateOverlay();
    invalidateWorld(getVisibleWorldBounds());
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
    const fontSize = useDeviceUIStore.getState().textSize;
    const width = getDefaultWidth(fontSize);
    const lh = lineHeightFn(fontSize);

    // Center placement: origin = click minus half block size
    const originX = worldX - width / 2;
    const originY = worldY - (padTop(fontSize) + lh + padBottom(fontSize)) / 2;

    let createdId: string | null = null;

    roomDoc.mutate((ydoc) => {
      const objects = ydoc.getMap('root').get('objects') as Y.Map<Y.Map<unknown>>;
      const id = ulid();
      const yObj = new Y.Map<unknown>();

      yObj.set('id', id);
      yObj.set('kind', 'code');
      yObj.set('origin', [originX, originY]);
      yObj.set('content', new Y.Text());
      yObj.set('language', 'typescript');
      yObj.set('fontSize', fontSize);
      yObj.set('width', width);
      yObj.set('ownerId', '');
      yObj.set('createdAt', Date.now());

      objects.set(id, yObj);
      createdId = id;
    });

    if (createdId) {
      this.mountEditor(createdId);
    }
  }

  // =========================================================================
  // Private: CSS var helper — sets exact px values for CM theme vars
  // =========================================================================

  /** Set all --c-* CSS custom properties as exact px on the container.
   *  CM theme references these instead of em units, eliminating browser
   *  em→px conversion rounding that causes sub-pixel mismatches vs canvas. */
  private setCSSVars(container: HTMLDivElement, fontSize: number, scale: number): void {
    const s = container.style;
    s.setProperty('--c-pt', `${padTop(fontSize) * scale}px`);
    s.setProperty('--c-pb', `${padBottom(fontSize) * scale}px`);
    s.setProperty('--c-gl', `${padLeft(fontSize) * scale}px`);
    s.setProperty('--c-gr', `${gutterPad(fontSize) * scale}px`);
    s.setProperty('--c-pr', `${padRight(fontSize) * scale}px`);
    s.setProperty('--c-gw', `${2 * charWidth(fontSize) * scale}px`);
  }

  // =========================================================================
  // Private: Editor Mounting — screen-space rendering (no CSS transform)
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

    // Screen-space dimensions — no CSS transform
    const screenFS = fontSize * scale;
    const screenW = width * scale;
    const screenLH = lineHeightFn(fontSize) * scale;

    // Create container div
    const container = document.createElement('div');
    container.className = 'code-editor';
    container.style.position = 'absolute';

    const [sx, sy] = worldToClient(origin[0], origin[1]);
    container.style.left = `${sx}px`;
    container.style.top = `${sy}px`;
    container.style.width = `${screenW}px`;
    container.style.fontSize = `${screenFS}px`;
    container.style.lineHeight = `${screenLH}px`;
    container.style.fontFamily = `'${CODE_FONT_FAMILY}', monospace`;
    container.style.borderRadius = `${BORDER_RADIUS * scale}px`;
    this.setCSSVars(container, fontSize, scale);

    host.appendChild(container);

    // Load CodeMirror modules lazily (parallel)
    const [cmState, cmView, cmCommands, cmLang, cmJS, cmPython, cmYCollab, cmAutocomplete, themeExts] =
      await Promise.all([
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/commands'),
        import('@codemirror/language'),
        import('@codemirror/lang-javascript'),
        import('@codemirror/lang-python'),
        import('y-codemirror.next'),
        import('@codemirror/autocomplete'),
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
        cmView.lineNumbers({
          formatNumber: (n: number, state: { doc: { lines: number } }) => {
            const digits = Math.max(2, String(state.doc.lines).length);
            return String(n).padStart(digits, ' ');
          },
        }),
        cmView.highlightActiveLine(),
        cmView.highlightActiveLineGutter(),
        cmView.EditorView.lineWrapping,
        cmLang.bracketMatching(),
        cmAutocomplete.closeBrackets(),
        langExt,
        cmLang.indentUnit.of('    '),
        cmView.keymap.of([...cmAutocomplete.closeBracketsKeymap, cmCommands.indentWithTab]),
        cmYCollab.yCollab(yText, null, { undoManager: this.sessionUM }),
        ...(themeExts as import('@codemirror/state').Extension[]),
        tabNormalizer,
      ],
    });

    const view = new cmView.EditorView({ state, parent: container });
    view.focus();

    // DEBUG: verify gutter-content alignment after parseInt fix
    setTimeout(() => {
      const _line = container.querySelector('.cm-line');
      const _scroller = container.querySelector('.cm-scroller');
      const _content = container.querySelector('.cm-content');
      // Get actual visible gutter elements (skip first spacer whose height=0)
      const gutterEls = container.querySelectorAll('.cm-lineNumbers .cm-gutterElement');
      const _gutter = Array.from(gutterEls).find(el => (el as HTMLElement).offsetHeight > 0) as HTMLElement | undefined;
      if (_line && _scroller && _content) {
        const lRect = (_line as HTMLElement).getBoundingClientRect();
        const sRect = (_scroller as HTMLElement).getBoundingClientRect();
        const cntRect = (_content as HTMLElement).getBoundingClientRect();
        const canvasPadTop = padTop(fontSize) * scale;
        console.log('[CodeTool] scrollerPad:', (lRect.top - sRect.top).toFixed(2), 'contentPad:', (cntRect.top - sRect.top).toFixed(2), 'canvasPad:', canvasPadTop.toFixed(2));
        console.log('[CodeTool] line0 top:', lRect.top.toFixed(2), 'height:', lRect.height.toFixed(2), 'lineHeight expected:', screenLH.toFixed(2));
        if (_gutter) {
          const gRect = _gutter.getBoundingClientRect();
          console.log('[CodeTool] gutter top:', gRect.top.toFixed(2), 'line top:', lRect.top.toFixed(2), 'GUTTER-LINE DIFF:', (gRect.top - lRect.top).toFixed(3), '(should be ~0)');
        }
      }
    }, 50);

    this.editorView = view;
    this.container = container;
    this.objectId = objectId;

    const selState = useSelectionStore.getState();
    if (selState.codeEditingId !== objectId) {
      selState.beginCodeEditing(objectId);
    }
    invalidateWorld(getVisibleWorldBounds());

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
  // Private: Editor Positioning — screen-space, no CSS transform
  // =========================================================================

  private positionEditor(): void {
    if (!this.container || !this.objectId) return;
    const handle = getCurrentSnapshot().objectsById.get(this.objectId);
    if (!handle) return;

    const props = getCodeProps(handle.y);
    if (!props) return;

    const scale = useCameraStore.getState().scale;
    const [sx, sy] = worldToClient(props.origin[0], props.origin[1]);
    const screenFS = props.fontSize * scale;
    const screenW = props.width * scale;
    const screenLH = lineHeightFn(props.fontSize) * scale;

    const c = this.container;
    c.style.left = `${sx}px`;
    c.style.top = `${sy}px`;
    c.style.width = `${screenW}px`;
    c.style.fontSize = `${screenFS}px`;
    c.style.lineHeight = `${screenLH}px`;
    c.style.borderRadius = `${BORDER_RADIUS * scale}px`;
    this.setCSSVars(c, props.fontSize, scale);

    // Trigger CM relayout after size change
    if (this.editorView) {
      (this.editorView as { requestMeasure(): void }).requestMeasure();
    }
  }

  // =========================================================================
  // Private: Commit and Close
  // =========================================================================

  commitAndClose(): void {
    if (!this.editorView || !this.objectId) return;

    this.removeEditorHandlers();

    // Destroy EditorView
    (this.editorView as { destroy(): void }).destroy();

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
