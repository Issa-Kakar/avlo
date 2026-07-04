/**
 * Dev-only verification bridge — `window.__avlo`.
 *
 * This module is imported from `main.tsx` ONLY under `import.meta.env.DEV`, so the
 * static `import()` is tree-shaken out of production builds (zero prod cost / surface).
 * It exists to make agent/headless verification of the canvas cheap and deterministic:
 * an imperative canvas is slow to drive by synthesizing pointer drags, so instead a
 * Playwright script calls `window.__avlo.createShape(...)` etc. via `page.evaluate`,
 * then screenshots + asserts on `count()` / `ids()`.
 *
 * It is a THIN re-export of the existing module-level getters (the codebase already
 * favors these — see room-runtime.ts). The creation helpers mirror the exact Y.Map
 * field pattern the real tools use (DrawingTool.commitShape / TextTool.createTextObject),
 * so objects created here flow through the normal deep-observer pipeline — handle,
 * spatial index, caches, and dirty rects all populate identically to a user gesture.
 *
 * Keep the surface minimal and additive; extend as verification needs grow.
 */
import { generateZAtTop } from '@avlo/shared';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import { invalidateOverlay } from '@/renderer/OverlayRenderLoop';
import { invalidateWorldAll } from '@/renderer/RenderLoop';
import {
  getBbox,
  getHandle,
  getHandleKind,
  getObjects,
  getObjectsById,
  getZOrder,
  hasActiveRoom,
  redo,
  transact,
  undo,
} from '@/runtime/room-runtime';
import { getUserId } from '@/stores/auth-store';
import { MAX_ZOOM, MIN_ZOOM, screenToWorld, useCameraStore, worldToClient } from '@/stores/camera-store';
import { setActiveTool } from '@/stores/device-ui-store';
import { useSelectionStore } from '@/stores/selection-store';

// ── Options -----------------------------------------------------------------

interface ShapeOpts {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Full frame `[x, y, w, h]`; overrides x/y/w/h when set. */
  frame?: [number, number, number, number];
  shapeType?: 'rect' | 'ellipse' | 'diamond' | 'roundedRect';
  color?: string;
  width?: number;
  opacity?: number;
  fillColor?: string;
}

interface TextOpts {
  x?: number;
  y?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  align?: 'left' | 'center' | 'right';
}

interface NoteOpts {
  x?: number;
  y?: number;
  text?: string;
  fillColor?: string;
  fontFamily?: string;
}

interface CodeOpts {
  x?: number;
  y?: number;
  text?: string;
  language?: 'javascript' | 'typescript' | 'python' | 'html' | 'css' | 'json' | 'sql';
  fontSize?: number;
  width?: number;
  lineNumbers?: boolean;
  title?: string;
  headerVisible?: boolean;
}

// ── Helpers -----------------------------------------------------------------

/** Seed a Y.XmlFragment with a single `<paragraph>` of plain text (ProseMirror shape). */
function seedParagraph(frag: Y.XmlFragment, text: string): void {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  frag.insert(0, [p]);
}

