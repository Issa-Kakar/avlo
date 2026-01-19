import type { PreviewData } from '@/lib/tools/types';
import { drawStrokePreview } from './layers/stroke-preview';
import { drawPresenceOverlays } from './layers';
import { drawDimmedStrokes } from './layers/eraser-dim';
import { drawPerfectShapePreview } from './layers/perfect-shape-preview';
import { drawConnectorPreview } from './layers/connector-preview';
import { getObjectCacheInstance } from './object-cache';
import { useCameraStore, getViewTransform, getViewportInfo } from '@/stores/camera-store';
import { getOverlayContext } from '@/canvas/SurfaceManager';
import { getCurrentSnapshot, getCurrentPresence, getGateStatus } from '@/canvas/room-runtime';
import { getActivePreview } from '@/canvas/tool-registry';
import { useDeviceUIStore } from '@/stores/device-ui-store';
import {
  getAnimationController,
  destroyAnimationController,
  EraserTrailAnimation,
} from '@/canvas/animation';

export class OverlayRenderLoop {
  private started = false;
  private rafId: number | null = null;
  private needsFrame = false;
  private cachedPreview: PreviewData | null = null;
  private holdPreviewOneFrame = false;
  private cameraUnsubscribe: (() => void) | null = null;
  private toolUnsubscribe: (() => void) | null = null;

  /**
   * Start the overlay render loop.
   * All dependencies are read from module registries - no config needed.
   * Preview is self-managed via tool-registry's getActivePreview().
   */
  start(): void {
    this.started = true;

    // Register animation jobs
    const controller = getAnimationController();
    controller.register(new EraserTrailAnimation());

    // Subscribe to camera store for self-invalidation
    // Overlay is cheap to redraw, so invalidate on any camera change
    this.cameraUnsubscribe = useCameraStore.subscribe(
      (state) => ({
        scale: state.scale,
        panX: state.pan.x,
        panY: state.pan.y,
        cssWidth: state.cssWidth,
        cssHeight: state.cssHeight,
        dpr: state.dpr,
      }),
      () => {
        // Any camera change invalidates overlay (full clear is cheap)
        this.invalidateAll();
      },
      {
        equalityFn: (a, b) =>
          a.scale === b.scale &&
          a.panX === b.panX &&
          a.panY === b.panY &&
          a.cssWidth === b.cssWidth &&
          a.cssHeight === b.cssHeight &&
          a.dpr === b.dpr,
      }
    );

    // Subscribe to tool changes - clear cached preview when tool switches
    let lastTool = useDeviceUIStore.getState().activeTool;
    this.toolUnsubscribe = useDeviceUIStore.subscribe((state) => {
      if (state.activeTool !== lastTool) {
        lastTool = state.activeTool;
        // Tool changed - clear any cached preview and ensure redraw
        this.cachedPreview = null;
        this.holdPreviewOneFrame = false;
        this.invalidateAll();
      }
    });
  }

  stop(): void {
    // Cancel store subscriptions first
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;
    this.toolUnsubscribe?.();
    this.toolUnsubscribe = null;

    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.needsFrame = false;
    this.started = false;
  }

  invalidateAll() {
    if (!this.needsFrame) {
      this.needsFrame = true;
      this.schedule();
    }
  }

  holdPreviewForOneFrame(): void {
    if (getActivePreview()?.kind === 'eraser') return;
    this.holdPreviewOneFrame = true;
    this.invalidateAll(); // Ensure we draw a frame
  }

