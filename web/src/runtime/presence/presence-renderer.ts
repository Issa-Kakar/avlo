/**
 * PresenceCursorRenderer — DOM-based peer cursor renderer.
 *
 * Each remote peer maps to an `<img>` slot positioned via `style.translate` so the
 * GPU compositor handles motion. Lives above the canvas's editor overlay
 * (`editorHost` z-index 3, this host z-index 4) so peer cursors keep rendering
 * over text/code editor surfaces — the bug that motivated the move off the
 * overlay canvas.
 *
 * SoA typed-array state + slot pool with `slotGen` guards against async bitmap
 * resolution races. Self-driven rAF (kicked by camera + awareness ticks);
 * settled cursors with a stationary camera produce zero writes.
 *
 * Owned by `presence.ts` as a module singleton — created on `attach()`, disposed
 * on `detach()`. The DOM host is owned by React (`Canvas.tsx`) and registered
 * via `SurfaceManager` — the renderer reads it lazily via `getCursorHost()`.
 *
 * @module runtime/presence/presence-renderer
 */

import { measureTextCached } from '@/core/text/text-measure';
import { getCursorHost } from '@/runtime/SurfaceManager';
import { subscribeCamera, useCameraStore } from '@/stores/camera-store';
import { type PeerIdentity, usePresenceStore } from '@/stores/presence-store';

// ─── Constants ───────────────────────────────────────────────────────

const CAPACITY = 128;

// Flag bits (Uint8 bit-packed)
const FLAG_ACTIVE = 1 << 0;
const FLAG_HAS_CURSOR = 1 << 1;
const FLAG_SETTLED = 1 << 2;
const FLAG_WAS_IN_VP = 1 << 3;
const FLAG_IMG_LOADED = 1 << 4;

// Smoothing
const TAU_MS = 60;
const DT_CLAMP_MS = 200;
const SETTLE_THRESHOLD_PX = 0.5; // canvas-px settle threshold (zoom-aware)

// Hysteresis (CSS px, against viewport bounds)
const ENTER_MARGIN_PX = 50;
const EXIT_MARGIN_PX = 150;

// Bitmap
const BITMAP_SCALE = 2;

// ─── Bitmap geometry (inlined from former cursor-bitmap.ts) ──────────

/**
 * Pointer outline — the IconSelect arrow (see `components/icons/index.tsx`),
 * a filled SVG path in a 24-unit viewBox. Four cubic-rounded vertices, symmetric
 * about the 45° diagonal: tip (hotspot), concave notch, and mirrored wings.
 */
const SELECT_CURSOR_PATH =
  'm15.533 16.072-2.764 5.243c-.514.974-1.933.895-2.33-.129L5.068 7.264c-.529-1.372.824-2.726 2.196-2.196l13.923 5.372c1.025.396 1.103 1.815.13 2.329l-5.245 2.765c-.23.12-.417.308-.538.538Z';
const TIP_VB = 3.689; // tip vertex, viewBox units (x === y — on the diagonal)
const SPAN_VB = 20.13; // tip vertex → far vertex extent, viewBox units

/** viewBox units → CSS px. Lifts the cursor to ~23px. */
const POINTER_SCALE = 1.15;

// Tip vertex (the hotspot) in the bitmap.
const TIP_X = 3;
const TIP_Y = 3;

/** Pointer's far extent in the bitmap. */
const POINTER_MAX = TIP_X + SPAN_VB * POINTER_SCALE;

// Label — rounded rect placed down the pointer's 45° axis from the tip.
const LABEL_FONT_SIZE = 12;
const LABEL_PAD_H = 10;
const LABEL_PAD_V = 5;
const LABEL_RADIUS = 7;
const LABEL_GAP_X = 16;
const LABEL_GAP_Y = 16;
const LABEL_FONT = `500 ${LABEL_FONT_SIZE}px "Inter", system-ui, sans-serif`;

// Room for the 1px outline bleed on the far / bottom edges of the bitmap.
const EDGE_PAD = 2;

/** Luminance-based text color (WCAG relative luminance). */
function textColorFor(bg: string): string {
  const hex = bg.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.45 ? '#1a1a1a' : '#ffffff';
}

const EMPTY_PEER_MAP = new Map<string, PeerIdentity>();

