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

---

## Core Implementation Details

### IndexEntry Data Structure

RBush stores items as **IndexEntry** objects that combine spatial bounds with object metadata:

```typescript
export interface IndexEntry {
  minX: number;      // World coordinates (NOT screen pixels)
  minY: number;
  maxX: number;
  maxY: number;
  id: string;        // ULID for strokes/texts
  kind: 'stroke' | 'text';  // Discriminant for filtering queries
  data: StrokeView | TextView;  // Full object reference
}
```

**Key Properties:**
- **World-space bounds:** All coordinates are in world units (px at scale=1), never screen/device pixels
- **Embedded discriminant:** `kind` field enables type-safe filtering without instanceof checks
- **Full object reference:** `data` field holds complete StrokeView/TextView (not just ID)
- **RBush protocol:** minX/minY/maxX/maxY are the ONLY required fields for RBush R-tree operations

### RBush Tree Configuration

```typescript
constructor() {
  // maxEntries = 9 is RBush default (optimal for most use cases)
  this.tree = new RBush<IndexEntry>(9);
  this.strokesById = new Map();
  this.textsById = new Map();
}
```

**maxEntries Parameter:**
- Controls R-tree node fanout (branch factor)
- Default `9` balances tree height vs node overhead
- Lower values → taller tree, more traversals
- Higher values → wider tree, more comparisons per node
- `9` is empirically optimal for 2D spatial data (RBush author recommendation)

### View Construction from Y.js Data

**StrokeView Construction (Observer + Hydration):**
```typescript
// Inline construction (no helper function - code appears in two places)
const view: StrokeView = {
  id: raw.id,                        // ULID from commit
  points: raw.points,                // Flattened [x,y,x,y,...] (plain number[])
  pointsTuples: raw.pointsTuples ?? null,  // [[x,y],[x,y],...] for PF (nullable)
  polyline: null,                    // Built at RENDER time only
  style: {
    color: raw.color,                // #RRGGBB hex string
    size: raw.size,                  // World units (px at scale=1)
    opacity: raw.opacity,            // 0..1 (pen: 1.0, highlighter: 0.45)
    tool: raw.tool,                  // 'pen' | 'highlighter'
  },
  bbox: raw.bbox,                    // [minX, minY, maxX, maxY] ALREADY INFLATED
  scene: raw.scene,                  // Scene index (assigned at commit)
  createdAt: raw.createdAt,          // ms epoch timestamp
  userId: raw.userId,                // Awareness ID at commit
  kind: raw.kind ?? 'shape',         // 'freehand' | 'shape' (default 'shape' for old data)
};
```

**TextView Construction:**
```typescript
const view: TextView = {
  id: raw.id,
  x: raw.x,           // World anchor (top-left corner)
  y: raw.y,
  w: raw.w,           // Layout box dimensions (world units)
  h: raw.h,
  content: raw.content,  // Plain text content
  color: raw.color,
  size: raw.size,        // Font size (world units)
  scene: raw.scene,
  createdAt: raw.createdAt,
  userId: raw.userId,
};
```

**Construction Locations:**
1. **Observer (incremental):** `setupArrayObservers()` → `_strokesObserver` inline (lines 1323-1339)
2. **Hydration (rebuild):** `hydrateViewsFromY()` inline (lines 1453-1469)

**Why No Helper Function:**
- Construction is trivial (direct field mapping)
- Only two call sites (observer + hydration)
- Inline code is clearer than abstraction overhead
- TypeScript infers correct types from object literals

### BBox Inflation Invariant (CRITICAL)

**The Single Source of Truth:**

Bboxes are inflated **ONCE** at commit time in `simplification.ts`:

```typescript
// File: client/src/lib/tools/simplification.ts
export function calculateBBox(
  points: [number, number][],
  strokeSize: number
): [number, number, number, number] {
  // Find min/max from centerline points
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  // CRITICAL: Inflate bounds for proper invalidation
  // This is in WORLD units (DPR handled at canvas level)
  const padding = strokeSize * 0.5 + 1;  // ← THE INFLATION FORMULA
  return [minX - padding, minY - padding, maxX + padding, maxY + padding];
}
```

**Inflation Formula Breakdown:**
- `strokeSize * 0.5` → Stroke radius (half-width extends from centerline)
- `+ 1` → Anti-aliasing margin (1 world unit = 1px at scale=1)
- Applied to ALL four edges → Full visual bounds of rendered stroke

