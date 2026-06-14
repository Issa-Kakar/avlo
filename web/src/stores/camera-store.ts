/**
 * Camera Store - Centralized camera/viewport state management
 *
 * Replaces ViewTransformContext with a Zustand store for maximum imperative access.
 * All tools, render loops, and overlays read directly from this store.
 *
 * Key principles:
 * - Single source of truth for camera state (scale, pan, viewport dimensions)
 * - Pure transform functions that read from store synchronously
 * - Module-level canvas reference for screen-to-world coordinate conversion
 * - Diff-cached subscriptions via `subscribeCamera` (no per-tick selector allocation)
 * - Manual localStorage persistence on a 1Hz debounce — no `persist` middleware
 *   (which would write localStorage on every setState; unacceptable on the pan path)
 *
 * @module stores/camera-store
 */

import { create } from 'zustand';
import type { BBoxTuple } from '@/core/types/geometry';
export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 5;

const PERSIST_KEY = 'avlo.camera.v1';

// ============================================
// TYPES
// ============================================

// View transform for coordinate conversion
export interface ViewTransform {
  worldToCanvas: (x: number, y: number) => [number, number];
  canvasToWorld: (x: number, y: number) => [number, number];
  scale: number; // world px → canvas px
  pan: { x: number; y: number }; // world offset
}

export interface CameraState {
  /** Zoom level (1.0 = 100%) */
  scale: number;
  /** World offset in world units */
  pan: { x: number; y: number };
  /** Viewport CSS width */
  cssWidth: number;
  /** Viewport CSS height */
  cssHeight: number;
  /** Device pixel ratio */
  dpr: number;
  /** Per-room persisted camera positions */
  roomCameras: Record<string, { scale: number; pan: { x: number; y: number } }>;
  /** Current room ID (ephemeral) */
  currentRoomId: string | null;
}

export interface CameraActions {
  /** Set scale with clamping to MIN_ZOOM/MAX_ZOOM */
  setScale: (scale: number) => void;
  /** Set pan position */
  setPan: (pan: { x: number; y: number }) => void;
  /** Set pan position from raw x,y (avoids per-call object literal on hot pan path) */
  setPanXY: (x: number, y: number) => void;
  /** Set scale and pan atomically (for animations) */
  setScaleAndPan: (scale: number, pan: { x: number; y: number }) => void;
  /** Set scale and pan atomically from raw x,y (avoids per-call object literal on hot zoom path) */
  setScaleAndPanXY: (scale: number, x: number, y: number) => void;
  /** Update viewport dimensions */
  setViewport: (cssWidth: number, cssHeight: number, dpr: number) => void;
  /** Reset view to initial state (scale=1, pan={0,0}) */
  resetView: () => void;
  /** Switch room — saves outgoing camera, restores incoming */
  setRoom: (roomId: string) => void;
}

export type CameraStore = CameraState & CameraActions;

// ============================================
// MODULE-LEVEL CANVAS REFERENCE
// ============================================

/** Module-level canvas element for coordinate conversion */
let canvasElement: HTMLCanvasElement | null = null;

/**
 * Set the canvas element for coordinate conversion.
 * Called by CanvasStage on mount.
 */
export function setCanvasElement(el: HTMLCanvasElement | null): void {
  canvasElement = el;
}

/**
 * Get the canvas bounding rect for screen-to-canvas conversion.
 * Returns empty DOMRect if canvas not mounted.
 */
export function getCanvasRect(): DOMRect {
  return canvasElement?.getBoundingClientRect() ?? new DOMRect();
}

/**
 * Get the raw canvas element (for event attachment etc.)
 */
export function getCanvasElement(): HTMLCanvasElement | null {
  return canvasElement;
}

/**
 * Capture pointer on the canvas element.
 * Called from CanvasRuntime at gesture start.
 */
export function capturePointer(pointerId: number): void {
  try {
    canvasElement?.setPointerCapture(pointerId);
  } catch {
    // Ignore errors (pointer may already be captured or released)
  }
}

