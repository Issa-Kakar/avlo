/**
 * CanvasRuntime - The Central Orchestrator
 *
 * This class is the "brain" of the canvas system. It:
 * - Imports tool registry (tools self-construct)
 * - Owns InputManager instance
 * - Creates RenderLoop and OverlayRenderLoop (with canvas refs only)
 * - Handles all pointer event logic (coordinate conversion, tool dispatch)
 * - Handles MMB pan (directly use panTool singleton)
 * - Handles wheel zoom
 *
 * NOTE: This is currently a shell with event handler stubs.
 * The full implementation will be completed in future phases.
 *
 * @module canvas/CanvasRuntime
 */

import { RenderLoop } from '@/renderer/RenderLoop';
import { OverlayRenderLoop } from '@/renderer/OverlayRenderLoop';
import { cancelZoom } from './animation/ZoomAnimator';
import { SurfaceManager } from './SurfaceManager';
import { InputManager } from './InputManager';
import { getCurrentTool, canStartMMBPan, panTool } from './tool-registry';
import {
  setWorldInvalidator,
  setOverlayInvalidator,
  setHoldPreviewFn,
} from './invalidation-helpers';
import { getActiveRoomDoc, updatePresenceCursor, clearPresenceCursor } from './room-runtime';
import {
  attach as attachKeyboard,
  detach as detachKeyboard,
  isSpacebarPanMode,
} from './keyboard-manager';
import { setLastCursorWorld, storePointerModifiers, updateLiveCtrl } from './cursor-tracking';
import { setCursorOverride } from '@/stores/device-ui-store';
import { getObjectCacheInstance } from '@/renderer/object-cache';
import {
  screenToWorld,
  screenToCanvas,
  capturePointer,
  releasePointer,
  useCameraStore,
  getVisibleWorldBounds,
} from '@/stores/camera-store';
import { calculateZoomTransform, boundsIntersect } from './internal/transforms';
import { contextMenuController } from './ContextMenuController';
import { updateEdgeScroll, stopEdgeScroll, isEdgeScrolling } from './edge-scroll';
import { clear as clearImageManager } from '@/lib/image/image-manager';
import { createImageFromBlob } from '@/lib/image/image-actions';

export interface RuntimeConfig {
  container: HTMLElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  editorHost: HTMLDivElement;
}

// --- Zoom constants ---
const WHEEL_BASE = 1.15; // 15% per notch at boost 1x (mouse wheel)
const VELOCITY_WINDOW_MS = 200; // Sliding window for event rate
const MIN_RATE = 3; // Events/sec below this = no boost
const RAMP_DIVISOR = 16; // Gradual ramp — max boost at ~19 eps
const MAX_BOOST = 2.0; // Ceiling multiplier (32% per fast notch)
const PINCH_SENSITIVITY = 0.01; // Trackpad pinch scaling

export class CanvasRuntime {
  private inputManager: InputManager | null = null;
  private surfaceManager: SurfaceManager | null = null;
  private renderLoop: RenderLoop | null = null;
  private overlayLoop: OverlayRenderLoop | null = null;
  private cameraUnsub: (() => void) | null = null;
  private snapshotUnsub: (() => void) | null = null;
  private presenceUnsub: (() => void) | null = null;
  private lastDocVersion = -1;
  private wheelTimestamps: number[] = [];

