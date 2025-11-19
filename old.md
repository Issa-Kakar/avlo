# RoomDocManager Y.Map Migration Analysis

## Executive Summary

This document provides a detailed analysis of the current RoomDocManager implementation and what needs to change for the Y.Map migration. The migration will eliminate the snapshot projection tax, simplify state management, and enable direct Yjs access from renderers.

---

## 1. Current Initialization Flow

### File: `/client/src/lib/room-doc-manager.ts`

#### Constructor Sequence (Lines 258-352)

```typescript
constructor(roomId: RoomId, options?: RoomDocManagerOptions) {
  // 1. Get stable user identity
  const identity = userProfileManager.getIdentity(); // Line 262
  this.userId = identity.userId;
  this.userProfile = { name: identity.name, color: identity.color };

  // 2. Create Y.Doc with room GUID (CRITICAL: NEVER mutate GUID)
  this.ydoc = new Y.Doc({ guid: roomId }); // Line 270

  // 3. Create awareness instance bound to this doc
  this.yAwareness = new YAwareness(this.ydoc); // Line 273

  // 4. Initialize timing abstractions
  this.clock = options?.clock || new BrowserClock(); // Line 286
  this.frames = options?.frames || new BrowserFrameScheduler(); // Line 287

  // 5. Initialize empty snapshot synchronously (NEVER null)
  this._currentSnapshot = createEmptySnapshot(); // Line 303

  // 6. Setup doc-level observers (Y.Doc 'update' event)
  this.setupObservers(); // Line 306
  // NOTE: Array observers are NOT attached yet

  // 7. Initialize throttled presence updates (30Hz)
  const presenceThrottle = this.throttle(this.updatePresence.bind(this), 33);
  this.updatePresenceThrottled = presenceThrottle.throttled;

  // 8. CRITICAL: Attach IDB FIRST before any structure creation
  this.initializeIndexedDBProvider(); // Line 320

  // 9. Initialize WebSocket provider immediately (don't wait for IDB)
  this.initializeWebSocketProvider(); // Line 323

  // 10. Deferred initialization after gates open
  this.whenGateOpen('idbReady').then(async () => {
    await Promise.race([
      this.whenGateOpen('wsSynced'),
      this.delay(5_000) // 5s grace to prevent cross-tab fresh-room races
    ]);

    const root = this.ydoc.getMap('root');
    if (!root.has('meta')) {
      this.initializeYjsStructures(); // Line 336
    }

    // NOW safe to attach array observers
    this.setupArrayObservers(); // Line 344

    // Attach UndoManager after observers
    this.attachUndoManager(); // Line 347
  });

  // 11. Start RAF loop (runs continuously until destroy)
  this.startPublishLoop(); // Line 351
}
```

**Key Initialization Points:**
1. **EmptySnapshot created synchronously** - prevents null snapshots
2. **IDB attached BEFORE structures** - prevents race condition
3. **WS-aware seeding** - waits for either WS sync or 5s grace
4. **Array observers attached AFTER structures exist** - prevents errors
5. **RAF loop starts immediately** - event-driven dirty publishing

---

### Gate System (Lines 219-227, 1838-1927)

```typescript
private gates = {
  idbReady: false,      // Opens when IDB loaded or 2s timeout
  wsConnected: false,   // Opens when WS connection established
  wsSynced: false,      // Opens after first sync step
  awarenessReady: false, // Opens when WS connected
  firstSnapshot: false   // Opens when first doc-derived snapshot published
};
```

**Gate Dependencies:**
```
Constructor
  ├─> initializeIndexedDBProvider()
  │   └─> Opens G_IDB_READY (2s timeout) [Line 1591-1625]
  │       └─> Triggers structure seeding if needed
  │           └─> setupArrayObservers() [Line 344]
  │               └─> attachUndoManager() [Line 347]
  │
  ├─> initializeWebSocketProvider()
  │   ├─> Opens G_WS_CONNECTED on 'status: connected' [Line 1646-1835]
  │   ├─> Opens G_WS_SYNCED on 'sync: true' [Line 1809-1826]
  │   └─> Opens G_AWARENESS_READY when WS connects [Line 1745-1757]
  │
  └─> startPublishLoop()
      └─> Opens G_FIRST_SNAPSHOT in buildSnapshot() when sawAnyDocUpdate=true [Line 2008-2010]
```

