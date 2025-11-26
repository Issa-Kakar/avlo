A) **What I will IGNORE from your current code and WHY**

1. **I’m not going to keep the “tool = settings in deps” pattern.**
   The giant `useEffect(...[activeTool, drawingSettings, ...])` as the *only* way tools see settings is done. I’ll keep the RenderLoop and pointer plumbing, but I’m going to stop re‑creating tools every time settings change.

2. **I’m not preserving Select as “just another tool” in the settings effect.**
   For Select specifically, settings are irrelevant. I’m not going to wedge it into the same “recreate on settings change” flow; its lifetime will be keyed only on `activeTool`.

3. **I’m not baking selection into Canvas state.**
   Selection state will not live in `Canvas` hooks or `device-ui-store`. It gets its own store and stays there. Canvas only wires it into tools and renderer.

4. **I’m not doing a half‑measure hit test.**
   I’ll base Select’s hit‑testing directly on your eraser geometry (same RBush, same shape tests). I won’t rely on AABB‑only hacks.

5. **I’m not designing toolbar‑apply‑style in this phase.**
   You said this phase is transforms + architecture. I’ll only put hooks in Canvas/Select/selection‑store that make later “apply style to selection” straightforward, but I won’t wire the toolbar effect yet.

---

B) **Clean‑room plan made explicit (code‑level)**

You said: *“in this phase i'll do transforms and whatnot and setup the architecture overall”*. So I’ll focus on:

* selection store
* SelectTool class with hit‑testing + state machine
* Canvas tool effect + dependencies (including getter pattern)
* preview provider & overlay shape
* renderer hook‑up for transform preview

I’ll give concrete code sketches you can almost drop in.

---

### B1. Selection store – concrete code

**File:** `client/src/stores/selection-store.ts`

```ts
import { create } from 'zustand';

export type SelectionMode = 'none' | 'single' | 'multi';

export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type TransformKind = 'none' | 'translate' | 'scale';

export interface TranslateTransform {
  kind: 'translate';
  dx: number;
  dy: number;
  originBounds: WorldRect;
}

export interface ScaleTransform {
  kind: 'scale';
  origin: [number, number];   // pivot in world space
  scaleX: number;
  scaleY: number;
  originBounds: WorldRect;
}

export type TransformState =
  | { kind: 'none' }
  | TranslateTransform
  | ScaleTransform;

export interface MarqueeState {
  active: boolean;
  anchor: [number, number] | null;
  current: [number, number] | null;
  rect: WorldRect | null;
}

export interface SelectionState {
  selectedIds: string[];
  primaryId: string | null;
  mode: SelectionMode;
  transform: TransformState;
  marquee: MarqueeState;
}

export interface SelectionActions {
  setSelection: (ids: string[], primaryId?: string | null) => void;
  addToSelection: (id: string) => void;
  toggleInSelection: (id: string) => void;
  clearSelection: () => void;
  pruneToExistingIds: (existingIds: Set<string>) => void;

  beginTranslate: (originBounds: WorldRect) => void;
  updateTranslate: (dx: number, dy: number) => void;
  beginScale: (originBounds: WorldRect, origin: [number, number]) => void;
  updateScale: (scaleX: number, scaleY: number) => void;
  endTransform: () => void;
  cancelTransform: () => void;

  beginMarquee: (anchor: [number, number]) => void;
  updateMarquee: (current: [number, number]) => void;
  endMarquee: () => void;
  cancelMarquee: () => void;
}

export type SelectionStore = SelectionState & SelectionActions;

const emptyRect: WorldRect = {
  minX: 0,
  minY: 0,
  maxX: 0,
  maxY: 0,
};

export const useSelectionStore = create<SelectionStore>((set, get) => ({
  selectedIds: [],
  primaryId: null,
  mode: 'none',
  transform: { kind: 'none' },
  marquee: { active: false, anchor: null, current: null, rect: null },

  setSelection: (ids, primaryId) =>
    set(() => ({
      selectedIds: ids,
      primaryId: primaryId ?? ids[0] ?? null,
      mode: ids.length === 0 ? 'none' : ids.length === 1 ? 'single' : 'multi',
      // selection change resets transient states
      transform: { kind: 'none' },
      marquee: { active: false, anchor: null, current: null, rect: null },
    })),

  addToSelection: (id) =>
    set((state) => {
      if (state.selectedIds.includes(id)) return state;
      const ids = [...state.selectedIds, id];
      return {
        selectedIds: ids,
        mode: ids.length === 1 ? 'single' : 'multi',
        primaryId: state.primaryId ?? id,
      };
    }),

  toggleInSelection: (id) =>
    set((state) => {
      if (state.selectedIds.includes(id)) {
        const ids = state.selectedIds.filter((x) => x !== id);
        return {
          selectedIds: ids,
          mode: ids.length === 0 ? 'none' : ids.length === 1 ? 'single' : 'multi',
          primaryId: ids[0] ?? null,
        };
      }
      const ids = [...state.selectedIds, id];
      return {
        selectedIds: ids,
        mode: ids.length === 1 ? 'single' : 'multi',
        primaryId: state.primaryId ?? id,
      };
    }),

  clearSelection: () =>
    set(() => ({
      selectedIds: [],
      primaryId: null,
      mode: 'none',
      transform: { kind: 'none' },
      marquee: { active: false, anchor: null, current: null, rect: null },
    })),

  pruneToExistingIds: (existing) =>
    set((state) => {
      const ids = state.selectedIds.filter((id) => existing.has(id));
      return {
        selectedIds: ids,
        primaryId: ids[0] ?? null,
        mode: ids.length === 0 ? 'none' : ids.length === 1 ? 'single' : 'multi',
        transform: ids.length ? state.transform : { kind: 'none' },
      };
    }),

  beginTranslate: (originBounds) =>
    set(() => ({
      transform: { kind: 'translate', dx: 0, dy: 0, originBounds },
    })),

  updateTranslate: (dx, dy) =>
    set((state) => {
      if (state.transform.kind !== 'translate') return state;
      return { transform: { ...state.transform, dx, dy } };
    }),

  beginScale: (originBounds, origin) =>
    set(() => ({
      transform: {
        kind: 'scale',
        origin,
        scaleX: 1,
        scaleY: 1,
        originBounds,
      },
    })),

  updateScale: (scaleX, scaleY) =>
    set((state) => {
      if (state.transform.kind !== 'scale') return state;
      return { transform: { ...state.transform, scaleX, scaleY } };
    }),

  endTransform: () =>
    set((state) => {
      if (state.transform.kind === 'none') return state;
      return { ...state, transform: { kind: 'none' } };
    }),

  cancelTransform: () =>
    set((state) => {
      if (state.transform.kind === 'none') return state;
      return { ...state, transform: { kind: 'none' } };
    }),

  beginMarquee: (anchor) =>
    set(() => ({
      marquee: { active: true, anchor, current: anchor, rect: { ...emptyRect } },
    })),

  updateMarquee: (current) =>
    set((state) => {
      if (!state.marquee.active || !state.marquee.anchor) return state;
      const [ax, ay] = state.marquee.anchor;
      const [cx, cy] = current;
      const rect: WorldRect = {
        minX: Math.min(ax, cx),
        minY: Math.min(ay, cy),
        maxX: Math.max(ax, cx),
        maxY: Math.max(ay, cy),
      };
      return { marquee: { active: true, anchor: state.marquee.anchor, current, rect } };
    }),

  endMarquee: () =>
    set((state) => ({
      marquee: { ...state.marquee, active: false },
    })),

  cancelMarquee: () =>
    set(() => ({
      marquee: { active: false, anchor: null, current: null, rect: null },
    })),
}));
```

