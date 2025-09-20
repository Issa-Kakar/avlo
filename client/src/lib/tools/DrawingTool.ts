import { ulid } from 'ulid';
import * as Y from 'yjs';
import type { IRoomDocManager } from '../room-doc-manager';
import { STROKE_CONFIG, ROOM_CONFIG } from '@avlo/shared';
import { simplifyStroke, calculateBBox, estimateEncodedSize } from './simplification';
import type { DrawingState, PreviewData, DeviceUIState } from './types';

// These constants are imported from @avlo/shared config
// See Step 7 for the values to add to /packages/shared/src/config.ts

export class DrawingTool {
  private state!: DrawingState; // Will be initialized in resetState called from constructor
  private room: IRoomDocManager; // Use interface, not implementation
  private deviceUI: DeviceUIState;
  private userId: string; // Stable user ID for all strokes from this tool instance

  // RAF coalescing
  private rafId: number | null = null;
  private pendingPoint: [number, number] | null = null;
  private lastBounds: [number, number, number, number] | null = null;

  // Callbacks
  private onInvalidate?: (bounds: [number, number, number, number]) => void;

  constructor(
    room: IRoomDocManager, // Use interface for loose coupling
    deviceUI: DeviceUIState,
    userId: string, // Pass stable ID, not a getter function
    onInvalidate?: (bounds: [number, number, number, number]) => void,
  ) {
    this.room = room;
    this.deviceUI = deviceUI;
    this.userId = userId; // Store the stable ID
    this.onInvalidate = onInvalidate;
    this.resetState();
  }

  private resetState(): void {
    this.state = {
      isDrawing: false,
      pointerId: null,
      points: [],
      config: {
        tool: 'pen',
        color: '#000000',
        size: 4,
        opacity: 1,
      },
      startTime: 0,
    };
    this.lastBounds = null;
  }

  canStartDrawing(): boolean {
    const tool = this.deviceUI.tool;
    return !this.state.isDrawing && (tool === 'pen' || tool === 'highlighter');
  }

  // PointerTool interface methods for polymorphic handling with EraserTool
  canBegin(): boolean {
    return this.canStartDrawing();
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    this.startDrawing(pointerId, worldX, worldY);
  }

  move(worldX: number, worldY: number): void {
    this.addPoint(worldX, worldY);
  }

  end(worldX?: number, worldY?: number): void {
    if (worldX !== undefined && worldY !== undefined) {
      this.commitStroke(worldX, worldY);
    } else {
      // Fallback to last point if no final coords provided
      const len = this.state.points.length;
      if (len >= 2) {
        this.commitStroke(this.state.points[len - 2], this.state.points[len - 1]);
      } else {
        this.cancelDrawing();
      }
    }
  }

  cancel(): void {
    this.cancelDrawing();
  }

  isActive(): boolean {
    return this.isDrawing();
  }

  startDrawing(pointerId: number, worldX: number, worldY: number): void {
    if (this.state.isDrawing) return;

    // Freeze tool settings at gesture start (CRITICAL)
    this.state = {
      isDrawing: true,
      pointerId,
      points: [worldX, worldY],
      config: {
        tool: this.deviceUI.tool,
        color: this.deviceUI.color,
        size: this.deviceUI.size,
        opacity:
          this.deviceUI.tool === 'highlighter'
            ? STROKE_CONFIG.HIGHLIGHTER_DEFAULT_OPACITY
            : this.deviceUI.opacity,
      },
      startTime: Date.now(),
    };
  }

