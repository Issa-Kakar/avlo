# RBush Spatial Index - Current Implementation State

**Last Updated:** 2025-10-20
**Status:** ✅ **IMPLEMENTED AND OPERATIONAL**

---

## Executive Summary

The RBush R-tree spatial index is **fully implemented** and **operational** across the AVLO codebase. It replaces the previous UniformGrid with a two-epoch architecture that provides O(log N) spatial queries, incremental updates via Y.Array observers, and deterministic rendering across all clients.

### Key Benefits Achieved
- ✅ **O(log N) spatial queries** (viewport culling, eraser hit-testing)
- ✅ **Incremental updates** (no full rebuilds on every frame)
- ✅ **Deterministic z-order** (ULID sorting ensures consistent rendering across tabs)
- ✅ **Minimal state** (Maps as single source of truth, no journal accumulation)

---

## Architecture Overview

### Two-Epoch Model

The RBush implementation uses a **two-epoch model** that cleanly separates full rebuilds from incremental updates:

#### **Epoch 1: Rebuild** (`needsSpatialRebuild = true`)
**Triggers:**
- First snapshot after observer attach
- Scene change (clear board)
- Sanity check failure (maps empty but Y.Arrays have content)

**Flow:**
```typescript
if (needsSpatialRebuild) {
  hydrateViewsFromY()           // Walk Y.Arrays → build Maps
  rebuildSpatialIndexFromViews() // Clear + bulkLoad RBush from Maps
  needsSpatialRebuild = false
}
```

**Complexity:** O(N) map build + O(N log N) bulk-load
**Observer Behavior:** Observers **ignore** incremental updates during this epoch (upcoming hydration reads fresh Y.Doc state)

#### **Epoch 2: Steady-State** (`needsSpatialRebuild = false`)
**Triggers:**
- Every Y.Array change after rebuild completes

**Flow:**
```typescript
// No explicit code in buildSnapshot!
// Observers already updated strokesById, textsById, spatialIndex
return composeSnapshotFromMaps()
```

**Complexity:** O(Δ log N) - only changed items, logarithmic index updates
**Observer Behavior:** Observers **directly update** Maps and RBush on each delta

---

## File Locations

### Core Spatial Index
**File:** [`packages/shared/src/spatial/rbush-spatial-index.ts`](packages/shared/src/spatial/rbush-spatial-index.ts)

```typescript
export class RBushSpatialIndex implements SpatialIndex {
  private tree: RBush<IndexEntry>;
  private strokesById: Map<string, StrokeView>;  // Internal bookkeeping
  private textsById: Map<string, TextView>;      // Internal bookkeeping

  // Epoch 1: Rebuild operations
  clear(): void;
  bulkLoad(strokes, texts): void;  // O(N log N)

  // Epoch 2: Steady-state operations
  insertStroke(stroke): void;      // O(log N)
  insertText(text): void;          // O(log N)
  removeById(id): void;            // O(log N)

  // Query operations
  queryRect(...): StrokeView[];         // Strokes only
  queryRectAll(...): {strokes, texts};  // Both types
  getAllStrokes(): StrokeView[];
  getAllTexts(): TextView[];
}
```

**Dependencies:**
```bash
# Installed in shared package
pnpm add rbush@^4.0.1 --filter=@avlo/shared
pnpm add @types/rbush@^3.0.5 --filter=@avlo/shared -D
```

### RoomDocManager Integration
**File:** [`client/src/lib/room-doc-manager.ts`](client/src/lib/room-doc-manager.ts)

**Authoritative State (Class Fields):**
```typescript
// Source of truth (persistent across snapshots)
private strokesById = new Map<string, StrokeView>();
private textsById = new Map<string, TextView>();

// Acceleration structure (derived, queryable facade)
private spatialIndex: RBushSpatialIndex | null = null;

// Epoch control
private needsSpatialRebuild = true;

// Observer cleanup references
private _strokesObserver: ((event: Y.YArrayEvent<any>) => void) | null = null;
private _textsObserver: ((event: Y.YArrayEvent<any>) => void) | null = null;
private _arraysObserved: boolean = false;

// Scene change detection
private prevScene: number = 0;
```