/**
 * Release pointer capture on the canvas element.
 * Called from CanvasRuntime at gesture end.
 */
export function releasePointer(pointerId: number): void {
  try {
    canvasElement?.releasePointerCapture(pointerId);
  } catch {
    // Ignore errors (pointer may already be released)
  }
}

// ============================================
// MOBILE DETECTION
// ============================================

/** Cached mobile detection result */
let mobileDetected: boolean | null = null;

/**
 * Check if running on a mobile device.
 * Result is cached on first call.
 */
export function isMobile(): boolean {
  if (mobileDetected === null) {
    mobileDetected = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
  }
  return mobileDetected;
}

// ============================================
// STORE CREATION
// ============================================

/** Seed roomCameras from localStorage. Tolerates missing/bad JSON. */
function loadInitialRoomCameras(): Record<string, { scale: number; pan: { x: number; y: number } }> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { roomCameras?: Record<string, { scale: number; pan: { x: number; y: number } }> };
    return parsed?.roomCameras ?? {};
  } catch {
    return {};
  }
}

/** Initial camera state */
const INITIAL_STATE: CameraState = {
  scale: 1,
  pan: { x: 0, y: 0 },
  cssWidth: 1, // Safe non-zero default
  cssHeight: 1,
  dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
  roomCameras: loadInitialRoomCameras(),
  currentRoomId: null,
};

/** Debounced sync timer for persisting camera to roomCameras */
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Hoisted module-level callback — avoids per-tick closure allocation. */
function syncRoomCamera(): void {
  syncTimer = null;
  const { scale, pan, currentRoomId, roomCameras } = useCameraStore.getState();
  if (!currentRoomId) return;
  const prev = roomCameras[currentRoomId];
  if (prev && prev.scale === scale && prev.pan.x === pan.x && prev.pan.y === pan.y) return;
  const next = { ...roomCameras, [currentRoomId]: { scale, pan } };
  useCameraStore.setState({ roomCameras: next });
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ roomCameras: next }));
  } catch {
    // localStorage full / unavailable → silently drop persist; in-memory state is canonical
  }
}

/**
 * Camera store. Uses plain `subscribe` (cache+diff via subscribeCamera helper).
 * Persistence is handled manually inside the 1Hz debounced sync below — NOT via
 * zustand's persist middleware, which would write localStorage on every setState
 * (60×/sec during pan, ~26 listeners/sec on the Storage event surface).
 */
export const useCameraStore = create<CameraStore>()((set, get) => ({
  // Initial state
  ...INITIAL_STATE,

  // Actions (all with equality guards to skip no-op updates)
  setScale: (scale: number) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    if (clamped === get().scale) return;
    set({ scale: clamped });
  },

  setPan: (pan: { x: number; y: number }) => {
    const curr = get().pan;
    if (pan.x === curr.x && pan.y === curr.y) return;
    set({ pan });
  },

  setPanXY: (x: number, y: number) => {
    const curr = get().pan;
    if (x === curr.x && y === curr.y) return;
    set({ pan: { x, y } });
  },

  setScaleAndPan: (scale: number, pan: { x: number; y: number }) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    const state = get();
    if (clamped === state.scale && pan.x === state.pan.x && pan.y === state.pan.y) return;
    set({ scale: clamped, pan });
  },

  setScaleAndPanXY: (scale: number, x: number, y: number) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    const state = get();
    if (clamped === state.scale && x === state.pan.x && y === state.pan.y) return;
    set({ scale: clamped, pan: { x, y } });
  },

  setViewport: (cssWidth: number, cssHeight: number, dpr: number) => {
    const state = get();
    if (cssWidth === state.cssWidth && cssHeight === state.cssHeight && dpr === state.dpr) return;
    set({ cssWidth, cssHeight, dpr });
  },

  resetView: () => {
    set({ scale: 1, pan: { x: 0, y: 0 } });
  },

  setRoom: (roomId: string) => {
    // Drop any pending debounced sync — we save outgoing inline below.
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    const { scale, pan, currentRoomId, roomCameras } = get();
    const updated = { ...roomCameras };
    // Save outgoing room
    if (currentRoomId) updated[currentRoomId] = { scale, pan };
    // Restore incoming room
    const saved = updated[roomId];
    set({
      roomCameras: updated,
      currentRoomId: roomId,
      scale: saved?.scale ?? 1,
      pan: saved?.pan ?? { x: 0, y: 0 },
    });
    // Persist room-switch state immediately (so a fast nav-then-close doesn't lose it).
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ roomCameras: updated }));
    } catch {
      // ignore
    }
  },
}));