**Critical Seeding Logic (Lines 328-348):**
```typescript
// Wait for IDB ready AND (WS synced OR 5s grace)
await Promise.race([
  this.whenGateOpen('wsSynced'),
  this.delay(5_000)
]);

// Only seed if structures don't exist
const root = this.ydoc.getMap('root');
if (!root.has('meta')) {
  this.initializeYjsStructures(); // Creates v1 schema
}

// NOW safe to observe arrays (structures guaranteed to exist)
this.setupArrayObservers();
```

---

## 2. Current State Management

### Two-Epoch Architecture (Lines 242-253)

```typescript
// Authoritative registries (flat maps, no scene filtering)
private strokesById = new Map<string, StrokeView>();  // Line 246
private textsById = new Map<string, TextView>();      // Line 247

// Spatial index (rebuilt once, then updated incrementally)
private spatialIndex: RBushSpatialIndex | null = null; // Line 250

// Epoch flag (triggers full rebuild)
private needsSpatialRebuild = true; // Line 253

// Track whether array observers have been attached
private _arraysObserved: boolean = false; // Line 256
```

**Data Flow:**
```
Y.Doc Update (handleYDocUpdate)
  ├─> Increment docVersion [Line 1568]
  ├─> Mark publishState.isDirty = true [Line 1573]
  └─> RAF loop publishes new snapshot

Array Observer Event (setupArrayObservers)
  ├─> IF needsSpatialRebuild: ignore (rebuild will read fresh) [Line 1320]
  ├─> ELSE: Apply incremental changes
  │   ├─> INSERT: Build view, add to map, insert to RBush [Lines 1323-1353]
  │   └─> DELETE: Remove from map, remove from RBush [Lines 1356-1377]
  └─> publishState.isDirty already set by doc update handler

buildSnapshot() [Lines 1975-2013]
  ├─> IF needsSpatialRebuild (Epoch 1: Rebuild)
  │   ├─> hydrateViewsFromY() - Walk Y.Arrays, build maps [Lines 1447-1496]
  │   ├─> rebuildSpatialIndexFromViews() - BulkLoad RBush [Lines 1498-1511]
  │   └─> needsSpatialRebuild = false [Line 1998]
  │
  └─> ELSE (Epoch 2: Steady-State)
      └─> Use current maps (already updated by observers)
```

---

### hydrateViewsFromY() Implementation (Lines 1447-1496)

```typescript
private hydrateViewsFromY(): void {
  // Clear all maps (fresh start)
  this.strokesById.clear();
  this.textsById.clear();

  // Walk Y.Arrays once, build each view exactly once
  const yStrokes = this.getStrokes();
  for (let i = 0; i < yStrokes.length; i++) {
    const raw = yStrokes.get(i);

    // Build StrokeView from raw Stroke
    const view: StrokeView = {
      id: raw.id,
      points: raw.points,                    // Plain number[] from Y.Doc
      pointsTuples: raw.pointsTuples ?? null,
      polyline: null,                        // Built at render time only
      style: {
        color: raw.color,
        size: raw.size,
        opacity: raw.opacity,
        tool: raw.tool,
      },
      bbox: raw.bbox,
      createdAt: raw.createdAt,
      userId: raw.userId,
      kind: raw.kind ?? 'shape',
    };

    this.strokesById.set(view.id, view);
  }

  // Same pattern for texts
  const yTexts = this.getTexts();
  for (let i = 0; i < yTexts.length; i++) {
    const raw = yTexts.get(i);

    const view: TextView = {
      id: raw.id,
      x: raw.x,
      y: raw.y,
      w: raw.w,
      h: raw.h,
      content: raw.content,
      color: raw.color,
      size: raw.size,
      createdAt: raw.createdAt,
      userId: raw.userId,
    };

    this.textsById.set(view.id, view);
  }
}
```

**Key Points:**
- Transforms `Stroke → StrokeView` and `TextBlock → TextView`
- Flattens style properties for renderer access
- Polyline is null (constructed at render time from points)
- Maps keyed by ID for O(1) lookup

---

### composeSnapshotFromMaps() (Lines 1517-1542)

```typescript
private composeSnapshotFromMaps(): Snapshot {
  // No scene filtering - all strokes and texts are visible
  const strokes = Array.from(this.strokesById.values()); // Line 1519
  const texts = Array.from(this.textsById.values());     // Line 1520

  // Build metadata
  const meta: SnapshotMeta = {
    cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
    readOnly: this.roomStats?.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
    bytes: this.roomStats?.bytes,
    expiresAt: this.roomStats?.expiresAt,
  };

  return {
    docVersion: this.docVersion,
    strokes, // Order unspecified - renderer sorts by ID before drawing
    texts,
    presence: this.buildPresenceView(),
    spatialIndex: this.spatialIndex, // Live index, not cloned
    view: this.getViewTransform(),
    meta,
    createdAt: Date.now(),
  };
}
```

