/**
 * CanvasRuntime - The Central Orchestrator
 *
 * Owns: SurfaceManager (DOM refs + resize), InputManager (events + modifiers),
 * render loop lifecycle, camera subscription.
 * Handles all pointer event logic (coordinate conversion, tool dispatch).
 *
 * @module runtime/CanvasRuntime
 */

import { cleanupOnRoomTeardown } from '@/core/bookmark/bookmark-unfurl';
import { createImageFromBlob, exceedsBatchLimit } from '@/core/image/image-actions';
import { clear as clearImageManager } from '@/core/image/image-manager';
import { gridLoop } from '@/renderer/grid/GridRenderLoop';
import { overlayLoop } from '@/renderer/OverlayRenderLoop';
import { renderLoop } from '@/renderer/RenderLoop';
import { capturePointer, releasePointer, screenToCanvas, screenToWorld, subscribeCamera, useCameraStore } from '@/stores/camera-store';
import { setCursorOverride, useDeviceUIStore } from '@/stores/device-ui-store';
import { contextMenuController } from './ContextMenuController';
import { setLastCursorWorld } from './input/cursor-tracking';
import { InputManager } from './input/InputManager';
import { installUIZoomBlock } from './input/install-ui-zoom-block';
import { isSpacebarPanMode } from './input/keyboard-manager';
import { resyncPeersFromAwareness } from './presence/presence';
import { syncPresenceCursorOnCameraMove } from './presence/presence-pointer';
import { SurfaceManager } from './SurfaceManager';
import { canStartMMBPan, getCurrentTool, panTool } from './tool-registry';
import { isEdgeScrolling, stopEdgeScroll, updateEdgeScroll } from './viewport/edge-scroll';
import { applyTrackpadPan } from './viewport/trackpad-pan';
import { calculateZoomTransform, cancelZoom } from './viewport/zoom';

export interface RuntimeConfig {
  container: HTMLElement;
  gridCanvas: HTMLCanvasElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  editorHost: HTMLDivElement;
  cursorHost: HTMLDivElement;
}

// --- Zoom constants ---
const WHEEL_BASE = 1.15;
const VELOCITY_WINDOW_MS = 200;
const MIN_RATE = 3;
const RAMP_DIVISOR = 16;
const WHEEL_BOOST_ENABLED = true; // A/B toggle — false disables fast-spin zoom acceleration entirely
const MAX_BOOST = 1.4; // fast-spin wheel-zoom acceleration ceiling (1.0 ⇒ no boost)
const PINCH_SENSITIVITY = 0.01;
const PINCH_MAX_DELTA = 10; // clamp |delta| into the pinch exponent — tames a real mouse ctrl-wheel (deltaY ≈ 120)

export class CanvasRuntime {
  private surfaceManager: SurfaceManager | null = null;
  private inputManager: InputManager | null = null;
  private cameraUnsub: (() => void) | null = null;
  private uninstallZoomBlock: (() => void) | null = null;
  private wheelTimestamps: number[] = [];

  start(config: RuntimeConfig): void {
    const { container, gridCanvas, baseCanvas, overlayCanvas, editorHost, cursorHost } = config;

    // 1. Surface manager: DOM refs, contexts, resize/DPR
    this.surfaceManager = new SurfaceManager(container, baseCanvas, overlayCanvas, editorHost, cursorHost);
    this.surfaceManager.start();

    // 1b. cursorHost is now registered. `connectRoom` (route beforeLoad) attached
    //     awareness before this mount, so peers that synced in that window were
    //     dropped by allocSlot's host-null guard — replay awareness to re-add them
    //     (avatars + their cursors). Synchronous with start() above: no awareness
    //     'update' can interleave, so this closes the race with no gap.
    resyncPeersFromAwareness();

    // 2. Render loops
    renderLoop.start();
    overlayLoop.start();
    // Grid loop is standalone (owns its own canvas sizing + on-demand rAF); no-op while off.
    gridLoop.start(gridCanvas);

    // 3. Input manager: pointer events, modifier state, keyboard lifecycle
    this.inputManager = new InputManager(this, baseCanvas, container);
    this.inputManager.attach();

    // 4. Page-zoom block: preempts browser Ctrl/⌘ + wheel/zoom-key/pinch on
    //    UI chrome and focused editors, which the canvas wheel handler can't
    //    reach. Scoped to canvas-page lifetime — disposed in stop().
    this.uninstallZoomBlock = installUIZoomBlock();

    // 5. Camera subscription for tool view changes + context menu repositioning
    this.cameraUnsub = subscribeCamera(() => {
      if (!isEdgeScrolling()) getCurrentTool()?.onViewChange();
      contextMenuController.onCameraMove();
      // Unguarded — must run during edge-scroll (camera pans while pointer is still).
      syncPresenceCursorOnCameraMove();
    });

    // 6. First-frame bootstrap
    renderLoop.invalidateAll();
    overlayLoop.invalidateAll();
  }

