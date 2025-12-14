/**
 * CanvasRuntime - The Central Orchestrator
 *
 * This class is the "brain" of the canvas system. It:
 * - Imports tool registry (tools self-construct)
 * - Owns InputManager instance
 * - Creates RenderLoop and OverlayRenderLoop (with canvas refs only)
 * - Creates ZoomAnimator
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
import { ZoomAnimator } from './animation/ZoomAnimator';
import { SurfaceManager } from './SurfaceManager';
import { InputManager } from './InputManager';
import { getCurrentTool, canStartMMBPan, panTool } from './tool-registry';
import { setWorldInvalidator, setOverlayInvalidator, setHoldPreviewFn } from './invalidation-helpers';
import { setBaseContext, setOverlayContext } from './canvas-context-registry';
import { getActiveRoomDoc, updatePresenceCursor, clearPresenceCursor } from './room-runtime';
import { getObjectCacheInstance } from '@/renderer/object-cache';
import { applyCursor } from './cursor-manager';
import {
  setCanvasElement,
  screenToWorld,
  screenToCanvas,
  capturePointer,
  releasePointer,
  useCameraStore,
  getVisibleWorldBounds,
} from '@/stores/camera-store';
import { calculateZoomTransform, boundsIntersect } from './internal/transforms';

export interface RuntimeConfig {
  container: HTMLElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
}

export class CanvasRuntime {
  private inputManager: InputManager | null = null;
  private surfaceManager: SurfaceManager | null = null;
  private renderLoop: RenderLoop | null = null;
  private overlayLoop: OverlayRenderLoop | null = null;
  private zoomAnimator: ZoomAnimator | null = null;
  private cameraUnsub: (() => void) | null = null;
  private snapshotUnsub: (() => void) | null = null;
  private lastDocVersion = -1;

  /**
   * Start the canvas runtime.
   * Sets up all subsystems: contexts, surface manager, render loops, input.
   */
  start(config: RuntimeConfig): void {
    const { container, baseCanvas, overlayCanvas } = config;

    // 1. Register contexts
    const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: false });
    const overlayCtx = overlayCanvas.getContext('2d', { willReadFrequently: false });
    if (!baseCtx || !overlayCtx) throw new Error('Failed to get 2D contexts');

    setBaseContext(baseCtx);
    setOverlayContext(overlayCtx);
    setCanvasElement(baseCanvas);

    // Apply initial cursor based on persisted active tool
    // (cursor-manager self-subscribes for future tool changes)
    applyCursor();

    // 2. Surface manager (resize/DPR)
    this.surfaceManager = new SurfaceManager(container, baseCanvas, overlayCanvas);
    this.surfaceManager.start();

    // 3. Render loops
    this.renderLoop = new RenderLoop();
    this.renderLoop.start();
    setWorldInvalidator((bounds) => this.renderLoop?.invalidateWorld(bounds));

    this.overlayLoop = new OverlayRenderLoop();
    this.overlayLoop.start();
    setOverlayInvalidator(() => this.overlayLoop?.invalidateAll());
    setHoldPreviewFn(() => this.overlayLoop?.holdPreviewForOneFrame());

    // 4. Zoom animator
    this.zoomAnimator = new ZoomAnimator();

    // 5. Input manager
    this.inputManager = new InputManager(this);
    this.inputManager.attach();

    // 6. Camera subscription for tool view changes
    this.cameraUnsub = useCameraStore.subscribe(
      (s) => ({ scale: s.scale, px: s.pan.x, py: s.pan.y }),
      () => getCurrentTool()?.onViewChange(),
      { equalityFn: (a, b) => a.scale === b.scale && a.px === b.px && a.py === b.py }
    );

    // 7. Snapshot subscription for dirty rect invalidation
    const roomDoc = getActiveRoomDoc();
    this.lastDocVersion = roomDoc.currentSnapshot.docVersion;
    this.snapshotUnsub = roomDoc.subscribeSnapshot((snapshot) => {
      // Check if document content changed (not just presence)
      if (snapshot.docVersion !== this.lastDocVersion) {
        this.lastDocVersion = snapshot.docVersion;

        // Hold preview for one frame to prevent flash on commit
        this.overlayLoop?.holdPreviewForOneFrame();

        // Process dirty patch from manager
        if (snapshot.dirtyPatch) {
          const { rects, evictIds } = snapshot.dirtyPatch;

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
        } else if (this.lastDocVersion < 2) {
          // Initial load without dirtyPatch
          this.renderLoop?.invalidateWorld(getVisibleWorldBounds());
        }

        // Update overlay for new doc content
        this.overlayLoop?.invalidateAll();
      } else {
        // Presence-only change - update overlay only
        this.overlayLoop?.invalidateAll();
      }
    });
  }

  /**
   * Stop the canvas runtime.
   * Cleans up all subsystems.
   */
  stop(): void {
    // Unsubscribe from stores first
    this.snapshotUnsub?.();
    this.cameraUnsub?.();

    this.inputManager?.detach();
    this.zoomAnimator?.destroy();

    setWorldInvalidator(null);
    this.renderLoop?.stop();
    this.renderLoop?.destroy();

    setOverlayInvalidator(null);
    setHoldPreviewFn(null);
    this.overlayLoop?.stop();
    this.overlayLoop?.destroy();

    this.surfaceManager?.stop();

    setBaseContext(null);
    setOverlayContext(null);
    setCanvasElement(null);

    // Clear object cache
    getObjectCacheInstance().clear();

    this.inputManager = null;
    this.surfaceManager = null;
    this.renderLoop = null;
    this.overlayLoop = null;
    this.zoomAnimator = null;
    this.cameraUnsub = null;
    this.snapshotUnsub = null;
    this.lastDocVersion = -1;
  }

  // === Event Handlers (called by InputManager) ===

  handlePointerDown(e: PointerEvent): void {
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
    const world = screenToWorld(e.clientX, e.clientY);
    if (world) updatePresenceCursor(world[0], world[1]);

    // Pan active? (from MMB or pan tool mode)
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      if (world) panTool.move(world[0], world[1]);
      return;
    }

    // Tool (active gesture or hover)
    const tool = getCurrentTool();
    if (tool && world) {
      tool.move(world[0], world[1]);
    }
  }

  handlePointerUp(e: PointerEvent): void {
    // Pan release (from MMB or pan tool mode)
    if (panTool.isActive() && panTool.getPointerId() === e.pointerId) {
      releasePointer(e.pointerId);
      panTool.end();
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

  handleWheel(e: WheelEvent): void {
    e.preventDefault();
    if (panTool.isActive()) return;

    const canvas = screenToCanvas(e.clientX, e.clientY);
    if (!canvas) return;

    let deltaY = e.deltaY;
    if (e.deltaMode === 1) deltaY *= 40;
    else if (e.deltaMode === 2) deltaY *= 800;

    const factor = Math.exp((-deltaY / 120) * Math.log(1.16));
    const { scale, pan } = useCameraStore.getState();
    const target = calculateZoomTransform(scale, pan, factor, { x: canvas[0], y: canvas[1] });

    this.zoomAnimator?.to(target.scale, target.pan);
  }
}
