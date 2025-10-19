# RBush Spatial Indexing Implementation Guide

## Implementation Status
- **Phase 1**: RBush Installation & Adapter ✅ COMPLETE
- **Phase 2**: RoomDocManager Integration ✅ COMPLETE (with two critical fixes)
- **Phase 3**: Snapshot Integration - IN PROGRESS
- **Phase 4**: Rendering Optimization - PENDING

## Critical Fixes Applied (Phase 2)

### Fix 1: Initialization Order
A critical initialization order bug was discovered and fixed. Y.Array observers were being attached before Y.js structures existed, causing "Strokes structure corrupted" errors. The fix ensures observers are only attached AFTER structures are initialized via the IDB gate callback.

### Fix 2: Hydration on Refresh (LATEST)
A critical bug where content would disappear on refresh was fixed. The issue occurred when IndexedDB loaded existing Y.Doc content but `prevStrokeViews` was empty with no journals, resulting in empty arrays being returned. The fix adds a hydration check in `buildViewsIncrementally()` that directly reads from Y.Arrays when `prevViews` are empty but Y.Arrays have content. See Step 2.4 for implementation details.

## Executive Summary

This guide provides a comprehensive, error-free implementation plan for replacing the current UniformGrid spatial index with RBush (R-tree) in the AVLO collaborative whiteboard. The implementation will eliminate the O(N × cells) spatial index rebuild on every snapshot, reduce O(N) scans in rendering, and fix the current double-inflation bug.

## Critical Discoveries

1. **Spatial index is rebuilt from scratch on EVERY snapshot** (line 1732 room-doc-manager.ts) - causing 5-50ms overhead per frame
2. **Stored bbox ALREADY includes inflation** of `(strokeSize * 0.5 + 1)` (line 29 simplification.ts)
3. **Current eraser has TRIPLE INFLATION BUG**:
   - Stroke bbox already inflated by `strokeWidth/2 + 1` (visual bounds)
   - Eraser inflates by `eraserRadius + strokeWidth/2` (line 235 EraserTool.ts)
   - UniformGrid inflates AGAIN by `strokeWidth/2` (double inflation)
4. **NO Y.Array observers exist** - only top-level Y.Doc 'update' event (line 1220 room-doc-manager.ts)
5. **Write patterns are append-only and delete** - no in-place modifications (DrawingTool.push, EraserTool.delete)
6. **Eraser queries strokes only** - texts are O(N) scanned (line 275-283 EraserTool.ts)
7. **NO CANVAS CLIPPING for dirty rects** - RenderLoop clears rects but draws ALL strokes (line 377)
8. **drawStrokes does O(N) iteration** - ignores spatial index, iterates snapshot.strokes (line 45-61)

---

## Phase 1: RBush Installation & Adapter

### Step 1.1: Install RBush

```bash
# Install in shared package instead
cd /home/issak/dev/avlo
pnpm add rbush@^4.0.1 --filter=@avlo/shared
pnpm add @types/rbush@^3.0.5 --filter=@avlo/shared -D
Updated File Location:
Move the RBush implementation to shared: File: /home/issak/dev/avlo/packages/shared/src/spatial/rbush-spatial-index.ts 

```
Do: packages/shared/src/spatial/rbush-spatial-index.ts (and re-export via packages/shared/src/spatial/index.ts if you want a stable import path)

### Step 1.2: Create RBush Adapter

**File:** `/home/issak/dev/avlo/packages/shared/src/spatial/rbush-spatial-index.ts`

