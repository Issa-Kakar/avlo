import { DevicePixelRect, WorldBounds, InvalidationReason, DIRTY_RECT_CONFIG } from './types';
import type { ViewTransform } from '@avlo/shared';

export class DirtyRectTracker {
  private rects: DevicePixelRect[] = [];
  private fullClearRequired = false;
  // Initialize with identity transform to avoid unnecessary full clear on first update
  private lastTransform: { scale: number; pan: { x: number; y: number } } = {
    scale: 1,
    pan: { x: 0, y: 0 },
  };
  private canvasSize = { width: 0, height: 0 }; // Device pixels
  private dpr = 1; // Store DPR for conversions

  constructor() {}

  // Set canvas dimensions for area ratio calculations (device pixels)
  setCanvasSize(width: number, height: number, dpr = 1): void {
    this.canvasSize = { width, height };
    this.dpr = dpr;
  }

  // Notify of transform change - forces full clear only if actually changed
  notifyTransformChange(newTransform: { scale: number; pan: { x: number; y: number } }): void {
    if (
      this.lastTransform.scale !== newTransform.scale ||
      this.lastTransform.pan.x !== newTransform.pan.x ||
      this.lastTransform.pan.y !== newTransform.pan.y
    ) {
      this.fullClearRequired = true;
      this.rects = [];
      this.lastTransform = { ...newTransform, pan: { ...newTransform.pan } };
    }
  }

  // Add world-space invalidation
  invalidateWorldBounds(bounds: WorldBounds, viewTransform: ViewTransform): void {
    // Guard against invalid scale
    if (!viewTransform.scale || viewTransform.scale <= 0) {
      // If scale is invalid, force full clear as a safety measure
      this.invalidateAll('transform-change');
      return;
    }

    // Use canonical transform helper for consistency
    // CRITICAL: worldToCanvas returns CSS pixels, NOT device pixels
    // Transform: (world - pan) * scale = CSS pixels
    const [minCanvasX, minCanvasY] = viewTransform.worldToCanvas(bounds.minX, bounds.minY);
    const [maxCanvasX, maxCanvasY] = viewTransform.worldToCanvas(bounds.maxX, bounds.maxY);

    // Pass CSS pixel rect to invalidateCanvasPixels (which converts to device pixels internally)
    this.invalidateCanvasPixels(
      {
        x: minCanvasX,
        y: minCanvasY,
        width: maxCanvasX - minCanvasX,
        height: maxCanvasY - minCanvasY,
      },
      viewTransform.scale,
      this.dpr,
    );
  }

  // Add CSS-pixel invalidation (takes CSS pixels, converts to device pixels internally)
  invalidateCanvasPixels(
    rect: { x: number; y: number; width: number; height: number },
    scale = 1,
    dpr = 1,
  ): void {
    if (this.fullClearRequired) return; // Already clearing everything

    // Validate input rect to prevent NaN/Infinity issues
    if (!isFinite(rect.x) || !isFinite(rect.y) || !isFinite(rect.width) || !isFinite(rect.height)) {
      // Invalid rect - force full clear as safety measure
      this.invalidateAll('dirty-overflow');
      return;
    }

    // Clamp negative dimensions to 0
    const safeRect = {
      x: rect.x,
      y: rect.y,
      width: Math.max(0, rect.width),
      height: Math.max(0, rect.height),
    };

    // Skip empty rectangles
    if (safeRect.width === 0 || safeRect.height === 0) {
      return;
    }

    // Convert CSS pixels to device pixels for clearing
    const deviceRect = {
      x: safeRect.x * dpr,
      y: safeRect.y * dpr,
      width: safeRect.width * dpr,
      height: safeRect.height * dpr,
    };

    // Scale-aware stroke margin in device pixels: worst-case is maxLineWidth * scale * dpr
    const strokeMargin = DIRTY_RECT_CONFIG.MAX_WORLD_LINE_WIDTH * scale * dpr;
    const totalMargin = DIRTY_RECT_CONFIG.AA_MARGIN + strokeMargin;

    // Apply margins for AA and stroke expansion (in device pixels)
    const inflated = {
      x: Math.floor(deviceRect.x - totalMargin),
      y: Math.floor(deviceRect.y - totalMargin),
      width: Math.ceil(deviceRect.width + 2 * totalMargin),
      height: Math.ceil(deviceRect.height + 2 * totalMargin),
    };

    // Clamp to canvas bounds to prevent overflow
    if (this.canvasSize.width > 0 && this.canvasSize.height > 0) {
      // If completely outside canvas, might still need to clear (for transforms)
      // But limit the rect size to reasonable bounds
      inflated.x = Math.max(
        -this.canvasSize.width,
        Math.min(inflated.x, this.canvasSize.width * 2),
      );
      inflated.y = Math.max(
        -this.canvasSize.height,
        Math.min(inflated.y, this.canvasSize.height * 2),
      );
      inflated.width = Math.min(inflated.width, this.canvasSize.width * 3);
      inflated.height = Math.min(inflated.height, this.canvasSize.height * 3);
    }

    // Snap to grid for better coalescing
    inflated.x =
      Math.floor(inflated.x / DIRTY_RECT_CONFIG.COALESCE_SNAP) * DIRTY_RECT_CONFIG.COALESCE_SNAP;
    inflated.y =
      Math.floor(inflated.y / DIRTY_RECT_CONFIG.COALESCE_SNAP) * DIRTY_RECT_CONFIG.COALESCE_SNAP;

    this.rects.push(inflated);
    this.checkPromotion();
  }