  private schedule(): void {
    if (this.rafId || !this.started) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.needsFrame = false;
      this.frame();
    });
  }

  private frame(): void {
    if (!this.started) return;

    // Get context from registry (replaces stage)
    const ctx = getOverlayContext();
    if (!ctx) return;

    // Get viewport from camera store (single source of truth)
    const vpInfo = getViewportInfo();
    const vp = { cssWidth: vpInfo.cssWidth, cssHeight: vpInfo.cssHeight, dpr: vpInfo.dpr };
    if (vp.cssWidth <= 1 || vp.cssHeight <= 1) return;

    // Tick all animations (decay trails, interpolate cursors, etc.)
    const now = performance.now();
    const animController = getAnimationController();
    animController.tick(now);

    // Always full clear overlay (cheap for preview + presence)
    // Inline clear: reset transform, clear device pixels
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, vp.cssWidth * vp.dpr, vp.cssHeight * vp.dpr);
    ctx.restore();

    // Get view transform from camera store
    const view = getViewTransform();

    // ---------- PASS 1: World-space preview (with world transform) ----------
    // Self-managed: read preview from tool registry instead of external provider
    const preview = getActivePreview();
    // Cache the latest preview if we have one
    if (preview && preview.kind !== 'eraser') {
      this.cachedPreview = preview;
    }
    // Draw preview if we have one OR if holding cached for one frame
    const usingCached =
    !preview && this.holdPreviewOneFrame && this.cachedPreview;
    const previewToDraw = preview || (usingCached && this.cachedPreview) || null;

    if (previewToDraw) {
      ctx.save();
      // Check preview kind using discriminant
      if (previewToDraw?.kind === 'stroke') {
          // Existing stroke preview (world space)
          // Explicit world transform: DPR × scale × translate combined
          ctx.setTransform(
            vp.dpr * view.scale, 0,
            0, vp.dpr * view.scale,
            -view.pan.x * vp.dpr * view.scale,
            -view.pan.y * vp.dpr * view.scale
          );
          drawStrokePreview(ctx, previewToDraw);

        } else if (previewToDraw?.kind === 'eraser') {
          // Eraser preview: only draw dimmed strokes
          // Trail is now handled by AnimationController
          const snapshot = getCurrentSnapshot();

          // World-space dimming for objects under eraser
          if (previewToDraw.hitIds.length > 0) {
            ctx.setTransform(
              vp.dpr * view.scale, 0,
              0, vp.dpr * view.scale,
              -view.pan.x * vp.dpr * view.scale,
              -view.pan.y * vp.dpr * view.scale
            );
            drawDimmedStrokes(ctx, previewToDraw.hitIds, snapshot, previewToDraw.dimOpacity);
          }

        } else if (previewToDraw?.kind === 'text') {
          // Text preview (world space)
          // Explicit world transform: DPR × scale × translate combined
          ctx.setTransform(
            vp.dpr * view.scale, 0,
            0, vp.dpr * view.scale,
            -view.pan.x * vp.dpr * view.scale,
            -view.pan.y * vp.dpr * view.scale
          );

          // Draw placement box with dashed outline
          ctx.strokeStyle = previewToDraw.isPlacing
            ? 'rgba(59, 130, 246, 0.5)'
            : 'rgba(0, 0, 0, 0.3)';
          ctx.lineWidth = 2 / view.scale; // Keep consistent visual thickness
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(
            previewToDraw.box.x,
            previewToDraw.box.y,
            previewToDraw.box.w,
            previewToDraw.box.h,
          );

          // Optional: Draw placement crosshair
          if (previewToDraw.isPlacing) {
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.3)';
            ctx.lineWidth = 1 / view.scale;
            ctx.setLineDash([]);
            // Vertical line
            ctx.beginPath();
            ctx.moveTo(previewToDraw.box.x, previewToDraw.box.y - 5);
            ctx.lineTo(previewToDraw.box.x, previewToDraw.box.y + 5);
            ctx.stroke();
            // Horizontal line
            ctx.beginPath();
            ctx.moveTo(previewToDraw.box.x - 5, previewToDraw.box.y);
            ctx.lineTo(previewToDraw.box.x + 5, previewToDraw.box.y);
            ctx.stroke();
          }
        } else if (previewToDraw?.kind === 'perfectShape') {
          // Perfect shape preview (world space)
          // Explicit world transform: DPR × scale × translate combined
          ctx.setTransform(
            vp.dpr * view.scale, 0,
            0, vp.dpr * view.scale,
            -view.pan.x * vp.dpr * view.scale,
            -view.pan.y * vp.dpr * view.scale
          );
          drawPerfectShapePreview(ctx, previewToDraw);

        } else if (previewToDraw?.kind === 'selection') {
          // Selection preview (world space for bounds, screen space for handle sizing)
          // Save for lineDash state management (restore happens at end of selection block)
          ctx.save();
          // Explicit world transform: DPR × scale × translate combined
          ctx.setTransform(
            vp.dpr * view.scale, 0,
            0, vp.dpr * view.scale,
            -view.pan.x * vp.dpr * view.scale,
            -view.pan.y * vp.dpr * view.scale
          );

          // === SELECTION HIGHLIGHTING (only when not transforming) ===
          if (!previewToDraw.isTransforming && previewToDraw.selectedIds?.length > 0) {
            const snapshot = getCurrentSnapshot();
            const cache = getObjectCacheInstance();

            ctx.strokeStyle = 'rgba(59, 130, 246, 1)';  // Blue
            ctx.lineWidth = 2 / view.scale;  // 2px visual regardless of zoom
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';

            for (const id of previewToDraw.selectedIds) {
              const handle = snapshot.objectsById.get(id);
              if (!handle) continue;

              // Text: stroke the frame rect
              if (handle.kind === 'text') {
                const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
                if (frame) {
                  const [x, y, w, h] = frame;
                  ctx.strokeRect(x, y, w, h);
                }
                continue;
              }

              // Strokes/Connectors: use bbox rectangle (avoids PF "ball" end cap artifact)
              if (handle.kind === 'stroke' || handle.kind === 'connector') {
                const [minX, minY, maxX, maxY] = handle.bbox;
                ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
                continue;
              }

              // Shapes: stroke the cached Path2D (follows actual geometry)
              const path = cache.getPath(id, handle);
              ctx.stroke(path);
            }
          }

          // Draw marquee rect if active (dashed, light blue fill)
          if (previewToDraw.marqueeRect) {
            const { minX, minY, maxX, maxY } = previewToDraw.marqueeRect;
            ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
            ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
            ctx.lineWidth = 1 / view.scale;
            ctx.setLineDash([4 / view.scale, 4 / view.scale]);
            ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
            ctx.setLineDash([]);
          }

          // Draw selection bounds and handles (skip during active transform)
          if (previewToDraw.selectionBounds && !previewToDraw.isTransforming) {
            const { minX, minY, maxX, maxY } = previewToDraw.selectionBounds;

            // Selection box stroke
            ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
            ctx.lineWidth = 1.5 / view.scale;
            ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

            // Corner handles (8px screen size, scaled to world)
            if (previewToDraw.handles) {
              const handleSize = 8 / view.scale;
              ctx.fillStyle = 'white';
              ctx.strokeStyle = 'rgba(59, 130, 246, 1)';
              ctx.lineWidth = 1.5 / view.scale;

              for (const h of previewToDraw.handles) {
                ctx.fillRect(
                  h.x - handleSize / 2,
                  h.y - handleSize / 2,
                  handleSize,
                  handleSize
                );
                ctx.strokeRect(
                  h.x - handleSize / 2,
                  h.y - handleSize / 2,
                  handleSize,
                  handleSize
                );
              }
            }
          }

          ctx.restore();
        } else if (previewToDraw?.kind === 'connector') {
          // Connector preview (world space)
          // Explicit world transform: DPR × scale × translate combined
          ctx.setTransform(
            vp.dpr * view.scale, 0,
            0, vp.dpr * view.scale,
            -view.pan.x * vp.dpr * view.scale,
            -view.pan.y * vp.dpr * view.scale
          );
          drawConnectorPreview(ctx, previewToDraw, view.scale);
        }
      ctx.restore();

      // Clear the hold flag and cache after drawing the held frame
      if (this.holdPreviewOneFrame && !preview) {
        this.holdPreviewOneFrame = false;
        this.cachedPreview = null;
      }
    }

    // ---------- PASS 2: Screen-space presence (DPR only) ----------
    const gates = getGateStatus();
    if (gates.awarenessReady && gates.firstSnapshot) {
      const presence = getCurrentPresence();
      ctx.save();
      // Explicit DPR-only transform for screen-space presence
      ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
      drawPresenceOverlays(ctx, presence, view, {
        pixelWidth: Math.round(vp.cssWidth * vp.dpr),
        pixelHeight: Math.round(vp.cssHeight * vp.dpr),
        cssWidth: vp.cssWidth,
        cssHeight: vp.cssHeight,
        dpr: vp.dpr,
      }, gates);
      ctx.restore();
    }

    // ---------- PASS 3: Screen-space animations (eraser trail, etc.) ----------
    ctx.save();
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    animController.render(ctx, vpInfo, view);
    ctx.restore();

    // Continue animation loop if any animations are active
    if (animController.hasActiveAnimations()) {
      this.invalidateAll();
    }
  }

  destroy() {
    // Ensure subscriptions are cleaned up
    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;
    this.toolUnsubscribe?.();
    this.toolUnsubscribe = null;

    // Destroy animation controller
    destroyAnimationController();

    this.stop();
  }
}