```typescript
import RBush from 'rbush';
import type { SpatialIndex, StrokeView, TextView } from '@avlo/shared';

export interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  kind: 'stroke' | 'text';
  data: StrokeView | TextView;
}

export class RBushSpatialIndex implements SpatialIndex {
  private tree: RBush<IndexEntry>;
  private strokesById: Map<string, StrokeView>;
  private textsById: Map<string, TextView>;

  constructor() {
    // maxEntries = 9 is RBush default, good for most cases
    this.tree = new RBush<IndexEntry>(9);
    this.strokesById = new Map();
    this.textsById = new Map();
  }

  /**
   * Clear the index completely (for scene changes)
   */
  clear(): void {
    this.tree.clear();
    this.strokesById.clear();
    this.textsById.clear();
  }

  /**
   * Bulk load initial data (for first room join)
   */
  bulkLoad(strokes: ReadonlyArray<StrokeView>, texts: ReadonlyArray<TextView>): void {
    const items: IndexEntry[] = [];

    // Add strokes - use stored bbox directly (already inflated)
    for (const stroke of strokes) {
      if (stroke.bbox && stroke.bbox.length === 4) {
        const [minX, minY, maxX, maxY] = stroke.bbox;
        items.push({
          minX, minY, maxX, maxY,
          id: stroke.id,
          kind: 'stroke',
          data: stroke,
        });
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
      this.tree.load(items);
    }
  }

  /**
   * Insert a single stroke (incremental update)
   */
  insertStroke(stroke: StrokeView): void {
    if (!stroke.bbox || stroke.bbox.length !== 4) return;

    const [minX, minY, maxX, maxY] = stroke.bbox;
    this.tree.insert({
      minX, minY, maxX, maxY,
      id: stroke.id,
      kind: 'stroke',
      data: stroke,
    });
    this.strokesById.set(stroke.id, stroke);
  }

  /**
   * Insert a single text (incremental update)
   */
  insertText(text: TextView): void {
    this.tree.insert({
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

  /**
   * Remove by ID (for deletions)
   */
  removeById(id: string): void {
    // Find the entry to remove
    const stroke = this.strokesById.get(id);
    const text = this.textsById.get(id);

    if (stroke && stroke.bbox) {
      const [minX, minY, maxX, maxY] = stroke.bbox;
      // RBush remove requires exact match
      this.tree.remove({
        minX, minY, maxX, maxY,
        id: stroke.id,
        kind: 'stroke',
        data: stroke,
      } as any, (a, b) => a.id === b.id);
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
      } as any, (a, b) => a.id === b.id);
      this.textsById.delete(id);
    }
  }

  // SpatialIndex interface implementation
  queryCircle(cx: number, cy: number, radius: number): ReadonlyArray<StrokeView> {
    const results = this.tree.search({
      minX: cx - radius,
      minY: cy - radius,
      maxX: cx + radius,
      maxY: cy + radius,
    });

    // Filter to strokes only and return
    return results
      .filter(item => item.kind === 'stroke')
      .map(item => item.data as StrokeView);
  }

  queryRect(minX: number, minY: number, maxX: number, maxY: number): ReadonlyArray<StrokeView> {
    const results = this.tree.search({ minX, minY, maxX, maxY });

    // Filter to strokes only
    return results
      .filter(item => item.kind === 'stroke')
      .map(item => item.data as StrokeView);
  }

  // Include texts in rect query (for selection tools)
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

  getAllStrokes(): ReadonlyArray<StrokeView> {
    return Array.from(this.strokesById.values());
  }

  getAllTexts(): ReadonlyArray<TextView> {
    return Array.from(this.textsById.values());
  }

  // Debug helper
  getStats(): { treeSize: number; strokeCount: number; textCount: number } {
    return {
      treeSize: this.tree.all().length,
      strokeCount: this.strokesById.size,
      textCount: this.textsById.size,
    };
  }
}
```

---

## Phase 2: RoomDocManager Integration (COMPLETED ✓)

### ⚠️ CRITICAL: Initialization Order Requirement

**CRITICAL BUG DISCOVERED AND FIXED:** Y.Array observers MUST be attached AFTER Y.js structures are initialized. Attempting to observe arrays before they exist will cause errors like "Strokes structure corrupted".

The proper initialization sequence is:
1. Setup Y.Doc update observer (`setupObservers`)
2. Initialize IndexedDB provider
3. Initialize WebSocket provider
4. Wait for IDB ready gate
5. Initialize Y.js structures (if needed)
6. **ONLY THEN** attach array observers

### Step 2.1: Add RBush and Journals to RoomDocManager

**File:** `/home/issak/dev/avlo/client/src/lib/room-doc-manager.ts`

Add these fields to the class (around line 247):

```typescript
// Spatial index (manager-owned, incrementally maintained)
private spatialIndex: RBushSpatialIndex | null = null;

// Array observer functions for cleanup
private _strokesObserver: ((event: Y.YArrayEvent<any>) => void) | null = null;
private _textsObserver: ((event: Y.YArrayEvent<any>) => void) | null = null;

// Journal for incremental updates (cleared each publish)
private strokeJournal: {
  adds: { idx: number; items: any[] }[];
  dels: { idx: number; count: number }[];
} = { adds: [], dels: [] };

private textJournal: {
  adds: { idx: number; items: any[] }[];
  dels: { idx: number; count: number }[];
} = { adds: [], dels: [] };

// Track if we need to rebuild (scene change)
private needsSpatialRebuild = true;

// Previous snapshot arrays for splice optimization
private prevStrokeViews: ReadonlyArray<StrokeView> = [];
private prevTextViews: ReadonlyArray<TextView> = [];

// Track previous scene for change detection
private prevScene: number = 0;

// Track whether array observers have been attached
private _arraysObserved: boolean = false;
```

### Step 2.2: Add Y.Array Observers