// ─── Class ───────────────────────────────────────────────────────────

export class PresenceCursorRenderer {
  private readonly localClientId: number;

  // SoA tables — allocated once at construction.
  private readonly positions = new Float32Array(CAPACITY * 4); // [tx, ty, dx, dy] at slot*4
  private readonly lastWritten = new Float32Array(CAPACITY * 2); // [cx, cy] at slot*2
  private readonly flags = new Uint8Array(CAPACITY);
  private readonly activeSlots = new Uint16Array(CAPACITY);
  private readonly slotToActive = new Int16Array(CAPACITY);
  private readonly slotGen = new Uint32Array(CAPACITY);
  private readonly clientIdBySlot = new Int32Array(CAPACITY);

  // Identity arrays
  private readonly userIds: string[] = new Array(CAPACITY);
  private readonly names: string[] = new Array(CAPACITY);
  private readonly colors: string[] = new Array(CAPACITY);
  private readonly blobUrls: (string | null)[] = new Array(CAPACITY);
  private readonly elements: (HTMLImageElement | null)[] = new Array(CAPACITY);

  // Resolution + free list
  private activeCount = 0;
  private readonly freeList: number[] = [];
  private readonly slotByClientId = new Map<number, number>();

  // Resources
  private cameraUnsub: (() => void) | null = null;
  private rafId: number | null = null;
  private lastTickMs = 0;
  private destroyed = false;