**Key Methods:**
- `setupArrayObservers()` - Attaches Y.Array observers (called AFTER structure initialization)
- `hydrateViewsFromY()` - Walks Y.Arrays to build Maps (Epoch 1)
- `rebuildSpatialIndexFromViews()` - BulkLoad RBush from Maps (Epoch 1)
- `composeSnapshotFromMaps()` - Derives snapshot arrays from Maps
- `buildSnapshot()` - Main epoch branching logic

### Rendering Integration
**File:** [`client/src/renderer/layers/strokes.ts`](client/src/renderer/layers/strokes.ts)

**Critical Fix Applied:** ULID sorting for deterministic z-order
```typescript
export function drawStrokes(ctx, snapshot, viewTransform, viewport) {
  // Spatial query (O(log N + K))
  const candidateStrokes = snapshot.spatialIndex.queryRect(
    visibleBounds.minX, visibleBounds.minY,
    visibleBounds.maxX, visibleBounds.maxY
  );

  // ✅ CRITICAL: Sort by ULID for deterministic draw order
  const sortedCandidates = [...candidateStrokes].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );

  // Render in ULID order (oldest first → newest on top)
  for (const stroke of sortedCandidates) {
    if (shouldSkipLOD(stroke, viewTransform)) continue;
    renderStroke(ctx, stroke, viewTransform);
  }
}
```

**Why ULID Sort is Critical:**
- RBush query order is **non-deterministic** (depends on tree shape, viewport, refresh timing)
- Without sorting, different tabs render the same strokes in **different z-orders**
- ULID provides **globally consistent lexicographic ordering**
- Cost is O(K log K) where K = visible strokes (cheap because K << N)

### Eraser Tool Integration
**File:** [`client/src/lib/tools/EraserTool.ts`](client/src/lib/tools/EraserTool.ts)

Uses combined spatial query for both strokes and texts:
```typescript
private updateHitTest(worldX: number, worldY: number): void {
  const radiusWorld = this.state.radiusPx / viewTransform.scale;

  if (snapshot.spatialIndex) {
    // Combined query (O(log N + K))
    const results = snapshot.spatialIndex.queryRectAll(
      worldX - radiusWorld, worldY - radiusWorld,
      worldX + radiusWorld, worldY + radiusWorld
    );

    // Test strokes (bbox already includes stroke width)
    for (const stroke of results.strokes) {
      if (this.strokeHitTest(worldX, worldY, stroke.points, radiusWorld)) {
        this.state.hitNow.add(stroke.id);
      }
    }

    // Test texts
    for (const text of results.texts) {
      if (this.circleRectIntersect(worldX, worldY, radiusWorld, text.x, text.y, text.w, text.h)) {
        this.state.hitNow.add(text.id);
      }
    }
  }
}
```

---

## Observer Pattern (Direct Updates)

### Y.Array Observer Implementation

**Location:** `room-doc-manager.ts` → `setupArrayObservers()`

**Strokes Observer:**
```typescript
this._strokesObserver = (event: Y.YArrayEvent<any>) => {
  // CRITICAL: Ignore during rebuild epoch
  if (this.needsSpatialRebuild) return;

  // Process INSERTS from delta
  for (const delta of event.changes.delta) {
    if ('insert' in delta) {
      for (const raw of delta.insert) {
        const view = buildStrokeView(raw);
        this.strokesById.set(view.id, view);      // Update map
        this.spatialIndex?.insertStroke(view);    // Update index (O(log N))
      }
    }
  }

  // Process DELETES from changes.deleted
  event.changes.deleted.forEach((item) => {
    const removedItems = item.content.getContent();
    for (const raw of removedItems) {
      this.strokesById.delete(raw.id);          // Update map
      this.spatialIndex?.removeById(raw.id);    // Update index (O(log N))
    }
  });
};
strokes.observe(this._strokesObserver);
```

**Texts Observer:** (Same pattern as strokes)

**Key Properties:**
- ✅ **Early return during rebuild** - Prevents stale incremental updates
- ✅ **Y.js provides deleted IDs** - Via `item.content.getContent()` (no ID tracking needed)
- ✅ **Direct updates** - No journaling, no buffering
- ✅ **O(log N) operations** - Insert/remove on both Map and RBush

---

## Snapshot Composition

### Derivation from Maps

**Location:** `room-doc-manager.ts` → `composeSnapshotFromMaps()`