**Snapshot Composition:**
- Arrays derived from Maps via `Array.from(map.values())`
- Map insertion order NOT semantic (renderer sorts by ULID)
- Spatial index shared live (read-only facade)

---

### buildSnapshot() Flow (Lines 1975-2013)

```typescript
private buildSnapshot(): Snapshot {
  // Early return if not initialized
  const root = this.getRoot();
  const meta = root.get('meta') as Y.Map<unknown> | undefined;
  if (!meta) {
    return this._currentSnapshot; // Return previous snapshot
  }

  // Ensure spatial index exists
  if (!this.spatialIndex) {
    this.spatialIndex = new RBushSpatialIndex();
    this.needsSpatialRebuild = true;
  }

  // ========== TWO-EPOCH BRANCHING ==========

  if (this.needsSpatialRebuild) {
    // ——— REBUILD EPOCH ———
    // Hydrate maps from Y.Arrays (ignores any stale incremental state)
    this.hydrateViewsFromY();
    // BulkLoad RBush from freshly built maps
    this.rebuildSpatialIndexFromViews();
    // Reset flag
    this.needsSpatialRebuild = false;
  }

  // ——— STEADY-STATE EPOCH ———
  // No else block needed!
  // Observers already updated strokesById/textsById/spatialIndex incrementally

  // Compose snapshot from current maps
  const snapshot = this.composeSnapshotFromMaps();

  // Open G_FIRST_SNAPSHOT gate if needed
  if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
    this.openGate('firstSnapshot');
  }

  return snapshot;
}
```

**Two-Epoch Model:**
1. **Rebuild Epoch**: Full hydration from Y.Arrays + bulkLoad RBush
2. **Steady-State Epoch**: Use current maps (observers keep them updated)

---

## 3. Current Array Observers (Lines 1303-1441)

### setupArrayObservers() (Lines 1303-1441)

```typescript
private setupArrayObservers(): void {
  // Idempotent - only attach once
  if (this._arraysObserved) return;

  const root = this.getRoot();
  const strokes = root.get('strokes');
  const texts = root.get('texts');

  // Hard assert: structures must exist
  if (!(strokes instanceof Y.Array) || !(texts instanceof Y.Array)) {
    throw new Error('setupArrayObservers(): structures not initialized');
  }

  // ——— STROKES OBSERVER ———
  this._strokesObserver = (event: Y.YArrayEvent<any>) => {
    // CRITICAL: Ignore during rebuild epoch
    if (this.needsSpatialRebuild) return;

    // Process INSERTS from delta
    for (const delta of event.changes.delta) {
      if ('insert' in delta) {
        const items = delta.insert as any[];
        for (const raw of items) {
          // Build StrokeView once
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
            createdAt: raw.createdAt,
            userId: raw.userId,
            kind: raw.kind ?? 'shape',
          };

          // Update map (O(1))
          this.strokesById.set(view.id, view);

          // Update spatial index (O(log N))
          if (this.spatialIndex) {
            this.spatialIndex.insertStroke(view);
          }
        }
      }
    }

    // Process DELETES from changes.deleted
    const deleted = event.changes.deleted as Set<any>;
    deleted.forEach((item: any) => {
      const content = item?.content;
      if (!content || typeof content.getContent !== 'function') return;

      const removedItems = content.getContent() as any[];
      for (const raw of removedItems) {
        const id = raw?.id;
        if (!id) continue;

        // Update map
        this.strokesById.delete(id);

        // Update spatial index
        if (this.spatialIndex) {
          this.spatialIndex.removeById(id);
        }
      }
    });

    // publishState.isDirty already set by Y.Doc 'update' handler
  };
  strokes.observe(this._strokesObserver);

  // ——— TEXTS OBSERVER (same pattern) ———
  this._textsObserver = (event: Y.YArrayEvent<any>) => {
    // Same logic for texts
  };
  texts.observe(this._textsObserver);

  // Mark attached
  this._arraysObserved = true;

  // Force one rebuild on first attach
  this.needsSpatialRebuild = true;
  this.publishState.isDirty = true;
}
```

**Observer Logic:**
1. **Epoch Guard**: Ignore events during rebuild (upcoming hydration will read fresh)
2. **Insert Processing**: Build view, add to map, insert to RBush
3. **Delete Processing**: Extract IDs from `content.getContent()`, remove from map/RBush
4. **Dirty Flag**: Already set by doc-level update handler

