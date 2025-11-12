import React, { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo } from 'react';
import { createEmptySnapshot } from '@avlo/shared';
import type { RoomId, Snapshot, ViewTransform } from '@avlo/shared';
import { CanvasStage, type CanvasStageHandle, type ResizeInfo } from './CanvasStage';
import { userProfileManager } from '../lib/user-profile-manager';
import { useRoomDoc } from '../hooks/use-room-doc';
import { useViewTransform } from './ViewTransformContext';
import { RenderLoop } from '../renderer/RenderLoop';
import { OverlayRenderLoop } from '../renderer/OverlayRenderLoop';
import type { ViewportInfo } from '../renderer/types';
import {
  clearStrokeCache,
  drawPresenceOverlays,
  invalidateStrokeCacheByIds, // NEW: for cache eviction on geometry changes
} from '../renderer/layers';
import { DrawingTool } from '@/lib/tools/DrawingTool';
import { EraserTool } from '@/lib/tools/EraserTool';
import { TextTool } from '@/lib/tools/TextTool';
import { PanTool } from '@/lib/tools/PanTool';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import { calculateZoomTransform } from './internal/transforms';
import { ZoomAnimator } from './animation/ZoomAnimator';

// Unified interface for all pointer tools
type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;

// Epsilon equality for floating point comparison
function bboxEquals(a: number[], b: number[]): boolean {
  const eps = 1e-3;
  return (
    Math.abs(a[0] - b[0]) < eps &&
    Math.abs(a[1] - b[1]) < eps &&
    Math.abs(a[2] - b[2]) < eps &&
    Math.abs(a[3] - b[3]) < eps
  );
}

interface WorldBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Helper to check if styles are equal
function stylesEqual(
  a: { color: string; size: number; opacity: number },
  b: { color: string; size: number; opacity: number },
): boolean {
  return a.color === b.color && a.size === b.size && a.opacity === b.opacity;
}

// Helper to convert bbox array to WorldBounds
function bboxToBounds(b: [number, number, number, number]): WorldBounds {
  return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] };
}

// Result type for diff operation
type EvictId = string;
type DiffResult = {
  dirty: WorldBounds[];
  evictIds: EvictId[];
};

function diffBoundsAndEvicts(prev: Snapshot, next: Snapshot): DiffResult {
  const prevSt = new Map(prev.strokes.map((s) => [s.id, s]));
  const nextSt = new Map(next.strokes.map((s) => [s.id, s]));
  const dirty: WorldBounds[] = [];
  const evict = new Set<string>();

  // Added / modified strokes
  for (const [id, n] of nextSt) {
    const p = prevSt.get(id);
    if (!p) {
      // Added: repaint only (cache had no entry)
      dirty.push(bboxToBounds(n.bbox));
      continue;
    }

    const bboxChanged = !bboxEquals(p.bbox, n.bbox);
    const styleChanged = !stylesEqual(p.style, n.style);

    if (bboxChanged) {
      // Geometry changed → evict, and repaint old+new footprint
      evict.add(id);
      dirty.push(bboxToBounds(p.bbox));
      dirty.push(bboxToBounds(n.bbox));
    } else if (styleChanged) {
      // Style only → repaint, no eviction (cache handles variants)
      dirty.push(bboxToBounds(n.bbox));
    }
  }

  // Removed strokes
  for (const [id, p] of prevSt) {
    if (!nextSt.has(id)) {
      evict.add(id);
      dirty.push(bboxToBounds(p.bbox));
    }
  }

  // --- Text blocks ---
  const prevTxt = new Map(prev.texts.map((t) => [t.id, t]));
  const nextTxt = new Map(next.texts.map((t) => [t.id, t]));

  for (const [id, n] of nextTxt) {
    const p = prevTxt.get(id);
    const rectChanged = !p || p.x !== n.x || p.y !== n.y || p.w !== n.w || p.h !== n.h;
    const styleOrContentChanged =
      !!p && (p.color !== n.color || p.size !== n.size || p.content !== n.content);
    if (rectChanged || styleOrContentChanged) {
      dirty.push({ minX: n.x, minY: n.y, maxX: n.x + n.w, maxY: n.y + n.h });
      if (p && rectChanged)
        dirty.push({ minX: p.x, minY: p.y, maxX: p.x + p.w, maxY: p.y + p.h });
    }
  }
  for (const [id, p] of prevTxt) {
    if (!nextTxt.has(id)) {
      dirty.push({ minX: p.x, minY: p.y, maxX: p.x + p.w, maxY: p.y + p.h });
    }
  }

  return { dirty, evictIds: [...evict] };
}

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
 *
 * Phase 3.3: Now uses RenderLoop with event-driven architecture
 * Phase 3.4: Fixed DPR handling in coordinate transforms
 */
