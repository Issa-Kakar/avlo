import React, { useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { createEmptySnapshot } from '@avlo/shared';
import type { RoomId, Snapshot } from '@avlo/shared';
import { CanvasStage, type CanvasStageHandle } from './CanvasStage';
import { userProfileManager } from '../lib/user-profile-manager';
import { useRoomDoc } from '../hooks/use-room-doc';
import { RenderLoop } from '../renderer/RenderLoop';
import { OverlayRenderLoop } from '../renderer/OverlayRenderLoop';
import type { ViewportInfo } from '../renderer/types';
import { drawPresenceOverlays } from '../renderer/layers';
import { getObjectCacheInstance } from '../renderer/object-cache';
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import { TextTool } from '@/lib/tools/TextTool';
import { PanTool } from '@/lib/tools/PanTool';
import { SelectTool } from '@/lib/tools/SelectTool';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import {
  useCameraStore,
  screenToWorld as cameraScreenToWorld,
  screenToCanvas as cameraScreenToCanvas,
  worldToClient as cameraWorldToClient,
  getVisibleWorldBounds as cameraGetVisibleWorldBounds,
} from '@/stores/camera-store';
import { calculateZoomTransform, boundsIntersect } from './internal/transforms';
import { ZoomAnimator } from './animation/ZoomAnimator';

// Unified interface for all pointer tools
type PointerTool = DrawingTool | EraserTool | TextTool | PanTool | SelectTool;

export interface CanvasProps {
  roomId: RoomId;
  className?: string;
}

export interface CanvasHandle {
  screenToWorld: (clientX: number, clientY: number) => [number, number];
  worldToClient: (worldX: number, worldY: number) => [number, number];
  invalidateWorld: (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => void;
  setPreviewProvider: (provider: () => any) => void;
}

/**
 * Canvas component that integrates rendering with coordinate transforms.
 * Bridges between the low-level CanvasStage and high-level room data.
 */
export const Canvas = React.forwardRef<CanvasHandle, CanvasProps>(({ roomId, className }, ref) => {
  // Replace single stageRef with two stages
  const baseStageRef = useRef<CanvasStageHandle>(null);
  const overlayStageRef = useRef<CanvasStageHandle>(null);
  const editorHostRef = useRef<HTMLDivElement>(null); // DOM overlay for text
  const roomDoc = useRoomDoc(roomId); // MUST be called at top level, not inside useEffect
  // Camera state is now in useCameraStore - no more useViewTransform()
  const toolRef = useRef<PointerTool>();
  const lastMouseClientRef = useRef<{ x: number; y: number } | null>(null); // Track last mouse position for tool seeding
  const renderLoopRef = useRef<RenderLoop | null>(null);
  const overlayLoopRef = useRef<OverlayRenderLoop | null>(null);

  // Get toolbar state from Zustand store - MUST come before activeToolRef initialization
  // Use NARROW SELECTORS to prevent spurious rerenders when other settings change
  // DrawingTool/EraserTool read settings from store at begin() time
  const activeTool = useDeviceUIStore(s => s.activeTool);
  const shapeVariant = useDeviceUIStore(s => s.shapeVariant);
  const textSize = useDeviceUIStore(s => s.textSize);
  const textColor = useDeviceUIStore(s => s.drawingSettings.color);

  // Track current tool for stable cursor (no longer need setScaleRef/setPanRef - use store directly)
  const activeToolRef = useRef<string>(activeTool);

  // Step 3.1: Add state refs for MMB pan
  // Tracks ephemeral MMB pan without touching Zustand
  const mmbPanRef = useRef<{
    active: boolean;
    pointerId: number | null;
    lastClient: { x: number; y: number } | null;
  }>({ active: false, pointerId: null, lastClient: null });

  // Cursor override that beats the tool's base cursor
  const cursorOverrideRef = useRef<string | null>(null);

  // Suppress tool preview during MMB pan (hides eraser ring)
  const suppressToolPreviewRef = useRef(false);

  // Zoom animator for smooth transitions
  const zoomAnimatorRef = useRef<ZoomAnimator | null>(null);

  // Get stable user ID from singleton
  const userId = useMemo(() => userProfileManager.getIdentity().userId, []);

  // PERFORMANCE OPTIMIZATION: Store in ref to avoid React re-renders
  const snapshotRef = useRef<Snapshot>(createEmptySnapshot()); // Initialize with empty snapshot

  // Keep activeToolRef in sync (no re-render)
  // Camera state is now read directly from useCameraStore.getState() - no ref needed
  useLayoutEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  // Subscribe to snapshots and check for document version changes
  useEffect(() => {
    let lastDocVersion = -1;

    const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
      snapshotRef.current = newSnapshot;

      if (!renderLoopRef.current || !overlayLoopRef.current) return;
      // Check if document content changed (not just presence)
      if (newSnapshot.docVersion !== lastDocVersion) {
        lastDocVersion = newSnapshot.docVersion;
        // Hold preview for one frame to prevent flash on commit
        overlayLoopRef.current.holdPreviewForOneFrame();

        // SIMPLIFIED: Just use dirtyPatch from manager
        // Manager already computed everything during observer callbacks
        if (newSnapshot.dirtyPatch) {
          const { rects, evictIds } = newSnapshot.dirtyPatch;

          // Evict from cache
          const cache = getObjectCacheInstance();
          cache.evictMany(evictIds);

          // Get visible world bounds directly from camera store
          const viewport = cameraGetVisibleWorldBounds();
          // Only invalidate visible dirty regions
          for (const bounds of rects) {
            if (boundsIntersect(bounds, viewport)) {
              renderLoopRef.current.invalidateWorld(bounds);
            }
          }
        } else if (lastDocVersion < 2) {
          // Initial load without dirtyPatch
          renderLoopRef.current.invalidateAll('content-change');
        }
        overlayLoopRef.current.invalidateAll(); // Also update overlay for new doc
      } else {
        // Presence-only change - update overlay only
        overlayLoopRef.current.invalidateAll();
      }
    });

    snapshotRef.current = roomDoc.currentSnapshot;
    lastDocVersion = roomDoc.currentSnapshot.docVersion;

    return unsubscribe;
  }, [roomDoc]); // Depend on roomDoc from hook

  // Helper to detect mobile (Phase 3.3 FPS throttling)
  const isMobile = useCallback(() => {
    return (
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      window.matchMedia?.('(max-width: 768px)').matches ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    );
  }, []);

  // COORDINATE TRANSFORM FUNCTIONS
  // Pure functions imported from camera-store - use directly, no wrappers needed!
  // cameraScreenToWorld(clientX, clientY) -> [worldX, worldY] | null
  // cameraWorldToClient(worldX, worldY) -> [clientX, clientY]

  // Step 3.2: Add cursor management function
  // CRITICAL: Stable function that reads from ref to avoid stale closures
  const applyCursor = useCallback(() => {
    const canvas = baseStageRef.current?.getCanvasElement();
    if (!canvas) return;

    // Priority 1: Explicit override (MMB dragging)
    if (cursorOverrideRef.current) {
      canvas.style.cursor = cursorOverrideRef.current;
      return;
    }

    // Priority 2: Tool-based default (read from ref for stability)
    const currentTool = activeToolRef.current;
    switch (currentTool) {
      case 'eraser':
        canvas.style.cursor = 'url("/cursors/avloEraser.cur") 16 16, auto';
        break;
      case 'pan':
        canvas.style.cursor = 'grab'; // Open hand idle
        break;
      case 'select':
        canvas.style.cursor = 'default'; // Arrow cursor for selection
        break;
      default:
        canvas.style.cursor = 'crosshair';
    }
  }, []); // ✅ Empty deps - reads from refs

  // NOTE: No stageReady gate needed!
  // - Canvas element is registered synchronously via ref callback in CanvasStage
  // - Event handlers guard with `if (!worldCoords) return` when canvas isn't ready
  // - This is the imperative pattern: try and let guards handle edge cases

  // 3D: Initialize base render loop
  // Use useLayoutEffect to ensure render loop exists before drawing tool effect
  // RenderLoop now reads view/viewport directly from camera store
  useLayoutEffect(() => {
    if (!baseStageRef.current) return;

    const renderLoop = new RenderLoop();
    renderLoopRef.current = renderLoop;
    renderLoop.start({
      stageRef: baseStageRef,
      // getView and getViewport are now optional - RenderLoop reads from camera store
      getSnapshot: () => snapshotRef.current,
      getGates: () => roomDoc.getGateStatus(),
      isMobile,
      onStats: import.meta.env.DEV
        ? (stats) => {
            if (stats.frameCount % 60 === 0) {
              // eslint-disable-next-line no-console
              console.log('[RenderLoop Stats]', {
                fps: stats.fps.toFixed(1),
                avgMs: stats.avgMs.toFixed(2),
                overBudget: stats.overBudgetCount,
                skipped: stats.skippedCount,
                lastClear: stats.lastClearType,
              });
            }
          }
        : undefined,
    });

    // Trigger initial render if we have content
    // Use gate status instead of svKey comparison
    // Use setTimeout(0) instead of queueMicrotask for better safety
    // This ensures the render loop is fully initialized and avoids race conditions
    let initialRenderTimeout: ReturnType<typeof setTimeout> | undefined;
    const gateStatus = roomDoc.getGateStatus();
    if (gateStatus.firstSnapshot) {
      initialRenderTimeout = setTimeout(() => {
        // Safety check - renderLoop might have been destroyed if component unmounted quickly
        if (renderLoopRef.current === renderLoop) {
          renderLoop.invalidateAll('content-change');
        }
      }, 0);
    }

    return () => {
      if (initialRenderTimeout) {
        clearTimeout(initialRenderTimeout);
      }
      renderLoop.stop();
      renderLoop.destroy();
      renderLoopRef.current = null;
      // TODO: Clear object cache on unmount when Phase 6 is implemented
      // This prevents memory leaks when switching rooms
      getObjectCacheInstance().clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // NO DEPENDENCIES - stable render loop lifecycle, isMobile is a stable callback

  // 3E: Add overlay render loop initialization
  // OverlayRenderLoop now reads view/viewport directly from camera store
  useLayoutEffect(() => {
    if (!overlayStageRef.current) return;

    const overlayLoop = new OverlayRenderLoop();
    overlayLoopRef.current = overlayLoop;

    overlayLoop.start({
      stage: overlayStageRef.current!,
      // getView and getViewport are now optional - OverlayRenderLoop reads from camera store
      getGates: () => roomDoc.getGateStatus(),
      getPresence: () => snapshotRef.current.presence,
      getSnapshot: () => snapshotRef.current,
      drawPresence: (ctx, _presence, view, vp) => {
        const viewport: ViewportInfo = {
          pixelWidth: Math.round(vp.cssWidth * vp.dpr),
          pixelHeight: Math.round(vp.cssHeight * vp.dpr),
          cssWidth: vp.cssWidth,
          cssHeight: vp.cssHeight,
          dpr: vp.dpr,
        };
        drawPresenceOverlays(
          ctx,
          snapshotRef.current,
          view,
          viewport,
          roomDoc.getGateStatus(),
        );
      },
    });

    return () => {
      overlayLoop.stop();
      overlayLoop.destroy();
      overlayLoopRef.current = null;
    };
  }, [roomDoc]);

  // Initialize ZoomAnimator for smooth zoom transitions
  // ZoomAnimator now reads/writes directly to camera store (no callbacks needed)
  useEffect(() => {
    zoomAnimatorRef.current = new ZoomAnimator();

    return () => {
      zoomAnimatorRef.current?.destroy();
      zoomAnimatorRef.current = null;
    };
  }, []); // Mount once

  // CRITICAL FIX: Combined initialization and event listener effect
  // This ensures everything is wired up atomically when dependencies are ready
  // IMPORTANT: viewTransform is NOT in dependencies to prevent mid-gesture teardown
  // stageReady IS in dependencies to ensure re-run when stage becomes available
  useEffect(() => {
    // Special handling for text tool config changes during editing
    // If text tool is actively editing, just update config without recreation
    if (activeTool === 'text' && toolRef.current?.isActive()) {
      const textTool = toolRef.current as any;
      if ('updateConfig' in textTool) {
        // Create text config from narrow selectors
        const textConfig = {
          size: textSize,
          color: textColor
        };
        textTool.updateConfig(textConfig);
        return; // Skip recreation, just update config
      }
    }

    // Wait for all required dependencies
    const renderLoop = renderLoopRef.current;
    const canvas = baseStageRef.current?.getCanvasElement();
    // Camera store always has valid state (defaults to scale:1, pan:{x:0,y:0})
    // No need to check viewTransform availability

    // Guard: ensure all required components exist
    // This effect WILL re-run when stageReady changes (once)
    if (!renderLoop || !canvas || !roomDoc) {
      // Only log in development mode
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.debug('Tool waiting for dependencies:', {
          renderLoop: !!renderLoop,
          canvas: !!canvas,
          room: !!roomDoc,
        });
      }
      return; // Dependencies not ready yet, will retry when stageReady changes
    }

    // Mobile detection for view-only enforcement
    // CRITICAL FIX: Include maxTouchPoints check for iPadOS (reports as "Macintosh")
    const isMobile =
      /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

    // Create appropriate tool based on activeTool (branch ONCE here)
    // All tools now read camera state directly from useCameraStore
    let tool: PointerTool | null = null;

    if (activeTool === 'eraser') {
      // Eraser tool uses fixed 10px radius - no settings needed
      // Constructor: (room, onInvalidate) - getView removed, reads from camera store
      tool = new EraserTool(
        roomDoc,
        () => overlayLoopRef.current?.invalidateAll(),
      );
    } else if (activeTool === 'pen' || activeTool === 'highlighter') {
      // Settings are read from store at begin() time - no need to pass them
      // Constructor: (room, toolType, userId, onInvalidate, requestOverlayFrame, opts?)
      // getView removed - uses worldToCanvas from camera store for jitter detection
      tool = new DrawingTool(
        roomDoc,
        activeTool,
        userId,
        (_bounds) => {
          // During drawing, invalidate overlay (preview is there)
          overlayLoopRef.current?.invalidateAll();
        },
        () => overlayLoopRef.current?.invalidateAll(),
      );
    } else if (activeTool === 'shape') {
      // Map shape variant to forced snap kind
      const forceSnapKind =
        shapeVariant === 'rectangle' ? 'rect' :
        shapeVariant === 'ellipse'   ? 'ellipseRect' :
        shapeVariant === 'diamond'   ? 'diamond' :
        shapeVariant === 'arrow'     ? 'arrow' : 'line';

      // Settings are read from store at begin() time - no need to pass them
      // getView removed - opts is now 6th param (was 7th)
      tool = new DrawingTool(
        roomDoc,
        'pen', // Shape tool uses pen mechanics
        userId,
        (_bounds) => overlayLoopRef.current?.invalidateAll(),
        () => overlayLoopRef.current?.invalidateAll(),
        { forceSnapKind },
      );
    } else if (activeTool === 'text') {
      // Text tool uses narrow selector for color and its own size
      const textSettings = {
        size: textSize,
        color: textColor
      };
      // CanvasHandle now only has getEditorHost - worldToClient and getView removed
      // TextTool imports worldToClient and reads scale from camera store directly
      tool = new TextTool(
        roomDoc,
        textSettings,
        userId,
        {
          getEditorHost: () => editorHostRef.current,
        },
        () => overlayLoopRef.current?.invalidateAll(),
      );
    } else if (activeTool === 'pan') {
      // PanTool constructor: (onInvalidateOverlay, applyCursor, setCursorOverride)
      // getView and setPan removed - reads/writes to camera store directly
      tool = new PanTool(
        () => overlayLoopRef.current?.invalidateAll(),
        applyCursor,
        (cursor: string | null) => { cursorOverrideRef.current = cursor; },
      );
    } else if (activeTool === 'select') {
      // SelectTool opts: getView removed - reads from camera store directly
      tool = new SelectTool(roomDoc, {
        invalidateWorld: (bounds) => renderLoopRef.current?.invalidateWorld(bounds),
        invalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
        applyCursor,
        setCursorOverride: (cursor: string | null) => { cursorOverrideRef.current = cursor; },
      });
    } else {
      return; // Unsupported tool
    }

    toolRef.current = tool;

    // Step 3.3: Wrap the preview provider to support suppression
    // Set preview provider on overlay loop (both tools implement getPreview())
    if (!isMobile && overlayLoopRef.current) {
      overlayLoopRef.current.setPreviewProvider({
        getPreview: () => {
          if (suppressToolPreviewRef.current) return null; // Hide during MMB
          return tool?.getPreview() || null;
        },
      });
    }

    // Update cursor style
    // Update cursor based on current tool/override
    cursorOverrideRef.current = null; // belt-and-suspenders reset
    applyCursor()

    // Seed the eraser preview using the last known mouse position (for keyboard shortcuts)
    if (!isMobile && activeTool === 'eraser' && lastMouseClientRef.current) {
      const { x, y } = lastMouseClientRef.current;
      const world = cameraScreenToWorld(x, y);
      if (world) {
        tool.move(world[0], world[1]);
      }
    }

    // Set canvas styles (conditional for mobile)
    if (!isMobile) {
      // Only disable touch on desktop (preserve scrolling on mobile)
      canvas.style.touchAction = 'none';
      // Don't override the cursor here - it was already set based on tool above
    }

    // CLEANUP - comprehensive cleanup on any dependency change
    return () => {
      // Cleanup
      const pointerId = tool?.getPointerId();
      if (pointerId !== null) {
        try {
          canvas.releasePointerCapture(pointerId);
        } catch {
          // Pointer capture may already be released, ignore
        }
      }
      tool?.cancel();
      tool?.destroy();
      toolRef.current = undefined;
      overlayLoopRef.current?.setPreviewProvider(null);

      // Reset MMB state if active (Step 4 cleanup)
      if (mmbPanRef.current.active) {
        mmbPanRef.current = { active: false, pointerId: null, lastClient: null };
        cursorOverrideRef.current = null;
        suppressToolPreviewRef.current = false;
      }
    };
  }, [
    roomDoc,
    userId,
    activeTool,
    textSize,      // Only for TextTool updateConfig
    textColor,     // Only for TextTool updateConfig (narrow selector)
    shapeVariant,  // Changes tool behavior (forceSnapKind)
    applyCursor,   // Stable function with empty deps
  ]); // DrawingTool/EraserTool read settings from store at begin() time
  // Note: cameraScreenToWorld/cameraWorldToClient are pure functions from camera-store, not React deps

  // Effect A: Stable event listeners (mount once) - Step 2.1
  // No stageReady gate - handlers guard themselves with screenToWorld null checks
  useEffect(() => {
    const canvas = baseStageRef.current?.getCanvasElement();
    if (!canvas) return;

    // All handlers read from refs - no closure dependencies
    // Step 4.1: Pointer Down Handler
    const handlePointerDown = (e: PointerEvent) => {
      // Mobile check (use ref or stable function)
      const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                       navigator.maxTouchPoints > 1;
      if (isMobile) return;

      // --- MMB EPHEMERAL PAN ---
      if (e.button === 1) {
        e.preventDefault(); // Stop OS autoscroll

        // Don't steal capture if tool is active
        if (toolRef.current?.isActive()) return;

        const canvas = baseStageRef.current?.getCanvasElement();
        if (!canvas) return;
        canvas.setPointerCapture(e.pointerId);

        mmbPanRef.current = {
          active: true,
          pointerId: e.pointerId,
          lastClient: { x: e.clientX, y: e.clientY },
        };

        cursorOverrideRef.current = 'grabbing';
        suppressToolPreviewRef.current = true; // Hide tool preview
        applyCursor();
        overlayLoopRef.current?.invalidateAll(); // Redraw without preview
        return;
      }

      // --- NORMAL TOOLS ---
      if (e.button !== 0) return; // Only left button for tools

      const tool = toolRef.current;
      if (!tool?.canBegin()) return;

      const worldCoords = cameraScreenToWorld(e.clientX, e.clientY);
      if (!worldCoords) return;

      e.preventDefault();
      const captureCanvas = baseStageRef.current?.getCanvasElement();
      if (captureCanvas) {
        captureCanvas.setPointerCapture(e.pointerId);
      }

      // Pass client coords for PanTool seeding (will be implemented later)
      if (activeToolRef.current === 'pan' && 'begin' in tool) {
        (tool as any).begin(e.pointerId, worldCoords[0], worldCoords[1], e.clientX, e.clientY);
      } else {
        tool.begin(e.pointerId, worldCoords[0], worldCoords[1]);
      }

      // Pan tool doesn't need 'drawing' activity
      if (activeToolRef.current !== 'pan') {
        roomDoc.updateActivity('drawing');
      }
    };

    // Step 4.2: Pointer Move Handler
    const handlePointerMove = (e: PointerEvent) => {
      // Track for tool seeding
      lastMouseClientRef.current = { x: e.clientX, y: e.clientY };

      // Check mobile
      const isMobile = /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                       navigator.maxTouchPoints > 1;

      // ALWAYS update presence first (unless mobile)
      if (!isMobile) {
        const world = cameraScreenToWorld(e.clientX, e.clientY);
        if (world) {
          roomDoc.updateCursor(world[0], world[1]);
        }
      }

      // MMB pan in progress?
      if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
        const last = mmbPanRef.current.lastClient!;
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        mmbPanRef.current.lastClient = { x: e.clientX, y: e.clientY };

        // Pan using world units (negative because we're dragging the canvas)
        // Read scale/pan from camera store, then set new pan
        const { scale, pan } = useCameraStore.getState();
        const newPan = {
          x: pan.x - dx / scale,
          y: pan.y - dy / scale,
        };
        useCameraStore.getState().setPan(newPan);

        overlayLoopRef.current?.invalidateAll();
        return; // Skip tool move during MMB pan
      }

      // Special handling for PanTool (only when actually dragging)
      const tool = toolRef.current;
      if (tool && activeToolRef.current === 'pan' && 'updatePan' in tool) {
        (tool as any).updatePan(e.clientX, e.clientY);
        // Only return early if actually dragging
        if (tool.isActive()) return;
        // Fall through to normal tool.move() for hover when not dragging
      }

      // Normal tool hover/preview (pen, eraser, etc)
      if (!isMobile && tool) {
        const world = cameraScreenToWorld(e.clientX, e.clientY);
        if (world) {
          tool.move(world[0], world[1]);

          // SelectTool: update handle hover cursor when idle
          if (activeToolRef.current === 'select' && !tool.isActive()) {
            (tool as SelectTool).updateHoverCursor(world[0], world[1]);
          }
        }
      }
    };

    // Step 4.3: Pointer Up/Cancel/Lost Handlers
    const handlePointerUp = (e: PointerEvent) => {
      // Handle MMB release
      if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
        try {
          baseStageRef.current?.getCanvasElement()?.releasePointerCapture(e.pointerId);
        } catch {
          // Pointer capture may already be released
        }

        mmbPanRef.current = { active: false, pointerId: null, lastClient: null };
        cursorOverrideRef.current = null;
        suppressToolPreviewRef.current = false; // Show tool preview again
        applyCursor();
        overlayLoopRef.current?.invalidateAll(); // Redraw with preview
        return;
      }

      // Normal tool end
      const tool = toolRef.current;
      if (!tool?.isActive() || e.pointerId !== tool.getPointerId()) return;

      try {
        baseStageRef.current?.getCanvasElement()?.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may already be released
      }

      const world = cameraScreenToWorld(e.clientX, e.clientY);
      tool.end(world?.[0], world?.[1]);
      roomDoc.updateActivity('idle');
    };

    const handlePointerCancel = (e: PointerEvent) => {
      // Handle MMB cancel
      if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
        // Same as pointer up for MMB
        mmbPanRef.current = { active: false, pointerId: null, lastClient: null };
        cursorOverrideRef.current = null;
        suppressToolPreviewRef.current = false;
        applyCursor();
        overlayLoopRef.current?.invalidateAll();
        return;
      }

      // Normal tool cancel
      if (e.pointerId !== toolRef.current?.getPointerId()) return;

      try {
        baseStageRef.current?.getCanvasElement()?.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may already be released
      }

      toolRef.current?.cancel();
      roomDoc.updateActivity('idle');
    };

    const handleLostPointerCapture = (e: PointerEvent) => {
      // Handle MMB lost capture
      if (mmbPanRef.current.active && e.pointerId === mmbPanRef.current.pointerId) {
        mmbPanRef.current = { active: false, pointerId: null, lastClient: null };
        cursorOverrideRef.current = null;
        suppressToolPreviewRef.current = false;
        applyCursor();
        overlayLoopRef.current?.invalidateAll();
        return;
      }

      // Normal tool lost capture
      if (e.pointerId === toolRef.current?.getPointerId()) {
        toolRef.current?.cancel();
        roomDoc.updateActivity('idle');
        if ('clearHover' in toolRef.current) {
          (toolRef.current as any).clearHover?.();
        }
      }
    };

    const handlePointerLeave = () => {
      roomDoc.updateCursor(undefined, undefined);

      if (toolRef.current && 'clearHover' in toolRef.current) {
        (toolRef.current as any).clearHover();
      }
    };

    // Step 5: Implement Wheel Zoom
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      // Block wheel during MMB pan
      if (mmbPanRef.current.active) return;

      // OPTIONAL: Block wheel during active tool gesture
      // if (toolRef.current?.isActive()) return;

      // Get canvas-relative cursor position for zoom pivot
      const canvasCoords = cameraScreenToCanvas(e.clientX, e.clientY);
      if (!canvasCoords) return; // Canvas not ready
      const [canvasX, canvasY] = canvasCoords;

      // Normalize wheel delta
      let deltaY = e.deltaY;
      if (e.deltaMode === 1) deltaY *= 40;  // Lines
      else if (e.deltaMode === 2) deltaY *= 800; // Pages
      const steps = deltaY / 120;

      // Calculate zoom factor (~16% per step)
      const ZOOM_STEP = Math.log(1.2);
      const factor = Math.exp(-steps * ZOOM_STEP);

      // Read LATEST transform from camera store
      const { scale, pan } = useCameraStore.getState();

      // Use existing calculateZoomTransform utility
      const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
        scale,
        pan,
        factor,
        { x: canvasX, y: canvasY }
      );

      // Use ZoomAnimator for smooth transitions
      zoomAnimatorRef.current?.to(targetScale, targetPan);
    };

    // Attach ALL listeners with { passive: false }
    canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
    canvas.addEventListener('pointermove', handlePointerMove, { passive: false });
    canvas.addEventListener('pointerup', handlePointerUp, { passive: false });
    canvas.addEventListener('pointercancel', handlePointerCancel, { passive: false });
    canvas.addEventListener('lostpointercapture', handleLostPointerCapture, { passive: false });
    canvas.addEventListener('pointerleave', handlePointerLeave, { passive: false });
    canvas.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerCancel);
      canvas.removeEventListener('lostpointercapture', handleLostPointerCapture);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, [applyCursor, roomDoc]); // cameraScreenToWorld is a pure function from store, not a React dep

  // 3F: Handle transform changes (scale/pan) for both loops
  // Subscribe to camera store for scale/pan changes instead of React dependency array
  useEffect(() => {
    const unsubscribe = useCameraStore.subscribe(
      // Selector: extract scale and pan
      (state) => ({ scale: state.scale, pan: state.pan }),
      // Callback: runs when selected values change
      () => {
        // Trigger a frame when transform changes
        // The DirtyRectTracker.notifyTransformChange() in tick() will detect the change
        // and automatically promote to full clear - we just need to trigger the frame
        renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
        overlayLoopRef.current?.invalidateAll(); // Overlay needs redraw on pan/zoom

        // Notify tool of view change for DOM repositioning
        if (toolRef.current && 'onViewChange' in toolRef.current) {
          (toolRef.current as TextTool | EraserTool).onViewChange?.();
        }
      },
      // Equality function for granular updates
      { equalityFn: (a, b) => a.scale === b.scale && a.pan.x === b.pan.x && a.pan.y === b.pan.y }
    );
    return unsubscribe;
  }, []); // Empty deps - subscription manages its own lifecycle

  // 3G: Handle viewport changes (resize/DPR) - triggers full redraw
  // Separate subscription because viewport changes need invalidateAll, not just dirty rect
  useEffect(() => {
    const unsubscribe = useCameraStore.subscribe(
      // Selector: extract viewport dimensions
      (state) => ({ cssWidth: state.cssWidth, cssHeight: state.cssHeight, dpr: state.dpr }),
      // Callback: runs when viewport changes
      () => {
        // Viewport changed - need full redraw
        renderLoopRef.current?.invalidateAll('geometry-change');
        overlayLoopRef.current?.invalidateAll();
      },
      // Equality function
      { equalityFn: (a, b) => a.cssWidth === b.cssWidth && a.cssHeight === b.cssHeight && a.dpr === b.dpr }
    );
    return unsubscribe;
  }, []); // Empty deps - subscription manages its own lifecycle

  // 3H: Update imperative handle for preview routing
  React.useImperativeHandle(
    ref,
    () => ({
      screenToWorld: (clientX: number, clientY: number): [number, number] => {
        const result = cameraScreenToWorld(clientX, clientY);
        return result || [clientX, clientY]; // Fallback for compatibility
      },
      worldToClient: cameraWorldToClient,
      invalidateWorld: (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => {
        renderLoopRef.current?.invalidateWorld(bounds);
      },
      setPreviewProvider: (provider: () => any) => {
        // Route to overlay loop instead of base loop
        if (overlayLoopRef.current) {
          overlayLoopRef.current.setPreviewProvider({
            getPreview: provider,
          });
        }
      },
    }),
    [], // Pure functions from camera-store, no React deps
  );

  // 3J: Update JSX to render two canvases
  // CanvasStage updates camera store directly via setViewport() - no onResize needed
  return (
    <div className="relative w-full h-full" style={{ backgroundColor: '#FFFFFF' }}>
      <CanvasStage
        ref={baseStageRef}
        className={className}
        style={{ position: 'absolute', inset: 0, zIndex: 1 }}
      />
      <CanvasStage
        ref={overlayStageRef}
        className={className}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 2,
          pointerEvents: 'none', // Critical: overlay doesn't block input
        }}
      />
      {/* NEW: DOM overlay for interactive HTML elements (text editor) */}
      <div
        ref={editorHostRef}
        className="dom-overlay-root"
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 3,
          pointerEvents: 'none', // Enable per-element when needed
        }}
      />
    </div>
  );
});

Canvas.displayName = 'Canvas';