---

## 4. Current docVersion Management

### handleYDocUpdate (Lines 1546-1589)

```typescript
private handleYDocUpdate = (update: Uint8Array, origin: unknown): void => {
  // Log transaction origin for debugging
  const originStr = /* origin detection logic */

  // Increment docVersion on ANY Y.Doc change
  this.docVersion = (this.docVersion + 1) >>> 0; // Unsigned 32-bit int [Line 1568]
  this.sawAnyDocUpdate = true; // We've now seen real doc data [Line 1569]

  // Mark dirty for RAF publish
  this.publishState.isDirty = true; // [Line 1573]

  // Store update for metrics
  if (this.publishState.pendingUpdates) {
    this.publishState.pendingUpdates.push({
      update,
      origin,
      time: this.clock.now(),
    });
  }

  // Update size estimate for guards
  const deltaBytes = update.byteLength;
  this.sizeEstimator.observeDelta(deltaBytes);

  // RAF loop will handle publishing
};
```

**docVersion Policy:**
- Increments on **every Y.Doc update** (not presence-only)
- Used to detect document changes vs presence-only changes
- Enables skipping expensive rebuilds when only presence changed

---

## 5. What Needs to Change for Y.Map Migration

### 5.1 Schema Changes

**Current Schema (v1):**
```typescript
root: Y.Map => {
  v: 1,
  meta: Y.Map,
  strokes: Y.Array<Stroke>,  // ← Remove
  texts: Y.Array<TextBlock>,  // ← Remove
  code: Y.Map,
  outputs: Y.Array
}
```

**New Schema (v2):**
```typescript
root: Y.Map => {
  v: 2,                      // Bump version
  meta: Y.Map,               // Unchanged
  objects: Y.Map<Y.Map>,     // ← NEW: All drawable objects
  code: Y.Map,               // Unchanged
  outputs: Y.Array           // Unchanged
}
```

**Migration Impact:**
- Update `initializeYjsStructures()` (Lines 729-774)
- Remove `getStrokes()` and `getTexts()` helpers (Lines 375-389)
- Add `getObjects()` helper returning `Y.Map<Y.Map>`

---

### 5.2 State Management Changes

**Remove:**
```typescript
// Lines 246-247
private strokesById = new Map<string, StrokeView>();
private textsById = new Map<string, TextView>();
```

**Add:**
```typescript
private objectsById = new Map<string, ObjectHandle>();
private dirtyRects: WorldBounds[] = [];
```

**ObjectHandle Structure:**
```typescript
interface ObjectHandle {
  id: string;
  kind: ObjectKind; // 'stroke' | 'text' | 'shape' | 'connector'
  yMap: Y.Map<any>; // Direct reference to Y.Map in objects
  bbox: [number, number, number, number]; // Computed bbox
}
```

**Why This Works:**
- No view model transformation needed (renderer reads Y.Map directly)
- Bbox computed once per update, cached in handle
- Direct Y.Map reference enables live collaboration on nested Y.Text

---

### 5.3 Deep Observer Pattern (Replaces Array Observers)

**Remove:**
```typescript
// Lines 1303-1441
private setupArrayObservers(): void { /* ... */ }
private _strokesObserver: ((event: Y.YArrayEvent<any>) => void) | null = null;
private _textsObserver: ((event: Y.YArrayEvent<any>) => void) | null = null;
```

**Add:**
```typescript
private objectsObserver: ((events: Y.YEvent<any>[], tx: Y.Transaction) => void) | null = null;

private setupObjectsObserver(): void {
  const objects = this.getObjects();

  this.objectsObserver = (events, tx) => {
    const touchedIds = new Set<string>();
    const deletedIds = new Set<string>();
    const textOnlyIds = new Set<string>();

    for (const ev of events) {
      // Top-level object adds/deletes
      if (ev.target === objects && ev instanceof Y.YMapEvent) {
        for (const [key, change] of ev.changes.keys) {
          const id = String(key);
          if (change.action === 'delete') {
            deletedIds.add(id);
          } else {
            touchedIds.add(id);
          }
        }
        continue;
      }

      // Nested changes - path[0] is object ID
      const objectId = String(ev.path[0] ?? '');
      if (objectId) {
        touchedIds.add(objectId);

        // Track text-only changes for optimization
        if (ev instanceof Y.YTextEvent) {
          textOnlyIds.add(objectId);
        }
      }
    }

    this.applyObjectChanges({ touchedIds, deletedIds, textOnlyIds });
    this.publishState.isDirty = true;
  };

  objects.observeDeep(this.objectsObserver);
}
```