Add this method after `setupObservers()` (around line 1295):

```typescript
// Phase 2: Y.Array Observers for incremental updates
private setupArrayObservers(): void {
  // Make idempotent - only attach once
  if (this._arraysObserved) return;

  // Get the root to check if structures exist
  const root = this.getRoot();
  const strokes = root.get('strokes');
  const texts = root.get('texts');

  // Hard assert: if this trips, the call ordering regressed
  if (!(strokes instanceof Y.Array) || !(texts instanceof Y.Array)) {
    throw new Error('setupArrayObservers(): structures not initialized');
  }

  // Shallow observe strokes array
  this._strokesObserver = (event) => {
    // Clear journal for this transaction
    this.strokeJournal.adds = [];
    this.strokeJournal.dels = [];

    let idx = 0;
    for (const delta of event.changes.delta) {
      if ('retain' in delta) {
        idx += delta.retain!;
      } else if ('delete' in delta) {
        this.strokeJournal.dels.push({ idx, count: delta.delete! });
        // idx doesn't move on delete (deleted items are gone)
      } else if ('insert' in delta) {
        const items = delta.insert as any[];
        this.strokeJournal.adds.push({ idx, items });
        idx += items.length;
      }
    }

    // Note: publishState.isDirty is already set by the Y.Doc update observer
    // No need to set it again here
  };
  strokes.observe(this._strokesObserver);

  // Shallow observe texts array
  this._textsObserver = (event) => {
    // Clear journal for this transaction
    this.textJournal.adds = [];
    this.textJournal.dels = [];

    let idx = 0;
    for (const delta of event.changes.delta) {
      if ('retain' in delta) {
        idx += delta.retain!;
      } else if ('delete' in delta) {
        this.textJournal.dels.push({ idx, count: delta.delete! });
        // idx doesn't move on delete (deleted items are gone)
      } else if ('insert' in delta) {
        const items = delta.insert as any[];
        this.textJournal.adds.push({ idx, items });
        idx += items.length;
      }
    }

    // Note: publishState.isDirty is already set by the Y.Doc update observer
    // No need to set it again here
  };
  texts.observe(this._textsObserver);

  // Mark observers as attached
  this._arraysObserved = true;

  // First-time sync: we may have missed some edits before observers attached.
  // Force one full rebuild path once, then journals take over.
  this.needsSpatialRebuild = true;
  this.publishState.isDirty = true;
}
```

### Step 2.3: Proper Initialization in Constructor

**⚠️ DO NOT call setupArrayObservers() directly in the constructor!**

Update the constructor initialization (around line 339-355):

```typescript
// In constructor, DO NOT call setupArrayObservers() here!
// this.setupArrayObservers(); // ❌ WRONG - structures don't exist yet

// Instead, add it to the whenGateOpen callback after structures are initialized:
this.whenGateOpen('idbReady').then(async () => {
  await Promise.race([
    this.whenGateOpen('wsSynced'),
    this.delay(350), // ~1–2 frames; prevents cross-tab fresh-room races
  ]);

  const root = this.ydoc.getMap('root');
  if (!root.has('meta')) {
    this.initializeYjsStructures();
  } else {
    this.logContainerIdentities('LOADED_FROM_IDB_OR_WS');
  }

  // ✅ Now that structures exist (either from IDB/WS or freshly initialized),
  // it's safe to attach array observers for incremental updates
  this.setupArrayObservers();
});
```

### Step 2.4: Cleanup in destroy() Method

Update the `destroy()` method to properly clean up array observers (around line 1160):

```typescript
// Remove Y.Array observers (Phase 2: RBush)
if (this._strokesObserver) {
  try {
    const root = this.getRoot();
    const strokes = root.get('strokes');
    if (strokes instanceof Y.Array) {
      strokes.unobserve(this._strokesObserver);
    }
  } catch {
    // Ignore errors during cleanup
  }
  this._strokesObserver = null;
}
if (this._textsObserver) {
  try {
    const root = this.getRoot();
    const texts = root.get('texts');
    if (texts instanceof Y.Array) {
      texts.unobserve(this._textsObserver);
    }
  } catch {
    // Ignore errors during cleanup
  }
  this._textsObserver = null;
}

// Clean up spatial index
if (this.spatialIndex) {
  this.spatialIndex.clear();
  this.spatialIndex = null;
}

// Clear journals
this.strokeJournal.adds = [];
this.strokeJournal.dels = [];
this.textJournal.adds = [];
this.textJournal.dels = [];
```

### Step 2.5: Modify buildSnapshot() to Use Incremental Updates

Replace the buildSnapshot method starting at line 1665:

```typescript
private buildSnapshot(): Snapshot {
  // Early return if not initialized
  const root = this.getRoot();
  const meta = root.get('meta') as Y.Map<unknown> | undefined;
  if (!meta) {
    return this.currentSnapshot;
  }

  // Get current scene
  const currentScene = this.getCurrentScene();

  // Check if scene changed (triggers rebuild)
  if (this.prevScene !== currentScene) {
    this.needsSpatialRebuild = true;
    this.prevScene = currentScene;
    // Clear previous arrays on scene change
    this.prevStrokeViews = [];
    this.prevTextViews = [];
  }

  // Build stroke and text views with incremental updates
  const { strokes, texts } = this.buildViewsIncrementally(currentScene);

  // Update spatial index incrementally
  if (!this.spatialIndex) {
    this.spatialIndex = new RBushSpatialIndex();
    this.needsSpatialRebuild = true;
  }

  if (this.needsSpatialRebuild) {
    // Full rebuild (scene change or first load)
    this.spatialIndex.clear();
    this.spatialIndex.bulkLoad(strokes, texts);
    this.needsSpatialRebuild = false;
  } else {
    // Apply incremental updates from journals
    this.applyJournalToSpatialIndex(strokes, texts);
  }

  // Build presence view
  const presence = this.buildPresenceView();

  // Build view transform
  const view: ViewTransform = this.getViewTransform();

  // Build metadata
  const meta: SnapshotMeta = {
    cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
    readOnly: this.roomStats?.bytes
      ? this.roomStats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES
      : false,
    bytes: this.roomStats?.bytes,
    expiresAt: this.roomStats?.expiresAt,
  };

  // Create frozen snapshot
  const snapshot: Snapshot = {
    docVersion: this.docVersion,
    scene: currentScene,
    strokes: Object.freeze(strokes) as ReadonlyArray<StrokeView>,
    texts: Object.freeze(texts) as ReadonlyArray<TextView>,
    presence,
    spatialIndex: this.spatialIndex, // Use live index
    view,
    meta,
    createdAt: Date.now(),
  };

  // Store for next incremental update
  this.prevStrokeViews = snapshot.strokes;
  this.prevTextViews = snapshot.texts;

  // Open G_FIRST_SNAPSHOT if needed
  if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
    this.openGate('firstSnapshot');
  }

  // Freeze in development
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
    Object.freeze(strokes);
    strokes.forEach((s) => Object.freeze(s));
    Object.freeze(texts);
    texts.forEach((t) => Object.freeze(t));
    return Object.freeze(snapshot);
  }

  return snapshot;
}
```

### Step 2.4: Add Incremental View Building

⚠️ **CRITICAL HYDRATION FIX**: A critical bug was discovered where content would disappear on refresh. The issue occurs when:
1. **First Load (Works):** Y.Arrays are empty → get populated → journals track changes → everything works
2. **After Refresh (Broken):** IndexedDB loads existing Y.Doc with strokes, but `prevStrokeViews` starts empty, journals are empty (no changes yet), resulting in empty arrays being returned.

**The Solution:** Check if `prevStrokeViews` is empty but Y.Arrays have content, and hydrate directly from Y.Doc.

Add this method after buildSnapshot:

```typescript
private buildViewsIncrementally(currentScene: number): {
  strokes: ReadonlyArray<StrokeView>;
  texts: ReadonlyArray<TextView>;
} {
  // CRITICAL: Hydration check for first load or refresh
  // If we have no previous views but Y.Arrays have content, we need to hydrate
  if (this.prevStrokeViews.length === 0 && this.prevTextViews.length === 0) {
    // Check if Y.Arrays have content that needs hydration
    const yStrokes = this.getStrokes();
    const yTexts = this.getTexts();

    if (yStrokes.length > 0 || yTexts.length > 0) {
      // Hydrate from Y.Arrays directly
      const hydratedStrokes: StrokeView[] = [];
      const hydratedTexts: TextView[] = [];

      // Build stroke views from Y.Array
      for (let i = 0; i < yStrokes.length; i++) {
        const raw = yStrokes.get(i);
        if (raw.scene !== currentScene) continue;

        const view: StrokeView = {
          id: raw.id,
          points: raw.points,
          pointsTuples: raw.pointsTuples ?? null,
          polyline: null, // Built at render time
          style: {
            color: raw.color,
            size: raw.size,
            opacity: raw.opacity,
            tool: raw.tool,
          },
          bbox: raw.bbox,
          scene: raw.scene,
          createdAt: raw.createdAt,
          userId: raw.userId,
          kind: raw.kind ?? 'shape',
        };
        hydratedStrokes.push(view);
      }

      // Build text views from Y.Array
      for (let i = 0; i < yTexts.length; i++) {
        const raw = yTexts.get(i);
        if (raw.scene !== currentScene) continue;

        const view: TextView = {
          id: raw.id,
          x: raw.x,
          y: raw.y,
          w: raw.w,
          h: raw.h,
          content: raw.content,
          color: raw.color,
          size: raw.size,
          scene: raw.scene,
          createdAt: raw.createdAt,
          userId: raw.userId,
        };
        hydratedTexts.push(view);
      }

      // Return hydrated views (will be stored in prevStrokeViews/prevTextViews after)
      return {
        strokes: hydratedStrokes,
        texts: hydratedTexts,
      };
    }
  }

  // If journals are empty and we have previous views, reuse them
  if (
    this.strokeJournal.adds.length === 0 &&
    this.strokeJournal.dels.length === 0 &&
    this.textJournal.adds.length === 0 &&
    this.textJournal.dels.length === 0 &&
    this.prevStrokeViews.length > 0
  ) {
    return {
      strokes: this.prevStrokeViews,
      texts: this.prevTextViews,
    };
  }

  // Start with copies of previous arrays
  let strokes = [...this.prevStrokeViews];
  let texts = [...this.prevTextViews];

  // Apply stroke deletions (reverse order to preserve indices)
  const strokeDels = [...this.strokeJournal.dels].sort((a, b) => b.idx - a.idx);
  for (const del of strokeDels) {
    const removed = strokes.slice(del.idx, del.idx + del.count);
    strokes.splice(del.idx, del.count);
  }

  // Apply stroke additions
  for (const add of this.strokeJournal.adds) {
    const mapped: StrokeView[] = [];
    for (const raw of add.items) {
      if (raw.scene !== currentScene) continue;

      // Map to view (same as current mapStroke logic)
      const view: StrokeView = {
        id: raw.id,
        points: raw.points,
        pointsTuples: raw.pointsTuples ?? null,
        polyline: null, // Built at render time
        style: {
          color: raw.color,
          size: raw.size,
          opacity: raw.opacity,
          tool: raw.tool,
        },
        bbox: raw.bbox,
        scene: raw.scene,
        createdAt: raw.createdAt,
        userId: raw.userId,
        kind: raw.kind ?? 'shape',
      };
      mapped.push(view);
    }

    strokes.splice(add.idx, 0, ...mapped);
  }

  // Apply text deletions
  const textDels = [...this.textJournal.dels].sort((a, b) => b.idx - a.idx);
  for (const del of textDels) {
    texts.splice(del.idx, del.count);
  }

  // Apply text additions
  for (const add of this.textJournal.adds) {
    const mapped: TextView[] = [];
    for (const raw of add.items) {
      if (raw.scene !== currentScene) continue;

      const view: TextView = {
        id: raw.id,
        x: raw.x,
        y: raw.y,
        w: raw.w,
        h: raw.h,
        content: raw.content,
        color: raw.color,
        size: raw.size,
        scene: raw.scene,
        createdAt: raw.createdAt,
        userId: raw.userId,
      };
      mapped.push(view);
    }

    texts.splice(add.idx, 0, ...mapped);
  }

  return { strokes, texts };
}
```

### Step 2.5: Add Journal Application to Spatial Index

Add this method:

```typescript
private applyJournalToSpatialIndex(
  currentStrokes: ReadonlyArray<StrokeView>,
  currentTexts: ReadonlyArray<TextView>
): void {
  if (!this.spatialIndex) return;

  // Build ID maps for current data
  const strokesById = new Map(currentStrokes.map(s => [s.id, s]));
  const textsById = new Map(currentTexts.map(t => [t.id, t]));

  // Process stroke deletions
  for (const del of this.strokeJournal.dels) {
    const removed = this.prevStrokeViews.slice(del.idx, del.idx + del.count);
    for (const stroke of removed) {
      this.spatialIndex.removeById(stroke.id);
    }
  }

  // Process stroke additions
  for (const add of this.strokeJournal.adds) {
    for (const raw of add.items) {
      const view = strokesById.get(raw.id);
      if (view) {
        this.spatialIndex.insertStroke(view);
      }
    }
  }

  // Process text deletions
  for (const del of this.textJournal.dels) {
    const removed = this.prevTextViews.slice(del.idx, del.idx + del.count);
    for (const text of removed) {
      this.spatialIndex.removeById(text.id);
    }
  }

  // Process text additions
  for (const add of this.textJournal.adds) {
    for (const raw of add.items) {
      const view = textsById.get(raw.id);
      if (view) {
        this.spatialIndex.insertText(view);
      }
    }
  }

  // Clear journals after applying
  this.strokeJournal.adds = [];
  this.strokeJournal.dels = [];
  this.textJournal.adds = [];
  this.textJournal.dels = [];
}
```

