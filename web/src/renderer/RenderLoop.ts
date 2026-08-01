import { manageImageViewport } from '@/core/image/image-manager';
import { getBBoxColumn } from '@/core/slots/slot-table';
import type { BBoxTuple, WorldBounds } from '@/core/types/geometry';
import { applyPendingResize, getBaseContext } from '@/runtime/SurfaceManager';
import { isMobile, subscribeCamera, useCameraStore } from '@/stores/camera-store';
import { drawObjects } from './layers/objects';
import { FRAME_CONFIG } from './types';

const NATIVE_RAF = true; // true = vsync (no throttle), false = 60fps cap

// Dirty-rect / tile-grid constants
const MAX_RECTS = 256; // dirtyBuf / clipWorldBuf capacity (extraction output, with headroom)
const AA_MARGIN = 2; // device pixels
const AREA_RATIO = 0.85; // popcount promotion → fullClear
const TILE_SHIFT = 3; // 8 device-px tiles (px >> TILE_SHIFT); profile 2 (4px) / 3 (8px) / 4 (16px)
const TILE_SIZE = 1 << TILE_SHIFT;
const CLIP_CAP = 32; // K: emit ≤ K rects; beyond this, collapse to the active bbox
const DEBUG_DIRTY = false; // instrumentation (overdraw ratio / rect count / extract ms) → window.__dirtyStats

export class RenderLoop {
  private started = false;
  private cameraUnsubscribe: (() => void) | null = null;

  // Emitted dirty rects (device px), filled by extraction each frame — zero allocation.
  private readonly dirtyBuf = new Float64Array(MAX_RECTS * 4); // [minX,minY,maxX,maxY,...]
  // World-space clip rects, filled from dirtyBuf each frame — zero allocation.
  private readonly clipWorldBuf = new Float64Array(MAX_RECTS * 4);
  private dirtyCount = 0;
  private fullClear = false;
  private canvasW = 0;
  private canvasH = 0;

  // === Tile-grid dirty tracking (device screen-space; replaces coalesce) ===
  // Power-of-two tiles anchored at (0,0). Insert = word-parallel OR splat (idempotent —
  // overlap elimination is free, no coalesce). Per frame: popcount promotion + RLE run-merge
  // extraction → a handful of rects. Cost is a function of tile resolution, not the damage
  // pattern, so the worst case is bounded (no O(n²)/O(n³) tail).
  private grid = new Uint32Array(0); // row-major occupancy bitset, wordsPerRow words/row
  private gridCols = 0;
  private gridRows = 0;
  private wordsPerRow = 0;
  private gridSizedW = -1; // device dims the grid is currently sized for
  private gridSizedH = -1;
  private hasGridDamage = false;
  // Active dirty sub-rect in TILE coords (inclusive). Empty when maxTX < minTX.
  private minTX = 0;
  private minTY = 0;
  private maxTX = -1;
  private maxTY = -1;
  // Extraction run scratch (sized in resizeGrid): [x0,x1,y0] triples per row, double-buffered.
  private runsA = new Int32Array(0);
  private runsB = new Int32Array(0);
  // Cached camera for the current accumulation window. A camera change forces fullClear, so
  // these stay constant within a window — invalidate* read them instead of the store.
  private camScale = 1;
  private camPanX = 0;
  private camPanY = 0;
  private camDpr = 1;
  private dbgTrueArea = 0; // DEBUG_DIRTY: Σ true device bbox area this window

  // Independent resize detection (not reliant on applyPendingResize return value)
  private lastCanvasW = 0;
  private lastCanvasH = 0;

  // Scheduling
  private rafId: number | null = null;
  private needsFrame = false;
  private urgent = false;
  private lastFrameTime = 0;
  private throttleTimeout: ReturnType<typeof setTimeout> | null = null;
  private nativeRafUntil = 0; // Bypass 60fps throttle until this timestamp (post-resize font warmup)

  // Visibility
  private isHidden = false;
  private hiddenIntervalId: number | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastFrameTime = performance.now();