  // Force full clear
  invalidateAll(_reason: InvalidationReason): void {
    this.fullClearRequired = true;
    this.rects = [];
  }

  // Check if we should promote to full clear
  private checkPromotion(): void {
    if (this.rects.length > DIRTY_RECT_CONFIG.MAX_RECT_COUNT) {
      this.fullClearRequired = true;
      this.rects = [];
      return;
    }

    // Calculate union area ratio
    const union = this.calculateUnion();
    if (union) {
      const unionArea = union.width * union.height;
      const canvasArea = this.canvasSize.width * this.canvasSize.height;
      if (canvasArea > 0 && unionArea / canvasArea > DIRTY_RECT_CONFIG.MAX_AREA_RATIO) {
        this.fullClearRequired = true;
        this.rects = [];
      }
    }
  }

  // Calculate union of all rects
  private calculateUnion(): DevicePixelRect | null {
    if (this.rects.length === 0) return null;

    let minX = Infinity,
      minY = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity;

    for (const rect of this.rects) {
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  // Coalesce overlapping/adjacent rectangles
  coalesce(): void {
    if (this.fullClearRequired || this.rects.length <= 1) return;

    // Simple coalescing: merge overlapping rects
    const merged: DevicePixelRect[] = [];
    const used = new Set<number>();

    for (let i = 0; i < this.rects.length; i++) {
      if (used.has(i)) continue;

      let current = { ...this.rects[i] };
      used.add(i);

      // Try to merge with other rects
      let didMerge = true;
      while (didMerge) {
        didMerge = false;
        for (let j = 0; j < this.rects.length; j++) {
          if (used.has(j)) continue;

          const other = this.rects[j];
          if (this.rectsOverlap(current, other)) {
            // Merge
            const minX = Math.min(current.x, other.x);
            const minY = Math.min(current.y, other.y);
            const maxX = Math.max(current.x + current.width, other.x + other.width);
            const maxY = Math.max(current.y + current.height, other.y + other.height);

            current = {
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
            };

            used.add(j);
            didMerge = true;
          }
        }
      }

      merged.push(current);
    }

    this.rects = merged;
    this.checkPromotion();
  }

  // Check if two rectangles overlap or are adjacent
  private rectsOverlap(a: DevicePixelRect, b: DevicePixelRect): boolean {
    const margin = DIRTY_RECT_CONFIG.COALESCE_SNAP; // Allow adjacent rects to merge
    return !(
      a.x > b.x + b.width + margin ||
      b.x > a.x + a.width + margin ||
      a.y > b.y + b.height + margin ||
      b.y > a.y + a.height + margin
    );
  }

  // Get clear instructions
  getClearInstructions(): { type: 'full' | 'dirty' | 'none'; rects?: DevicePixelRect[] } {
    if (this.fullClearRequired) {
      return { type: 'full' };
    }

    if (this.rects.length === 0) {
      return { type: 'none' };
    }

    return { type: 'dirty', rects: [...this.rects] };
  }

  // Reset after frame
  reset(): void {
    this.rects = [];
    this.fullClearRequired = false;
  }
}