  /**
   * Start the canvas runtime.
   * Sets up all subsystems: surface manager (contexts + resize), render loops, input.
   */
  start(config: RuntimeConfig): void {
    const { container, baseCanvas, overlayCanvas, editorHost } = config;

    // 1. Surface manager handles all DOM refs:
    //    - Getting and storing 2D contexts
    //    - Setting editor host for TextTool
    //    - Setting canvas element for coordinate transforms
    //    - Applying initial cursor
    //    - Resize/DPR observation
    this.surfaceManager = new SurfaceManager(container, baseCanvas, overlayCanvas, editorHost);
    this.surfaceManager.start();

    // 3. Render loops
    this.renderLoop = new RenderLoop();
    this.renderLoop.start();
    setWorldInvalidator((bounds) => this.renderLoop?.invalidateWorld(bounds));

    this.overlayLoop = new OverlayRenderLoop();
    this.overlayLoop.start();
    setOverlayInvalidator(() => this.overlayLoop?.invalidateAll());
    setHoldPreviewFn(() => this.overlayLoop?.holdPreviewForOneFrame());

    // 4. Input manager + keyboard
    this.inputManager = new InputManager(this);
    this.inputManager.attach();
    attachKeyboard();

    // 6. Camera subscription for tool view changes + context menu repositioning
    this.cameraUnsub = useCameraStore.subscribe(
      (s) => ({ scale: s.scale, px: s.pan.x, py: s.pan.y }),
      () => {
        if (!isEdgeScrolling()) getCurrentTool()?.onViewChange();
        contextMenuController.onCameraMove();
      },
      { equalityFn: (a, b) => a.scale === b.scale && a.px === b.px && a.py === b.py },
    );

    // 7. Snapshot subscription for dirty rect invalidation (event-driven)
    const roomDoc = getActiveRoomDoc();
    this.lastDocVersion = roomDoc.currentSnapshot.docVersion;
    this.snapshotUnsub = roomDoc.subscribeSnapshot((snap) => {
      // Doc content changed - event-driven, no presence polling
      if (snap.docVersion !== this.lastDocVersion) {
        this.lastDocVersion = snap.docVersion;
        // Hold preview for one frame to prevent flash on commit
        this.overlayLoop?.holdPreviewForOneFrame();
        if (this.lastDocVersion < 2) {
          this.renderLoop?.invalidateAll();
        }
        // Process dirty patch from manager
        else if (snap.dirtyPatch) {
          const { rects, evictIds } = snap.dirtyPatch;

          // Evict from cache
          const cache = getObjectCacheInstance();
          cache.evictMany(evictIds);

          // Only invalidate visible dirty regions
          const viewport = getVisibleWorldBounds();
          for (const bounds of rects) {
            if (boundsIntersect(bounds, viewport)) {
              this.renderLoop?.invalidateWorld(bounds);
            }
          }
        }

        // Update overlay for new doc content
        this.overlayLoop?.invalidateAll();
      }
    });

    // 8. Presence subscription for overlay updates (separate from doc)
    this.presenceUnsub = roomDoc.subscribePresence(() => {
      // Presence changed - only update overlay (cursors, etc.)
      this.overlayLoop?.invalidateAll();
    });
  }

  /**
   * Stop the canvas runtime.
   * Cleans up all subsystems.
   */
  stop(): void {
    // Unsubscribe from stores first
    this.snapshotUnsub?.();
    this.presenceUnsub?.();
    this.cameraUnsub?.();

    this.inputManager?.detach();
    detachKeyboard();
    cancelZoom();
    stopEdgeScroll();

    setWorldInvalidator(null);
    this.renderLoop?.stop();
    this.renderLoop?.destroy();

    setOverlayInvalidator(null);
    setHoldPreviewFn(null);
    this.overlayLoop?.stop();
    this.overlayLoop?.destroy();

    // SurfaceManager.stop() handles all DOM ref cleanup:
    // - Clearing contexts
    // - Clearing editor host
    // - Clearing canvas element
    this.surfaceManager?.stop();

    // Clear object cache + image manager
    getObjectCacheInstance().clear();
    clearImageManager();

    this.inputManager = null;
    this.surfaceManager = null;
    this.renderLoop = null;
    this.overlayLoop = null;
    this.cameraUnsub = null;
    this.snapshotUnsub = null;
    this.presenceUnsub = null;
    this.lastDocVersion = -1;
  }

  // === Event Handlers (called by InputManager) ===

  handlePointerDown(e: PointerEvent): void {
    storePointerModifiers(e);
    updateLiveCtrl(e);
    panTool.cancelCoast();
    cancelZoom();

    // MMB = button 1: always pan (if allowed)
    if (e.button === 1) {
      if (!canStartMMBPan()) return;
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;
      capturePointer(e.pointerId);
      panTool.begin(e.pointerId, world[0], world[1]);
      return;
    }

    // Spacebar pan: left-click while holding space → route to panTool
    if (e.button === 0 && isSpacebarPanMode()) {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;
      capturePointer(e.pointerId);
      panTool.begin(e.pointerId, world[0], world[1]);
      return;
    }

    // Left click = button 0: use current tool (might be panTool!)
    if (e.button === 0) {
      const tool = getCurrentTool();
      if (!tool?.canBegin()) return;
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (!world) return;
      capturePointer(e.pointerId);
      tool.begin(e.pointerId, world[0], world[1]);
    }
    // Right click (button 2+): ignored
  }