    // Visibility listener
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    // Initialize canvas dimensions + camera cache + tile grid
    const { scale, pan, cssWidth, cssHeight, dpr } = useCameraStore.getState();
    this.canvasW = Math.round(cssWidth * dpr);
    this.canvasH = Math.round(cssHeight * dpr);
    this.lastCanvasW = this.canvasW;
    this.lastCanvasH = this.canvasH;
    this.camScale = scale;
    this.camPanX = pan.x;
    this.camPanY = pan.y;
    this.camDpr = dpr;
    this.ensureGrid(this.canvasW, this.canvasH);

    // Any camera change → full clear + schedule frame
    this.cameraUnsubscribe = subscribeCamera((s) => {
      this.canvasW = Math.round(s.cssWidth * s.dpr);
      this.canvasH = Math.round(s.cssHeight * s.dpr);
      this.fullClear = true;
      this.dirtyCount = 0;
      this.markDirty();
    });

    if (document.hidden) this.startHiddenLoop();
  }

  stop(): void {
    // Remove visibility listener
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.cameraUnsubscribe?.();
    this.cameraUnsubscribe = null;

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.hiddenIntervalId !== null) {
      clearInterval(this.hiddenIntervalId);
      this.hiddenIntervalId = null;
    }
    if (this.throttleTimeout !== null) {
      clearTimeout(this.throttleTimeout);
      this.throttleTimeout = null;
    }

    this.started = false;
    this.dirtyCount = 0;
    this.fullClear = false;
    this.needsFrame = false;
    this.urgent = false;
    this.lastFrameTime = 0;
    this.nativeRafUntil = 0;
    this.lastCanvasW = 0;
    this.lastCanvasH = 0;
    this.hasGridDamage = false;
    this.gridSizedW = -1;
    this.gridSizedH = -1;
    this.resetActiveRect();
  }

  // =============================================
  // PUBLIC API
  // =============================================

  /** Add a world-space dirty rect. BBox must already include stroke width. */
  invalidateWorld(bounds: WorldBounds): void {
    if (!this.started || this.fullClear) return;
    const s = this.camScale * this.camDpr;
    this.mark(
      Math.floor((bounds.minX - this.camPanX) * s - AA_MARGIN),
      Math.floor((bounds.minY - this.camPanY) * s - AA_MARGIN),
      Math.ceil((bounds.maxX - this.camPanX) * s + AA_MARGIN),
      Math.ceil((bounds.maxY - this.camPanY) * s + AA_MARGIN),
    );
    this.markDirty();
  }

  /** Add a world-space dirty rect from BBoxTuple. Avoids WorldBounds allocation. */
  invalidateWorldBBox(bbox: BBoxTuple): void {
    if (!this.started || this.fullClear) return;
    const s = this.camScale * this.camDpr;
    this.mark(
      Math.floor((bbox[0] - this.camPanX) * s - AA_MARGIN),
      Math.floor((bbox[1] - this.camPanY) * s - AA_MARGIN),
      Math.ceil((bbox[2] - this.camPanX) * s + AA_MARGIN),
      Math.ceil((bbox[3] - this.camPanY) * s + AA_MARGIN),
    );
    this.markDirty();
  }

  /**
   * Add a world-space dirty rect straight off the global slot bbox column
   * (`slot * 4` lane — live slots only). Smi arg, column read inside — the
   * prepare-for-typed-array-geometry seam. Unlike invalidateWorld{,BBox},
   * markDirty is GATED on mark()'s damage flag: the old RDM path was culled
   * by invalidateIfVisible, but this one publishes every touched slot, and an
   * ungated markDirty schedules a rAF whose tick runs manageImageViewport
   * before the nothing-to-do early-out — a peer editing offscreen objects
   * would drive an idle client at ~60Hz busy-work.
   */
  invalidateWorldSlot(slot: number): void {
    if (!this.started || this.fullClear) return;
    const col = getBBoxColumn();
    const o = slot * 4;
    const s = this.camScale * this.camDpr;
    if (
      this.mark(
        Math.floor((col[o] - this.camPanX) * s - AA_MARGIN),
        Math.floor((col[o + 1] - this.camPanY) * s - AA_MARGIN),
        Math.ceil((col[o + 2] - this.camPanX) * s + AA_MARGIN),
        Math.ceil((col[o + 3] - this.camPanY) * s + AA_MARGIN),
      )
    ) {
      this.markDirty();
    }
  }

  /** Force full clear on next frame. */
  invalidateAll(): void {
    this.fullClear = true;
    this.dirtyCount = 0;
    this.markDirty();
  }

  // =============================================
  // TILE GRID — insert (splat)
  // =============================================

  /**
   * Clamp a device-space rect to the canvas, short-circuit a near-fullscreen rect to
   * fullClear, else splat it into the tile grid. Off-canvas rects (transform/topology
   * don't viewport-gate) clamp away to a no-op. Returns `true` iff damage was
   * recorded (splat ran or the area-ratio branch promoted to fullClear) — the
   * invalidateWorldSlot gate; existing callers markDirty unconditionally.
   */
  private mark(minX: number, minY: number, maxX: number, maxY: number): boolean {
    const cw = this.canvasW;
    const ch = this.canvasH;
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > cw) maxX = cw;
    if (maxY > ch) maxY = ch;
    if (minX >= maxX || minY >= maxY) return false;

    if (DEBUG_DIRTY) this.dbgTrueArea += (maxX - minX) * (maxY - minY);

    // A single rect already covering > AREA_RATIO of the canvas promotes immediately —
    // never splat a full-screen rect into the grid.
    if ((maxX - minX) * (maxY - minY) > AREA_RATIO * cw * ch) {
      this.fullClear = true;
      return true;
    }

    this.splat(minX, minY, maxX, maxY);
    return true;
  }

  /** Word-parallel OR of a clamped, non-empty device rect into the grid + active sub-rect. */
  private splat(minX: number, minY: number, maxX: number, maxY: number): void {
    const tx0 = minX >> TILE_SHIFT;
    const ty0 = minY >> TILE_SHIFT;
    const tx1 = (maxX - 1) >> TILE_SHIFT; // half-open: tile holding the last covered pixel
    const ty1 = (maxY - 1) >> TILE_SHIFT;
    const wpr = this.wordsPerRow;
    const g = this.grid;
    const w0 = tx0 >> 5;
    const w1 = tx1 >> 5;
    const firstMask = 0xffffffff << (tx0 & 31); // JS int32 math; Uint32Array store truncates correctly
    const lastMask = 0xffffffff >>> (31 - (tx1 & 31));

    for (let ty = ty0; ty <= ty1; ty++) {
      const base = ty * wpr;
      if (w0 === w1) {
        g[base + w0] |= firstMask & lastMask;
      } else {
        g[base + w0] |= firstMask;
        for (let w = w0 + 1; w < w1; w++) g[base + w] = 0xffffffff;
        g[base + w1] |= lastMask;
      }
    }

    if (tx0 < this.minTX) this.minTX = tx0;
    if (ty0 < this.minTY) this.minTY = ty0;
    if (tx1 > this.maxTX) this.maxTX = tx1;
    if (ty1 > this.maxTY) this.maxTY = ty1;
    this.hasGridDamage = true;
  }

  // =============================================
  // TILE GRID — sizing
  // =============================================

  /** Resize the tile grid when device dims change (forces a fullClear when it does). */
  private ensureGrid(w: number, h: number): void {
    if (w === this.gridSizedW && h === this.gridSizedH) return;
    this.gridSizedW = w;
    this.gridSizedH = h;
    this.resizeGrid(w, h);
  }

  private resizeGrid(w: number, h: number): void {
    const cols = (w + TILE_SIZE - 1) >> TILE_SHIFT;
    const rows = (h + TILE_SIZE - 1) >> TILE_SHIFT;
    const wpr = (cols + 31) >> 5;
    const needed = wpr * rows;
    if (needed > this.grid.length)
      this.grid = new Uint32Array(needed); // grow only (new buffer is zeroed)
    else if (needed > 0) this.grid.fill(0, 0, needed); // reuse: clear stale bits from the prior layout
    const runCap = (cols + 1) * 3; // ≥ max runs/row (≤ ceil(cols/2)) × 3
    if (this.runsA.length < runCap) {
      this.runsA = new Int32Array(runCap);
      this.runsB = new Int32Array(runCap);
    }
    this.gridCols = cols;
    this.gridRows = rows;
    this.wordsPerRow = wpr;
    this.resetActiveRect();
    this.hasGridDamage = false;
    this.fullClear = true; // dims changed → repaint everything at the new size
  }

  private resetActiveRect(): void {
    this.minTX = this.gridCols;
    this.minTY = this.gridRows;
    this.maxTX = -1;
    this.maxTY = -1;
  }

  /** Clear only the active sub-rect's words + reset tracking. Cheap per-frame reset. */
  private resetGridActive(): void {
    if (this.maxTX >= this.minTX && this.maxTY >= this.minTY) {
      const g = this.grid;
      const wpr = this.wordsPerRow;
      const wMin = this.minTX >> 5;
      const wMax = this.maxTX >> 5;
      for (let r = this.minTY; r <= this.maxTY; r++) {
        const base = r * wpr;
        for (let w = wMin; w <= wMax; w++) g[base + w] = 0;
      }
    }
    this.resetActiveRect();
    this.hasGridDamage = false;
    if (DEBUG_DIRTY) this.dbgTrueArea = 0;
  }

  // =============================================
  // SCHEDULING
  // =============================================

  private markDirty(): void {
    if (!this.started) return;
    this.needsFrame = true;
    this.urgent = true;
    if (this.throttleTimeout !== null) {
      clearTimeout(this.throttleTimeout);
      this.throttleTimeout = null;
    }
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (!this.started || this.isHidden || this.rafId !== null) return;

    if (!NATIVE_RAF && !this.urgent && performance.now() >= this.nativeRafUntil) {
      const targetMs = 1000 / (isMobile() ? FRAME_CONFIG.MOBILE_FPS : FRAME_CONFIG.TARGET_FPS);
      const elapsed = performance.now() - this.lastFrameTime;
      if (elapsed < targetMs) {
        this.throttleTimeout = setTimeout(() => {
          this.throttleTimeout = null;
          this.scheduleFrame();
        }, targetMs - elapsed);
        return;
      }
    }

    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.tick();
      if (this.needsFrame) {
        this.urgent = false;
        this.scheduleFrame();
      }
    });
  }

  // =============================================
  // MAIN TICK
  // =============================================

  private tick(): void {
    if (!this.started) return;
    this.lastFrameTime = performance.now();
    this.needsFrame = false;

    // 1. Get context
    const ctx = getBaseContext();
    if (!ctx) return;

    // 2. Apply pending resize + detect canvas dimension change independently
    applyPendingResize();
    if (ctx.canvas.width !== this.lastCanvasW || ctx.canvas.height !== this.lastCanvasH) {
      this.lastCanvasW = ctx.canvas.width;
      this.lastCanvasH = ctx.canvas.height;
      this.fullClear = true;
      this.dirtyCount = 0;
      // Render at native rAF (bypass 60fps throttle) for 150ms after context reset.
      // Continuous full redraws give the GPU multiple frames to warm font caches.
      this.nativeRafUntil = performance.now() + 150;
    }

    // 3. Read camera state (single read for entire frame)
    const { scale, pan, dpr, cssWidth, cssHeight } = useCameraStore.getState();
    if (cssWidth <= 0 || cssHeight <= 0) return;
    if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(pan.x) || !Number.isFinite(pan.y)) return;

    // Cache camera for the next accumulation window (constant until the next camera change,
    // which forces fullClear). invalidate* read these instead of the store — no per-call getState.
    this.camScale = scale;
    this.camPanX = pan.x;
    this.camPanY = pan.y;
    this.camDpr = dpr;

    const pixelW = Math.round(cssWidth * dpr);
    const pixelH = Math.round(cssHeight * dpr);
    this.canvasW = pixelW;
    this.canvasH = pixelH;
    this.ensureGrid(pixelW, pixelH);

    // 4. Viewport-driven image management (decode visible, evict off-viewport, mip selection)
    manageImageViewport();

    // 5. Resolve dirty region from the tile grid: popcount promotion → run-merge extraction.
    if (!this.fullClear && this.hasGridDamage) {
      if (this.popcountActive() > AREA_RATIO * this.gridCols * this.gridRows) {
        this.fullClear = true;
      } else if (DEBUG_DIRTY) {
        const t0 = performance.now();
        this.dirtyCount = this.extractDirtyRects();
        this.recordDirtyStats(performance.now() - t0);
      } else {
        this.dirtyCount = this.extractDirtyRects();
      }
    }

    // 6. Determine clear mode
    const hasDirty = this.dirtyCount > 0;
    if (!this.fullClear && !hasDirty) {
      if (this.hasGridDamage) this.resetGridActive();
      return; // Nothing to do
    }

    // 7. CLEAR PASS (identity transform)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.fullClear) {
      ctx.clearRect(0, 0, pixelW, pixelH);
    } else {
      const buf = this.dirtyBuf;
      for (let i = 0; i < this.dirtyCount; i++) {
        const off = i * 4;
        ctx.clearRect(buf[off], buf[off + 1], buf[off + 2] - buf[off], buf[off + 3] - buf[off + 1]);
      }
    }
    ctx.restore();

    // 8. DRAW PASS (world transform)
    ctx.save();
    const s = dpr * scale;
    ctx.setTransform(s, 0, 0, s, -pan.x * s, -pan.y * s);

    // Build clip region from dirty rects (device px → world coords) into reusable buffer.
    const hasClip = !this.fullClear && hasDirty;
    let clipCount = 0;
    if (hasClip) {
      const invS = 1 / (scale * dpr);
      const buf = this.dirtyBuf;
      const cbuf = this.clipWorldBuf;

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < this.dirtyCount; i++) {
        const off = i * 4;
        const wMinX = buf[off] * invS + pan.x;
        const wMinY = buf[off + 1] * invS + pan.y;
        const wMaxX = buf[off + 2] * invS + pan.x;
        const wMaxY = buf[off + 3] * invS + pan.y;
        cbuf[off] = wMinX;
        cbuf[off + 1] = wMinY;
        cbuf[off + 2] = wMaxX;
        cbuf[off + 3] = wMaxY;
        ctx.rect(wMinX, wMinY, wMaxX - wMinX, wMaxY - wMinY);
      }
      clipCount = this.dirtyCount;
      ctx.clip();
    }

    drawObjects(ctx, hasClip ? this.clipWorldBuf : null, clipCount);

    if (hasClip) ctx.restore();
    ctx.restore();

    // 9. Reset dirty state
    this.dirtyCount = 0;
    this.fullClear = false;
    if (this.hasGridDamage) this.resetGridActive();

    // 10. Native rAF window: keep redrawing for GPU font cache warmup
    if (performance.now() < this.nativeRafUntil) {
      this.fullClear = true;
      this.needsFrame = true;
    }
  }

  // =============================================
  // TILE GRID — promotion + extraction
  // =============================================

  /** Set-tile count over the active sub-rect (SWAR popcount). Drives fullClear promotion. */
  private popcountActive(): number {
    const g = this.grid;
    const wpr = this.wordsPerRow;
    const wMin = this.minTX >> 5;
    const wMax = this.maxTX >> 5;
    let count = 0;
    for (let r = this.minTY; r <= this.maxTY; r++) {
      const base = r * wpr;
      for (let w = wMin; w <= wMax; w++) {
        let x = g[base + w];
        x = x - ((x >>> 1) & 0x55555555);
        x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
        x = (x + (x >>> 4)) & 0x0f0f0f0f;
        count += Math.imul(x, 0x01010101) >>> 24;
      }
    }
    return count;
  }

  /**
   * Vectorize the tile grid into ≤ CLIP_CAP device-px rects (per-row RLE runs + vertical
   * run-merge), written into dirtyBuf. Returns the rect count. Collapses to the active bbox
   * when the cap is exceeded — bounds clip complexity and the O(V·M) object cull.
   */
  private extractDirtyRects(): number {
    const g = this.grid;
    const wpr = this.wordsPerRow;
    const cols = this.gridCols;
    const minTX = this.minTX;
    const maxTX = this.maxTX;
    const minTY = this.minTY;
    const maxTY = this.maxTY;
    const wMin = minTX >> 5;
    const wMax = maxTX >> 5;
    const buf = this.dirtyBuf;
    const cw = this.canvasW;
    const ch = this.canvasH;

    let prev = this.runsA; // open rectangles from the previous row: [x0, x1, y0] triples
    let curr = this.runsB;
    let prevCount = 0;
    let outCount = 0;

    for (let r = minTY; r <= maxTY; r++) {
      // --- 1. extract this row's set-bit runs into `curr` (left→right, x0 ascending, unique) ---
      let currCount = 0;
      const base = r * wpr;
      let open = false;
      let runStart = 0;
      for (let w = wMin; w <= wMax; w++) {
        const word = g[base + w] >>> 0;
        if (word === 0) {
          if (open) {
            const k = currCount * 3;
            curr[k] = runStart;
            curr[k + 1] = w << 5; // run ends at this word boundary
            currCount++;
            open = false;
          }
          continue;
        }
        if (word === 0xffffffff) {
          if (!open) {
            runStart = w << 5;
            open = true;
          }
          continue;
        }
        const colBase = w << 5;
        for (let b = 0; b < 32; b++) {
          if ((word & (1 << b)) !== 0) {
            if (!open) {
              runStart = colBase + b;
              open = true;
            }
          } else if (open) {
            const k = currCount * 3;
            curr[k] = runStart;
            curr[k + 1] = colBase + b;
            currCount++;
            open = false;
          }
        }
      }
      if (open) {
        let x1 = (wMax + 1) << 5;
        if (x1 > cols) x1 = cols;
        const k = currCount * 3;
        curr[k] = runStart;
        curr[k + 1] = x1;
        currCount++;
      }

      // --- 2. merge `curr` against `prev` by x0 (both sorted, x0 unique per row) ---
      let i = 0;
      let j = 0;
      while (i < prevCount && j < currCount) {
        const px0 = prev[i * 3];
        const cx0 = curr[j * 3];
        if (px0 === cx0) {
          if (prev[i * 3 + 1] === curr[j * 3 + 1]) {
            curr[j * 3 + 2] = prev[i * 3 + 2]; // same span → carry the rectangle's top down
          } else {
            if (outCount >= CLIP_CAP) return this.collapseActive();
            this.emitTileRect(buf, outCount, px0, prev[i * 3 + 2], prev[i * 3 + 1], r, cw, ch);
            outCount++;
            curr[j * 3 + 2] = r; // width changed → a new rectangle starts at this row
          }
          i++;
          j++;
        } else if (px0 < cx0) {
          if (outCount >= CLIP_CAP) return this.collapseActive();
          this.emitTileRect(buf, outCount, px0, prev[i * 3 + 2], prev[i * 3 + 1], r, cw, ch);
          outCount++;
          i++;
        } else {
          curr[j * 3 + 2] = r; // unmatched curr run → new rectangle
          j++;
        }
      }
      while (i < prevCount) {
        if (outCount >= CLIP_CAP) return this.collapseActive();
        this.emitTileRect(buf, outCount, prev[i * 3], prev[i * 3 + 2], prev[i * 3 + 1], r, cw, ch);
        outCount++;
        i++;
      }
      while (j < currCount) {
        curr[j * 3 + 2] = r;
        j++;
      }

      const tmp = prev;
      prev = curr;
      curr = tmp;
      prevCount = currCount;
    }

    // --- 3. flush rectangles still open at the bottom ---
    const yBottom = maxTY + 1;
    for (let i = 0; i < prevCount; i++) {
      if (outCount >= CLIP_CAP) return this.collapseActive();
      this.emitTileRect(buf, outCount, prev[i * 3], prev[i * 3 + 2], prev[i * 3 + 1], yBottom, cw, ch);
      outCount++;
    }

    return outCount;
  }

  /** Write tile-rect [x0,x1)×[y0,y1) as a device-px rect into dirtyBuf[idx], clamped to canvas. */
  private emitTileRect(buf: Float64Array, idx: number, x0t: number, y0t: number, x1t: number, y1t: number, cw: number, ch: number): void {
    let x1 = x1t << TILE_SHIFT;
    let y1 = y1t << TILE_SHIFT;
    if (x1 > cw) x1 = cw;
    if (y1 > ch) y1 = ch;
    const o = idx * 4;
    buf[o] = x0t << TILE_SHIFT; // tile coords ≥ minT ≥ 0 — no low clamp needed
    buf[o + 1] = y0t << TILE_SHIFT;
    buf[o + 2] = x1;
    buf[o + 3] = y1;
  }

  /** Emit the whole active sub-rect as a single device-px rect (cap-exceeded fallback). */
  private collapseActive(): number {
    const buf = this.dirtyBuf;
    let x1 = (this.maxTX + 1) << TILE_SHIFT;
    let y1 = (this.maxTY + 1) << TILE_SHIFT;
    if (x1 > this.canvasW) x1 = this.canvasW;
    if (y1 > this.canvasH) y1 = this.canvasH;
    buf[0] = this.minTX << TILE_SHIFT;
    buf[1] = this.minTY << TILE_SHIFT;
    buf[2] = x1;
    buf[3] = y1;
    return 1;
  }

  private recordDirtyStats(extractMs: number): void {
    const buf = this.dirtyBuf;
    let emitted = 0;
    for (let i = 0; i < this.dirtyCount; i++) {
      const o = i * 4;
      emitted += (buf[o + 2] - buf[o]) * (buf[o + 3] - buf[o + 1]);
    }
    (globalThis as unknown as { __dirtyStats?: unknown }).__dirtyStats = {
      rectCount: this.dirtyCount,
      trueArea: this.dbgTrueArea,
      emittedArea: emitted,
      overdrawRatio: this.dbgTrueArea > 0 ? emitted / this.dbgTrueArea : 1,
      extractMs,
    };
  }

  // =============================================
  // VISIBILITY
  // =============================================

  private handleVisibilityChange = (): void => {
    this.isHidden = document.hidden;
    if (this.isHidden) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.needsFrame) this.startHiddenLoop();
    } else {
      if (this.hiddenIntervalId !== null) {
        clearInterval(this.hiddenIntervalId);
        this.hiddenIntervalId = null;
      }
      if (this.needsFrame) this.scheduleFrame();
    }
  };

  private startHiddenLoop(): void {
    if (this.hiddenIntervalId || !this.started) return;
    this.hiddenIntervalId = window.setInterval(() => {
      if (this.started && this.needsFrame) {
        this.tick();
      } else if (!this.started && this.hiddenIntervalId !== null) {
        clearInterval(this.hiddenIntervalId);
        this.hiddenIntervalId = null;
      }
    }, 1000 / FRAME_CONFIG.HIDDEN_FPS);
  }
}

/** Module-level singleton — started/stopped by CanvasRuntime */
export const renderLoop = new RenderLoop();

// =============================================
// MODULE-LEVEL INVALIDATION WRAPPERS
// =============================================

/** Invalidate a world-space dirty rect. Safe no-op before start(). */
export function invalidateWorld(bounds: WorldBounds): void {
  renderLoop.invalidateWorld(bounds);
}

/** Invalidate a world-space dirty rect from BBoxTuple. Safe no-op before start(). */
export function invalidateWorldBBox(bbox: BBoxTuple): void {
  renderLoop.invalidateWorldBBox(bbox);
}

/** Invalidate a live slot's rect straight off the global bbox column. Safe no-op before start(). */
export function invalidateWorldSlot(slot: number): void {
  renderLoop.invalidateWorldSlot(slot);
}

/** Force full base-canvas clear on next frame. Safe no-op before start(). */
export function invalidateWorldAll(): void {
  renderLoop.invalidateAll();
}