  stop(): void {
    // Abort any in-flight tool gesture first (Y.Doc + editor host are still alive here, since
    // the Canvas effect cleanup runs before RoomPage's disconnectRoom) so navigating away
    // mid-stroke/marquee/transform doesn't carry tool state into the next room. Mirrors the
    // pointer-cancel path — panTool is checked separately from the active tool since it can be
    // mid-gesture (MMB / spacebar pan) independent of the selected tool.
    if (panTool.isActive()) panTool.cancel();
    const activeTool = getCurrentTool();
    if (activeTool?.isActive()) activeTool.cancel();

    this.cameraUnsub?.();
    this.uninstallZoomBlock?.();

    this.inputManager?.detach();
    cancelZoom();
    stopEdgeScroll();

    renderLoop.stop();
    overlayLoop.stop();
    gridLoop.stop();

    this.surfaceManager?.stop();

    clearImageManager();
    cleanupOnRoomTeardown();

    this.inputManager = null;
    this.surfaceManager = null;
    this.cameraUnsub = null;
    this.uninstallZoomBlock = null;
  }

  // === Event Handlers (called by InputManager — modifiers already updated) ===

  handlePointerDown(e: PointerEvent): void {
    panTool.cancelCoast();
    cancelZoom();

    if (e.button === 1) {
      if (!canStartMMBPan()) return;
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;
      capturePointer(e.pointerId);
      panTool.begin(e.pointerId, world[0], world[1]);
      return;
    }

    if (e.button === 0 && isSpacebarPanMode()) {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;
      capturePointer(e.pointerId);
      panTool.begin(e.pointerId, world[0], world[1]);
      return;
    }

    if (e.button === 0) {
      const tool = getCurrentTool();
      if (!tool?.canBegin()) return;
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;
      capturePointer(e.pointerId);
      tool.begin(e.pointerId, world[0], world[1]);
    }
  }

  handlePointerMove(e: PointerEvent): void {
    const world = screenToWorld(e.clientX, e.clientY);
    if (world) setLastCursorWorld(world);

    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      if (world) panTool.move(world[0], world[1]);
      return;
    }

    if (isSpacebarPanMode()) return;

    const tool = getCurrentTool();
    if (tool && world) {
      tool.move(world[0], world[1]);
    }