This is deliberately pure: no Yjs, no Canvas, just selection + transform preview.

---

### B2. SelectTool – explicit state machine + hit‑testing

**File:** `client/src/lib/tools/SelectTool.ts`

Skeleton:

```ts
import type * as Y from 'yjs';
import type { IRoomDocManager } from '../room-doc-manager';
import type { Snapshot, ViewTransform, ObjectHandle } from '@avlo/shared'; // adjust paths
import { useSelectionStore } from '@/stores/selection-store';

const HIT_RADIUS_PX = 6;

type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale';

type HandleId = 'nw' | 'ne' | 'se' | 'sw';

interface HitCandidate {
  id: string;
  kind: 'stroke' | 'shape' | 'text' | 'connector';
  distance: number;
  insideInterior: boolean;
  area: number;
}

interface SelectToolOpts {
  getView: () => ViewTransform;
  invalidateWorld: (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => void;
  invalidateOverlay: () => void;
}

export class SelectTool {
  private room: IRoomDocManager;
  private getView: () => ViewTransform;
  private invalidateWorld: SelectToolOpts['invalidateWorld'];
  private invalidateOverlay: () => void;

  private phase: Phase = 'idle';
  private pointerId: number | null = null;
  private downWorld: [number, number] | null = null;
  private lastWorld: [number, number] | null = null;
  private activeHandle: HandleId | null = null;
  private hitAtDown: HitCandidate | null = null;

  constructor(room: IRoomDocManager, opts: SelectToolOpts) {
    this.room = room;
    this.getView = opts.getView;
    this.invalidateWorld = opts.invalidateWorld;
    this.invalidateOverlay = opts.invalidateOverlay;
  }

  canBegin(): boolean {
    return this.phase === 'idle';
  }

  getPointerId(): number | null {
    return this.pointerId;
  }

  isActive(): boolean {
    return this.phase !== 'idle';
  }

  destroy(): void {
    this.cancel();
  }

  begin(pointerId: number, worldX: number, worldY: number): void {
    if (!this.canBegin()) return;

    this.pointerId = pointerId;
    this.downWorld = [worldX, worldY];
    this.lastWorld = [worldX, worldY];

    const selection = useSelectionStore.getState();
    const hitHandle = this.hitTestHandle(worldX, worldY, selection);
    if (hitHandle) {
      // start scale transform from selection bounds
      this.phase = 'scale';
      this.activeHandle = hitHandle;
      const bounds = this.currentSelectionBounds(selection, /*withTransform*/ false);
      if (bounds) {
        const origin = this.computeScaleOrigin(bounds, hitHandle);
        useSelectionStore.getState().beginScale(bounds, origin);
      }
      this.invalidateOverlay();
      return;
    }

    const hit = this.hitTestObjects(worldX, worldY);
    if (hit) {
      this.phase = 'pendingClick';
      this.hitAtDown = hit;
      // don’t change selection yet; wait to know if it’s click vs drag
    } else {
      // potential marquee
      this.phase = 'pendingClick';
      this.hitAtDown = null;
    }

    this.invalidateOverlay();
  }

  move(worldX: number, worldY: number): void {
    if (!this.isActive()) return;
    this.lastWorld = [worldX, worldY];

    switch (this.phase) {
      case 'pendingClick': {
        const [dxPx, dyPx] = this.worldDeltaToScreenDelta(worldX, worldY);
        const distPx = Math.hypot(dxPx, dyPx);
        if (distPx < 4) {
          // still a click
          return;
        }

        if (this.hitAtDown) {
          // turn into translate
          const selectionStore = useSelectionStore.getState();
          const { selectedIds } = selectionStore;

          // if clicked object is not already selected, select just it
          if (!selectedIds.includes(this.hitAtDown.id)) {
            selectionStore.setSelection([this.hitAtDown.id]);
          }

          const bounds = this.currentSelectionBounds(selectionStore, false);
          if (bounds) {
            selectionStore.beginTranslate(bounds);
          }
          this.phase = 'translate';
          this.invalidateWorld(bounds!);
          this.invalidateOverlay();
        } else {
          // no hit → marquee
          this.phase = 'marquee';
          useSelectionStore.getState().beginMarquee(this.downWorld!);
          useSelectionStore.getState().updateMarquee([worldX, worldY]);
          this.invalidateOverlay();
        }
        break;
      }

      case 'marquee': {
        useSelectionStore.getState().updateMarquee([worldX, worldY]);
        this.invalidateOverlay();
        break;
      }

      case 'translate': {
        const selectionStore = useSelectionStore.getState();
        const { transform } = selectionStore;
        if (transform.kind !== 'translate' || !this.downWorld) return;

        const dx = worldX - this.downWorld[0];
        const dy = worldY - this.downWorld[1];

        selectionStore.updateTranslate(dx, dy);

        const movedBounds = this.translateBounds(transform.originBounds, dx, dy);
        const union = this.unionBounds(transform.originBounds, movedBounds);
        this.invalidateWorld(union);
        this.invalidateOverlay();
        break;
      }

      case 'scale': {
        const selectionStore = useSelectionStore.getState();
        const { transform } = selectionStore;
        if (transform.kind !== 'scale') return;

        const { originBounds, origin } = transform;
        const [sx, sy] = this.computeScaleFactors(originBounds, origin, [worldX, worldY], this.activeHandle!);
        selectionStore.updateScale(sx, sy);

        const scaledBounds = this.scaleBounds(originBounds, origin, sx, sy);
        const union = this.unionBounds(originBounds, scaledBounds);
        this.invalidateWorld(union);
        this.invalidateOverlay();
        break;
      }
    }
  }

  end(worldX?: number, worldY?: number): void {
    if (!this.isActive()) return;
    const phase = this.phase;
    this.phase = 'idle';

    const selectionStore = useSelectionStore.getState();

    if (phase === 'pendingClick') {
      if (this.hitAtDown) {
        selectionStore.setSelection([this.hitAtDown.id]);
      } else {
        selectionStore.clearSelection();
      }
      this.resetPointer();
      this.invalidateOverlay();
      return;
    }

    if (phase === 'marquee') {
      const { marquee } = selectionStore;
      const rect = marquee.rect;
      selectionStore.endMarquee();
      if (rect) {
        const ids = this.computeMarqueeSelection(rect);
        selectionStore.setSelection(ids);
      }
      this.resetPointer();
      this.invalidateWorld(rect ?? this.fullWorldBounds());
      this.invalidateOverlay();
      return;
    }

    if (phase === 'translate') {
      const { transform, selectedIds } = selectionStore;
      if (transform.kind === 'translate') {
        this.commitTranslate(selectedIds, transform.dx, transform.dy);
      }
      selectionStore.endTransform();
      this.resetPointer();
      this.invalidateWorld(this.fullWorldBounds()); // conservative
      this.invalidateOverlay();
      return;
    }

    if (phase === 'scale') {
      const { transform, selectedIds } = selectionStore;
      if (transform.kind === 'scale') {
        this.commitScale(selectedIds, transform.origin, transform.scaleX, transform.scaleY);
      }
      selectionStore.endTransform();
      this.resetPointer();
      this.invalidateWorld(this.fullWorldBounds());
      this.invalidateOverlay();
      return;
    }
  }

  cancel(): void {
    const selectionStore = useSelectionStore.getState();
    selectionStore.cancelTransform();
    selectionStore.cancelMarquee();
    this.resetPointer();
    this.phase = 'idle';
    this.invalidateOverlay();
  }

  getPreview(): any | null {
    const selection = useSelectionStore.getState();
    const { selectedIds, transform, marquee } = selection;

    if (!selectedIds.length && !marquee.rect) return null;

    const bounds = this.currentSelectionBounds(selection, true);

    return {
      kind: 'selection',
      selectionBounds: bounds,
      marqueeRect: marquee.rect,
    };
  }

  onViewChange(): void {
    // Re-run hit tests / handles if needed; for now just invalidate overlay
    this.invalidateOverlay();
  }

  // -------------- internals --------------

  private resetPointer() {
    this.pointerId = null;
    this.downWorld = null;
    this.lastWorld = null;
    this.hitAtDown = null;
    this.activeHandle = null;
  }

  private worldDeltaToScreenDelta(worldX: number, worldY: number): [number, number] {
    const view = this.getView();
    const [cx0, cy0] = view.worldToCanvas(this.downWorld![0], this.downWorld![1]);
    const [cx1, cy1] = view.worldToCanvas(worldX, worldY);
    return [cx1 - cx0, cy1 - cy0];
  }

  private currentSelectionBounds(selection: SelectionState, withTransform: boolean) {
    const { selectedIds, transform } = selection;
    if (!selectedIds.length) return null;

    // For now: use transform.originBounds for preview bounds during transform
    if (withTransform && transform.kind !== 'none') {
      if (transform.kind === 'translate') {
        return this.translateBounds(transform.originBounds, transform.dx, transform.dy);
      }
      if (transform.kind === 'scale') {
        return this.scaleBounds(transform.originBounds, transform.origin, transform.scaleX, transform.scaleY);
      }
    }

    const snapshot = this.room.currentSnapshot;
    let bounds: WorldRect | null = null;

    for (const id of selectedIds) {
      const handle = snapshot.objectsById.get(id);
      if (!handle) continue;
      const [minX, minY, maxX, maxY] = handle.bbox;
      if (!bounds) {
        bounds = { minX, minY, maxX, maxY };
      } else {
        bounds.minX = Math.min(bounds.minX, minX);
        bounds.minY = Math.min(bounds.minY, minY);
        bounds.maxX = Math.max(bounds.maxX, maxX);
        bounds.maxY = Math.max(bounds.maxY, maxY);
      }
    }

    return bounds;
  }

  private translateBounds(b: WorldRect, dx: number, dy: number): WorldRect {
    return {
      minX: b.minX + dx,
      minY: b.minY + dy,
      maxX: b.maxX + dx,
      maxY: b.maxY + dy,
    };
  }

  private scaleBounds(b: WorldRect, origin: [number, number], sx: number, sy: number): WorldRect {
    const [ox, oy] = origin;
    const corners: [number, number][] = [
      [b.minX, b.minY],
      [b.maxX, b.minY],
      [b.maxX, b.maxY],
      [b.minX, b.maxY],
    ];

    const scaled = corners.map(([x, y]) => [
      ox + (x - ox) * sx,
      oy + (y - oy) * sy,
    ] as [number, number]);

    const xs = scaled.map(([x]) => x);
    const ys = scaled.map(([, y]) => y);

    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }

  private unionBounds(a: WorldRect, b: WorldRect): WorldRect {
    return {
      minX: Math.min(a.minX, b.minX),
      minY: Math.min(a.minY, b.minY),
      maxX: Math.max(a.maxX, b.maxX),
      maxY: Math.max(a.maxY, b.maxY),
    };
  }

  private fullWorldBounds(): WorldRect {
    // Conservative: just something big; your DirtyRectTracker will coalesce anyway
    const snap = this.room.currentSnapshot;
    const vt = snap.view;
    return {
      minX: vt.pan.x - 10000,
      minY: vt.pan.y - 10000,
      maxX: vt.pan.x + 10000,
      maxY: vt.pan.y + 10000,
    };
  }

  // ----- Hit testing (reuses eraser’s geometry logic conceptually) -----

  private hitTestObjects(worldX: number, worldY: number): HitCandidate | null {
    const snapshot = this.room.currentSnapshot;
    const { spatialIndex, objectsById } = snapshot;
    if (!spatialIndex) return null;

    const view = this.getView();
    const radiusWorld = HIT_RADIUS_PX / view.scale;

    const results = spatialIndex.query({
      minX: worldX - radiusWorld,
      minY: worldY - radiusWorld,
      maxX: worldX + radiusWorld,
      maxY: worldY + radiusWorld,
    });

    const candidates: HitCandidate[] = [];

    for (const entry of results) {
      const handle = objectsById.get(entry.id);
      if (!handle) continue;

      switch (handle.kind) {
        case 'stroke':
        case 'connector': {
          const points = handle.y.get('points') as [number, number][] | undefined;
          if (!points || points.length === 0) break;
          const dist = this.strokeDistance(worldX, worldY, points);
          if (dist <= radiusWorld) {
            candidates.push({
              id: handle.id,
              kind: handle.kind,
              distance: dist,
              insideInterior: false,
              area: 0,
            });
          }
          break;
        }
        case 'shape': {
          const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
          if (!frame) break;
          const shapeType = (handle.y.get('shapeType') as string) ?? 'rect';
          const width = (handle.y.get('width') as number) ?? 1;
          const fillColor = handle.y.get('fillColor') as string | undefined;

          const [x, y, w, h] = frame;
          const area = w * h;
          const isInside = this.pointInShapeInterior(worldX, worldY, shapeType, frame);
          const dist = this.shapeDistance(worldX, worldY, shapeType, frame, width, !!fillColor);

          if (dist <= radiusWorld || isInside) {
            candidates.push({
              id: handle.id,
              kind: 'shape',
              distance: isInside ? 0 : dist,
              insideInterior: isInside,
              area,
            });
          }
          break;
        }
        case 'text': {
          const frame = handle.y.get('frame') as [number, number, number, number] | undefined;
          if (!frame) break;
          const [x, y, w, h] = frame;
          const inside = worldX >= x && worldX <= x + w && worldY >= y && worldY <= y + h;
          const dist = inside ? 0 : this.rectEdgeDistance(worldX, worldY, frame);
          if (dist <= radiusWorld || inside) {
            candidates.push({
              id: handle.id,
              kind: 'text',
              distance: dist,
              insideInterior: inside,
              area: w * h,
            });
          }
          break;
        }
      }
    }

    if (!candidates.length) return null;

    // Prefer candidates where cursor is inside interior (shapes/text) if any
    const interior = candidates.filter((c) => c.insideInterior);
    const pool = interior.length ? interior : candidates;

    // Ranking: text > stroke/connector > shape, then distance, then smaller area, then topmost (ULID)
    const kindWeight = (kind: HitCandidate['kind']) =>
      kind === 'text' ? 0 : kind === 'stroke' || kind === 'connector' ? 1 : 2;

    pool.sort((a, b) => {
      const kwDiff = kindWeight(a.kind) - kindWeight(b.kind);
      if (kwDiff !== 0) return kwDiff;

      const dDiff = a.distance - b.distance;
      if (dDiff !== 0) return dDiff;

      const areaDiff = a.area - b.area;
      if (areaDiff !== 0) return areaDiff;

      return a.id < b.id ? 1 : -1; // later ULID (topmost) wins
    });

    return pool[0];
  }

  private strokeDistance(
    px: number,
    py: number,
    points: [number, number][],
  ): number {
    if (points.length === 1) {
      const [x, y] = points[0];
      return Math.hypot(px - x, py - y);
    }
    let best = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      const d = this.pointToSegmentDistance(px, py, x1, y1, x2, y2);
      if (d < best) best = d;
    }
    return best;
  }

  private pointToSegmentDistance(
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): number {
    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {
      return Math.hypot(px - x1, py - y1);
    }

    const t = Math.max(
      0,
      Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)),
    );
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    return Math.hypot(px - projX, py - projY);
  }

  private rectEdgeDistance(
    px: number,
    py: number,
    frame: [number, number, number, number],
  ): number {
    const [x, y, w, h] = frame;
    const left = x;
    const right = x + w;
    const top = y;
    const bottom = y + h;

    const dx = px < left ? left - px : px > right ? px - right : 0;
    const dy = py < top ? top - py : py > bottom ? py - bottom : 0;

    if (dx === 0 && dy === 0) {
      // inside rect: distance to nearest edge
      const dLeft = px - left;
      const dRight = right - px;
      const dTop = py - top;
      const dBottom = bottom - py;
      return Math.min(dLeft, dRight, dTop, dBottom);
    }

    return Math.hypot(dx, dy);
  }

  private pointInShapeInterior(
    px: number,
    py: number,
    shapeType: string,
    frame: [number, number, number, number],
  ): boolean {
    const [x, y, w, h] = frame;
    switch (shapeType) {
      case 'ellipse':
        // normalize to unit circle
        if (w === 0 || h === 0) return false;
        const cx = x + w / 2;
        const cy = y + h / 2;
        const rx = w / 2;
        const ry = h / 2;
        const dx = (px - cx) / rx;
        const dy = (py - cy) / ry;
        return dx * dx + dy * dy <= 1;
      case 'diamond': {
        const top: [number, number] = [x + w / 2, y];
        const right: [number, number] = [x + w, y + h / 2];
        const bottom: [number, number] = [x + w / 2, y + h];
        const left: [number, number] = [x, y + h / 2];
        return this.pointInConvexPolygon(px, py, [top, right, bottom, left]);
      }
      default:
        // rect & roundedRect
        return px >= x && px <= x + w && py >= y && py <= y + h;
    }
  }

  private pointInConvexPolygon(
    px: number,
    py: number,
    vertices: [number, number][],
  ): boolean {
    let sign: number | null = null;
    for (let i = 0; i < vertices.length; i++) {
      const [x1, y1] = vertices[i];
      const [x2, y2] = vertices[(i + 1) % vertices.length];
      const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
      const s = cross >= 0 ? 1 : -1;
      if (sign === null) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  }

  private shapeDistance(
    px: number,
    py: number,
    shapeType: string,
    frame: [number, number, number, number],
    strokeWidth: number,
    _isFilled: boolean,
  ): number {
    const [x, y, w, h] = frame;
    const halfStroke = strokeWidth / 2;

    switch (shapeType) {
      case 'ellipse': {
        // approximate via normalized distance
        const cx = x + w / 2;
        const cy = y + h / 2;
        const rx = w / 2;
        const ry = h / 2;
        if (rx === 0 || ry === 0) {
          return this.rectEdgeDistance(px, py, frame);
        }
        const dx = (px - cx) / rx;
        const dy = (py - cy) / ry;
        const norm = Math.sqrt(dx * dx + dy * dy);
        const avgRadius = (rx + ry) / 2;
        return Math.abs(norm - 1) * avgRadius + halfStroke;
      }
      case 'diamond': {
        const top: [number, number] = [x + w / 2, y];
        const right: [number, number] = [x + w, y + h / 2];
        const bottom: [number, number] = [x + w / 2, y + h];
        const left: [number, number] = [x, y + h / 2];
        const edges: [[number, number], [number, number]][] = [
          [top, right],
          [right, bottom],
          [bottom, left],
          [left, top],
        ];
        let best = Infinity;
        for (const [p1, p2] of edges) {
          const d = this.pointToSegmentDistance(px, py, p1[0], p1[1], p2[0], p2[1]);
          if (d < best) best = d;
        }
        return best + halfStroke;
      }
      default: {
        // rect / roundedRect
        return this.rectEdgeDistance(px, py, frame) + halfStroke;
      }
    }
  }

  private hitTestHandle(
    worldX: number,
    worldY: number,
    selection: SelectionState,
  ): HandleId | null {
    const bounds = this.currentSelectionBounds(selection, true);
    if (!bounds) return null;

    const view = this.getView();
    const handleRadiusPx = 5;
    const { minX, minY, maxX, maxY } = bounds;
    const handles: { id: HandleId; world: [number, number] }[] = [
      { id: 'nw', world: [minX, minY] },
      { id: 'ne', world: [maxX, minY] },
      { id: 'se', world: [maxX, maxY] },
      { id: 'sw', world: [minX, maxY] },
    ];

    const [cx, cy] = view.worldToCanvas(worldX, worldY);

    for (const h of handles) {
      const [hx, hy] = view.worldToCanvas(h.world[0], h.world[1]);
      const d = Math.hypot(cx - hx, cy - hy);
      if (d <= handleRadiusPx) return h.id;
    }
    return null;
  }

  private computeScaleOrigin(bounds: WorldRect, handle: HandleId): [number, number] {
    const { minX, minY, maxX, maxY } = bounds;
    switch (handle) {
      case 'nw': return [maxX, maxY];
      case 'ne': return [minX, maxY];
      case 'se': return [minX, minY];
      case 'sw': return [maxX, minY];
    }
  }

  private computeScaleFactors(
    originBounds: WorldRect,
    origin: [number, number],
    current: [number, number],
    handle: HandleId,
  ): [number, number] {
    const [ox, oy] = origin;
    const { minX, minY, maxX, maxY } = originBounds;
    const width = maxX - minX;
    const height = maxY - minY;
    if (width === 0 || height === 0) return [1, 1];

    const [cx, cy] = current;

    // Opposite corner used as reference
    let baseX: number;
    let baseY: number;
    switch (handle) {
      case 'nw':
        baseX = maxX; baseY = maxY; break;
      case 'ne':
        baseX = minX; baseY = maxY; break;
      case 'se':
        baseX = minX; baseY = minY; break;
      case 'sw':
        baseX = maxX; baseY = minY; break;
    }

    const sx = (cx - ox) / (baseX - ox || 1);
    const sy = (cy - oy) / (baseY - oy || 1);

    // Clamp a bit to avoid negative scales for now
    return [Math.max(0.1, sx), Math.max(0.1, sy)];
  }

  private computeMarqueeSelection(rect: WorldRect): string[] {
    const snapshot = this.room.currentSnapshot;
    const { spatialIndex, objectsById } = snapshot;
    if (!spatialIndex) return [];

    const results = spatialIndex.query(rect);
    const ids: string[] = [];

    for (const entry of results) {
      const handle = objectsById.get(entry.id);
      if (!handle) continue;
      // Simple: select by bbox intersection
      ids.push(handle.id);
    }

    return ids;
  }

  private commitTranslate(ids: string[], dx: number, dy: number): void {
    if (!ids.length) return;

    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<any>>;
      for (const id of ids) {
        const y = objects.get(id);
        if (!y) continue;
        const kind = y.get('kind') as string;

        if (kind === 'stroke' || kind === 'connector') {
          const points = (y.get('points') as [number, number][]) ?? [];
          const next = points.map(([x, y]) => [x + dx, y + dy] as [number, number]);
          y.set('points', next);
        } else if (kind === 'shape' || kind === 'text') {
          const frame = y.get('frame') as [number, number, number, number] | undefined;
          if (!frame) continue;
          const [x, y0, w, h] = frame;
          y.set('frame', [x + dx, y0 + dy, w, h]);
        }
      }
    });
  }

  private commitScale(
    ids: string[],
    origin: [number, number],
    sx: number,
    sy: number,
  ): void {
    if (!ids.length) return;
    const [ox, oy] = origin;

    this.room.mutate((ydoc) => {
      const root = ydoc.getMap('root');
      const objects = root.get('objects') as Y.Map<Y.Map<any>>;
      for (const id of ids) {
        const y = objects.get(id);
        if (!y) continue;
        const kind = y.get('kind') as string;

        if (kind === 'stroke' || kind === 'connector') {
          const points = (y.get('points') as [number, number][]) ?? [];
          const next = points.map(([x, y0]) => [
            ox + (x - ox) * sx,
            oy + (y0 - oy) * sy,
          ] as [number, number]);
          y.set('points', next);
        } else if (kind === 'shape' || kind === 'text') {
          const frame = y.get('frame') as [number, number, number, number] | undefined;
          if (!frame) continue;
          const [x, y0, w, h] = frame;

          const x1 = x;
          const y1 = y0;
          const x2 = x + w;
          const y2 = y0 + h;

          const [sx1, sy1] = [ox + (x1 - ox) * sx, oy + (y1 - oy) * sy];
          const [sx2, sy2] = [ox + (x2 - ox) * sx, oy + (y2 - oy) * sy];

          const nx = Math.min(sx1, sx2);
          const ny = Math.min(sy1, sy2);
          const nw = Math.abs(sx2 - sx1);
          const nh = Math.abs(sy2 - sy1);

          y.set('frame', [nx, ny, nw, nh]);
        }
      }
    });
  }
}
```