  constructor(localClientId: number) {
    this.localClientId = localClientId;
    this.slotToActive.fill(-1);
    this.clientIdBySlot.fill(-1);
    // Free list seeded LIFO so pop yields 0, 1, 2…
    for (let i = CAPACITY - 1; i >= 0; i--) this.freeList.push(i);
    for (let i = 0; i < CAPACITY; i++) {
      this.userIds[i] = '';
      this.names[i] = '';
      this.colors[i] = '';
      this.blobUrls[i] = null;
      this.elements[i] = null;
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  attach(): void {
    this.cameraUnsub = subscribeCamera(this._onCameraChange);
    this.lastTickMs = 0;
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // 1. Cancel rAF first — no DOM writes after this point.
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // 2. Unsubscribe camera — no kicks after rAF cancelled.
    if (this.cameraUnsub) {
      this.cameraUnsub();
      this.cameraUnsub = null;
    }

    // 3. Free each active slot — removes <img>, revokes blob, clears entries.
    while (this.activeCount > 0) {
      this.freeSlot(this.activeSlots[this.activeCount - 1]);
    }

    // 4. Empty the Zustand peer store.
    usePresenceStore.getState().setPeers(EMPTY_PEER_MAP);
  }

  private readonly _onCameraChange = (): void => {
    this.kickRaf();
  };

  // ─── Awareness facade ─────────────────────────────────────────────

  hasActivePeers(): boolean {
    return this.activeCount > 0;
  }

  processAwarenessBatch(
    added: number[],
    updated: number[],
    removed: number[],
    getState: (cid: number) => Record<string, unknown> | undefined,
  ): void {
    if (this.destroyed) return;
    let identityDirty = false;
    let anyTouched = false;

    // Removals first — frees DOM resources before potential alloc churn.
    for (let i = 0; i < removed.length; i++) {
      const cid = removed[i];
      if (cid === this.localClientId) continue;
      const slot = this.slotByClientId.get(cid);
      if (slot === undefined) continue;
      this.freeSlot(slot);
      identityDirty = true;
    }

    for (let i = 0; i < added.length; i++) {
      const cid = added[i];
      if (cid === this.localClientId) continue;
      if (this.upsertFromState(cid, getState(cid))) identityDirty = true;
      anyTouched = true;
    }
    for (let i = 0; i < updated.length; i++) {
      const cid = updated[i];
      if (cid === this.localClientId) continue;
      if (this.upsertFromState(cid, getState(cid))) identityDirty = true;
      anyTouched = true;
    }

    if (identityDirty) this.rebuildPeerStore();
    if (anyTouched || identityDirty) this.kickRaf();
  }

  clearAllPeers(): void {
    while (this.activeCount > 0) {
      this.freeSlot(this.activeSlots[this.activeCount - 1]);
    }
    this.rebuildPeerStore();
  }

  // ─── Slot allocation / teardown ────────────────────────────────────

  private upsertFromState(clientId: number, state: Record<string, unknown> | undefined): boolean {
    if (!state?.userId) return false;

    const userId = state.userId as string;
    const name = (state.name as string) || 'Anonymous';
    const color = (state.color as string) || '#808080';
    const cursor = state.cursor as { x: number; y: number } | undefined;

    let slot = this.slotByClientId.get(clientId);
    let identityChanged = false;

    if (slot === undefined) {
      slot = this.allocSlot(clientId);
      if (slot === -1) return false;
      this.setIdentity(slot, userId, name, color);
      this.requestBitmap(slot);
      identityChanged = true;
    }
    // Existing slot: identity is immutable. No diff. No re-render.
    // (If identity-mutation is ever exposed in-app, add a name/color diff here +
    // requestBitmap; slotGen already handles the out-of-order resolve case.)

    const base = slot << 2;
    const hadCursor = (this.flags[slot] & FLAG_HAS_CURSOR) !== 0;
    if (cursor) {
      const tx = Math.round(cursor.x);
      const ty = Math.round(cursor.y);
      this.positions[base] = tx;
      this.positions[base + 1] = ty;
      if (!hadCursor) {
        // First sample OR cursor reappearing — snap (no smoothing from stale).
        this.positions[base + 2] = tx;
        this.positions[base + 3] = ty;
        this.flags[slot] |= FLAG_HAS_CURSOR | FLAG_SETTLED;
      } else {
        this.flags[slot] |= FLAG_HAS_CURSOR;
        this.flags[slot] &= ~FLAG_SETTLED;
      }
    } else {
      this.flags[slot] &= ~FLAG_HAS_CURSOR;
    }

    return identityChanged;
  }

  private allocSlot(clientId: number): number {
    if (this.freeList.length === 0) {
      console.warn('[PresenceCursorRenderer] CAPACITY exceeded, dropping peer', clientId);
      return -1;
    }
    const host = getCursorHost();
    if (host === null) {
      // Defensive: under the ordering invariant, host is registered before any
      // awareness packet arrives. If this ever fires, it's a real bug.
      console.warn('[PresenceCursorRenderer] cursorHost not registered; dropping peer', clientId);
      return -1;
    }
    const slot = this.freeList.pop() as number;

    // Register active
    this.slotToActive[slot] = this.activeCount;
    this.activeSlots[this.activeCount++] = slot;

    // Reset state — bump slotGen so any in-flight resolver from the previous
    // tenant sees a mismatch and discards its blob.
    this.flags[slot] = FLAG_ACTIVE;
    this.slotGen[slot]++;
    this.clientIdBySlot[slot] = clientId;
    this.slotByClientId.set(clientId, slot);

    // Pre-compute initial transform from current camera so the element appears
    // at the right place from frame 0. Cursor data may not be present yet — in
    // that case positions are zero and the tick hides the element via !HAS_CURSOR.
    const cam = useCameraStore.getState();
    const base = slot << 2;
    const initCx = (this.positions[base + 2] - cam.pan.x) * cam.scale;
    const initCy = (this.positions[base + 3] - cam.pan.y) * cam.scale;
    const lwBase = slot << 1;
    this.lastWritten[lwBase] = initCx;
    this.lastWritten[lwBase + 1] = initCy;

    const el = this.buildElementForSlot(slot, host, initCx, initCy);
    this.elements[slot] = el;
    this.blobUrls[slot] = null;

    return slot;
  }

  private freeSlot(slot: number): void {
    const f = this.flags[slot];
    if ((f & FLAG_ACTIVE) === 0) return;

    // 1. Remove from dense active list via swap-remove of INDEX.
    const idx = this.slotToActive[slot];
    const last = this.activeSlots[this.activeCount - 1];
    this.activeSlots[idx] = last;
    this.slotToActive[last] = idx;
    this.slotToActive[slot] = -1;
    this.activeCount--;

    // 2. Drop reverse-lookup.
    const cid = this.clientIdBySlot[slot];
    if (cid !== -1) this.slotByClientId.delete(cid);
    this.clientIdBySlot[slot] = -1;

    // 3. Bump slotGen — invalidates in-flight bitmap renders for this slot.
    this.slotGen[slot]++;

    // 4. Teardown DOM + blob.
    const el = this.elements[slot];
    if (el !== null) {
      el.onload = null;
      el.src = '';
      el.parentNode?.removeChild(el);
      this.elements[slot] = null;
    }
    const oldUrl = this.blobUrls[slot];
    if (oldUrl !== null) {
      URL.revokeObjectURL(oldUrl);
      this.blobUrls[slot] = null;
    }

    // 5. Clear identity strings.
    this.userIds[slot] = '';
    this.names[slot] = '';
    this.colors[slot] = '';

    // 6. Reset flags and slot data.
    this.flags[slot] = 0;
    const lwBase = slot << 1;
    this.lastWritten[lwBase] = 0;
    this.lastWritten[lwBase + 1] = 0;
    const base = slot << 2;
    this.positions[base] = 0;
    this.positions[base + 1] = 0;
    this.positions[base + 2] = 0;
    this.positions[base + 3] = 0;

    // 7. Return to free list.
    this.freeList.push(slot);
  }

  private setIdentity(slot: number, userId: string, name: string, color: string): void {
    this.userIds[slot] = userId;
    this.names[slot] = name;
    this.colors[slot] = color;
  }

  // ─── Bitmap pipeline ──────────────────────────────────────────────

  private requestBitmap(slot: number): void {
    const gen = ++this.slotGen[slot];
    const color = this.colors[slot];
    const name = this.names[slot];

    void this.renderBitmapBlob(color, name).then((blob) => {
      // Generation guard — catches both slot reuse AND any future identity change.
      if (this.destroyed || this.slotGen[slot] !== gen) return;

      const newUrl = URL.createObjectURL(blob);
      const el = this.elements[slot];
      if (el === null) {
        URL.revokeObjectURL(newUrl);
        return;
      }
      const oldUrl = this.blobUrls[slot];
      el.src = newUrl;
      this.blobUrls[slot] = newUrl;
      if (oldUrl !== null) URL.revokeObjectURL(oldUrl);
    });
  }

  private async renderBitmapBlob(color: string, name: string): Promise<Blob> {
    const textW = measureTextCached(LABEL_FONT, name);
    const labelW = textW + LABEL_PAD_H * 2;
    const labelH = LABEL_FONT_SIZE + LABEL_PAD_V * 2;
    const labelX = TIP_X + LABEL_GAP_X;
    const labelY = TIP_Y + LABEL_GAP_Y;

    const totalW = Math.ceil(Math.max(POINTER_MAX, labelX + labelW) + EDGE_PAD);
    const totalH = Math.ceil(Math.max(POINTER_MAX, labelY + labelH) + EDGE_PAD);

    const oc = new OffscreenCanvas(totalW * BITMAP_SCALE, totalH * BITMAP_SCALE);
    const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.scale(BITMAP_SCALE, BITMAP_SCALE);

    // --- Label (drawn first — pointer sits on top) ---
    ctx.beginPath();
    ctx.roundRect(labelX, labelY, labelW, labelH, LABEL_RADIUS);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = textColorFor(color);
    ctx.font = LABEL_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, labelX + LABEL_PAD_H, labelY + labelH / 2);

    // --- Pointer ---
    const path = new Path2D(SELECT_CURSOR_PATH);
    ctx.save();
    ctx.translate(TIP_X - TIP_VB * POINTER_SCALE, TIP_Y - TIP_VB * POINTER_SCALE);
    ctx.scale(POINTER_SCALE, POINTER_SCALE);
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1 / POINTER_SCALE;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
    ctx.restore();

    return oc.convertToBlob({ type: 'image/png' });
  }

  private buildElementForSlot(slot: number, host: HTMLDivElement, initialCx: number, initialCy: number): HTMLImageElement {
    const el = document.createElement('img');
    const s = el.style;
    s.position = 'absolute';
    s.top = '0';
    s.left = '0';
    s.pointerEvents = 'none';
    s.willChange = 'transform';
    s.visibility = 'hidden';
    s.translate = `${initialCx}px ${initialCy}px`;

    el.onload = () => {
      if (this.destroyed) return;
      if (this.elements[slot] !== el) return; // stale onload from a previous slot owner
      s.width = `${el.naturalWidth / BITMAP_SCALE}px`;
      s.height = `${el.naturalHeight / BITMAP_SCALE}px`;
      this.flags[slot] |= FLAG_IMG_LOADED;
      this.kickRaf();
    };

    host.appendChild(el);
    return el;
  }

  // ─── rAF driver ───────────────────────────────────────────────────

  private kickRaf(): void {
    if (this.rafId !== null || this.destroyed) return;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.rafId = null;
    if (this.destroyed) return;

    const lastMs = this.lastTickMs;
    this.lastTickMs = now;
    const dt = lastMs > 0 ? Math.min(now - lastMs, DT_CLAMP_MS) : 16;
    const alpha = dt > 0 ? 1 - Math.exp(-dt / TAU_MS) : 0;

    const cam = useCameraStore.getState();
    const scale = cam.scale;
    const panX = cam.pan.x;
    const panY = cam.pan.y;
    const cssW = cam.cssWidth;
    const cssH = cam.cssHeight;

    const slots = this.activeSlots;
    const flags = this.flags;
    const positions = this.positions;
    const lastWritten = this.lastWritten;
    const elements = this.elements;
    const count = this.activeCount;

    let anyUnsettled = false;

    for (let i = 0; i < count; i++) {
      const slot = slots[i];
      const el = elements[slot];
      if (el === null) continue;

      let f = flags[slot];
      if ((f & FLAG_HAS_CURSOR) === 0) {
        if ((f & FLAG_WAS_IN_VP) !== 0) {
          el.style.visibility = 'hidden';
          f &= ~FLAG_WAS_IN_VP;
          flags[slot] = f;
        }
        continue;
      }

      const base = slot << 2;
      const tx = positions[base];
      const ty = positions[base + 1];
      let dx = positions[base + 2];
      let dy = positions[base + 3];

      const settled = (f & FLAG_SETTLED) !== 0;
      if (!settled && alpha > 0) {
        dx += (tx - dx) * alpha;
        dy += (ty - dy) * alpha;
        positions[base + 2] = dx;
        positions[base + 3] = dy;
      }

      const cx = (dx - panX) * scale;
      const cy = (dy - panY) * scale;

      if (!settled) {
        const tcx = (tx - panX) * scale;
        const tcy = (ty - panY) * scale;
        const dxAbs = cx > tcx ? cx - tcx : tcx - cx;
        const dyAbs = cy > tcy ? cy - tcy : tcy - cy;
        if (dxAbs < SETTLE_THRESHOLD_PX && dyAbs < SETTLE_THRESHOLD_PX) {
          positions[base + 2] = tx;
          positions[base + 3] = ty;
          f |= FLAG_SETTLED;
        } else {
          anyUnsettled = true;
        }
      }

      const wasInVp = (f & FLAG_WAS_IN_VP) !== 0;
      const imgLoaded = (f & FLAG_IMG_LOADED) !== 0;
      const margin = wasInVp ? EXIT_MARGIN_PX : ENTER_MARGIN_PX;
      const inVp = cx >= -margin && cx <= cssW + margin && cy >= -margin && cy <= cssH + margin;
      const shouldBeVisible = inVp && imgLoaded;

      if (shouldBeVisible !== wasInVp) {
        el.style.visibility = shouldBeVisible ? 'visible' : 'hidden';
        if (shouldBeVisible) f |= FLAG_WAS_IN_VP;
        else f &= ~FLAG_WAS_IN_VP;
      }

      if (shouldBeVisible) {
        const lwBase = slot << 1;
        const lastX = lastWritten[lwBase];
        const lastY = lastWritten[lwBase + 1];
        if (cx !== lastX || cy !== lastY) {
          el.style.translate = `${cx}px ${cy}px`;
          lastWritten[lwBase] = cx;
          lastWritten[lwBase + 1] = cy;
        }
      }

      if (f !== flags[slot]) flags[slot] = f;
    }

    if (anyUnsettled) this.kickRaf();
  };

  // ─── Peer store sync ──────────────────────────────────────────────

  private rebuildPeerStore(): void {
    const map = new Map<string, PeerIdentity>();
    for (let i = 0; i < this.activeCount; i++) {
      const slot = this.activeSlots[i];
      map.set(this.userIds[slot], { name: this.names[slot], color: this.colors[slot] });
    }
    usePresenceStore.getState().setPeers(map);
  }
}