/** Wait for the browser to have painted at least one frame after the last mutation. */
function waitForIdle(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/** Await a fixed delay (for animated camera ops that settle over time). */
function settle(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shallow, JSON-friendly snapshot of an object's Y.Map fields (Y containers → tag string). */
function snapshot(id: string): Record<string, unknown> | null {
  const y = getObjects().get(id) as Y.Map<unknown> | undefined;
  if (!y) return null;
  const out: Record<string, unknown> = {};
  y.forEach((value, key) => {
    out[key] = value instanceof Y.AbstractType ? `[${value.constructor.name}]` : value;
  });
  return out;
}

// ── Creators (mirror the real tools' Y.Map field pattern) -------------------

function createShape(opts: ShapeOpts = {}): string {
  const frame = opts.frame ?? [opts.x ?? 120, opts.y ?? 120, opts.w ?? 220, opts.h ?? 140];
  const id = ulid();
  const userId = getUserId();
  transact(() => {
    const m = new Y.Map<unknown>();
    m.set('id', id);
    m.set('kind', 'shape');
    m.set('shapeType', opts.shapeType ?? 'rect');
    m.set('color', opts.color ?? '#2563eb');
    m.set('width', opts.width ?? 2);
    if (opts.fillColor) m.set('fillColor', opts.fillColor);
    m.set('opacity', opts.opacity ?? 1);
    m.set('frame', frame);
    m.set('ownerId', userId);
    m.set('createdAt', Date.now());
    m.set('z', generateZAtTop(getZOrder().maxZ()));
    getObjects().set(id, m);
  });
  return id;
}

function createText(opts: TextOpts = {}): string {
  const id = ulid();
  const userId = getUserId();
  transact(() => {
    const m = new Y.Map<unknown>();
    m.set('id', id);
    m.set('kind', 'text');
    m.set('origin', [opts.x ?? 120, opts.y ?? 120]);
    const frag = new Y.XmlFragment();
    m.set('content', frag);
    m.set('fontSize', opts.fontSize ?? 24);
    m.set('fontFamily', opts.fontFamily ?? 'Inter');
    m.set('color', opts.color ?? '#1e1e1e');
    m.set('align', opts.align ?? 'left');
    m.set('width', 'auto');
    m.set('ownerId', userId);
    m.set('createdAt', Date.now());
    m.set('z', generateZAtTop(getZOrder().maxZ()));
    getObjects().set(id, m);
    if (opts.text) seedParagraph(frag, opts.text);
  });
  return id;
}

function createNote(opts: NoteOpts = {}): string {
  const id = ulid();
  const userId = getUserId();
  transact(() => {
    const m = new Y.Map<unknown>();
    m.set('id', id);
    m.set('kind', 'note');
    m.set('origin', [opts.x ?? 120, opts.y ?? 120]);
    const frag = new Y.XmlFragment();
    m.set('content', frag);
    m.set('scale', 1);
    m.set('fontFamily', opts.fontFamily ?? 'Inter');
    m.set('align', 'left');
    m.set('alignV', 'top');
    m.set('fillColor', opts.fillColor ?? '#FEF3AC');
    m.set('ownerId', userId);
    m.set('createdAt', Date.now());
    m.set('z', generateZAtTop(getZOrder().maxZ()));
    getObjects().set(id, m);
    if (opts.text) seedParagraph(frag, opts.text);
  });
  return id;
}

function createCode(opts: CodeOpts = {}): string {
  const id = ulid();
  const userId = getUserId();
  transact(() => {
    const m = new Y.Map<unknown>();
    m.set('id', id);
    m.set('kind', 'code');
    m.set('origin', [opts.x ?? 120, opts.y ?? 120]);
    const yText = new Y.Text();
    if (opts.text) yText.insert(0, opts.text);
    m.set('content', yText);
    m.set('language', opts.language ?? 'typescript');
    m.set('fontSize', opts.fontSize ?? 14);
    m.set('width', opts.width ?? 480);
    m.set('lineNumbers', opts.lineNumbers ?? true);
    m.set('headerVisible', opts.headerVisible ?? true);
    m.set('outputVisible', false);
    m.set('title', opts.title ?? 'Untitled');
    m.set('ownerId', userId);
    m.set('createdAt', Date.now());
    m.set('z', generateZAtTop(getZOrder().maxZ()));
    getObjects().set(id, m);
  });
  return id;
}

// ── Bulk / mutation ---------------------------------------------------------

function remove(...ids: string[]): void {
  transact(() => {
    for (const id of ids) getObjects().delete(id);
  });
}

function clearAll(): number {
  const ids = [...getObjects().keys()];
  transact(() => {
    for (const id of ids) getObjects().delete(id);
  });
  return ids.length;
}

// ── Camera ------------------------------------------------------------------

/** Instantly frame all content in the viewport (deterministic — no animation). */
function fit(padding = 80): void {
  const handles = [...getObjectsById().values()];
  if (handles.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const h of handles) {
    if (h.minX < minX) minX = h.minX;
    if (h.minY < minY) minY = h.minY;
    if (h.maxX > maxX) maxX = h.maxX;
    if (h.maxY > maxY) maxY = h.maxY;
  }
  const { cssWidth, cssHeight } = useCameraStore.getState();
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const raw = Math.min((cssWidth - 2 * padding) / bw, (cssHeight - 2 * padding) / bh);
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, raw));
  // screen = (world - pan) * scale ⇒ center bounds in the viewport.
  const pan = {
    x: (minX + maxX) / 2 - cssWidth / (2 * scale),
    y: (minY + maxY) / 2 - cssHeight / (2 * scale),
  };
  useCameraStore.setState({ scale, pan });
}

function setCamera(next: { scale?: number; pan?: { x: number; y: number } }): void {
  const cur = useCameraStore.getState();
  useCameraStore.setState({
    scale: next.scale != null ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.scale)) : cur.scale,
    pan: next.pan ?? cur.pan,
  });
}

// ── Bridge object ------------------------------------------------------------

const bridge = {
  // state
  hasRoom: () => hasActiveRoom(),
  count: () => (hasActiveRoom() ? getObjects().size : 0),
  ids: () => (hasActiveRoom() ? [...getObjects().keys()] : []),
  get: snapshot,
  bbox: (id: string) => getBbox(id) ?? null,
  kind: (id: string) => getHandleKind(id) ?? null,
  handle: (id: string) => getHandle(id) ?? null,
  // create
  createShape,
  createText,
  createNote,
  createCode,
  // mutate
  remove,
  clearAll,
  undo,
  redo,
  transact,
  // selection
  select: (ids: string[]) => useSelectionStore.getState().setSelection(ids),
  clearSelection: () => useSelectionStore.getState().clearSelection(),
  selectedIds: () => useSelectionStore.getState().selectedIds,
  // tool
  setTool: (tool: string) => setActiveTool(tool as Parameters<typeof setActiveTool>[0]),
  // camera
  camera: () => {
    const { scale, pan, cssWidth, cssHeight, dpr } = useCameraStore.getState();
    return { scale, pan, cssWidth, cssHeight, dpr };
  },
  setCamera,
  fit,
  screenToWorld,
  worldToClient,
  /** Force a full base + overlay repaint (no-op before the render loop has started). */
  invalidateAll: () => {
    invalidateWorldAll();
    invalidateOverlay();
  },
  // sync
  waitForIdle,
  settle,
  // escape hatches for advanced scripts
  Y,
  stores: { camera: useCameraStore, selection: useSelectionStore },
};

export type AvloBridge = typeof bridge;

declare global {
  interface Window {
    __avlo?: AvloBridge;
  }
}

window.__avlo = bridge;
console.info('[avlo] dev verification bridge ready — window.__avlo (createShape/createText/createNote/fit/count/…)');