**Key Differences:**
1. **Single Observer**: Handles all object types (strokes, texts, shapes, connectors)
2. **Deep Observation**: Catches nested changes (e.g., Y.Text edits in labels)
3. **Batched Processing**: All changes in one transaction processed together
4. **Path-based Detection**: `ev.path[0]` identifies which object changed

---

### 5.4 applyObjectChanges() (New Method)

```typescript
private applyObjectChanges(args: {
  touchedIds: Set<string>;
  deletedIds: Set<string>;
  textOnlyIds: Set<string>;
}): void {
  const objects = this.getObjects();
  const cache = getObjectCacheInstance();

  // Process deletions
  for (const id of args.deletedIds) {
    const handle = this.objectsById.get(id);
    if (!handle) continue;

    // Update spatial index
    if (this.spatialIndex) {
      this.spatialIndex.remove(id, handle.bbox);
    }

    // Evict cache
    cache.evictById(id);

    // Mark dirty
    this.dirtyRects.push(bboxToBounds(handle.bbox));

    // Remove from registry
    this.objectsById.delete(id);
  }

  // Process additions/updates
  for (const id of args.touchedIds) {
    const yObj = objects.get(id);
    if (!yObj) continue;

    const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';
    const prevHandle = this.objectsById.get(id);
    const oldBBox = prevHandle?.bbox;

    // Compute new bbox
    const newBBox = this.computeBBoxFor(kind, yObj);

    const newHandle: ObjectHandle = {
      id,
      kind,
      yMap: yObj,
      bbox: newBBox,
    };

    this.objectsById.set(id, newHandle);

    // Update spatial index
    if (this.spatialIndex) {
      if (oldBBox) {
        this.spatialIndex.update(id, oldBBox, newBBox, kind);
      } else {
        this.spatialIndex.insert(id, newBBox, kind);
      }
    }

    // Handle cache and dirty rects
    if (!oldBBox) {
      // New object
      this.dirtyRects.push(bboxToBounds(newBBox));
    } else {
      const bboxChanged = !bboxEquals(oldBBox, newBBox);

      if (bboxChanged) {
        // Geometry changed
        cache.evictById(id);
        this.dirtyRects.push(bboxToBounds(oldBBox));
        this.dirtyRects.push(bboxToBounds(newBBox));
      } else if (!args.textOnlyIds.has(id)) {
        // Style changed
        this.dirtyRects.push(bboxToBounds(newBBox));
      }
    }
  }
}
```

**Responsibilities:**
1. **Delete Handling**: Remove from spatial index, evict cache, mark dirty
2. **Add/Update Handling**: Compute bbox, update handle, update spatial index
3. **Dirty Tracking**: Collect dirty rects for Canvas.tsx
4. **Cache Management**: Evict on geometry change, preserve on style change

---

### 5.5 Bbox Computation (New Method)

```typescript
private computeBBoxFor(kind: ObjectKind, yMap: Y.Map<any>): [number, number, number, number] {
  switch (kind) {
    case 'stroke': {
      const points = (yMap.get('points') as [number, number][]) ?? [];
      if (points.length === 0) return [0, 0, 0, 0];

      const width = (yMap.get('width') as number) ?? 1;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

      for (const [x, y] of points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }

      // Inflate by stroke width + 1px margin
      const inflate = (width * 0.5) + 1;
      return [minX - inflate, minY - inflate, maxX + inflate, maxY + inflate];
    }

    case 'text': {
      const frame = (yMap.get('frame') as [number, number, number, number]) ?? [0, 0, 0, 0];
      const [x, y, w, h] = frame;
      return [x, y, x + w, y + h];
    }

    case 'shape': {
      const frame = (yMap.get('frame') as [number, number, number, number]) ?? [0, 0, 0, 0];
      const strokeWidth = (yMap.get('strokeWidth') as number) ?? 0;
      const [x, y, w, h] = frame;

      // Inflate by stroke width if has outline
      const inflate = strokeWidth > 0 ? (strokeWidth * 0.5) + 1 : 0;
      return [x - inflate, y - inflate, x + w + inflate, y + h + inflate];
    }

    default:
      return [0, 0, 0, 0];
  }
}
```

**Key Points:**
- Per-kind bbox computation logic
- Stroke: Inflate by width for accurate hit-testing
- Text/Shape: Use frame bounds
- Called once per update, cached in ObjectHandle