```typescript
private composeSnapshotFromMaps(): Snapshot {
  // Derive arrays from maps (order is NOT semantic)
  const strokes = Array.from(this.strokesById.values());
  const texts = Array.from(this.textsById.values());

  return {
    docVersion: this.docVersion,
    scene: this.getCurrentScene(),
    strokes,  // Renderer will sort by ULID before drawing
    texts,
    presence: this.buildPresenceView(),
    spatialIndex: this.spatialIndex,  // Live index, not cloned
    view: this.getViewTransform(),
    meta: { /* ... */ },
    createdAt: Date.now(),
  };
}
```

**Key Properties:**
- ✅ **Maps are source of truth** - Persistent across snapshots
- ✅ **Arrays are derived outputs** - Built on-demand from Maps
- ✅ **Spatial index is live** - Shared read-only facade (not cloned)
- ✅ **Map insertion order is NOT semantic** - Renderer sorts by ULID

---

## Initialization Sequence

### Critical Order (MUST FOLLOW)

**Location:** `room-doc-manager.ts` → Constructor + `whenGateOpen('idbReady')`

```typescript
// 1. Constructor: DO NOT call setupArrayObservers() here!
constructor(roomId: string) {
  this.ydoc = new Y.Doc({ guid: roomId });
  this.setupObservers();  // Y.Doc 'update' observer only
  // ... provider setup ...
}

// 2. After IDB ready + WS synced (or 350ms grace)
this.whenGateOpen('idbReady').then(async () => {
  await Promise.race([
    this.whenGateOpen('wsSynced'),
    this.delay(350),
  ]);

  const root = this.ydoc.getMap('root');
  if (!root.has('meta')) {
    this.initializeYjsStructures();  // First-time seed
  }

  // ✅ NOW it's safe to attach array observers
  this.setupArrayObservers();
});
```

**Why This Order Matters:**
- ❌ **Attaching observers before structures exist** → "Strokes structure corrupted" errors
- ✅ **Wait for IDB + WS** → Ensures Y.Arrays are initialized or seeded
- ✅ **Then attach observers** → Observers see valid Y.Array references

---

## Removed Complexity (What We Don't Do)

### ❌ Removed: Ordered ID Arrays
```typescript
// ❌ REMOVED (not needed)
private orderedStrokeIds: string[] = [];
private orderedTextIds: string[] = [];
```
**Why:** Y.js tells us deleted IDs via `event.changes.deleted.getContent()`. Eraser builds id→index map on-demand (only code that needs Y.Array indices).

### ❌ Removed: ID Journals
```typescript
// ❌ REMOVED (not needed)
private strokeAddedIds: string[] = [];
private strokeDeletedIds: string[] = [];
```
**Why:** Observers update Maps and RBush **directly** - no buffering needed.

### ❌ Removed: Index-Based Journals
```typescript
// ❌ REMOVED (not needed)
private strokeJournal: {
  adds: { idx: number; items: any[] }[];
  dels: { idx: number; count: number }[];
};
```
**Why:** Required complex splice logic. Observers extract IDs directly from Y.js events.

### ❌ Removed: Previous Snapshot Arrays
```typescript
// ❌ REMOVED (not needed)
private prevStrokeViews: ReadonlyArray<StrokeView> = [];
private prevTextViews: ReadonlyArray<TextView> = [];
```
**Why:** Maps are persistent - no need for "previous" state. Snapshot arrays are derived outputs.

### ❌ Removed: Deep Object.freeze
```typescript
// ❌ REMOVED from hot paths
Object.freeze(strokes);
strokes.forEach((s) => Object.freeze(s));
```
**Why:** O(N) cost every snapshot. Not needed - Maps are manager-internal, snapshots are read-only by convention.

---

## Performance Characteristics

### Spatial Query Performance
| Operation | Complexity | Use Case |
|-----------|-----------|----------|
| Viewport culling | O(log N + K) | `drawStrokes()` |
| Eraser hit-test | O(log N + K) | `EraserTool.updateHitTest()` |
| Scene rebuild | O(N log N) | Clear board, first load |
| Incremental insert | O(log N) | New stroke committed |
| Incremental delete | O(log N) | Eraser removes stroke |

**Where:**
- N = Total strokes/texts in scene
- K = Results returned (visible items, hit items)