**Why This Works:**
- **Perfect Freehand polygons:** PF outline already wider than centerline + radius
- **Stroked polylines:** Canvas stroke extends `lineWidth/2` from path
- **1px margin:** Covers sub-pixel AA bleeding at any scale

**Consumer Guarantee:**
```typescript
// ✅ RBush: Use bbox as-is, NEVER re-inflate
if (stroke.bbox && stroke.bbox.length === 4) {
  const [minX, minY, maxX, maxY] = stroke.bbox;  // Direct destructure
  items.push({ minX, minY, maxX, maxY, id, kind: 'stroke', data: stroke });
}

// ✅ Eraser: Query with tool radius only (bbox already includes stroke width)
const radiusWorld = eraserRadiusPx / viewTransform.scale;
const results = spatialIndex.queryRectAll(
  worldX - radiusWorld, worldY - radiusWorld,
  worldX + radiusWorld, worldY + radiusWorld
);
// No additional stroke width inflation needed!
```

**Historical Bug (FIXED):**
- Old code inflated AGAIN by `strokeWidth/2` during queries
- Caused "ghost hits" where eraser detected strokes far from cursor
- RBush implementation enforces single-inflation invariant

### Text BBox Calculation

**Texts compute bbox dynamically** (no stored bbox field in Y.js):

```typescript
// Texts use layout box directly (no inflation needed - text rendering is exact)
insertText(text: TextView): void {
  this.tree.insert({
    minX: text.x,              // Top-left anchor
    minY: text.y,
    maxX: text.x + text.w,     // Bottom-right = anchor + dimensions
    maxY: text.y + text.h,
    id: text.id,
    kind: 'text',
    data: text,
  });
  this.textsById.set(text.id, text);
}
```

**Why No Inflation:**
- Text rendering is pixel-exact (no stroke width, no AA bleed)
- Layout box (`w` × `h`) already matches visual bounds
- Font metrics pre-computed during TextTool commit

### Stroke vs Text Asymmetry Table

| Property | Strokes | Texts |
|----------|---------|-------|
| **BBox Source** | Stored in Y.js (`bbox` field) | Computed from `x,y,w,h` |
| **Inflation** | Applied at commit (`strokeSize*0.5+1`) | None (layout box is exact) |
| **Coordinates** | Centerline points + bbox | Anchor + dimensions |
| **Y.js Fields** | `points`, `bbox`, `kind`, `style` | `x`, `y`, `w`, `h`, `content` |
| **Polyline** | Built at render time (null in storage) | N/A |
| **Scene Filter** | Applied (only current scene indexed) | Applied (only current scene indexed) |

### Query Operations (Internal Implementation)

**queryRect (Strokes Only):**
```typescript
queryRect(minX: number, minY: number, maxX: number, maxY: number): ReadonlyArray<StrokeView> {
  const results = this.tree.search({ minX, minY, maxX, maxY });

  // Filter to strokes only
  return results
    .filter(item => item.kind === 'stroke')
    .map(item => item.data as StrokeView);
}
```

**queryRectAll (Strokes + Texts):**
```typescript
queryRectAll(minX: number, minY: number, maxX: number, maxY: number): {
  strokes: ReadonlyArray<StrokeView>;
  texts: ReadonlyArray<TextView>;
} {
  const results = this.tree.search({ minX, minY, maxX, maxY });

  const strokes = results
    .filter(item => item.kind === 'stroke')
    .map(item => item.data as StrokeView);

  const texts = results
    .filter(item => item.kind === 'text')
    .map(item => item.data as TextView);

  return { strokes, texts };
}
```

**queryCircle (Circle→Rect Approximation):**
```typescript
queryCircle(cx: number, cy: number, radius: number): ReadonlyArray<StrokeView> {
  // Use bounding square as conservative query (cheap rect query)
  const results = this.tree.search({
    minX: cx - radius,
    minY: cy - radius,
    maxX: cx + radius,
    maxY: cx + radius,
  });

  // Caller performs fine-grained circle test on results
  return results
    .filter(item => item.kind === 'stroke')
    .map(item => item.data as StrokeView);
}
```

**RBush.search() Internals:**
- R-tree traversal from root
- Prune branches with non-overlapping MBRs (minimum bounding rectangles)
- Collect all leaf entries with overlapping bounds
- Returns flat array of IndexEntry objects
- **Order is non-deterministic** (depends on tree shape, traversal order)
- Complexity: O(log N + K) where K = results

**Why Filter After Query:**
- RBush stores BOTH strokes and texts in same tree
- Single unified spatial index (no separate trees)
- Filter by `kind` to return requested type
- `queryRectAll` returns BOTH types without filtering