    updateEdgeScroll(e.clientX, e.clientY);
  }

  handlePointerUp(e: PointerEvent): void {
    stopEdgeScroll();
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      releasePointer(e.pointerId);
      panTool.end();
      if (isSpacebarPanMode()) {
        setCursorOverride('grab');
      }
      return;
    }

    const tool = getCurrentTool();
    if (tool?.isActive() && tool.getPointerId() === e.pointerId) {
      releasePointer(e.pointerId);
      const world = screenToWorld(e.clientX, e.clientY);
      tool.end(world?.[0], world?.[1]);
    }
  }

  handlePointerCancel(e: PointerEvent): void {
    stopEdgeScroll();
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      panTool.cancel();
      return;
    }

    const tool = getCurrentTool();
    if (tool?.getPointerId() === e.pointerId) {
      releasePointer(e.pointerId);
      tool.cancel();
    }
  }

  handlePointerLeave(_e: PointerEvent): void {
    getCurrentTool()?.onPointerLeave();
  }

  handleLostPointerCapture(e: PointerEvent): void {
    stopEdgeScroll();
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      panTool.cancel();
      return;
    }

    const tool = getCurrentTool();
    if (tool?.getPointerId() === e.pointerId) {
      tool.cancel();
      tool.onPointerLeave();
    }
  }

  handleDrop(e: DragEvent): void {
    e.preventDefault();
    if (!e.dataTransfer) return;

    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/') || f.name.endsWith('.svg'));
    if (files.length === 0) return;
    if (exceedsBatchLimit(files.length, 'drop')) return;

    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) return;

    for (const file of files) {
      createImageFromBlob(file, world[0], world[1]);
    }
  }

  handleWheel(e: WheelEvent): void {
    e.preventDefault(); // always — also suppresses back/forward history swipe
    if (panTool.isActive()) return; // MMB/spacebar drag locks out ALL wheel (incl. trackpad pan)
    cancelZoom();

    const canvas = screenToCanvas(e.clientX, e.clientY);
    if (!canvas) return;

    // Normalize BOTH axes by deltaMode (lines → ×40, pages → ×800).
    let dX = e.deltaX;
    let dY = e.deltaY;
    if (e.deltaMode === 1) {
      dX *= 40;
      dY *= 40;
    } else if (e.deltaMode === 2) {
      dX *= 800;
      dY *= 800;
    }

    const pivot = { x: canvas[0], y: canvas[1] };
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl) {
      // Ctrl/⌘ + wheel is ALWAYS a zoom, both modes. A trackpad pinch always
      // arrives as ctrl+wheel (browser convention), so routing by device mode
      // would force a pinch through the mouse-notch formula and make it crawl.
      // handlePinchZoom's clamp degrades a real mouse ctrl-wheel (deltaY ≈ 120)
      // to a gentle per-notch step, so one path serves both devices.
      this.handlePinchZoom(dY, pivot);
    } else if (useDeviceUIStore.getState().pointerInput === 'mouse') {
      this.handleWheelZoom(dY, pivot); // plain mouse wheel → zoom
    } else {
      // Trackpad two-finger pan (direct 1:1; momentum, if any, is the OS's — see
      // trackpad-pan.ts). Forward guard: don't fight a live tool gesture.
      if (getCurrentTool()?.isActive()) return;
      // Kill an in-flight MMB coast — isActive() is false while coasting, so the
      // top guard misses it.
      panTool.cancelCoast();
      applyTrackpadPan(dX, dY);
    }
  }

  private handleWheelZoom(delta: number, pivot: { x: number; y: number }): void {
    const now = performance.now();
    const boost = this.getWheelBoost(now);
    const normalizedDelta = delta / 120;
    const factor = WHEEL_BASE ** (-normalizedDelta * boost);

    const { scale, pan } = useCameraStore.getState();
    const target = calculateZoomTransform(scale, pan, factor, pivot);
    useCameraStore.getState().setScaleAndPanXY(target.scale, target.pan.x, target.pan.y);
  }

  private handlePinchZoom(delta: number, pivot: { x: number; y: number }): void {
    // Serves both a trackpad pinch (tiny deltas) and a real mouse ctrl-wheel: the
    // clamp caps a mouse notch (deltaY ≈ 120) to a gentle 2^-0.1 ≈ 0.93 step
    // instead of teleporting (2^-1.2 ≈ 0.44).
    const clamped = Math.max(-PINCH_MAX_DELTA, Math.min(PINCH_MAX_DELTA, delta));
    const factor = 2 ** (-clamped * PINCH_SENSITIVITY);

    const { scale, pan } = useCameraStore.getState();
    const target = calculateZoomTransform(scale, pan, factor, pivot);
    useCameraStore.getState().setScaleAndPanXY(target.scale, target.pan.x, target.pan.y);
  }

  private getWheelBoost(now: number): number {
    if (!WHEEL_BOOST_ENABLED) return 1; // A/B toggle — flip WHEEL_BOOST_ENABLED to compare
    while (this.wheelTimestamps.length && this.wheelTimestamps[0] < now - VELOCITY_WINDOW_MS) {
      this.wheelTimestamps.shift();
    }
    this.wheelTimestamps.push(now);

    if (this.wheelTimestamps.length < 2) return 1;

    const span = (now - this.wheelTimestamps[0]) / 1000;
    const rate = span > 0 ? (this.wheelTimestamps.length - 1) / span : 0;

    return 1 + Math.min(Math.max(rate - MIN_RATE, 0) / RAMP_DIVISOR, MAX_BOOST - 1);
  }
}
