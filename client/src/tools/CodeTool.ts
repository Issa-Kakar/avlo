/**
 * CodeTool — Click-to-place code blocks + CodeMirror DOM overlay editing.
 *
 * Screen-space rendering: all dimensions computed as world * scale in px.
 * No CSS transform: scale() — text stays crisp at all zoom levels.
 * All CM padding/sizing via CSS custom properties (--c-*) set as exact px.
 */

import { generateZAtTop } from '@avlo/shared';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import { getCodeOutput, getCodeProps, getHeaderVisible, getLineNumbers, getOutputVisible } from '@/core/accessors';
import {
  borderRadius,
  charWidth,
  chromeFontSize,
  getDefaultWidth,
  gutterGap,
  headerBarHeight,
  lineHeight as lineHeightFn,
  padBottom,
  padLeft,
  padRight,
  padTop,
} from '@/core/code/code-system';
import { getCodeMirrorExtensions } from '@/core/code/code-theme';
import {
  CODE_FONT_FAMILY,
  MAX_OUTPUT_CANVAS_LINES,
  MAX_TITLE_LENGTH,
  OUTPUT_LABEL_H_RATIO,
  OUTPUT_LINE_H_MULT,
  OUTPUT_PAD_BOTTOM_RATIO,
  playButtonGeom,
  THEME,
} from '@/core/code/code-tokens';
import { pickTopmostOfKind } from '@/core/spatial/object-query';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { invalidateWorldAll } from '@/renderer/RenderLoop';
import { getActiveRoomDoc, getHandle, getObjects, getZOrder, transact } from '@/runtime/room-runtime';
import { getEditorHost } from '@/runtime/SurfaceManager';
import { getCanvasElement, useCameraStore, worldToClient } from '@/stores/camera-store';
import { getUserId } from '@/stores/auth-store';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';
import { dispose } from '@/utils/dispose';
import type { PointerTool, PreviewData } from './types';

export class CodeTool implements PointerTool {
  private gestureActive = false;
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private hitCodeId: string | null = null;
  private pendingEntryWorld: [number, number] | null = null;

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
  // Tracks the in-flight mount target during the async CM import window. A second
  // startEditing call simply overwrites this; the first await's post-resume
  // identity check then finds a stale id and bails without ever touching the DOM.
  private pendingMountId: string | null = null;

  canBegin(): boolean {
    return !this.gestureActive;
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    this.gestureActive = true;
    this.pointerId = pointerId;
    this.downWorld = [worldX, worldY];

    // Hit test for existing code blocks
    this.hitCodeId = pickTopmostOfKind([worldX, worldY], { px: 8 }, 'code');
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
    invalidateWorldAll();
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
    const ui = useDeviceUIStore.getState();
    const fontSize = ui.text.size;
    const lineNumbers = ui.code.lineNumbers;
    const headerVisible = ui.code.headerVisible;
    const width = getDefaultWidth(fontSize);
    const lh = lineHeightFn(fontSize);

    // Center placement: origin = click minus half block size (including header when shown)
    const singleLineH = (headerVisible ? headerBarHeight(fontSize) : 0) + padTop(fontSize) + lh + padBottom(fontSize);
    const originX = worldX - width / 2;
    const originY = worldY - singleLineH / 2;

    const createdId = transact(() => {
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
      yObj.set('headerVisible', headerVisible);
      yObj.set('outputVisible', false);
      yObj.set('title', 'Untitled');
      yObj.set('ownerId', '');
      yObj.set('createdAt', Date.now());
      yObj.set('z', generateZAtTop(getZOrder().maxZ()));

      getObjects().set(id, yObj);
      return id;
    });

    if (createdId) {
      this.mountEditor(createdId);
    }
  }

  // =========================================================================
  // Private: CSS var helper — sets exact px values for CM theme vars
  // =========================================================================