### Remove Operation (Tricky Equality)

**The Challenge:**

RBush.remove() requires **exact object match** by default (reference equality). Since we're creating NEW IndexEntry objects, we need a **custom comparator:**

```typescript
removeById(id: string): void {
  const stroke = this.strokesById.get(id);
  const text = this.textsById.get(id);

  if (stroke && stroke.bbox) {
    const [minX, minY, maxX, maxY] = stroke.bbox;
    // Custom comparator: match by ID, not reference
    this.tree.remove({
      minX, minY, maxX, maxY,
      id: stroke.id,
      kind: 'stroke',
      data: stroke,
    } as any, (a, b) => a.id === b.id);  // ← CRITICAL: ID-based equality
    this.strokesById.delete(id);
  } else if (text) {
    this.tree.remove({
      minX: text.x,
      minY: text.y,
      maxX: text.x + text.w,
      maxY: text.y + text.h,
      id: text.id,
      kind: 'text',
      data: text,
    } as any, (a, b) => a.id === b.id);  // ← CRITICAL: ID-based equality
    this.textsById.delete(id);
  }
}
```

**Why This is Necessary:**
- Default RBush.remove() uses `===` (reference equality)
- We create a NEW IndexEntry object for removal (not same reference as inserted entry)
- Custom comparator `(a, b) => a.id === b.id` matches by ID
- RBush finds the entry with matching bounds AND matching ID
- Removes it from the tree

**Without Custom Comparator:**
- RBush.remove() would fail silently (no match found)
- Entry would remain in tree → memory leak + stale query results
- Maps would be out-of-sync with tree

### Bulk Load Operation

**Optimized Initial Population:**

```typescript
bulkLoad(strokes: ReadonlyArray<StrokeView>, texts: ReadonlyArray<TextView>): void {
  const items: IndexEntry[] = [];

  // Add strokes - use stored bbox directly (already inflated)
  for (const stroke of strokes) {
    if (stroke.bbox && stroke.bbox.length === 4) {
      const [minX, minY, maxX, maxY] = stroke.bbox;
      items.push({ minX, minY, maxX, maxY, id: stroke.id, kind: 'stroke', data: stroke });
      this.strokesById.set(stroke.id, stroke);
    }
  }

  // Add texts - compute bbox from x,y,w,h
  for (const text of texts) {
    items.push({
      minX: text.x,
      minY: text.y,
      maxX: text.x + text.w,
      maxY: text.y + text.h,
      id: text.id,
      kind: 'text',
      data: text,
    });
    this.textsById.set(text.id, text);
  }

  if (items.length > 0) {
    this.tree.load(items);  // RBush.load() uses OMT (Overlap Minimizing Top-down) algorithm
  }
}
```

**RBush.load() vs RBush.insert():**

| Operation | Algorithm | Complexity | Use Case |
|-----------|-----------|------------|----------|
| `load()` | OMT bulk-build | O(N log N) | Initial load, full rebuild |
| `insert()` | Incremental R-tree insert | O(log N) | Single item add |

**OMT Algorithm:**
- Sorts items by spatial proximity
- Builds balanced tree bottom-up
- Minimizes bounding box overlap between nodes
- Produces optimal tree structure (better query performance)
- **Only works on empty tree** (clears tree first)

**Why We Use load():**
- Scene changes require full rebuild → clear + load
- First snapshot after page load → load from IDB
- Better tree quality than N sequential inserts
- ~5-10x faster than insert() loop for large N

### Internal Maps (Bookkeeping)

**Dual-Purpose Design:**

```typescript
private strokesById: Map<string, StrokeView>;
private textsById: Map<string, TextView>;
```

**Purpose 1: Fast ID→Object Lookup**
- Used by `removeById()` to find entry for removal
- Avoids O(N) tree scan to find entry by ID
- Maps are O(1) lookup by ID

**Purpose 2: getAllStrokes() / getAllTexts()**
```typescript
getAllStrokes(): ReadonlyArray<StrokeView> {
  return Array.from(this.strokesById.values());
}
```
- Faster than `this.tree.all().filter(...)` (no tree traversal + filter)
- Used by fallback code paths when spatial index unavailable

**Synchronization Invariants:**
- Maps ALWAYS in sync with tree (updated together)
- Insert: Add to both tree and map
- Remove: Remove from both tree and map
- Clear: Clear both tree and maps
- **Never allow map/tree divergence** (would cause subtle bugs)

---

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