// ============================================
// SUBSCRIPTION HELPER
// ============================================

/**
 * Subscribe to camera transform changes (scale, pan, viewport, dpr) with internal
 * caching/diffing — fires `listener(state)` only when at least one of the 6 fields
 * actually changes.
 *
 * Replaces the per-subscriber `subscribeWithSelector` pattern, which allocated a
 * fresh selector-result object per setState. With 4 hot subscribers (debounce sync,
 * tool view-change, RenderLoop, OverlayRenderLoop) this matters during pan/zoom.
 */
export type CameraListener = (s: CameraStore) => void;
export function subscribeCamera(listener: CameraListener): () => void {
  let pScale = NaN;
  let pPanX = NaN;
  let pPanY = NaN;
  let pCw = NaN;
  let pCh = NaN;
  let pDpr = NaN;
  return useCameraStore.subscribe((s) => {
    if (s.scale === pScale && s.pan.x === pPanX && s.pan.y === pPanY && s.cssWidth === pCw && s.cssHeight === pCh && s.dpr === pDpr) return;
    pScale = s.scale;
    pPanX = s.pan.x;
    pPanY = s.pan.y;
    pCw = s.cssWidth;
    pCh = s.cssHeight;
    pDpr = s.dpr;
    listener(s);
  });
}

// Debounced sync: write current camera to roomCameras + localStorage at most once per second.
// The hoisted `syncRoomCamera` callback avoids allocating a fresh closure per pan tick.
subscribeCamera(() => {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncRoomCamera, 1000);
});

// ============================================
// PURE TRANSFORM FUNCTIONS
// ============================================

/**
 * Convert world coordinates to canvas (CSS pixel) coordinates.
 * Formula: canvas = (world - pan) * scale
 */
export function worldToCanvas(worldX: number, worldY: number): [number, number] {
  const { scale, pan } = useCameraStore.getState();
  return [(worldX - pan.x) * scale, (worldY - pan.y) * scale];
}

/**
 * Convert canvas (CSS pixel) coordinates to world coordinates.
 * Formula: world = canvas / scale + pan
 */
export function canvasToWorld(canvasX: number, canvasY: number): [number, number] {
  const { scale, pan } = useCameraStore.getState();
  // Guard against zero scale
  const s = Math.max(1e-6, scale);
  return [canvasX / s + pan.x, canvasY / s + pan.y];
}

/**
 * Convert screen (client) coordinates to canvas (CSS pixel) coordinates.
 * Returns null if canvas not yet mounted (rect.width === 0).
 * Useful for zoom pivot calculations where we need canvas-relative position.
 */
export function screenToCanvas(clientX: number, clientY: number): [number, number] | null {
  const rect = getCanvasRect();
  if (rect.width === 0) return null;
  return [clientX - rect.left, clientY - rect.top];
}

/**
 * Convert screen (client) coordinates to world coordinates.
 * Returns null if canvas not yet mounted (rect.width === 0).
 */
export function screenToWorld(clientX: number, clientY: number): [number, number] | null {
  const canvasCoords = screenToCanvas(clientX, clientY);
  if (!canvasCoords) return null;
  return canvasToWorld(canvasCoords[0], canvasCoords[1]);
}

/**
 * Zero-alloc screen→world. Writes into `out`, returns true; returns false
 * (out untouched) if the canvas isn't mounted. For hot per-pointer-move
 * callers — see screenToWorld for the allocating form.
 */