---

### 5.6 New Hydration Strategy (Replaces hydrateViewsFromY)

**Remove:**
```typescript
// Lines 1447-1496
private hydrateViewsFromY(): void { /* ... */ }
```

**Add:**
```typescript
private hydrateObjectsFromY(): void {
  // Clear registry (fresh start)
  this.objectsById.clear();

  // Walk objects map once
  const objects = this.getObjects();

  for (const [id, yObj] of objects) {
    const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';
    const bbox = this.computeBBoxFor(kind, yObj);

    const handle: ObjectHandle = {
      id,
      kind,
      yMap: yObj,
      bbox,
    };

    this.objectsById.set(id, handle);
  }
}
```

**Simplification:**
- No view model transformation (just compute bbox)
- Direct Y.Map references in handles
- Single loop for all object types

---

### 5.7 Spatial Index Changes

**Current (RBushSpatialIndex):**
```typescript
interface IndexEntry {
  minX: number; minY: number; maxX: number; maxY: number;
  id: string;
  kind: 'stroke' | 'text';
  data: StrokeView | TextView; // ← Full view stored
}

class RBushSpatialIndex {
  private strokesById: Map<string, StrokeView>; // ← Duplicate storage
  private textsById: Map<string, TextView>;     // ← Duplicate storage
  // ...
}
```

**New (ObjectSpatialIndex):**
```typescript
interface IndexEntry {
  minX: number; minY: number; maxX: number; maxY: number;
  id: string;
  kind: ObjectKind;
  // NO data field - lookup via objectsById
}

class ObjectSpatialIndex {
  private tree = new RBush<IndexEntry>();

  insert(id: string, bbox: Bounds, kind: ObjectKind): void;
  update(id: string, oldBBox: Bounds, newBBox: Bounds, kind: ObjectKind): void;
  remove(id: string, bbox: Bounds): void;
  query(bounds: Bounds): IndexEntry[];
  bulkLoad(handles: ObjectHandle[]): void;
  clear(): void;
}
```

**Key Changes:**
1. **No Duplicate Storage**: Index only stores bbox + id + kind
2. **Lookup Pattern**: Renderer queries index → gets IDs → looks up handles
3. **Update Method**: Efficient bbox change handling (RBush remove + insert)

---

### 5.8 Snapshot Structure Changes

**Current:**
```typescript
interface Snapshot {
  docVersion: number;
  strokes: ReadonlyArray<StrokeView>;  // ← Derived arrays
  texts: ReadonlyArray<TextView>;      // ← Derived arrays
  presence: PresenceView;
  spatialIndex: SpatialIndex | null;
  view: ViewTransform;
  meta: SnapshotMeta;
  createdAt: number;
}
```

**New:**
```typescript
interface Snapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>; // ← Direct reference
  spatialIndex: ObjectSpatialIndex | null;
  presence: PresenceView;
  view: ViewTransform;
  meta: SnapshotMeta;
  createdAt: number;
  dirtyPatch?: {                                 // ← NEW: Optional dirty tracking
    rects: WorldBounds[];
    evictIds: string[];
  };
}
```

**Benefits:**
1. **Live References**: Snapshot shares objectsById Map (no copy)
2. **Dirty Patch**: Canvas.tsx can use precomputed dirty rects
3. **No Projection**: Renderer accesses Y.Maps directly via handles

---

### 5.9 buildSnapshot() Changes

**Current (Lines 1975-2013):**
```typescript
private buildSnapshot(): Snapshot {
  if (!meta) return this._currentSnapshot;

  if (!this.spatialIndex) {
    this.spatialIndex = new RBushSpatialIndex();
    this.needsSpatialRebuild = true;
  }

  if (this.needsSpatialRebuild) {
    this.hydrateViewsFromY();            // Walk Y.Arrays
    this.rebuildSpatialIndexFromViews(); // BulkLoad RBush
    this.needsSpatialRebuild = false;
  }

  const snapshot = this.composeSnapshotFromMaps(); // Derive arrays

  if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
    this.openGate('firstSnapshot');
  }

  return snapshot;
}
```