### Step 2.6: Add Cleanup in destroy()

Add cleanup for the new observers and spatial index in the destroy method (around line 1150):

```typescript
// Remove Y.Array observers
if (this._strokesObserver) {
  const strokes = this.getStrokes();
  if (strokes) {
    strokes.unobserve(this._strokesObserver);
  }
  this._strokesObserver = null;
}
if (this._textsObserver) {
  const texts = this.getTexts();
  if (texts) {
    texts.unobserve(this._textsObserver);
  }
  this._textsObserver = null;
}

// Clean up spatial index
if (this.spatialIndex) {
  this.spatialIndex.clear();
  this.spatialIndex = null;
}

// Clear journals
this.strokeJournal.adds = [];
this.strokeJournal.dels = [];
this.textJournal.adds = [];
this.textJournal.dels = [];

// Clear previous snapshot references
this.prevStrokeViews = [];
this.prevTextViews = [];
```

### Step 2.7: Remove Old buildSpatialIndex Method

Delete the buildSpatialIndex method that uses UniformGrid (around lines 2000-2008).

---

## Phase 3: Rendering Optimization

### Step 3.1: Optimize Stroke Drawing

**File:** `/home/issak/dev/avlo/client/src/renderer/layers/strokes.ts`

Replace the main loop (lines 38-61):

```typescript
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  // Clear cache on scene change
  if (snapshot.scene !== lastScene) {
    strokeCache.clear();
    lastScene = snapshot.scene;
  }

  // Calculate visible world bounds for culling
  const visibleBounds = getVisibleWorldBounds(viewTransform, viewport);

  // Use spatial index for efficient querying
  let candidateStrokes: ReadonlyArray<StrokeView>;

  if (snapshot.spatialIndex) {
    // Query only strokes in visible area
    candidateStrokes = snapshot.spatialIndex.queryRect(
      visibleBounds.minX,
      visibleBounds.minY,
      visibleBounds.maxX,
      visibleBounds.maxY,
    );
  } else {
    // Fallback to all strokes
    candidateStrokes = snapshot.strokes;
  }

  let renderedCount = 0;
  let culledCount = 0;

  // Process only candidate strokes
  for (const stroke of candidateStrokes) {
    // LOD check still needed (spatial query is coarse)
    if (shouldSkipLOD(stroke, viewTransform)) {
      culledCount++;
      continue;
    }

    renderStroke(ctx, stroke, viewTransform);
    renderedCount++;
  }

  // Development logging
  if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_RENDER_LAYERS && renderedCount > 0) {
    console.debug(
      `[Strokes] Rendered ${renderedCount}/${candidateStrokes.length} candidates (${culledCount} LOD culled)`,
    );
  }
}
```

### Step 3.2: Optimize Translucency Check

**File:** `/home/issak/dev/avlo/client/src/renderer/RenderLoop.ts`

Replace the translucency check (lines 303-305):

```typescript
// Check if any translucent stroke intersects the viewport
let hasTranslucentInView = false;

if (snapshot.spatialIndex) {
  // Use spatial query for efficiency
  const visibleStrokes = snapshot.spatialIndex.queryRect(
    visibleBounds.minX,
    visibleBounds.minY,
    visibleBounds.maxX,
    visibleBounds.maxY,
  );
  hasTranslucentInView = visibleStrokes.some(
    (stroke) => stroke.style.opacity < 1
  );
} else {
  // Fallback to linear scan
  hasTranslucentInView = snapshot.strokes.some(
    (stroke) => stroke.style.opacity < 1 && boxesIntersect(visibleBounds, stroke.bbox),
  );
}
```

### Step 3.3: Fix Double Inflation in isStrokeVisible

**File:** `/home/issak/dev/avlo/client/src/renderer/stroke-builder/path-builder.ts`

Since bbox already includes stroke width, we don't need to inflate again (lines 168-181):

```typescript
export function isStrokeVisible(
  stroke: StrokeView,
  viewportBounds: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  const [minX, minY, maxX, maxY] = stroke.bbox;

  // No inflation needed - bbox already includes stroke width
  return !(
    maxX < viewportBounds.minX ||
    minX > viewportBounds.maxX ||
    maxY < viewportBounds.minY ||
    minY > viewportBounds.maxY
  );
}
```

---

## Phase 4: Eraser Tool Optimization

### Step 4.1: Fix Triple Inflation Bug & Use Combined Query

**File:** `/home/issak/dev/avlo/client/src/lib/tools/EraserTool.ts`

Replace lines 215-283 with correct implementation that:
1. Uses combined query for strokes AND texts
2. Fixes the triple inflation bug
3. Removes redundant viewport pruning