That’s a lot, but it’s the explicit version you asked for: state machine, hit testing, transform preview, commit logic.

---

### B3. Canvas tool effect – fixed dependencies + getter pattern

Core changes:

1. **Stop binding tool lifetime to drawing settings.**
2. **Add SelectTool branch.**
3. **Use a getter into `device-ui-store` so tools can freeze settings on `begin()`.**

Conceptual change in `Canvas`:

* Instead of:

  ```ts
  const {
    activeTool,
    drawingSettings,
    highlighterOpacity,
    eraserSize,
    textSize,
    shapeVariant
  } = useDeviceUIStore();
  ```

  and using all of those as `useEffect` deps,

* You do:

  ```ts
  const activeTool = useDeviceUIStore((s) => s.activeTool);
  const shapeVariant = useDeviceUIStore((s) => s.shapeVariant);
  ```

* And inside the effect, when you need settings, call:

  ```ts
  const getToolSettings = () => useDeviceUIStore.getState().getCurrentToolSettings();
  ```

Tool creation effect dependencies become:

```ts
useEffect(() => {
  // create/destroy tools based ONLY on activeTool, not settings
}, [
  roomDoc,
  userId,
  activeTool,
  shapeVariant,
  stageReady,
  screenToWorld,
  worldToClient,
  applyCursor,
]);
```