export const Canvas = React.forwardRef<CanvasHandle, CanvasProps>(({ roomId, className }, ref) => {
  // Replace single stageRef with two stages
  const baseStageRef = useRef<CanvasStageHandle>(null);
  const overlayStageRef = useRef<CanvasStageHandle>(null);
  const editorHostRef = useRef<HTMLDivElement>(null); // NEW: DOM overlay for text
  const roomDoc = useRoomDoc(roomId); // MUST be called at top level, not inside useEffect
  const { transform: viewTransform, setScale, setPan } = useViewTransform();
  const toolRef = useRef<PointerTool>();
  const lastMouseClientRef = useRef<{ x: number; y: number } | null>(null); // Track last mouse position for tool seeding
  const [_canvasSize, setCanvasSize] = useState<ResizeInfo | null>(null);
  const canvasSizeRef = useRef<ResizeInfo | null>(null); // For access in closures
  const renderLoopRef = useRef<RenderLoop | null>(null); // existing
  const overlayLoopRef = useRef<OverlayRenderLoop | null>(null); // new

  // Get toolbar state from Zustand store - MUST come before activeToolRef initialization
  // Phase 9: Updated to use new store structure
  const { activeTool, pen, highlighter, eraser, text, shape } = useDeviceUIStore();

  // Add setter and tool refs for stable callbacks (Step 1.1)
  const setScaleRef = useRef<(scale: number) => void>();
  const setPanRef = useRef<(pan: { x: number; y: number }) => void>();
  const activeToolRef = useRef<string>(activeTool); // Track current tool for stable cursor

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
  // We use the public subscription API (same as useRoomSnapshot hook) but store the result in a ref
  // instead of state to prevent React render storms at 60+ FPS. This maintains the architectural
  // boundary - we're still consuming immutable snapshots through the public API, just optimizing
  // how we store them to avoid unnecessary React work.
  const snapshotRef = useRef<Snapshot>(createEmptySnapshot()); // Initialize with empty snapshot
  const viewTransformRef = useRef<ViewTransform>(viewTransform); // Store latest transform

  // Keep view transform ref updated (no re-render)
  // Use useLayoutEffect to ensure ref is updated before drawing tool effect reads it
  // Step 1.3: Update refs in layout effect
  useLayoutEffect(() => {
    viewTransformRef.current = viewTransform;
    setScaleRef.current = setScale;
    setPanRef.current = setPan;
    activeToolRef.current = activeTool; // Keep tool ref in sync
  }, [viewTransform, setScale, setPan, activeTool]);

  // Subscribe to snapshots via public API (stores in ref to avoid re-renders)
  // 3C: Update snapshot subscription to check docVersion
  useEffect(() => {
    let lastDocVersion = -1;

    const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
      const prevSnapshot = snapshotRef.current;
      snapshotRef.current = newSnapshot;

      if (!renderLoopRef.current || !overlayLoopRef.current) return;

      // Check if scene changed (requires full clear on both)
      if (!prevSnapshot || prevSnapshot.scene !== newSnapshot.scene) {
        renderLoopRef.current.invalidateAll('scene-change');
        overlayLoopRef.current.invalidateAll();
        lastDocVersion = newSnapshot.docVersion;
        return;
      }

      // Check if document content changed (not just presence)
      // CRITICAL: docVersion increments on Y.Doc changes, NOT on presence changes
      if (newSnapshot.docVersion !== lastDocVersion) {
        console.log('Document content changed, docVersion:', newSnapshot.docVersion);
        lastDocVersion = newSnapshot.docVersion;

        // Hold preview for one frame to prevent flash on commit
        overlayLoopRef.current.holdPreviewForOneFrame();

        // Use bbox diffing for targeted invalidation with cache eviction
        const { dirty, evictIds } = diffBoundsAndEvicts(prevSnapshot, newSnapshot);

        // Evict geometry for ids whose geometry footprint changed or were removed
        if (evictIds.length) {
          invalidateStrokeCacheByIds(evictIds);
        }

        // Repaint everything that changed style or geometry, additions/removals, etc.
        // (DirtyRectTracker will coalesce or promote to full clear if appropriate.)
        for (const b of dirty) {
          renderLoopRef.current.invalidateWorld(b);
        }

        overlayLoopRef.current.invalidateAll(); // Also update overlay for new doc
      } else {
        // Presence-only change - update overlay only
        overlayLoopRef.current.invalidateAll();
      }
    });

    console.log('Subscribed to snapshots, lastDocVersion:', lastDocVersion);
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

  // Convert screen coordinates (DOM event) to world coordinates (Y.Doc space)
  // CRITICAL: This function is stable (no deps) to prevent effect re-runs
  // It reads viewTransform from ref to always use the latest transform
  const screenToWorld = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const canvas = baseStageRef.current?.getCanvasElement();
    const transform = viewTransformRef.current; // Always get latest transform
    if (!canvas || !transform) {
      return null; // Signal error to caller
    }

    const rect = canvas.getBoundingClientRect();
    // Screen → Canvas (CSS pixels)
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;

    // Canvas → World (using ViewTransform)
    return transform.canvasToWorld(canvasX, canvasY);
  }, []); // NO DEPENDENCIES - stable function that reads from refs

  // Convert world coordinates to client (CSS) coordinates
  // Used for positioning UI elements
  // Step 1.4: FIXED - No dependencies, reads from ref
  const worldToClient = useCallback((worldX: number, worldY: number): [number, number] => {
    const stage = baseStageRef.current;
    const vt = viewTransformRef.current; // Read latest from ref
    if (!stage || !vt) return [worldX, worldY];

    // World to canvas (returns CSS pixels)
    const [canvasX, canvasY] = vt.worldToCanvas(worldX, worldY);

    // Get canvas element position
    const rect = stage.getBounds();

    // Canvas to screen (both in CSS pixels) - NO DPR division
    return [canvasX + rect.left, canvasY + rect.top];
  }, []); // ✅ Empty deps = stable function

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
        canvas.style.cursor = 'none'; // Overlay draws ring
        break;
      case 'pan':
        canvas.style.cursor = 'grab'; // Open hand idle
        break;
      default:
        canvas.style.cursor = 'crosshair';
    }
  }, []); // ✅ Empty deps - reads from refs

  // 3G: Handle resize for both stages
  const handleBaseResize = useCallback((info: ResizeInfo) => {
    setCanvasSize(info);
    canvasSizeRef.current = info;
    renderLoopRef.current?.setResizeInfo({
      width: info.pixelWidth,
      height: info.pixelHeight,
      dpr: info.dpr,
    });
  }, []);

  const handleOverlayResize = useCallback((_info: ResizeInfo) => {
    // Overlay just needs to invalidate on resize
    overlayLoopRef.current?.invalidateAll();
  }, []);

  // CRITICAL FIX: Compute stageReady to ensure effect re-runs when stage becomes available
  // This prevents the initialization from silently failing if timing precondition is missed
  const stageReady = !!(renderLoopRef.current && baseStageRef.current?.getCanvasElement());

  // 3D: Initialize base render loop
  // Use useLayoutEffect to ensure render loop exists before drawing tool effect
  useLayoutEffect(() => {
    if (!baseStageRef.current) return;

    const renderLoop = new RenderLoop();
    renderLoopRef.current = renderLoop;
    console.log('Base render loop initialized');
    renderLoop.start({
      stageRef: baseStageRef,
      getView: () => viewTransformRef.current,
      getSnapshot: () => snapshotRef.current,
      getViewport: (): ViewportInfo => {
        // Use cached canvas size if available for better performance
        const cachedSize = canvasSizeRef.current;
        if (cachedSize && cachedSize.cssWidth > 0 && cachedSize.cssHeight > 0) {
          return {
            pixelWidth: cachedSize.pixelWidth,
            pixelHeight: cachedSize.pixelHeight,
            cssWidth: cachedSize.cssWidth,
            cssHeight: cachedSize.cssHeight,
            dpr: cachedSize.dpr,
          };
        }

        // Fallback to getBounds if canvasSize not yet set
        const bounds = baseStageRef.current?.getBounds();
        const dpr = window.devicePixelRatio || 1;

        if (!bounds || bounds.width === 0 || bounds.height === 0) {
          // Return minimal valid viewport for edge cases
          return {
            pixelWidth: 1,
            pixelHeight: 1,
            cssWidth: 1,
            cssHeight: 1,
            dpr,
          };
        }

        return {
          pixelWidth: Math.max(1, Math.round(bounds.width * dpr)),
          pixelHeight: Math.max(1, Math.round(bounds.height * dpr)),
          cssWidth: bounds.width,
          cssHeight: bounds.height,
          dpr,
        };
      },
      getGates: () => roomDoc.getGateStatus(), // Phase 7: Provide gate status for presence rendering
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
    //     // Safety check - renderLoop might have been destroyed if component unmounted quickly
        if (renderLoopRef.current === renderLoop) {
          renderLoop.invalidateAll('content-change');
        }
      }, 0);
    }

    return () => {
      if (initialRenderTimeout) {
        console.log('Clearing initial render timeout');
        clearTimeout(initialRenderTimeout);
      }
      renderLoop.stop();
      renderLoop.destroy();
      renderLoopRef.current = null;
      // Clear stroke render cache on unmount
      // This prevents memory leaks when switching rooms
      clearStrokeCache();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // NO DEPENDENCIES - stable render loop lifecycle, isMobile is a stable callback

  // 3E: Add overlay render loop initialization
  useLayoutEffect(() => {
    if (!overlayStageRef.current) return;

    const overlayLoop = new OverlayRenderLoop();
    overlayLoopRef.current = overlayLoop;

    overlayLoop.start({
      stage: overlayStageRef.current!,
      getView: () => viewTransformRef.current!,
      getViewport: () => {
        const cachedSize = canvasSizeRef.current;
        if (cachedSize && cachedSize.cssWidth > 0) {
          return {
            cssWidth: cachedSize.cssWidth,
            cssHeight: cachedSize.cssHeight,
            dpr: cachedSize.dpr,
          };
        }
        // Fallback
        const dpr = window.devicePixelRatio || 1;
        return { cssWidth: 1, cssHeight: 1, dpr };
      },
      getGates: () => roomDoc.getGateStatus(),
      getPresence: () => snapshotRef.current.presence, // Get from current snapshot
      getSnapshot: () => snapshotRef.current, // Added for eraser dimming
      drawPresence: (ctx, presence, view, vp) => {
        // Import drawPresenceOverlays from layers
        const viewport: ViewportInfo = {
          pixelWidth: Math.round(vp.cssWidth * vp.dpr),
          pixelHeight: Math.round(vp.cssHeight * vp.dpr),
          cssWidth: vp.cssWidth,
          cssHeight: vp.cssHeight,
          dpr: vp.dpr,
        };
        drawPresenceOverlays(
          ctx,
          snapshotRef.current, // Pass full snapshot (presence is already up-to-date)
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
  useEffect(() => {
    zoomAnimatorRef.current = new ZoomAnimator(
      () => viewTransformRef.current,
      (s) => setScaleRef.current?.(s),
      (p) => setPanRef.current?.(p),
    );

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
        textTool.updateConfig(text);
        return; // Skip recreation, just update config
      }
    }

    // Wait for all required dependencies
    const renderLoop = renderLoopRef.current;
    const canvas = baseStageRef.current?.getCanvasElement();
    const initialTransform = viewTransformRef.current; // Check initial availability

    // Guard: ensure all required components exist
    // This effect WILL re-run when stageReady changes (once)
    if (!renderLoop || !canvas || !roomDoc || !initialTransform) {
      // Only log in development mode
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.debug('DrawingTool waiting for dependencies:', {
          renderLoop: !!renderLoop,
          canvas: !!canvas,
          room: !!roomDoc,
          viewTransform: !!initialTransform,
        });
      }
      return; // Dependencies not ready yet, will retry when stageReady changes
    }

    // Mobile detection for view-only enforcement
    // CRITICAL FIX: Include maxTouchPoints check for iPadOS (reports as "Macintosh")
    const isMobile =
      /Android|webOS|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;

    // Create appropriate tool based on activeTool (branch ONCE here)
    let tool: PointerTool | null = null;

    if (activeTool === 'eraser') {
      // Pass deviceUI.eraser directly (no adapter needed)
      tool = new EraserTool(
        roomDoc,
        eraser, // Direct from store, no adapter
        userId,
        () => overlayLoopRef.current?.invalidateAll(),
        // Pass viewport callback for hit-test pruning
        () => {
          const size = canvasSizeRef.current;
          if (size) {
            return {
              cssWidth: size.cssWidth,
              cssHeight: size.cssHeight,
              dpr: size.dpr,
            };
          }
          return { cssWidth: 1, cssHeight: 1, dpr: 1 };
        },
        // Pass live view transform for accurate hit-testing
        () => viewTransformRef.current,
      );
    } else if (activeTool === 'pen' || activeTool === 'highlighter') {
      // Pass settings directly to DrawingTool (no adapter needed)
      const settings = activeTool === 'pen' ? pen : highlighter;

      tool = new DrawingTool(
        roomDoc,
        settings,
        activeTool,
        userId,
        (_bounds) => {
          // During drawing, invalidate overlay (preview is there)
          // The overlay will full-clear anyway, but this triggers a frame
          overlayLoopRef.current?.invalidateAll();
        },
        // requestOverlayFrame: tools call this after snap or any preview change
        () => overlayLoopRef.current?.invalidateAll(),
        // getView: needed only for hold-jitter in SCREEN px (pre-snap)
        () => viewTransformRef.current
      );
    } else if (activeTool === 'shape') {
      // Map shape variant to forced snap kind
      const variant = shape?.variant ?? 'rectangle';
      const forceSnapKind =
        variant === 'rectangle' ? 'rect' :
        variant === 'ellipse'   ? 'ellipseRect' :
        variant === 'arrow'     ? 'arrow' : 'line';

      // Use shape settings or fall back to pen settings
      const settings = shape?.settings ?? pen;

      tool = new DrawingTool(
        roomDoc,
        settings,
        'pen', // Shape tool uses pen mechanics
        userId,
        (_bounds) => overlayLoopRef.current?.invalidateAll(),
        () => overlayLoopRef.current?.invalidateAll(),
        () => viewTransformRef.current,
        { forceSnapKind } // Pass forced snap configuration
      );
    } else if (activeTool === 'text') {
      tool = new TextTool(
        roomDoc,
        text, // From Zustand store
        userId,
        {
          worldToClient,
          getView: () => viewTransformRef.current,
          getEditorHost: () => editorHostRef.current, // Pass DOM overlay ref
        },
        () => overlayLoopRef.current?.invalidateAll(),
      );
    } else if (activeTool === 'pan') {
      tool = new PanTool(
        () => viewTransformRef.current,
        (pan) => setPanRef.current?.(pan), // Value setter, not functional updater
        () => overlayLoopRef.current?.invalidateAll(),
        applyCursor,
        (cursor) => { cursorOverrideRef.current = cursor; }
      );
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
      const world = screenToWorld(x, y);
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
    // CRITICAL FIX: Ensure NO global CSS sets touch-action: none on canvas for mobile
    // Check your stylesheets - mobile MUST preserve touch-action: auto for scrolling
    // Note: Canvas CSS size should be set by CanvasStage
    // Physical size (width/height) = CSS size * DPR (handled by CanvasStage)

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
    pen,
    highlighter,
    eraser,
    text,
    shape,
    stageReady,
    screenToWorld,
    worldToClient, // Now stable with empty deps, safe to include
    applyCursor, // Stable function with empty deps
  ]); // Include all tool dependencies

  // Effect A: Stable event listeners (mount once) - Step 2.1
  useEffect(() => {
    const canvas = baseStageRef.current?.getCanvasElement();
    if (!canvas || !stageReady) return;

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

      const worldCoords = screenToWorld(e.clientX, e.clientY);
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
        const world = screenToWorld(e.clientX, e.clientY);
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
        const view = viewTransformRef.current;
        if (view && setPanRef.current) {
          const newPan = {
            x: view.pan.x - dx / view.scale,
            y: view.pan.y - dy / view.scale,
          };
          setPanRef.current(newPan);
        }

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
        const world = screenToWorld(e.clientX, e.clientY);
        if (world) {
          tool.move(world[0], world[1]);
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

      const world = screenToWorld(e.clientX, e.clientY);
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

      const canvas = baseStageRef.current?.getCanvasElement();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Normalize wheel delta
      let deltaY = e.deltaY;
      if (e.deltaMode === 1) deltaY *= 40;  // Lines
      else if (e.deltaMode === 2) deltaY *= 800; // Pages
      const steps = deltaY / 120;

      // Calculate zoom factor (~16% per step)
      const ZOOM_STEP = Math.log(1.2);
      const factor = Math.exp(-steps * ZOOM_STEP);

      // Read LATEST transform from ref
      const v = viewTransformRef.current;
      if (!v) return;

      // Use existing calculateZoomTransform utility
      const { scale: targetScale, pan: targetPan } = calculateZoomTransform(
        v.scale,
        v.pan,
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
  }, [stageReady, applyCursor, roomDoc, screenToWorld]); // Added stable deps to silence ESLint

  // 3F: Handle transform changes for both loops
  useEffect(() => {
    // Trigger a frame when transform changes
    // The DirtyRectTracker.notifyTransformChange() in tick() will detect the change
    // and automatically promote to full clear - we just need to trigger the frame
    renderLoopRef.current?.invalidateCanvas({ x: 0, y: 0, width: 1, height: 1 });
    overlayLoopRef.current?.invalidateAll(); // Overlay needs redraw on pan/zoom

    // NEW: Notify tool of view change for DOM repositioning
    if (toolRef.current && 'onViewChange' in toolRef.current) {
      (toolRef.current as any).onViewChange();
    }
  }, [viewTransform.scale, viewTransform.pan.x, viewTransform.pan.y]);

  // 3H: Update imperative handle for preview routing
  React.useImperativeHandle(
    ref,
    () => ({
      screenToWorld: (clientX: number, clientY: number): [number, number] => {
        const result = screenToWorld(clientX, clientY);
        return result || [clientX, clientY]; // Fallback for compatibility
      },
      worldToClient,
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
    [screenToWorld, worldToClient], // Both are now stable with empty deps
  );

  // 3J: Update JSX to render two canvases
  return (
    <div className="relative w-full h-full" style={{ backgroundColor: '#FFFFFF' }}>
      <CanvasStage
        ref={baseStageRef}
        className={className}
        style={{ position: 'absolute', inset: 0, zIndex: 1 }}
        onResize={handleBaseResize}
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
        onResize={handleOverlayResize}
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