  addPoint(worldX: number, worldY: number): void {
    if (!this.state.isDrawing) return;

    // Coalesce to RAF
    this.pendingPoint = [worldX, worldY];

    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        // Double-check state in case tool was destroyed during RAF
        if (this.pendingPoint && this.state.isDrawing) {
          this.state.points.push(...this.pendingPoint);
          this.updateBounds();
        }
        this.pendingPoint = null;
        this.rafId = null;
      });
    }
  }

  private flushPending(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.pendingPoint && this.state.isDrawing) {
      this.state.points.push(...this.pendingPoint);
      this.pendingPoint = null;
    }
  }

  private updateBounds(): void {
    // Calculate bounds WITH stroke width inflation
    const bounds = calculateBBox(this.state.points, this.state.config.size);

    // Invalidate old region first (if exists)
    if (this.lastBounds) {
      this.onInvalidate?.(this.lastBounds);
    }

    // Then invalidate new region
    // CRITICAL: RenderLoop MUST internally union all invalidated regions
    // within a single frame to avoid redundant redraws
    // This is a Phase 3 RenderLoop responsibility, not DrawingTool's
    // DrawingTool can call invalidate multiple times; RenderLoop handles deduplication
    if (bounds) {
      this.onInvalidate?.(bounds);
      this.lastBounds = bounds;
    }
  }

  getPreview(): PreviewData | null {
    if (!this.state.isDrawing || this.state.points.length < 2) {
      return null;
    }

    return {
      kind: 'stroke',  // Add discriminant for union type
      points: this.state.points,
      tool: this.state.config.tool,
      color: this.state.config.color,
      size: this.state.config.size,
      opacity: this.state.config.tool === 'pen'
        ? STROKE_CONFIG.CURSOR_PREVIEW_OPACITY        // 0.35 for pen preview
        : STROKE_CONFIG.HIGHLIGHTER_PREVIEW_OPACITY,  // 0.15 for highlighter preview (lighter to prevent flicker)
      bbox: this.lastBounds,
    };
  }

  isDrawing(): boolean {
    return this.state.isDrawing;
  }

  getPointerId(): number | null {
    return this.state.pointerId;
  }

  cancelDrawing(): void {
    this.flushPending();
    if (this.lastBounds) {
      this.onInvalidate?.(this.lastBounds);
    }
    this.resetState();
  }

  commitStroke(finalX: number, finalY: number): void {
    if (!this.state.isDrawing) return;

    // CRITICAL: Flush RAF before commit
    this.flushPending();

    // Add final point if different
    const len = this.state.points.length;
    if (len < 2 || this.state.points[len - 2] !== finalX || this.state.points[len - 1] !== finalY) {
      this.state.points.push(finalX, finalY);
    }

    // Validate minimum points
    if (this.state.points.length < 4) {
      this.cancelDrawing();
      return;
    }

    // Store preview bounds before simplification
    const previewBounds = this.lastBounds;

    // Simplify FIRST, then check size
    const { points: simplified } = simplifyStroke(this.state.points, this.state.config.tool);

    // Check if simplification rejected the stroke (empty points means exceeded 128KB budget)
    if (simplified.length === 0) {
      // TODO: Show user toast about stroke being too complex
      this.cancelDrawing();
      return;
    }

    // Check frame size AFTER simplification (2MB transport limit)
    const estimatedSize = estimateEncodedSize(simplified);
    if (estimatedSize > ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES) {
      console.error(
        `Stroke too large for transport: ${estimatedSize} bytes (max: ${ROOM_CONFIG.MAX_INBOUND_FRAME_BYTES})`,
      );
      // TODO: Show user toast about stroke being too complex
      this.cancelDrawing();
      return;
    }

    // Calculate final bbox for the simplified stroke
    const simplifiedBbox = calculateBBox(simplified, this.state.config.size);

    // Commit to Y.Doc
    const strokeId = ulid();
    const userId = this.userId; // Use stable ID stored at construction

    try {
      this.room.mutate((ydoc) => {
        const root = ydoc.getMap('root');
        const strokes = root.get('strokes') as Y.Array<any>;
        const meta = root.get('meta') as Y.Map<any>;

        // Get scene_ticks (MUST be initialized by RoomDocManager in Phase 2)
        const sceneTicks = meta.get('scene_ticks') as Y.Array<number>;
        if (!sceneTicks) {
          // This is a CRITICAL error - scene_ticks MUST be initialized in Phase 2
          console.error('CRITICAL: scene_ticks not initialized - Phase 2 implementation is broken');
          // TODO: Show user toast/banner about room metadata not initialized
          // Surface this error visibly so it's not silent
          return;
        }

        // Scene assigned AT COMMIT TIME
        const currentScene = sceneTicks.length;

        strokes.push([
          {
            id: strokeId,
            tool: this.state.config.tool, // Frozen at start
            color: this.state.config.color, // Frozen at start
            size: this.state.config.size, // Frozen at start
            opacity: this.state.config.opacity, // Frozen at start
            points: simplified, // Plain number[]
            bbox: simplifiedBbox,
            scene: currentScene,
            createdAt: Date.now(),
            userId,
          },
        ]);
      });
    } catch (err) {
      console.error('Failed to commit stroke:', err);
    } finally {
      // CRITICAL: Invalidate BOTH preview bounds AND simplified stroke bounds
      // The preview bounds clear the preview rendering
      // The simplified bounds ensure the new stroke area is redrawn
      if (previewBounds) {
        this.onInvalidate?.(previewBounds);
      }
      if (simplifiedBbox) {
        this.onInvalidate?.(simplifiedBbox);
      }
      this.resetState();
    }
  }

  destroy(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null; // Ensure idempotent
    }
    this.resetState();
  }
}