  /** Set all --c-* CSS custom properties as exact px on the container.
   *  CM theme references the layout vars instead of em units, eliminating
   *  browser em→px conversion rounding. Chrome color vars feed plain CSS
   *  rules (`.code-editor`, `.code-title`, ...) so a future theme swap
   *  flows through without touching index.css. */
  private setCSSVars(container: HTMLDivElement, fontSize: number, scale: number, lineNumbers = true): void {
    const s = container.style;
    const pl = padLeft(fontSize) * scale;
    // Layout (px) — single padLeft constant for chrome, gutter indent, and content.
    // `--c-gg` is the extra gutter→content separation (lines-on only), painted as
    // right-padding inside `.cm-gutterElement` so the active-line gutter highlight
    // covers it continuously up to the code line.
    s.setProperty('--c-pt', `${padTop(fontSize) * scale}px`);
    s.setProperty('--c-pb', `${padBottom(fontSize) * scale}px`);
    s.setProperty('--c-pr', `${padRight(fontSize) * scale}px`);
    s.setProperty('--c-cl', `${pl}px`);
    if (lineNumbers) {
      s.setProperty('--c-gi', `${pl}px`);
      s.setProperty('--c-gw', `${2 * charWidth(fontSize) * scale}px`);
      s.setProperty('--c-gg', `${gutterGap(fontSize) * scale}px`);
    } else {
      s.removeProperty('--c-gi');
      s.removeProperty('--c-gw');
      s.removeProperty('--c-gg');
    }
    // Play button — sized to fontSize. CSS positions the SVG absolutely via
    // `calc(50% - var(--c-tri-w) / 3)` so the triangle centroid (at W/3 of its
    // bbox) lands on the button center, matching canvas's `triX = btnCx - triW/3`.
    const { triW, triH } = playButtonGeom(fontSize);
    s.setProperty('--c-btn-size', `${fontSize * scale}px`);
    s.setProperty('--c-tri-w', `${triW * scale}px`);
    s.setProperty('--c-tri-h', `${triH * scale}px`);
    // Chrome colors — index.css rules read `var(--c-*, <hex fallback>)`.
    s.setProperty('--c-bg', THEME.chrome.bg);
    s.setProperty('--c-sep', THEME.chrome.sep);
    s.setProperty('--c-title', THEME.chrome.title);
    s.setProperty('--c-caret', THEME.chrome.caret);
    s.setProperty('--c-placeholder', THEME.chrome.placeholder);
    s.setProperty('--c-output-label', THEME.chrome.outputLabel);
    s.setProperty('--c-output-text', THEME.chrome.outputText);
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

    // ─── PHASE 1: off-DOM build ────────────────────────────────────────────
    // Container + header are constructed detached. CM is still imported async
    // below; the editor view will be parented into this container while it's
    // off-DOM. Nothing visible to the user yet — code stays painted on the
    // canvas, no flicker.
    const screenFS = fontSize * scale;
    const screenW = width * scale;
    const screenLH = lineHeightFn(fontSize) * scale;

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

    if (props.headerVisible) {
      this.createHeaderDiv(container, handle.y, props.fontSize, scale);
    }

    // Mark intent. A subsequent `startEditing` overwrites this id; the older
    // mount's post-await check then sees a stale id and bails before any DOM
    // swap or store mutation.
    this.pendingMountId = objectId;

    // ─── PHASE 2: lazy CM imports (the only async window) ──────────────────
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

    // ─── PHASE 3: post-await abort check ───────────────────────────────────
    // - Re-entrancy: another startEditing overwrote pendingMountId.
    // - Object was deleted / kind changed during the import wait.
    // - Editor was closed (commitAndClose) during the wait.
    // In any case, drop the half-built container (still off-DOM, GC handles it)
    // and don't touch shared state.
    if (this.pendingMountId !== objectId) return;
    const stillValid = getHandle(objectId);
    if (!stillValid || stillValid.kind !== 'code') {
      this.pendingMountId = null;
      return;
    }

    // ─── PHASE 4: build CM state + view (still off-DOM) ────────────────────
    const yText = props.content;
    const yMap = handle.y;
    const userId = getUserId();
    this.sessionUM = new Y.UndoManager([yText, yMap], {
      trackedOrigins: new Set([userId]),
      captureTimeout: 500,
    });

    // Tab normalizer: replace \t with 4 spaces in all insertions
    // biome-ignore lint/suspicious/noExplicitAny: CodeMirror transactionFilter callback param
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
      // biome-ignore lint/suspicious/noExplicitAny: CodeMirror keymap handler view param
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

    // CM renders its DOM into the off-DOM container. Works fine — measurement
    // happens later via `requestMeasure` (or implicitly on first focus).
    const view = new cmView.EditorView({ state, parent: container });

    if (props.outputVisible) {
      this.createOutputDiv(container, handle.y, props.fontSize, scale);
    }

    // ─── PHASE 5: ATOMIC SWAP ──────────────────────────────────────────────
    // In a single tick (no paint occurs between these synchronous statements):
    // container hits the DOM, its screen geometry is re-derived from the LIVE
    // camera, canvas suppresses its code rendering for this id, overlay clears
    // its resize handles. From the user's perspective, one frame: code
    // disappears from canvas + handles disappear + DOM appears with fully
    // rendered CM, positioned exactly where the canvas was painting it.
    host.appendChild(container);

    this.editorView = view;
    this.container = container;
    this.objectId = objectId;
    this.pendingMountId = null;

    // Re-sync to the LIVE camera + props before the canvas hands off. PHASE 1
    // positioned the container from a scale/pan snapshot taken *before* the
    // async import window; a zoom/pan during that ~500ms (or a remote geometry
    // edit) leaves left/top/width/fontSize/CSS-vars/header/output stale, and the
    // handoff frame would show the editor frozen at the old transform while the
    // canvas repaints neighbors at the new one. positionEditor() is the single
    // authority for on-screen geometry — it recomputes everything from current
    // state here, then again on every onViewChange while editing. PHASE 1's
    // geometry is therefore only scaffolding for CM's off-DOM build; this call
    // establishes the first user-visible frame. Runs post-appendChild so its
    // requestMeasure() measures an attached element.
    this.positionEditor();

    useSelectionStore.getState().beginCodeEditing(objectId);

    invalidateOverlay();
    invalidateWorldAll();

    // ─── PHASE 6: post-swap wiring ─────────────────────────────────────────
    // Focus routing: title input if click landed in header region, else CM
    const entryWorld = this.pendingEntryWorld;
    this.pendingEntryWorld = null;
    const clickedHeader = entryWorld && props.headerVisible && entryWorld[1] < origin[1] + headerBarHeight(fontSize);

    if (clickedHeader && this.titleInput) {
      this.titleInput.focus();
    } else if (entryWorld) {
      view.focus();
      requestAnimationFrame(() => {
        if (!this.editorView) return;
        const v = this.editorView as {
          posAtCoords(coords: { x: number; y: number }): number | null;
          dispatch(spec: unknown): void;
          focus(): void;
        };
        // Map the click's world point through a LIVE worldToClient here, not at
        // mount: the camera may have moved between the swap and this rAF (zoom
        // still settling), and posAtCoords resolves against the editor's current
        // on-screen position. A pre-await snapshot would land the caret wrong.
        const [cx, cy] = worldToClient(entryWorld[0], entryWorld[1]);
        const pos = v.posAtCoords({ x: cx, y: cy });
        if (pos != null) {
          v.dispatch({ selection: { anchor: pos } });
        }
        v.focus();
      });
    } else {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    }

    // Extract syncConf for main UM integration
    // biome-ignore lint/suspicious/noExplicitAny: accessing CodeMirror internal facet
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
          this.titleInput.value = raw ?? 'Untitled';
        }
      }
      if (keys.has('output')) {
        this.updateOutputContent(yMap);
      }
    };
    yMap.observe(mapObserver);
    this.yMapUnobserve = () => yMap.unobserve(mapObserver);

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
      if (this.container?.contains(target)) return;
      const menuElement = document.querySelector('.ctx-menu');
      if (menuElement?.contains(target)) return;
      this.commitAndClose();
      // Consume canvas clicks when code tool is active
      if (useDeviceUIStore.getState().tool.active === 'code') {
        const canvas = getCanvasElement();
        if (canvas?.contains(target)) {
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
    this.clickTimeoutId = dispose(this.clickTimeoutId, clearTimeout);
    this.boundHandleKeyDown = dispose(this.boundHandleKeyDown, (h) => document.removeEventListener('keydown', h, true));
    this.boundHandleClickOutside = dispose(this.boundHandleClickOutside, (h) => document.removeEventListener('pointerdown', h, true));
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
    // biome-ignore lint/suspicious/noExplicitAny: CodeMirror dispatch accepts loosely typed state effects
    (this.editorView as any).dispatch({
      // biome-ignore lint/suspicious/noExplicitAny: compartment reconfigure is loosely typed
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
    // biome-ignore lint/suspicious/noExplicitAny: CodeMirror dispatch accepts loosely typed state effects
    (this.editorView as any).dispatch({
      // biome-ignore lint/suspicious/noExplicitAny: compartment reconfigure is loosely typed
      effects: (this.langCompartment as any).reconfigure(ext),
    });
  }

  // =========================================================================
  // Public: Commit and Close — safe to call when nothing is mounted (no-op DOM teardown,
  // still syncs store state). Selection store calls this when the editing object is
  // deleted by a remote peer or local action.
  // =========================================================================

  commitAndClose(): void {
    if (this.editorView && this.objectId) {
      this.saveTitle(); // saveTitle null-guards on missing handle internally
      this.titleInput = null; // Prevent blur-triggered re-save during DOM removal
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
      this.yMapUnobserve = dispose(this.yMapUnobserve, (fn) => fn());
      this.langCompartment = null;
      this.lineNumbersCompartment = null;

      // Clear per-session UM before destroy — flushes stack items holding plugin refs
      this.sessionUM = dispose(this.sessionUM, (m) => m.clear());

      // Destroy EditorView. Don't manually null its internal fields — CM's
      // `destroy()` schedules a final blur-notification setTimeout that reads
      // `view.observer.notifiedFocused`; pre-emptive nulling races that timeout
      // and throws "Cannot read properties of null (reading 'notifiedFocused')".
      // V8 GC handles cycles fine; the bookkeeping isn't needed.
      (this.editorView as { destroy(): void }).destroy();

      // Remove container
      if (this.container?.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }

      this.container = null;
      this.editorView = null;
      this.objectId = null;
      this.headerDiv = null;
      this.titleInput = null;
      this.outputDiv = null;
      this.outputTextDiv = null;

      invalidateWorldAll();
      invalidateOverlay();
    }

    // Cancel any in-flight mount — its post-await check will see a stale id
    // and bail before mutating shared state or the DOM.
    this.pendingMountId = null;
    useSelectionStore.getState().endCodeEditing();
  }

  // =========================================================================
  // Private: Header / Output DOM Helpers
  // =========================================================================

  private createHeaderDiv(container: HTMLDivElement, y: Y.Map<unknown>, fs: number, scale: number): void {
    const hh = headerBarHeight(fs) * scale;
    const cfs = chromeFontSize(fs) * scale;

    const header = document.createElement('div');
    header.className = 'code-header';
    header.style.height = `${hh}px`;
    header.style.padding = `0 ${padRight(fs) * scale}px 0 ${padLeft(fs) * scale}px`;

    const input = document.createElement('input');
    input.className = 'code-title';
    input.type = 'text';
    input.maxLength = MAX_TITLE_LENGTH;
    const raw = y.get('title') as string | undefined;
    input.value = raw ?? 'Untitled';
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
    playBtn.style.background = THEME.chrome.playBg;
    // Size + SVG positioning come from --c-btn-size / --c-tri-w / --c-tri-h on
    // the container (set in setCSSVars, refreshed on every positionEditor).
    // viewBox `0 0 17 20` matches triW:triH = 0.85:1.
    playBtn.innerHTML = `<svg viewBox="0 0 17 20"><path d="M0 0L17 10L0 20Z" fill="${THEME.chrome.playGreen}"/></svg>`;

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
    sep.style.background = THEME.chrome.sep;
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
}