**New:**
```typescript
private buildSnapshot(): Snapshot {
  if (!meta) return this._currentSnapshot;

  if (!this.spatialIndex) {
    this.spatialIndex = new ObjectSpatialIndex();
    this.needsSpatialRebuild = true;
  }

  if (this.needsSpatialRebuild) {
    this.hydrateObjectsFromY();              // Walk objects map
    this.rebuildSpatialIndexFromObjects();   // BulkLoad RBush
    this.needsSpatialRebuild = false;
  }

  // Build dirty patch if needed
  const dirtyPatch = this.dirtyRects.length > 0
    ? {
        rects: [...this.dirtyRects],
        evictIds: [] // Populated by applyObjectChanges
      }
    : undefined;

  // Clear dirty rects after capturing
  this.dirtyRects = [];

  return {
    docVersion: this.docVersion,
    objectsById: this.objectsById,      // Direct reference
    spatialIndex: this.spatialIndex,
    presence: this.buildPresenceView(),
    view: this.getViewTransform(),
    meta: this.buildMeta(),
    createdAt: Date.now(),
    dirtyPatch,                         // NEW
  };
}
```

**Changes:**
1. Use `hydrateObjectsFromY()` instead of `hydrateViewsFromY()`
2. Include `dirtyPatch` in snapshot (optional)
3. Pass `objectsById` directly (no array derivation)

---

## 6. Initialization Order Changes

### Current Order:
```
1. Create Y.Doc
2. Create awareness
3. Setup doc observer (Y.Doc 'update' event)
4. Attach IDB provider
5. Attach WS provider
6. Wait for gates → seed structures
7. Attach array observers (AFTER structures exist)
8. Attach UndoManager (AFTER observers)
9. Start RAF loop
```

### New Order (Minimal Changes):
```
1. Create Y.Doc                              [Unchanged]
2. Create awareness                          [Unchanged]
3. Setup doc observer                        [Unchanged]
4. Attach IDB provider                       [Unchanged]
5. Attach WS provider                        [Unchanged]
6. Wait for gates → seed structures          [Update initializeYjsStructures()]
7. Attach deep observer (AFTER structures)   [Replace setupArrayObservers()]
8. Attach UndoManager (AFTER observer)       [Update to track objects map]
9. Start RAF loop                            [Unchanged]
```

**Key Change:**
```typescript
// In constructor's whenGateOpen('idbReady').then() block:
if (!root.has('meta')) {
  this.initializeYjsStructures(); // Creates v2 schema with objects map
}

// Replace this:
this.setupArrayObservers();

// With this:
this.setupObjectsObserver();

// Update UndoManager:
this.attachUndoManager(); // Now tracks objects map instead of arrays
```

---

### Updated initializeYjsStructures() (Lines 729-774)

**Current (v1 schema):**
```typescript
private initializeYjsStructures(): void {
  this.ydoc.transact(() => {
    const root = this.ydoc.getMap('root');

    if (!root.has('v')) {
      root.set('v', 1); // Schema v1
    }

    if (!root.has('strokes')) {
      root.set('strokes', new Y.Array<Stroke>());
    }

    if (!root.has('texts')) {
      root.set('texts', new Y.Array<TextBlock>());
    }

    // meta, code, outputs unchanged...
  });
}
```

**New (v2 schema):**
```typescript
private initializeYjsStructures(): void {
  this.ydoc.transact(() => {
    const root = this.ydoc.getMap('root');

    // Bump schema version
    root.set('v', 2);

    // Keep meta, code, outputs as-is
    if (!root.has('meta')) {
      root.set('meta', new Y.Map());
    }

    // NEW: Create objects map instead of arrays
    if (!root.has('objects')) {
      root.set('objects', new Y.Map());
    }

    // code and outputs unchanged...
  });
}
```

---

### Updated UndoManager (Lines 411-429)

**Current:**
```typescript
private attachUndoManager(): void {
  const strokes = root.get('strokes') as Y.Array<any>;
  const texts = root.get('texts') as Y.Array<any>;

  this.undoManager = new Y.UndoManager([strokes, texts], {
    trackedOrigins: new Set([this.userId]),
    captureTimeout: 500,
  });
}
```

**New:**
```typescript
private attachUndoManager(): void {
  const objects = root.get('objects') as Y.Map<Y.Map<any>>;

  this.undoManager = new Y.UndoManager([objects], {
    trackedOrigins: new Set([this.userId]),
    captureTimeout: 500,
  });
}
```

**Key Change:**
- Track `objects` map instead of separate `strokes` and `texts` arrays
- Same origin-based tracking (per-user undo/redo)

---

## 7. Summary of Required Changes

### RoomDocManager Changes:

1. **Schema Update** (Lines 729-774):
   - Bump `v: 2`
   - Replace `strokes: Y.Array` and `texts: Y.Array` with `objects: Y.Map<Y.Map>`