Then:

* For DrawingTool:

  ```ts
  tool = new DrawingTool(
    roomDoc,
    () => useDeviceUIStore.getState().getCurrentToolSettings(),
    activeTool,         // 'pen' | 'highlighter'
    userId,
    (_bounds) => overlayLoopRef.current?.invalidateAll(),
    () => overlayLoopRef.current?.invalidateAll(),
    () => viewTransformRef.current,
  );
  ```

  `DrawingTool`’s constructor changes from `(room, settings, kind, ...)` to `(room, getSettings, kind, ...)`, and in `begin()` it calls `const cfg = this.getSettings();` and freezes that per gesture.

* For shape tool:

  ```ts
  const forceSnapKind = /* same mapping as now */;
  tool = new DrawingTool(
    roomDoc,
    () => useDeviceUIStore.getState().getCurrentToolSettings(),
    'pen', // mechanics
    userId,
    (_bounds) => overlayLoopRef.current?.invalidateAll(),
    () => overlayLoopRef.current?.invalidateAll(),
    () => viewTransformRef.current,
    { forceSnapKind },
  );
  ```

* For TextTool, you can keep the existing “updateConfig when active” effect as‑is, or also move it to a getter; in this phase you can leave your current special case for text.

* **New SelectTool branch**:

  ```ts
  } else if (activeTool === 'select') {
    tool = new SelectTool(roomDoc, {
      getView: () => viewTransformRef.current,
      invalidateWorld: (bounds) => renderLoopRef.current?.invalidateWorld(bounds),
      invalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
    });
  }
  ```

