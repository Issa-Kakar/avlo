/**
 * CodeTool — Click-to-place code blocks + CodeMirror DOM overlay editing.
 *
 * Screen-space rendering: all dimensions computed as world * scale in px.
 * No CSS transform: scale() — text stays crisp at all zoom levels.
 * All CM padding/sizing via CSS custom properties (--c-*) set as exact px.
 */

import * as Y from 'yjs';
import { ulid } from 'ulid';
import { getActiveRoomDoc, getHandle, transact, getObjects } from '@/runtime/room-runtime';
import { getCanvasElement, getVisibleWorldBounds, useCameraStore, worldToClient } from '@/stores/camera-store';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { invalidateWorld } from '@/renderer/RenderLoop';
import { getEditorHost } from '@/runtime/SurfaceManager';
import { useSelectionStore } from '@/stores/selection-store';
import { useDeviceUIStore, getUserId } from '@/stores/device-ui-store';
import {
  getCodeProps,
  getLineNumbers,
  getLanguage,
  getHeaderVisible,
  getOutputVisible,
  getCodeOutput,
  CODE_EXTENSIONS,
} from '@/core/accessors';
import type { CodeLanguage } from '@/core/accessors';
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
  chromeFontSize,
  headerBarHeight,
} from '@/core/code/code-system';
import {
  CODE_FONT_FAMILY,
  MAX_TITLE_LENGTH,
  MAX_OUTPUT_CANVAS_LINES,
  OUTPUT_LINE_H_MULT,
  OUTPUT_PAD_BOTTOM_RATIO,
  OUTPUT_LABEL_H_RATIO,
} from '@/core/code/code-tokens';
import { getCodeMirrorExtensions } from '@/core/code/code-theme';
import { queryHits } from '@/core/spatial/object-query';
import { pickTopmostByKind } from '@/core/spatial/pickers';
import type { PointerTool, PreviewData } from './types';

export class CodeTool implements PointerTool {
  private gestureActive = false;
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private hitCodeId: string | null = null;
  private pendingEntryWorld: [number, number] | null = null;

  // Public: prevent close→remount cycle (mirrors textTool.justClosedLabelId)
  justClosedCodeId: string | null = null;

