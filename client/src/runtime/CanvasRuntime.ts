/**
 * CanvasRuntime - The Central Orchestrator
 *
 * Owns: SurfaceManager (DOM refs + resize), InputManager (events + modifiers),
 * render loop lifecycle, camera/snapshot subscriptions.
 * Handles all pointer event logic (coordinate conversion, tool dispatch).
 *
 * @module runtime/CanvasRuntime
 */

import { renderLoop } from '@/renderer/RenderLoop';
import { overlayLoop } from '@/renderer/OverlayRenderLoop';
import { cancelZoom, calculateZoomTransform } from './viewport/zoom';
import { SurfaceManager } from './SurfaceManager';
import { InputManager } from './InputManager';
import { getCurrentTool, canStartMMBPan, panTool } from './tool-registry';
import { holdPreviewForOneFrame } from '@/renderer/layers/tool-preview';
import { getActiveRoomDoc } from './room-runtime';
import { updateCursor, clearCursor } from './presence/presence';
import { isSpacebarPanMode } from './keyboard-manager';
import { setLastCursorWorld } from './cursor-tracking';
import { setCursorOverride } from '@/stores/device-ui-store';
import {
  screenToWorld,
  screenToCanvas,
  capturePointer,
  releasePointer,
  useCameraStore,
} from '@/stores/camera-store';
import { contextMenuController } from './ContextMenuController';
import { updateEdgeScroll, stopEdgeScroll, isEdgeScrolling } from './viewport/edge-scroll';
import { clear as clearImageManager } from '@/core/image/image-manager';
import { cleanupOnRoomTeardown } from '@/core/bookmark/bookmark-unfurl';
import { createImageFromBlob } from '@/core/image/image-actions';

export interface RuntimeConfig {
  container: HTMLElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  editorHost: HTMLDivElement;
}

// --- Zoom constants ---
const WHEEL_BASE = 1.15;
const VELOCITY_WINDOW_MS = 200;
const MIN_RATE = 3;
const RAMP_DIVISOR = 16;
const MAX_BOOST = 2.0;
const PINCH_SENSITIVITY = 0.01;

export class CanvasRuntime {
  private surfaceManager: SurfaceManager | null = null;
  private inputManager: InputManager | null = null;
  private cameraUnsub: (() => void) | null = null;
  private snapshotUnsub: (() => void) | null = null;
  private lastDocVersion = -1;
  private wheelTimestamps: number[] = [];

  start(config: RuntimeConfig): void {
    const { container, baseCanvas, overlayCanvas, editorHost } = config;

    // 1. Surface manager: DOM refs, contexts, resize/DPR
    this.surfaceManager = new SurfaceManager(container, baseCanvas, overlayCanvas, editorHost);
    this.surfaceManager.start();

    // 2. Render loops
    renderLoop.start();
    overlayLoop.start();

    // 3. Input manager: pointer events, modifier state, keyboard lifecycle
    this.inputManager = new InputManager(this, baseCanvas, container);
    this.inputManager.attach();

    // 4. Camera subscription for tool view changes + context menu repositioning
    this.cameraUnsub = useCameraStore.subscribe(
      (s) => ({ scale: s.scale, px: s.pan.x, py: s.pan.y }),
      () => {
        if (!isEdgeScrolling()) getCurrentTool()?.onViewChange();
        contextMenuController.onCameraMove();
      },
      { equalityFn: (a, b) => a.scale === b.scale && a.px === b.px && a.py === b.py },
    );

    // 5. Snapshot subscription
    const roomDoc = getActiveRoomDoc();
    this.lastDocVersion = roomDoc.currentSnapshot.docVersion;
    renderLoop.invalidateAll();
    overlayLoop.invalidateAll();

    this.snapshotUnsub = roomDoc.subscribeSnapshot((snap) => {
      if (snap.docVersion !== this.lastDocVersion) {
        this.lastDocVersion = snap.docVersion;
        holdPreviewForOneFrame();
        overlayLoop.invalidateAll();
      }
    });
  }

  stop(): void {
    this.snapshotUnsub?.();
    this.cameraUnsub?.();

    this.inputManager?.detach();
    cancelZoom();
    stopEdgeScroll();

    renderLoop.stop();
    overlayLoop.stop();

    this.surfaceManager?.stop();

    clearImageManager();
    cleanupOnRoomTeardown();

    this.inputManager = null;
    this.surfaceManager = null;
    this.cameraUnsub = null;
    this.snapshotUnsub = null;
    this.lastDocVersion = -1;
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
    if (world) {
      setLastCursorWorld(world);
      updateCursor(world[0], world[1]);
    }

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
    clearCursor();
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

    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 40;
    else if (e.deltaMode === 2) delta *= 800;

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