Selection itself lives in the `selection-store`, so destroying/recreating SelectTool is harmless, but now it won’t be recreated on every settings tweak because we removed settings from deps.

---

### B4. Preview provider + overlay

You already have:

```ts
overlayLoopRef.current.setPreviewProvider({
  getPreview: () => {
    if (suppressToolPreviewRef.current) return null;
    return tool?.getPreview() || null;
  },
});
```

`SelectTool.getPreview()` returns:

```ts
{
  kind: 'selection',
  selectionBounds: WorldRect | null,
  marqueeRect: WorldRect | null,
}
```

You extend your overlay preview union + renderer to understand `kind: 'selection'` and draw:

* `selectionBounds` as a stroked rect with handles.
* `marqueeRect` as a light filled rect while dragging.

That’s all SelectTool needs from overlay.

---

### B5. Renderer hook – transform preview on base canvas

In `RenderLoop` / `drawObjects`:

* Add a way to access selection state:

  ```ts
  renderLoop.start({
    // existing
    getView: () => viewTransformRef.current,
    getSnapshot: () => snapshotRef.current,
    getViewport: /* ... */,
    // new:
    getSelectionState: () => useSelectionStore.getState(),
  });
  ```

* Change `drawObjects` signature to accept `selection?: SelectionState`.