export function screenToWorldInto(clientX: number, clientY: number, out: [number, number]): boolean {
  const rect = getCanvasRect();
  if (rect.width === 0) return false;
  const { scale, pan } = useCameraStore.getState();
  const s = Math.max(1e-6, scale);
  out[0] = (clientX - rect.left) / s + pan.x;
  out[1] = (clientY - rect.top) / s + pan.y;
  return true;
}

/**
 * Convert world coordinates to screen (client) coordinates.
 */
export function worldToClient(worldX: number, worldY: number): [number, number] {
  const rect = getCanvasRect();
  const [canvasX, canvasY] = worldToCanvas(worldX, worldY);
  return [canvasX + rect.left, canvasY + rect.top];
}

// ============================================
// VIEWPORT UTILITY FUNCTIONS
// ============================================

/**
 * Get the world-space bounds currently visible in the viewport.
 */
export function getVisibleWorldBounds(): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const { cssWidth, cssHeight, scale, pan } = useCameraStore.getState();
  // Guard against invalid scale
  const safeScale = Math.max(0.001, scale);

  return {
    minX: pan.x,
    minY: pan.y,
    maxX: cssWidth / safeScale + pan.x,
    maxY: cssHeight / safeScale + pan.y,
  };
}

/**
 * Tuple-shaped visible world bounds. Mutates a module-scoped scratch tuple
 * rather than allocating a fresh object per call — hot consumers (renderer
 * culling, image viewport management) hit this every frame.
 *
 * Callers MUST treat the returned tuple as readonly; the same array is
 * overwritten on the next call.
 */
const _scratchVisibleTuple: BBoxTuple = [0, 0, 0, 0];

export function getVisibleBoundsTuple(): Readonly<BBoxTuple> {
  const { cssWidth, cssHeight, scale, pan } = useCameraStore.getState();
  const safeScale = Math.max(0.001, scale);
  _scratchVisibleTuple[0] = pan.x;
  _scratchVisibleTuple[1] = pan.y;
  _scratchVisibleTuple[2] = cssWidth / safeScale + pan.x;
  _scratchVisibleTuple[3] = cssHeight / safeScale + pan.y;
  return _scratchVisibleTuple;
}

// ============================================
// SELECTORS FOR REACT COMPONENTS
// ============================================

/** Selector for scale value */
export const selectScale = (s: CameraStore): number => s.scale;

/** Selector for pan value */
export const selectPan = (s: CameraStore): { x: number; y: number } => s.pan;

/** Selector for DPR value */
export const selectDpr = (s: CameraStore): number => s.dpr;

/** Selector for viewport dimensions */
export const selectViewport = (s: CameraStore): { cssWidth: number; cssHeight: number; dpr: number } => ({
  cssWidth: s.cssWidth,
  cssHeight: s.cssHeight,
  dpr: s.dpr,
});

// ============================================
// VIEWTRANSFORM COMPATIBILITY HELPER
// ============================================

/**
 * Get a ViewTransform object compatible with the existing interface.
 * Use this for backward compatibility during migration.
 */
export function getViewTransform(): ViewTransform {
  const { scale, pan } = useCameraStore.getState();

  return {
    worldToCanvas: (x: number, y: number): [number, number] => {
      return [(x - pan.x) * scale, (y - pan.y) * scale];
    },
    canvasToWorld: (x: number, y: number): [number, number] => {
      const s = Math.max(1e-6, scale);
      return [x / s + pan.x, y / s + pan.y];
    },
    scale,
    pan,
  };
}

/**
 * Create a ViewTransform from explicit scale and pan values.
 * Used when we need a transform with specific values (not current state).
 */
export function createViewTransform(scale: number, pan: { x: number; y: number }): ViewTransform {
  return {
    worldToCanvas: (x: number, y: number): [number, number] => {
      return [(x - pan.x) * scale, (y - pan.y) * scale];
    },
    canvasToWorld: (x: number, y: number): [number, number] => {
      const s = Math.max(1e-6, scale);
      return [x / s + pan.x, y / s + pan.y];
    },
    scale,
    pan,
  };
}