  // Editor state
  objectId: string | null = null;
  private container: HTMLDivElement | null = null;
  private editorView: unknown | null = null; // EditorView — typed as unknown to keep imports lazy
  private headerDiv: HTMLDivElement | null = null;
  private titleInput: HTMLInputElement | null = null;
  private outputDiv: HTMLDivElement | null = null;
  private outputTextDiv: HTMLDivElement | null = null;
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
    const cands = queryHits({ at: [worldX, worldY], radius: { px: 8 } });
    this.hitCodeId = pickTopmostByKind(cands, 'code');
  }

  move(_worldX: number, _worldY: number): void {
    // No preview during gesture
  }

  end(worldX?: number, worldY?: number): void {
    if (!this.gestureActive) return;

    const x = worldX ?? this.downWorld?.[0] ?? 0;
    const y = worldY ?? this.downWorld?.[1] ?? 0;

    if (this.hitCodeId) {
      this.startEditing(this.hitCodeId, this.downWorld ?? undefined);
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
  startEditing(objectId: string, entryWorld?: [number, number]): void {
    this.pendingEntryWorld = entryWorld ?? null;
    useSelectionStore.getState().beginCodeEditing(objectId);
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
    const uiState = useDeviceUIStore.getState();
    const fontSize = uiState.textSize;
    const lineNumbers = uiState.codeLineNumbers;
    const width = getDefaultWidth(fontSize);
    const lh = lineHeightFn(fontSize);

    // Center placement: origin = click minus half block size (including header)
    const singleLineH = headerBarHeight(fontSize) + padTop(fontSize) + lh + padBottom(fontSize);
    const originX = worldX - width / 2;
    const originY = worldY - singleLineH / 2;

    let createdId: string | null = null;

    transact(() => {
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
      yObj.set('headerVisible', true);
      yObj.set('outputVisible', false);
      yObj.set('ownerId', '');
      yObj.set('createdAt', Date.now());

      getObjects().set(id, yObj);
      createdId = id;
    });

    if (createdId) {
      useSelectionStore.getState().beginCodeEditing(createdId);
      this.mountEditor(createdId);
    }
  }

  // =========================================================================
  // Private: CSS var helper — sets exact px values for CM theme vars
  // =========================================================================

  /** Set all --c-* CSS custom properties as exact px on the container.
   *  CM theme references these instead of em units, eliminating browser
   *  em→px conversion rounding that causes sub-pixel mismatches vs canvas. */
  private setCSSVars(container: HTMLDivElement, fontSize: number, scale: number, lineNumbers = true): void {
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

    const handle = getHandle(objectId);
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

    // Header bar (before CM editor)
    if (props.headerVisible) {
      this.createHeaderDiv(container, handle.y, props.fontSize, scale);
    }

    host.appendChild(container);

    // Load CodeMirror modules lazily (parallel)
    const [cmState, cmView, cmCommands, cmLang, cmJS, cmPython, cmYCollab, cmAutocomplete, themeExts] = await Promise.all([
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
    const userId = getUserId();
    this.sessionUM = new Y.UndoManager([yText, yMap], {
      trackedOrigins: new Set([userId]),
      captureTimeout: 500,
    });

    // Tab normalizer: replace \t with 4 spaces in all insertions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabNormalizer = cmState.EditorState.transactionFilter.of((tr: any) => {
      if (!tr.docChanged) return tr;
      const edits: { from: number; to: number; insert: string }[] = [];
      tr.changes.iterChanges((_fA: number, _tA: number, fromB: number, toB: number, inserted: { toString(): string }) => {
        const t = inserted.toString();
        if (t.includes('\t')) {
          edits.push({ from: fromB, to: toB, insert: t.replace(/\t/g, '    ') });
        }
      });
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
    const langExt = props.language === 'python' ? cmPython.python() : cmJS.javascript({ typescript: true, jsx: true });

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

    // Output panel (after CM editor)
    if (props.outputVisible) {
      this.createOutputDiv(container, handle.y, props.fontSize, scale);
    }

    // Focus routing: title input if click landed in header region, else CM
    const entryWorld = this.pendingEntryWorld;
    this.pendingEntryWorld = null;
    const clickedHeader = entryWorld && props.headerVisible && entryWorld[1] < origin[1] + headerBarHeight(fontSize);

    if (clickedHeader && this.titleInput) {
      this.titleInput.focus();
    } else if (entryWorld) {
      const [cx, cy] = worldToClient(entryWorld[0], entryWorld[1]);
      view.focus();
      requestAnimationFrame(() => {
        if (!this.editorView) return;
        const v = this.editorView as {
          posAtCoords(coords: { x: number; y: number }): number | null;
          dispatch(spec: unknown): void;
          focus(): void;
        };
        const pos = v.posAtCoords({ x: cx, y: cy });
        if (pos != null) {
          v.dispatch({ selection: { anchor: pos } });
        }
        v.focus();
      });
    } else {
      view.focus();
    }

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

    // Y.Map observer for live property sync (fontSize, width, origin, language, chrome)
    const mapObserver = (evt: Y.YMapEvent<unknown>) => {
      const keys = evt.keysChanged;
      if (keys.has('fontSize') || keys.has('width') || keys.has('origin')) {
        this.positionEditor();
      }
      if (keys.has('language')) {
        this.switchLanguage(yMap);
        this.updateTitleForLanguageChange(yMap);
      }
      if (keys.has('lineNumbers')) {
        this.switchLineNumbers(yMap);
        this.positionEditor();
      }
      if (keys.has('headerVisible')) {
        this.updateHeaderVisibility(yMap);
        this.positionEditor();
      }
      if (keys.has('outputVisible')) {
        this.updateOutputVisibility(yMap);
        this.positionEditor();
      }
      if (keys.has('title')) {
        if (this.titleInput && document.activeElement !== this.titleInput) {
          const raw = yMap.get('title') as string | undefined;
          const lang = getLanguage(yMap) as CodeLanguage;
          this.titleInput.value = raw ?? `Untitled.${CODE_EXTENSIONS[lang]}`;
        }
      }
      if (keys.has('output')) {
        this.updateOutputContent(yMap);
      }
    };
    yMap.observe(mapObserver);
    this.yMapUnobserve = () => yMap.unobserve(mapObserver);

    this.editorView = view;
    this.container = container;
    this.objectId = objectId;

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
    const handle = getHandle(this.objectId);
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

    // Update header dimensions
    if (this.headerDiv) {
      const hh = headerBarHeight(props.fontSize) * scale;
      const cfs = chromeFontSize(props.fontSize) * scale;
      this.headerDiv.style.height = `${hh}px`;
      this.headerDiv.style.padding = `0 ${padRight(props.fontSize) * scale}px 0 ${padLeft(props.fontSize) * scale}px`;
      if (this.titleInput) this.titleInput.style.fontSize = `${cfs}px`;
    }

    // Update output dimensions
    if (this.outputDiv) {
      const cfs = chromeFontSize(props.fontSize) * scale;
      const outputLH = cfs * OUTPUT_LINE_H_MULT;
      this.outputDiv.style.fontSize = `${cfs}px`;
      const padB = props.fontSize * OUTPUT_PAD_BOTTOM_RATIO * scale;
      this.outputDiv.style.padding = `0 ${padRight(props.fontSize) * scale}px ${padB}px ${padLeft(props.fontSize) * scale}px`;
      // Update separator margins
      const sep = this.outputDiv.firstElementChild;
      if (sep && (sep as HTMLElement).style.height === '1px') {
        (sep as HTMLElement).style.margin = `0 ${-padRight(props.fontSize) * scale}px 0 ${-padLeft(props.fontSize) * scale}px`;
      }
      // Update label height
      const label = this.outputDiv.querySelector('.code-output-label') as HTMLElement | null;
      if (label) {
        const labelH = props.fontSize * OUTPUT_LABEL_H_RATIO * scale;
        label.style.height = `${labelH}px`;
        label.style.lineHeight = `${labelH}px`;
      }
      if (this.outputTextDiv) {
        this.outputTextDiv.style.maxHeight = `${MAX_OUTPUT_CANVAS_LINES * outputLH}px`;
        this.outputTextDiv.style.lineHeight = `${outputLH}px`;
      }
    }

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
    const [cmJS, cmPython] = await Promise.all([import('@codemirror/lang-javascript'), import('@codemirror/lang-python')]);
    if (!this.editorView || !this.langCompartment) return;
    const ext = lang === 'python' ? cmPython.python() : cmJS.javascript({ typescript: true, jsx: true });
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

    this.saveTitle();
    this.titleInput = null; // Prevent blur-triggered re-save during DOM removal
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
    this.headerDiv = null;
    this.titleInput = null;
    this.outputDiv = null;
    this.outputTextDiv = null;

    useSelectionStore.getState().endCodeEditing();
    invalidateWorld(getVisibleWorldBounds());
    invalidateOverlay();
  }

  // =========================================================================
  // Private: Header / Output DOM Helpers
  // =========================================================================

  private createHeaderDiv(container: HTMLDivElement, y: Y.Map<unknown>, fs: number, scale: number): void {
    const hh = headerBarHeight(fs) * scale;
    const cfs = chromeFontSize(fs) * scale;
    const lang = getLanguage(y) as CodeLanguage;

    const header = document.createElement('div');
    header.className = 'code-header';
    header.style.height = `${hh}px`;
    header.style.padding = `0 ${padRight(fs) * scale}px 0 ${padLeft(fs) * scale}px`;

    const input = document.createElement('input');
    input.className = 'code-title';
    input.type = 'text';
    input.maxLength = MAX_TITLE_LENGTH;
    const raw = y.get('title') as string | undefined;
    input.value = raw ?? `Untitled.${CODE_EXTENSIONS[lang]}`;
    input.style.fontSize = `${cfs}px`;
    input.addEventListener('blur', () => this.saveTitle());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur(); // Confirm title — editor stays mounted, no CM focus
      } else if (e.key === 'Escape') {
        e.stopPropagation(); // Prevent document-level handler from closing editor
        input.blur();
      }
    });

    const playBtn = document.createElement('button');
    playBtn.className = 'code-run-btn';
    playBtn.style.width = `${fs * scale}px`;
    playBtn.style.height = `${fs * scale}px`;
    playBtn.style.background = '#4ADE8035';
    playBtn.innerHTML = `<svg viewBox="0 0 16 16" width="${cfs * 0.8}px" height="${cfs * 0.8}px"><path d="M5 3l8 5-8 5V3z" fill="#4ADE80"/></svg>`;

    header.appendChild(input);
    header.appendChild(playBtn);
    container.appendChild(header);

    this.headerDiv = header;
    this.titleInput = input;
  }

  private createOutputDiv(container: HTMLDivElement, y: Y.Map<unknown>, fs: number, scale: number): void {
    const cfs = chromeFontSize(fs) * scale;
    const outputLH = cfs * OUTPUT_LINE_H_MULT;
    const maxH = MAX_OUTPUT_CANVAS_LINES * outputLH;

    const output = document.createElement('div');
    output.className = 'code-output';
    output.style.fontSize = `${cfs}px`;
    const padB = fs * OUTPUT_PAD_BOTTOM_RATIO * scale;
    output.style.padding = `0 ${padRight(fs) * scale}px ${padB}px ${padLeft(fs) * scale}px`;

    // Separator line — matches canvas fillRect (1px within the output area)
    const sep = document.createElement('div');
    sep.style.height = '1px';
    sep.style.background = 'rgba(255, 255, 255, 0.125)';
    sep.style.margin = `0 ${-padRight(fs) * scale}px 0 ${-padLeft(fs) * scale}px`;

    const label = document.createElement('div');
    label.className = 'code-output-label';
    label.textContent = 'Output';
    const labelH = fs * OUTPUT_LABEL_H_RATIO * scale;
    label.style.height = `${labelH}px`;
    label.style.lineHeight = `${labelH}px`;

    const textDiv = document.createElement('div');
    textDiv.className = 'code-output-text';
    textDiv.style.maxHeight = `${maxH}px`;
    textDiv.style.lineHeight = `${outputLH}px`;
    textDiv.textContent = (getCodeOutput(y) as string) ?? '';

    output.appendChild(sep);
    output.appendChild(label);
    output.appendChild(textDiv);
    container.appendChild(output);

    this.outputDiv = output;
    this.outputTextDiv = textDiv;
  }

  private saveTitle(): void {
    if (!this.titleInput || !this.objectId) return;
    const handle = getHandle(this.objectId);
    if (!handle) return;

    const trimmed = this.titleInput.value.trim();
    const raw = handle.y.get('title') as string | undefined;

    if (trimmed === '') {
      // Deliberate clear — store empty string (distinct from undefined = show fallback)
      if (raw !== '') {
        transact(() => {
          handle.y.set('title', '');
        });
      }
    } else if (trimmed !== raw) {
      transact(() => {
        handle.y.set('title', trimmed);
      });
    }
  }

  toggleHeader(): void {
    if (!this.objectId) return;
    const handle = getHandle(this.objectId);
    if (!handle) return;
    const current = getHeaderVisible(handle.y);
    transact(() => {
      handle.y.set('headerVisible', !current);
    });
  }

  toggleOutput(): void {
    if (!this.objectId) return;
    const handle = getHandle(this.objectId);
    if (!handle) return;
    const current = getOutputVisible(handle.y);
    transact(() => {
      handle.y.set('outputVisible', !current);
    });
  }

  private updateHeaderVisibility(y: Y.Map<unknown>): void {
    const visible = getHeaderVisible(y);
    if (visible && !this.headerDiv && this.container) {
      const props = getCodeProps(y);
      if (!props) return;
      const scale = useCameraStore.getState().scale;
      this.createHeaderDiv(this.container, y, props.fontSize, scale);
      // Move header to be the first child (before chevrons + CM)
      if (this.headerDiv && this.container.firstChild !== this.headerDiv) {
        this.container.insertBefore(this.headerDiv, this.container.firstChild);
      }
    } else if (!visible && this.headerDiv) {
      this.headerDiv.remove();
      this.headerDiv = null;
      this.titleInput = null;
    }
  }

  private updateOutputVisibility(y: Y.Map<unknown>): void {
    const visible = getOutputVisible(y);
    if (visible && !this.outputDiv && this.container) {
      const props = getCodeProps(y);
      if (!props) return;
      const scale = useCameraStore.getState().scale;
      this.createOutputDiv(this.container, y, props.fontSize, scale);
    } else if (!visible && this.outputDiv) {
      this.outputDiv.remove();
      this.outputDiv = null;
      this.outputTextDiv = null;
    }
  }

  private updateOutputContent(y: Y.Map<unknown>): void {
    if (!this.outputTextDiv) return;
    this.outputTextDiv.textContent = getCodeOutput(y) ?? '';
  }

  private updateTitleForLanguageChange(y: Y.Map<unknown>): void {
    if (!this.titleInput) return;
    const raw = y.get('title') as string | undefined;
    if (raw === undefined) {
      const lang = getLanguage(y) as CodeLanguage;
      this.titleInput.value = `Untitled.${CODE_EXTENSIONS[lang]}`;
    }
  }
}