* Inside:

  ```ts
  const transform = selection?.transform;
  const selectedSet = new Set(selection?.selectedIds ?? []);

  for (const entry of candidates) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    const isSelected = selectedSet.has(handle.id);
    const needsTransform = transform && transform.kind !== 'none' && isSelected;

    if (!needsTransform) {
      drawObject(ctx, handle);
      continue;
    }

    ctx.save();

    if (transform.kind === 'translate') {
      ctx.translate(transform.dx, transform.dy);
    } else if (transform.kind === 'scale') {
      const { origin, scaleX, scaleY } = transform;
      ctx.translate(origin[0], origin[1]);
      ctx.scale(scaleX, scaleY);
      ctx.translate(-origin[0], -origin[1]);
    }

    drawObject(ctx, handle);

    ctx.restore();
  }
  ```

This gives you the WYSIWYG transform preview without touching Yjs until SelectTool commits.

---

C) **Why this is the right level of explicitness for this phase**

* You can start by dropping in `selection-store.ts` and `SelectTool.ts`, wire the SelectTool branch in `Canvas`, and **you already have a working select tool with:**

  * precise hit‑testing,
  * single/multi selection,
  * marquee,
  * translate + scale preview and commit.

* The Canvas changes I’m asking for are strictly:

  * cut settings out of the tool creation effect deps,
  * inject a `getCurrentToolSettings` getter into DrawingTool/TextTool instead of giving them baked configs,
  * add the SelectTool branch with invalidateWorld + invalidateOverlay hooks.