### Memory Footprint
- **Maps:** O(N) - One entry per stroke/text
- **RBush:** O(N) - One IndexEntry per item
- **Total:** ~2× overhead vs raw Y.Arrays (acceptable for O(log N) queries)

---

## Critical Invariants (NEVER VIOLATE)

### 1. Stored BBox Includes Inflation
```typescript
// ✅ CORRECT - bbox already includes (strokeSize * 0.5 + 1)
const [minX, minY, maxX, maxY] = stroke.bbox;
this.spatialIndex.insertStroke(stroke);  // Use bbox as-is
```

### 2. RBush Uses Stored BBox Directly
```typescript
// ✅ CORRECT - no re-inflation
if (stroke.bbox && stroke.bbox.length === 4) {
  const [minX, minY, maxX, maxY] = stroke.bbox;
  items.push({ minX, minY, maxX, maxY, id: stroke.id, kind: 'stroke', data: stroke });
}
```

### 3. Snapshot Immutability
```typescript
// ✅ CORRECT - spatial index is read-only facade
return {
  spatialIndex: this.spatialIndex,  // Live index, not cloned
  // ...
};
```

### 4. Scene Filtering
```typescript
// ✅ CORRECT - only current scene in Maps/Index
if (raw.scene !== currentScene) continue;
```

### 5. Observer Ignore During Rebuild
```typescript
// ✅ CRITICAL - prevent stale incremental updates
if (this.needsSpatialRebuild) return;
```

### 6. ULID Sort Before Rendering
```typescript
// ✅ CRITICAL - deterministic z-order across tabs
const sortedCandidates = [...candidateStrokes].sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0
);
```

---

## Debugging & Diagnostics

### RBush Stats (Development)
```typescript
// Available in RBushSpatialIndex
getStats(): { treeSize: number; strokeCount: number; textCount: number }
```

### Sanity Checks
```typescript
// Rebuild trigger conditions
if (this.strokesById.size === 0 && yStrokes.length > 0) {
  console.warn('[RoomDocManager] Sanity check failed: maps empty but Y.Arrays have content');
  this.needsSpatialRebuild = true;
}
```

### Gate Status
```typescript
// Check if observers are attached
console.log('Arrays observed:', this._arraysObserved);
console.log('Needs rebuild:', this.needsSpatialRebuild);
console.log('Spatial index size:', this.spatialIndex?.getStats());
```

---

## Known Limitations & Future Work

### Current Limitations
1. **Scene ticks will be removed** - Future: per-user clear with atomic Y.js delete
2. **No multi-scene index** - Current: rebuild on scene change (acceptable UX)
3. **No persistent cache** - RBush rebuilds on page load (O(N log N) once)

### Future Optimizations
1. **WebWorker offload** - Build RBush off main thread for large scenes
2. **Dirty rect spatial query** - Query per dirty rect instead of full viewport
3. **Canvas clipping** - Clip to dirty regions during partial redraws

---

## Testing Checklist

### ✅ Verified Behaviors
- [x] First load: Maps hydrate from Y.Arrays
- [x] Refresh: IDB loads content, observers attach, no content loss
- [x] Drawing: New strokes insert incrementally (O(log N))
- [x] Erasing: Strokes/texts delete incrementally (O(log N))
- [x] Clear board: Full rebuild on scene change
- [x] Z-order: ULID sort ensures consistent rendering across tabs
- [x] Viewport culling: Only visible strokes rendered
- [x] Eraser hit-test: Spatial query returns correct candidates

### 🧪 Stress Test Scenarios
- [ ] 5000 strokes: Verify no performance degradation
- [ ] Rapid erasing: Verify index consistency
- [ ] Multi-tab refresh: Verify z-order consistency
- [ ] Scene change: Verify full rebuild completes

---

## Summary

The RBush spatial index is **production-ready** and provides significant performance improvements over the previous UniformGrid:

✅ **O(log N) queries** vs O(N) linear scans
✅ **Incremental updates** vs full rebuilds every frame
✅ **Deterministic rendering** via ULID sorting
✅ **Minimal state** - Maps as single source of truth
✅ **Clean architecture** - Two-epoch model with clear separation

The implementation is **stable**, **tested**, and **operational** across all major code paths (rendering, eraser, scene changes, multi-tab sync).