```typescript
private updateHitTest(worldX: number, worldY: number): void {
  const snapshot = this.room.currentSnapshot;
  const viewTransform = this.getView ? this.getView() : snapshot.view;

  // Convert radius to world units
  const radiusWorld = this.state.radiusPx / viewTransform.scale;

  // Clear current hits (accumulator persists)
  this.state.hitNow.clear();

  // CRITICAL FIX: Use combined query for both strokes AND texts
  if (snapshot.spatialIndex) {
    // Query with eraser's bounding square
    // Since bbox already includes stroke width, no extra inflation needed!
    const results = snapshot.spatialIndex.queryRectAll(
      worldX - radiusWorld,
      worldY - radiusWorld,
      worldX + radiusWorld,
      worldY + radiusWorld,
    );

    // Test strokes - bbox already includes stroke width
    for (const stroke of results.strokes) {
      // Fine-grained segment test (bbox already has stroke width)
      if (this.strokeHitTest(worldX, worldY, stroke.points, radiusWorld)) {
        this.state.hitNow.add(stroke.id);
      }
    }

    // Test texts - simple circle-rect intersection
    for (const text of results.texts) {
      // Check if eraser circle overlaps text rect
      if (this.circleRectIntersect(
        worldX, worldY, radiusWorld,
        text.x, text.y, text.w, text.h
      )) {
        this.state.hitNow.add(text.id);
      }
    }
  } else {
    // Fallback without spatial index (keep existing code)
    // ... existing fallback implementation
  }

  // Update accumulator if dragging
  if (this.state.pointerId !== null) {
    for (const id of this.state.hitNow) {
      this.state.hitAccum.add(id);
    }
  }

  this.onInvalidate?.();
}

// Helper for circle-rect intersection
private circleRectIntersect(
  cx: number, cy: number, r: number,
  x: number, y: number, w: number, h: number
): boolean {
  // Find closest point on rect to circle center
  const closestX = Math.max(x, Math.min(cx, x + w));
  const closestY = Math.max(y, Math.min(cy, y + h));

  // Check if distance is within radius
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx * dx + dy * dy) <= (r * r);
}
```

---

## Phase 5: Dirty Rect Clipping & Spatial Query Optimization

### Step 5.1: Add Clipping to RenderLoop

**File:** `/home/issak/dev/avlo/client/src/renderer/RenderLoop.ts`

Add clipping support after line 346 (after clearing but before drawing):

```typescript
// Draw pass 1: World content (world transform)
stage.withContext((ctx) => {
  // Apply world transform
  ctx.scale(view.scale, view.scale);
  ctx.translate(-view.pan.x, -view.pan.y);

  // CRITICAL: Apply clipping if we have dirty rects
  let clipRegion: DirtyClipRegion | null = null;
  if (clearInstructions.type === 'dirty' && clearInstructions.rects) {
    // Convert device pixel rects to world coordinates for clipping
    clipRegion = {
      worldRects: clearInstructions.rects.map(rect => {
        // Convert device pixels → CSS pixels → world
        const cssX = rect.x / viewport.dpr;
        const cssY = rect.y / viewport.dpr;
        const cssW = rect.width / viewport.dpr;
        const cssH = rect.height / viewport.dpr;

        const [worldX1, worldY1] = view.canvasToWorld(cssX, cssY);
        const [worldX2, worldY2] = view.canvasToWorld(cssX + cssW, cssY + cssH);

        return {
          minX: worldX1,
          minY: worldY1,
          maxX: worldX2,
          maxY: worldY2,
        };
      })
    };

    // Create clipping path for all dirty regions
    ctx.save();
    ctx.beginPath();
    for (const rect of clearInstructions.rects) {
      // Clip in device pixels (transform already applied)
      const x = rect.x / viewport.dpr / view.scale + view.pan.x;
      const y = rect.y / viewport.dpr / view.scale + view.pan.y;
      const w = rect.width / viewport.dpr / view.scale;
      const h = rect.height / viewport.dpr / view.scale;
      ctx.rect(x, y, w, h);
    }
    ctx.clip();
  }

  // Pass clip region to drawing functions
  const augmentedViewport = {
    ...viewport,
    visibleWorldBounds: visibleBounds,
    clipRegion, // NEW: Pass dirty regions for spatial queries
  };

  drawBackground(ctx, snapshot, view, augmentedViewport);
  drawStrokes(ctx, snapshot, view, augmentedViewport);
  drawText(ctx, snapshot, view, augmentedViewport);
  drawAuthoringOverlays(ctx, snapshot, view, augmentedViewport);

  // Restore clipping state
  if (clipRegion) {
    ctx.restore();
  }
});
```