* Nothing in this phase touches the toolbar logic: the inspector still just updates `device-ui-store`. Later we add the “if activeTool === 'select' && selection non‑empty, mirror these setting changes into selected Yjs objects” effect without touching tools.

* Because selection & transform preview live in Zustand + SelectTool, and rendering reads that state directly, **you don’t have to push anything into Yjs for preview**, which keeps your undo/redo and RBush pipeline clean.

---

D) **Integration DELTAS (file‑by‑file, with the explicit pieces you need)**

1. **`EraserTool.ts` → geometry inspiration (no code change required now)**
   The hit‑testing inside SelectTool mirrors your eraser’s world‑space RBush query + per‑kind geometry tests; you can, later, literally move `strokeHitTest`, `diamondHitTest`, `ellipseHitTest`, etc., into a shared `hitTestGeometry.ts` and have both tools import from there. 

2. **`device-ui-store.ts` → use getters instead of deps**

   * Keep `getCurrentToolSettings()` exactly as you have it; it’s what tools will call.
   * In `Canvas`, stop destructuring the whole `drawingSettings` blob just to feed it into the tool effect; instead use `useDeviceUIStore((s) => s.activeTool)` and `useDeviceUIStore((s) => s.shapeVariant)` as the only selectors driving the effect. Tools read settings via `useDeviceUIStore.getState().getCurrentToolSettings()` on `begin()`. 