  handlePointerMove(e: PointerEvent): void {
    updateLiveCtrl(e);
    const world = screenToWorld(e.clientX, e.clientY);
    if (world) {
      setLastCursorWorld(world);
      updatePresenceCursor(world[0], world[1]);
    }

    // Pan active? (from MMB or pan tool mode)
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      if (world) panTool.move(world[0], world[1]);
      return;
    }

    // Spacebar pan: suppress tool hover (prevents cursor override reset)
    if (isSpacebarPanMode()) return;

    // Tool (active gesture or hover)
    const tool = getCurrentTool();
    if (tool && world) {
      tool.move(world[0], world[1]);
    }

    updateEdgeScroll(e.clientX, e.clientY);
  }

  handlePointerUp(e: PointerEvent): void {
    updateLiveCtrl(e);
    stopEdgeScroll();
    // Pan release (from MMB, pan tool mode, or spacebar pan)
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      releasePointer(e.pointerId);
      panTool.end();
      // Restore grab cursor if spacebar still held (open hand between drags)
      if (isSpacebarPanMode()) {
        setCursorOverride('grab');
      }
      return;
    }

    // Tool release
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
    clearPresenceCursor();
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

    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith('image/') || f.name.endsWith('.svg'),
    );
    if (files.length === 0) return;

    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) return;

    for (const file of files) {
      createImageFromBlob(file, world[0], world[1]);
    }
  }

  handleWheel(e: WheelEvent): void {
    e.preventDefault();
    if (panTool.isActive()) return;
    cancelZoom();

    const canvas = screenToCanvas(e.clientX, e.clientY);
    if (!canvas) return;

    // Normalize delta across browsers/modes
    let delta = e.deltaY;
    if (e.deltaMode === 1)
      delta *= 40; // DOM_DELTA_LINE
    else if (e.deltaMode === 2) delta *= 800; // DOM_DELTA_PAGE

    const pivot = { x: canvas[0], y: canvas[1] };

    if (e.ctrlKey || e.metaKey) {
      this.handlePinchZoom(delta, pivot);
    } else {
      this.handleWheelZoom(delta, pivot);
    }
  }

  private handleWheelZoom(delta: number, pivot: { x: number; y: number }): void {
    const now = performance.now();
    const boost = this.getWheelBoost(now);
    const normalizedDelta = delta / 120;
    const factor = Math.pow(WHEEL_BASE, -normalizedDelta * boost);

    const { scale, pan } = useCameraStore.getState();
    const target = calculateZoomTransform(scale, pan, factor, pivot);
    useCameraStore.getState().setScaleAndPan(target.scale, target.pan);
  }

  private handlePinchZoom(delta: number, pivot: { x: number; y: number }): void {
    const factor = Math.pow(2, -delta * PINCH_SENSITIVITY);

    const { scale, pan } = useCameraStore.getState();
    const target = calculateZoomTransform(scale, pan, factor, pivot);
    useCameraStore.getState().setScaleAndPan(target.scale, target.pan);
  }

  private getWheelBoost(now: number): number {
    // Prune events outside window
    while (this.wheelTimestamps.length && this.wheelTimestamps[0] < now - VELOCITY_WINDOW_MS) {
      this.wheelTimestamps.shift();
    }
    this.wheelTimestamps.push(now);

    if (this.wheelTimestamps.length < 2) return 1;

    const span = (now - this.wheelTimestamps[0]) / 1000;
    const rate = span > 0 ? (this.wheelTimestamps.length - 1) / span : 0;

    // Ramp: <3 eps → 1.0, 15 eps → 2.5 (clamped)
    return 1 + Math.min(Math.max(rate - MIN_RATE, 0) / RAMP_DIVISOR, MAX_BOOST - 1);
  }
}