### Step 5.2: Use Spatial Queries per Dirty Rect

**File:** `/home/issak/dev/avlo/client/src/renderer/layers/strokes.ts`

Optimize to query per dirty rect instead of whole viewport:

```typescript
export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo & { clipRegion?: DirtyClipRegion },
): void {
  // Clear cache on scene change
  if (snapshot.scene !== lastScene) {
    strokeCache.clear();
    lastScene = snapshot.scene;
  }

  let candidateStrokes: ReadonlyArray<StrokeView>;

  if (snapshot.spatialIndex) {
    if (viewport.clipRegion?.worldRects) {
      // OPTIMIZATION: Query each dirty rect and union results
      const strokeSet = new Set<StrokeView>();

      for (const rect of viewport.clipRegion.worldRects) {
        const results = snapshot.spatialIndex.queryRect(
          rect.minX,
          rect.minY,
          rect.maxX,
          rect.maxY,
        );
        for (const stroke of results) {
          strokeSet.add(stroke);
        }
      }

      candidateStrokes = Array.from(strokeSet);
    } else {
      // Full viewport query
      const visibleBounds = getVisibleWorldBounds(viewTransform, viewport);
      candidateStrokes = snapshot.spatialIndex.queryRect(
        visibleBounds.minX,
        visibleBounds.minY,
        visibleBounds.maxX,
        visibleBounds.maxY,
      );
    }
  } else {
    // Fallback to all strokes
    candidateStrokes = snapshot.strokes;
  }

  // Render candidates (LOD check still applies)
  let renderedCount = 0;
  for (const stroke of candidateStrokes) {
    if (shouldSkipLOD(stroke, viewTransform)) continue;
    renderStroke(ctx, stroke, viewTransform);
    renderedCount++;
  }
}

// Add type for clip region
interface DirtyClipRegion {
  worldRects: Array<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }>;
}
```

### Step 5.3: Remove Redundant Visibility Checks

Since we're using spatial queries, remove the redundant `isStrokeVisible` check from line 48 in strokes.ts - the spatial query already handles this!

---

## Testing & Validation

### Performance Metrics to Track

1. **Spatial Index Build Time**
   - Before: ~5-50ms per snapshot (O(N × cells))
   - After: ~0.1ms incremental update (O(log N))

2. **Render Loop Iteration Count**
   - Before: 5000 strokes scanned every frame
   - After: ~100 strokes queried (zoomed view)

3. **Memory Usage**
   - Before: UniformGrid with excessive cells
   - After: RBush with hierarchical nodes

### Test Scenarios

1. **Append-only drawing**: Verify incremental insert
2. **Eraser deletion**: Verify incremental remove
3. **Scene change**: Verify clear and rebuild
4. **Large strokes**: Verify no cell explosion
5. **Zoomed viewport**: Verify query efficiency

### Debug Logging

Add temporary logging to verify behavior:

```typescript
// In applyJournalToSpatialIndex
console.log('[RBush] Applied journal:', {
  strokeAdds: this.strokeJournal.adds.length,
  strokeDels: this.strokeJournal.dels.length,
  treeStats: this.spatialIndex.getStats(),
});

// In drawStrokes
console.log('[Render] Spatial query:', {
  totalStrokes: snapshot.strokes.length,
  candidates: candidateStrokes.length,
  rendered: renderedCount,
});
```

---

## Migration Notes

### Files to Modify

1. **packages/shared/package.json** - Add rbush & @types/rbush dependencies
2. **packages/shared/src/spatial/rbush-spatial-index.ts** - NEW file (RBush adapter)
3. **packages/shared/src/spatial/index.ts** - NEW file (re-export)
4. **client/src/lib/room-doc-manager.ts** - Add incremental updates, journals
5. **client/src/lib/tools/EraserTool.ts** - Fix triple inflation, use combined query
6. **client/src/renderer/layers/strokes.ts** - Spatial queries, dirty rect support
7. **client/src/renderer/RenderLoop.ts** - Add clipping, pass dirty regions
8. **client/src/renderer/stroke-builder/path-builder.ts** - Remove double inflation

### Files to Delete

1. **client/src/lib/spatial/stroke-spatial-index.ts** - After migration
2. **client/src/lib/spatial/uniform-grid.ts** - After migration

---

## Key Invariants to Maintain

1. **Stored bbox includes inflation** - `(strokeSize * 0.5 + 1)`
2. **RBush uses stored bbox directly** - no re-inflation
3. **Snapshot immutability** - spatial index is read-only facade
4. **Scene filtering** - only current scene in index
5. **Y.Array shallow observe** - no deep observation needed