2. **State Management** (Lines 246-253):
   - Replace `strokesById` and `textsById` with `objectsById: Map<string, ObjectHandle>`
   - Add `dirtyRects: WorldBounds[]`

3. **Observers** (Lines 1303-1441):
   - Remove `setupArrayObservers()`, `_strokesObserver`, `_textsObserver`
   - Add `setupObjectsObserver()` with deep observer
   - Add `applyObjectChanges()` method

4. **Hydration** (Lines 1447-1496):
   - Replace `hydrateViewsFromY()` with `hydrateObjectsFromY()`
   - No view transformation, just compute bbox

5. **Snapshot Composition** (Lines 1517-1542):
   - Remove `composeSnapshotFromMaps()` array derivation
   - Pass `objectsById` directly in snapshot

6. **buildSnapshot()** (Lines 1975-2013):
   - Use new hydration method
   - Include `dirtyPatch` in snapshot

7. **Helpers**:
   - Remove `getStrokes()` and `getTexts()`
   - Add `getObjects()` returning `Y.Map<Y.Map>`
   - Add `computeBBoxFor(kind, yMap)`

8. **UndoManager** (Lines 411-429):
   - Track `objects` map instead of arrays

### Spatial Index Changes:

1. **New Implementation** (`packages/shared/src/spatial/object-spatial-index.ts`):
   - Remove duplicate storage (strokesById/textsById)
   - Store only bbox + id + kind
   - Add `update()` method for efficient bbox changes

### Type Changes:

1. **New Types** (`packages/shared/src/types/`):
   - Add `ObjectHandle` interface
   - Add `ObjectKind` type
   - Remove `StrokeView` and `TextView` (or deprecate)

2. **Snapshot Update** (`packages/shared/src/types/snapshot.ts`):
   - Replace `strokes` and `texts` arrays with `objectsById: Map<string, ObjectHandle>`
   - Add `dirtyPatch` optional field

---

## 8. Critical Considerations

### 8.1 Gate Dependencies Remain Same

- IDB ready → structure seeding → observer attachment → UndoManager
- Observer changes (array → deep) but timing unchanged

### 8.2 Two-Epoch Model Preserved

- Rebuild epoch: `hydrateObjectsFromY()` + `rebuildSpatialIndexFromObjects()`
- Steady-state: Observers keep `objectsById` and `spatialIndex` updated

### 8.3 RAF Loop Unchanged

- Same event-driven dirty publishing
- Same doc vs presence-only detection via `docVersion`

### 8.4 Bbox Computation Critical

- Must be correct for all object types
- Cached in ObjectHandle (recomputed on update)
- Used for spatial index and dirty rect tracking

### 8.5 Dirty Rect Optimization

- RoomDocManager tracks dirty rects during `applyObjectChanges()`
- Passed to Canvas.tsx via `snapshot.dirtyPatch`
- Enables efficient partial repaints

---

## 9. Testing Strategy

### Phase 1: Core Infrastructure
1. Test schema migration (v1 → v2)
2. Test deep observer with mock events
3. Test bbox computation for all kinds
4. Test objectsById hydration

### Phase 2: Integration
1. Test spatial index with new structure
2. Test snapshot building
3. Test dirty rect tracking
4. Test UndoManager with objects map

### Phase 3: Rendering
1. Test Canvas.tsx with new snapshot structure
2. Test cache eviction logic
3. Test dirty rect invalidation

---

## 10. Migration Path

### Step 1: Add New Types (No Breaking Changes)
- Add `ObjectHandle`, `ObjectKind` types
- Add `ObjectSpatialIndex` class
- Keep existing types for compatibility

### Step 2: Update RoomDocManager (Breaking Changes)
- Implement v2 schema seeding
- Add deep observer
- Update snapshot building
- Remove array observers

### Step 3: Update Tools
- DrawingTool writes to objects map
- EraserTool deletes from objects map
- TextTool creates text objects

### Step 4: Update Renderers
- Read from ObjectHandles
- Access Y.Maps directly
- Use new spatial index

### Step 5: Cleanup
- Remove old types (StrokeView, TextView)
- Remove array observer code
- Update tests

---

## Conclusion

The Y.Map migration is a focused refactor that:

1. **Simplifies state management** by eliminating view models
2. **Enables direct Yjs access** from renderers
3. **Preserves proven patterns** (two-epoch model, gate system, RAF loop)
4. **Improves performance** by eliminating snapshot projection tax
5. **Enables future features** (shapes, connectors, collaborative text)

The migration can be done incrementally with careful attention to initialization order and gate dependencies.