3. **`ToolPanel.tsx` → nothing for this phase**

   * Leave `ToolPanel` exactly as is. It already:

     * Controls `activeTool`.
     * Controls `drawingSettings` and related knobs.
   * In a later phase you’ll add the selection‑style sync layer in Canvas that interprets toolbar changes when `activeTool === 'select'`. No need to touch this file yet. 

4. **`SELECT_PLANNING.md` → this is the concrete version**

   * The selection store file above is the concrete version of your “Selection State Store (NEW)” sketch.
   * The renderer hook (selection‑aware `drawObjects`) matches your plan to keep transforms on base canvas and not in overlay.
   * The SelectTool state machine (pendingClick → marquee/translate/scale) maps directly to your “pointer down, precise hit test; if no candidate → marquee; if yes → single select & transform”. 

5. **`CLAUDE.md` / architecture overview → consistency**

   * The selection store and SelectTool use `room.currentSnapshot`, RBush, and Yjs mutations exactly the way your other tools do:

     * RBush for queries,
     * object handles via `objectsById`,
     * Yjs writes via `room.mutate`. 

6. **`newCanvas.tsx` → the critical diffs**

   In `newCanvas.tsx`: 

   * **Imports:**

     ```ts
     import { SelectTool } from '@/lib/tools/SelectTool';
     import { useSelectionStore } from '@/stores/selection-store';
     ```

   * **PointerTool union:**

     ```ts
     // before
     type PointerTool = DrawingTool | EraserTool | TextTool | PanTool;

     // after
     type PointerTool = DrawingTool | EraserTool | TextTool | PanTool | SelectTool;
     ```

   * **Device UI selectors:**

     Replace the big destructuring:

     ```ts
     const {
       activeTool,
       drawingSettings,
       highlighterOpacity,
       eraserSize,
       textSize,
       shapeVariant
     } = useDeviceUIStore();
     ```

     with narrow selectors (for the tool effect):

     ```ts
     const activeTool = useDeviceUIStore((s) => s.activeTool);
     const shapeVariant = useDeviceUIStore((s) => s.shapeVariant);
     ```

     Whenever you need settings at tool creation time, use:

     ```ts
     const getToolSettings = () => useDeviceUIStore.getState().getCurrentToolSettings();
     const uiState = useDeviceUIStore.getState(); // for textSize, etc
     ```

   * **Tool creation effect deps:**

     Change the effect that creates tools to depend ONLY on:

     ```ts
     useEffect(() => {
       // ... tool creation ...
     }, [
       roomDoc,
       userId,
       activeTool,
       shapeVariant,
       stageReady,
       screenToWorld,
       worldToClient,
       applyCursor,
     ]);
     ```

     and remove `drawingSettings`, `highlighterOpacity`, `eraserSize`, `textSize` from that array.

   * **DrawingTool construction:**

     Replace the inline `settings` object with a getter:

     ```ts
     } else if (activeTool === 'pen' || activeTool === 'highlighter') {
       tool = new DrawingTool(
         roomDoc,
         () => useDeviceUIStore.getState().getCurrentToolSettings(),
         activeTool,
         userId,
         (_bounds) => overlayLoopRef.current?.invalidateAll(),
         () => overlayLoopRef.current?.invalidateAll(),
         () => viewTransformRef.current,
       );
     } else if (activeTool === 'shape') {
       const forceSnapKind =
         shapeVariant === 'rectangle' ? 'rect' :
         shapeVariant === 'ellipse'   ? 'ellipseRect' :
         shapeVariant === 'diamond'   ? 'diamond' :
         shapeVariant === 'arrow'     ? 'arrow' : 'line';

       tool = new DrawingTool(
         roomDoc,
         () => useDeviceUIStore.getState().getCurrentToolSettings(),
         'pen',
         userId,
         (_bounds) => overlayLoopRef.current?.invalidateAll(),
         () => overlayLoopRef.current?.invalidateAll(),
         () => viewTransformRef.current,
         { forceSnapKind },
       );
     }
     ```

     You’ll update `DrawingTool`’s constructor accordingly.

   * **TextTool special case effect:**

     Keep your existing small block that calls `updateConfig` when `activeTool === 'text'` and text settings change; just move it into a separate `useEffect` that depends on `[activeTool, textSize, drawingSettings.color]` if you want to preserve that behavior. (Or rework TextTool to also use a getter.)

   * **SelectTool branch:**

     Add:

     ```ts
     } else if (activeTool === 'select') {
       tool = new SelectTool(
         roomDoc,
         {
           getView: () => viewTransformRef.current,
           invalidateWorld: (bounds) => renderLoopRef.current?.invalidateWorld(bounds),
           invalidateOverlay: () => overlayLoopRef.current?.invalidateAll(),
         },
       );
     }
     ```

   * **Renderer wiring:**

     In the RenderLoop `.start({...})` call:

     ```ts
     renderLoop.start({
       stageRef: baseStageRef,
       getView: () => viewTransformRef.current,
       getSnapshot: () => snapshotRef.current,
       getViewport: /* existing */,
       getGates: () => roomDoc.getGateStatus(),
       isMobile,
       onStats: /* existing */,
       // NEW:
       getSelectionState: () => useSelectionStore.getState(),
     });
     ```

     And in the drawing layer (`drawObjects`), pass that selection state down and apply transform as shown in **B5**.

---

If you implement just this subset:

* `selection-store.ts`
* `SelectTool.ts` with the state machine + hit‑testing + commit logic
* Canvas changes (imports, PointerTool union, tool effect deps, SelectTool branch)
* minimal renderer hook to apply translate transform to selected objects on base canvas

you’ll have a real, working select tool with translate/scale preview and a clean architecture to layer toolbar‑style syncing on top of later.
