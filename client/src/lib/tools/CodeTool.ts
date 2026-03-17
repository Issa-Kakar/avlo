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
import { getCodeProps, getLineNumbers } from '@avlo/shared';
import {
  getDefaultWidth,
  padTop,
  padBottom,
  padLeft,
  padRight,
  gutterPad,
  charWidth,
  borderRadius,
  lineHeight as lineHeightFn,
} from '@/lib/code/code-system';
import { CODE_FONT_FAMILY } from '@/lib/code/code-tokens';
import { getCodeMirrorExtensions } from '@/lib/code/code-theme';
import { hitTestVisibleCode } from '@/lib/geometry/hit-testing';
import { userProfileManager } from '@/lib/user-profile-manager';
import type { PointerTool, PreviewData } from './types';

export class CodeTool implements PointerTool {
  private gestureActive = false;
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private hitCodeId: string | null = null;

  // Public: prevent close→remount cycle (mirrors textTool.justClosedLabelId)
  justClosedCodeId: string | null = null;

  // Editor state
  objectId: string | null = null;
  private container: HTMLDivElement | null = null;
  private editorView: unknown | null = null; // EditorView — typed as unknown to keep imports lazy
  private sessionUM: Y.UndoManager | null = null;
  private boundHandleKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundHandleClickOutside: ((e: PointerEvent) => void) | null = null;
  private clickTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private syncConf: unknown = null;
  private langCompartment: unknown = null;
  private lineNumbersCompartment: unknown = null;
  private yMapUnobserve: (() => void) | null = null;

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
    this.hitCodeId = hitTestVisibleCode(worldX, worldY, snapshot, scale);
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
    const uiState = useDeviceUIStore.getState();
    const fontSize = uiState.textSize;
    const lineNumbers = uiState.codeLineNumbers;
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
      yObj.set('lineNumbers', lineNumbers);
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
  private setCSSVars(
    container: HTMLDivElement,
    fontSize: number,
    scale: number,
    lineNumbers = true,
  ): void {
    const s = container.style;
    s.setProperty('--c-pt', `${padTop(fontSize) * scale}px`);
    s.setProperty('--c-pb', `${padBottom(fontSize) * scale}px`);
    s.setProperty('--c-pr', `${padRight(fontSize) * scale}px`);
    if (lineNumbers) {
      s.setProperty('--c-gl', `${padLeft(fontSize) * scale}px`);
      s.setProperty('--c-gr', `${gutterPad(fontSize) * scale}px`);
      s.setProperty('--c-gw', `${2 * charWidth(fontSize) * scale}px`);
    } else {
      s.setProperty('--c-gl', '0px');
      s.setProperty('--c-gr', `${padLeft(fontSize) * scale}px`);
      s.setProperty('--c-gw', '0px');
    }
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
    container.style.borderRadius = `${borderRadius(fontSize) * scale}px`;
    this.setCSSVars(container, fontSize, scale, props.lineNumbers);

    host.appendChild(container);

    // Load CodeMirror modules lazily (parallel)
    const [
      cmState,
      cmView,
      cmCommands,
      cmLang,
      cmJS,
      cmPython,
      cmYCollab,
      cmAutocomplete,
      themeExts,
    ] = await Promise.all([
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

    // Per-session UndoManager scoped to Y.Text + Y.Map (captures content + property changes)
    const yText = props.content;
    const yMap = handle.y;
    const userId = userProfileManager.getIdentity().userId;
    this.sessionUM = new Y.UndoManager([yText, yMap], {
      trackedOrigins: new Set([userId]),
      captureTimeout: 500,
    });

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

    // Backspace at 4-space indent boundaries deletes the unit

    const backspaceIndent = {
      key: 'Backspace',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: (v: any) => {
        const sel = v.state.selection.main;
        if (!sel.empty) return false;
        const pos = sel.head;
        const line = v.state.doc.lineAt(pos);
        const col = pos - line.from;
        if (col === 0 || col % 4 !== 0) return false;
        if (v.state.doc.sliceString(pos - 4, pos) !== '    ') return false;
        v.dispatch({ changes: { from: pos - 4, to: pos } });
        return true;
      },
    };

    // Language extension in compartment for dynamic reconfiguration
    const langCompartment = new cmState.Compartment();
    this.langCompartment = langCompartment;
    const langExt =
      props.language === 'python'
        ? cmPython.python()
        : cmJS.javascript({ typescript: true, jsx: true });

    // Line numbers in compartment for dynamic toggle
    const lineNumbersCompartment = new cmState.Compartment();
    this.lineNumbersCompartment = lineNumbersCompartment;
    const lineNumbersExt = props.lineNumbers
      ? cmView.lineNumbers({
          formatNumber: (n: number, state: { doc: { lines: number } }) => {
            const digits = Math.max(2, String(state.doc.lines).length);
            return String(n).padStart(digits, ' ');
          },
        })
      : [];

    const state = cmState.EditorState.create({
      doc: yText.toString(),
      extensions: [
        lineNumbersCompartment.of(lineNumbersExt),
        cmView.highlightActiveLine(),
        cmView.highlightActiveLineGutter(),
        cmView.EditorView.lineWrapping,
        cmLang.bracketMatching(),
        cmAutocomplete.closeBrackets(),
        langCompartment.of(langExt),
        cmLang.indentUnit.of('    '),
        cmView.keymap.of([
          backspaceIndent,
          ...cmAutocomplete.closeBracketsKeymap,
          cmCommands.indentWithTab,
          ...cmYCollab.yUndoManagerKeymap,
        ]),
        cmYCollab.yCollab(yText, null, { undoManager: this.sessionUM }),
        cmView.placeholder('Type something...'),
        ...(themeExts as import('@codemirror/state').Extension[]),
        tabNormalizer,
      ],
    });

    const view = new cmView.EditorView({ state, parent: container });
    view.focus();

    // Extract syncConf for main UM integration
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const syncConf = (view.state as any).facet(cmYCollab.ySyncFacet);
    this.syncConf = syncConf;

    // Seal main UM — entire editing session merges into one undo item
    const mainUM = getActiveRoomDoc().getUndoManager();
    if (mainUM) {
      mainUM.addTrackedOrigin(syncConf);
      mainUM.stopCapturing();
      mainUM.captureTimeout = 600_000;
    }

    // Y.Map observer for live property sync (fontSize, width, origin, language)
    const mapObserver = (evt: Y.YMapEvent<unknown>) => {
      const keys = evt.keysChanged;
      if (keys.has('fontSize') || keys.has('width') || keys.has('origin')) {
        this.positionEditor();
      }
      if (keys.has('language')) {
        this.switchLanguage(yMap);
      }
      if (keys.has('lineNumbers')) {
        this.switchLineNumbers(yMap);
        this.positionEditor();
      }
    };
    yMap.observe(mapObserver);
    this.yMapUnobserve = () => yMap.unobserve(mapObserver);

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
    this.clickTimeoutId = setTimeout(() => {
      this.clickTimeoutId = null;
      if (this.boundHandleClickOutside) {
        document.addEventListener('pointerdown', this.boundHandleClickOutside, true);
      }
    }, 100);
  }

  private removeEditorHandlers(): void {
    if (this.clickTimeoutId !== null) {
      clearTimeout(this.clickTimeoutId);
      this.clickTimeoutId = null;
    }
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
    c.style.borderRadius = `${borderRadius(props.fontSize) * scale}px`;
    this.setCSSVars(c, props.fontSize, scale, props.lineNumbers);

    // Trigger CM relayout after size change
    if (this.editorView) {
      (this.editorView as { requestMeasure(): void }).requestMeasure();
    }
  }

  // =========================================================================
  // Private: Dynamic Line Numbers Toggle
  // =========================================================================

  private async switchLineNumbers(yMap: Y.Map<unknown>): Promise<void> {
    if (!this.editorView || !this.lineNumbersCompartment) return;
    const ln = getLineNumbers(yMap);
    const cmView = await import('@codemirror/view');
    if (!this.editorView || !this.lineNumbersCompartment) return;
    const ext = ln
      ? cmView.lineNumbers({
          formatNumber: (n: number, state: { doc: { lines: number } }) => {
            const digits = Math.max(2, String(state.doc.lines).length);
            return String(n).padStart(digits, ' ');
          },
        })
      : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.editorView as any).dispatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      effects: (this.lineNumbersCompartment as any).reconfigure(ext),
    });
  }

  // =========================================================================
  // Private: Dynamic Language Switching
  // =========================================================================

  private async switchLanguage(yMap: Y.Map<unknown>): Promise<void> {
    if (!this.editorView || !this.langCompartment) return;
    const lang = yMap.get('language') as string;
    const [cmJS, cmPython] = await Promise.all([
      import('@codemirror/lang-javascript'),
      import('@codemirror/lang-python'),
    ]);
    if (!this.editorView || !this.langCompartment) return;
    const ext =
      lang === 'python' ? cmPython.python() : cmJS.javascript({ typescript: true, jsx: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.editorView as any).dispatch({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      effects: (this.langCompartment as any).reconfigure(ext),
    });
  }

  // =========================================================================
  // Private: Commit and Close
  // =========================================================================

  commitAndClose(): void {
    if (!this.editorView || !this.objectId) return;

    this.justClosedCodeId = this.objectId;
    this.removeEditorHandlers();

    // Unseal main UndoManager
    const mainUM = getActiveRoomDoc().getUndoManager();
    if (mainUM && this.syncConf) {
      mainUM.removeTrackedOrigin(this.syncConf);
      mainUM.stopCapturing();
      mainUM.captureTimeout = 500;
    }
    this.syncConf = null;

    // Clean up Y.Map observer + language compartment
    this.yMapUnobserve?.();
    this.yMapUnobserve = null;
    this.langCompartment = null;
    this.lineNumbersCompartment = null;

    // Clear per-session UM before destroy — flushes stack items holding plugin refs
    if (this.sessionUM) {
      this.sessionUM.clear();
      this.sessionUM = null;
    }

    // Destroy EditorView + break internal back-reference cycles
    const view = this.editorView as Record<string, unknown>;
    (view as unknown as { destroy(): void }).destroy();
    view.viewState = null;
    view.docView = null;
    view.inputState = null;
    view.observer = null;

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
