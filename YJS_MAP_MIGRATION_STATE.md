# Y.Map Migration: Current State Documentation
*Generated: November 2024*
*Purpose: LLM-readable comprehensive documentation of the Y.Map migration implementation*

## Executive Summary

The AVLO codebase has successfully migrated from Y.Array-based storage to a Y.Map<Y.Map<any>> architecture. This migration eliminates intermediate view layers, simplifies the rendering pipeline, and provides direct Y.Map access throughout the system. The implementation is functionally complete for core drawing features (pen, highlighter, eraser, shapes) with rendering and caching fully operational.

### Migration Success Metrics
- ✅ Y.Map nested structure fully implemented
- ✅ Direct Y.Map reading in renderers (NO cloning/views)
- ✅ BBox computed locally with width padding
- ✅ Unified object type system with clear semantic separation
- ✅ Single Path2D cache keyed by object ID
- ✅ Spatial index as pure acceleration structure
- ✅ Two-epoch model with observeDeep for incremental updates
- ✅ DirtyPatch system for efficient invalidation
- ✅ Viewport intersection optimization
- ⚠️ Text/Connector/Select tools pending implementation

---

## Core Architecture

### 1. Y.Map Document Structure

```typescript
Y.Doc → root: Y.Map → {
  v: 2,                           // Schema version (bumped from 1)
  meta: Y.Map<Meta>,             // Metadata (scene ticks, canvas config)
  objects: Y.Map<Y.Map<any>>,    // NEW: All drawable objects
  code: Y.Map<CodeCell>,         // Code cells (future)
  outputs: Y.Array<Output>       // Code outputs (future)
}
```

**Key Design Decision**: Objects stored as nested Y.Maps where:
- Outer map: Keyed by object ID (ULID)
- Inner map: Contains all object properties
- NO arrays for objects (pure map-based storage)

### 2. Object Type System

#### 2.1 ObjectKind Semantic Separation
```typescript
export type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector';
```

**Strict Semantic Rules**:
- `stroke` = Pen/highlighter strokes (ALWAYS Perfect Freehand filled polygons)
- `shape` = Geometric shapes (ALWAYS frame-based with optional fill/stroke)
- `text` = Text blocks (frame-based positioning with Y.Text content)
- `connector` = Connection lines/arrows (ALWAYS polylines with caps)

#### 2.2 ObjectHandle Interface
```typescript
export interface ObjectHandle {
  id: string;                              // ULID
  kind: ObjectKind;                         // Discriminator
  y: Y.Map<any>;                           // LIVE Y.Map reference (no copying!)
  bbox: [number, number, number, number];  // Computed locally via computeBBoxFor()
}
```

**CRITICAL**: The `y` field provides direct Y.Map access. Renderers read fields directly: `handle.y.get('color')`

#### 2.3 Field Schema per ObjectKind

##### Stroke Fields (Pen/Highlighter)
```typescript
{
  id: string;              // ULID
  kind: 'stroke';          // Literal
  tool: 'pen' | 'highlighter';
  color: string;           // #RRGGBB
  width: number;           // World units (renamed from 'size')
  opacity: number;         // 0-1
  points: [number, number][];  // Tuples (NOT flat array)
  ownerId: string;         // User ID
  createdAt: number;       // ms epoch
}
```

##### Shape Fields (Geometric)
```typescript
{
  id: string;
  kind: 'shape';
  shapeType: 'rect' | 'ellipse' | 'diamond' | 'roundedRect';
  frame: [number, number, number, number];  // [x, y, width, height]
  fillColor?: string;      // Optional fill
  strokeColor?: string;    // Optional outline
  strokeWidth?: number;    // Outline width
  opacity: number;
  cornerRadius?: number;   // For roundedRect
  ownerId: string;
  createdAt: number;

  // PLANNED (not implemented):
  label?: Y.Text;          // Collaborative text inside shape
  padding?: [number, number, number, number];
  textAlignV?: 'top' | 'middle' | 'bottom';
  connectorIds?: string[]; // Reverse lookup for attached connectors
}
```

##### Text Fields (Text Blocks)
```typescript
{
  id: string;
  kind: 'text';
  frame: [number, number, number, number];  // [x, y, width, height]
  text: string | Y.Text;   // Content (Y.Text for collaboration)
  color: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: string;
  fontStyle: string;
  textAlign: string;
  opacity: number;
  ownerId: string;
  createdAt: number;

  // PLANNED:
  padding?: [number, number, number, number];
  backgroundColor?: string;
}
```

##### Connector Fields (Lines/Arrows)
```typescript
{
  id: string;
  kind: 'connector';
  points: [number, number][];  // Path points
  startCap?: 'arrow' | 'circle';
  endCap?: 'arrow' | 'circle';
  color: string;
  width: number;
  opacity: number;
  ownerId: string;
  createdAt: number;

  // PLANNED (sticky connectors):
  fromId?: string;         // Attached shape ID
  fromAnchor?: 'top' | 'right' | 'bottom' | 'left';
  toId?: string;
  toAnchor?: 'top' | 'right' | 'bottom' | 'left';
  routingMode?: 'auto' | 'manual';
  routingType?: 'linear' | 'elbow' | 'curved';
  label?: Y.Text;
  labelOffset?: number;
}
```

---

## RoomDocManager Implementation

### 3. State Management

#### 3.1 Core State
```typescript
class RoomDocManager {
  // Y.Doc and providers
  private ydoc: Y.Doc;
  private idbProvider: IndexedDBProvider;
  private wsProvider: WebsocketProvider;
  private undoManager: Y.UndoManager;

  // Object registry (local mirror of Y.Doc)
  private objectsById = new Map<string, ObjectHandle>();

  // Spatial acceleration
  private spatialIndex: ObjectSpatialIndex | null = null;

  // Dirty tracking (accumulated between snapshots)
  private dirtyRects: WorldBounds[] = [];
  private cacheEvictIds = new Set<string>();

  // Observer
  private objectsObserver: ((events: Y.YEvent<any>[], tx: Y.Transaction) => void) | null = null;

  // Two-epoch flag
  private needsSpatialRebuild = true;  // Starts true, goes false after first hydration
}
```

#### 3.2 Two-Epoch Model

**Epoch 1: Rebuild (needsSpatialRebuild = true)**
- Triggers: Initial load, scene changes, sanity failures
- Process: Full hydration from Y.Doc → rebuild objectsById + spatial index
- Observer: MUTED (returns early)

**Epoch 2: Steady-State (needsSpatialRebuild = false)**
- Observer: ACTIVE, processes incremental changes
- Updates: Direct modifications to objectsById + spatial index
- Tracking: Accumulates dirtyRects and cacheEvictIds

#### 3.3 ObserveDeep Implementation

```typescript
setupObjectsObserver(): void {
  const objects = this.getObjects();

  this.objectsObserver = (events, tx) => {
    // CRITICAL: Ignore during rebuild epoch
    if (this.needsSpatialRebuild) return;

    const touchedIds = new Set<string>();
    const deletedIds = new Set<string>();
    const textOnlyIds = new Set<string>();

    for (const ev of events) {
      if (ev.target === objects && ev instanceof Y.YMapEvent) {
        // Top-level object adds/deletes
        for (const [key, change] of ev.changes.keys) {
          if (change.action === 'delete') {
            deletedIds.add(key);
          } else {
            touchedIds.add(key);
          }
        }
      } else {
        // Nested property changes
        const path = ev.path as (string | number)[];
        const id = String(path[0]);  // Object ID is always path[0]
        touchedIds.add(id);

        // Track text-only changes for optimization
        if (ev instanceof Y.YTextEvent) {
          const field = String(path[1]);
          if (field === 'text' || field === 'label') {
            textOnlyIds.add(id);
          }
        }
      }
    }

    this.applyObjectChanges({ touchedIds, deletedIds, textOnlyIds });
  };

  objects.observeDeep(this.objectsObserver);
}
```

**Path Analysis**: For nested changes, `ev.path` provides the property path:
- `path[0]` = Object ID
- `path[1]` = Field name (e.g., 'color', 'points', 'text')
- `path[2+]` = Deeper nesting (for Y.Text operations)

#### 3.4 applyObjectChanges Logic

**Deletion Flow**:
1. Lookup handle from objectsById
2. Remove from spatial index using old bbox
3. Add ID to cacheEvictIds (Path2D eviction)
4. Push bbox to dirtyRects
5. Delete from objectsById

**Addition/Update Flow**:
1. Get Y.Map from parent: `objects.get(id)`
2. Extract kind: `yObj.get('kind')`
3. Compute new bbox: `computeBBoxFor(kind, yObj)`
4. Build handle with live Y.Map reference
5. Update spatial index (insert or update)
6. **Cache/Dirty Decision Tree**:
   - New object → Mark dirty, no eviction
   - BBox changed → Evict + mark both old/new dirty
   - BBox unchanged (style-only) → Mark dirty, no eviction
   - Text-only change → Skip dirty marking

#### 3.5 BBox Computation

```typescript
function computeBBoxFor(kind: ObjectKind, yMap: Y.Map<any>): [number, number, number, number] {
  switch (kind) {
    case 'stroke':
    case 'connector': {
      const points = yMap.get('points') as [number, number][];
      // Find min/max from points
      const width = yMap.get('width') as number ?? 1;
      const padding = width * 0.5 + 1;  // CRITICAL: Width affects bbox!
      return [minX - padding, minY - padding, maxX + padding, maxY + padding];
    }

    case 'shape':
    case 'text': {
      const frame = yMap.get('frame') as [number, number, number, number];
      return [frame[0], frame[1], frame[0] + frame[2], frame[1] + frame[3]];
    }
  }
}
```

**CRITICAL INSIGHT**: Width is part of bbox calculation. When width changes:
1. BBox changes (due to padding)
2. Triggers geometry eviction
3. Path2D must be rebuilt

#### 3.6 Snapshot Building

```typescript
buildSnapshot(): Snapshot {
  // Create spatial index ONCE (singleton pattern)
  if (!this.spatialIndex) {
    this.spatialIndex = new ObjectSpatialIndex();
  }

  // Two-epoch model: rebuild on first run or when flagged
  if (this.needsSpatialRebuild) {
    this.hydrateObjectsFromY();  // Full rebuild from Y.Doc
    this.needsSpatialRebuild = false;
  }

  // Build dirty patch from accumulated changes
  let dirtyPatch: DirtyPatch | null = null;
  if (this.dirtyRects.length > 0 || this.cacheEvictIds.size > 0) {
    dirtyPatch = {
      rects: this.dirtyRects.splice(0),        // DRAIN array
      evictIds: Array.from(this.cacheEvictIds) // Copy set
    };
    this.cacheEvictIds.clear();  // CLEAR set
  }

  return {
    docVersion: this.docVersion,
    objectsById: this.objectsById,      // LIVE Map reference (not cloned!)
    spatialIndex: this.spatialIndex,    // LIVE index reference
    presence: this.buildPresenceView(),
    view: this.getViewTransform(),
    meta: metaData,
    createdAt: Date.now(),
    dirtyPatch,  // Transient, cleared after extraction
  };
}
```

---

## Spatial Index

### 4. ObjectSpatialIndex

```typescript
export class ObjectSpatialIndex {
  private tree = new RBush<IndexEntry>(9);  // Max 9 entries per node

  insert(id: string, bbox: [number, number, number, number], kind: ObjectKind): void;
  update(id: string, oldBBox: [...], newBBox: [...], kind: ObjectKind): void;
  remove(id: string, bbox: [number, number, number, number]): void;
  query(bounds: { minX, minY, maxX, maxY }): IndexEntry[];
  bulkLoad(handles: ObjectHandle[]): void;  // O(N log N) bulk insert
  clear(): void;
}
```

**Key Design**:
- NO internal data storage (purely spatial acceleration)
- Returns `IndexEntry[]` with `{ minX, minY, maxX, maxY, id, kind }`
- Lookup pattern: `query() → entry.id → objectsById.get(id) → handle.y`

---

## Rendering Pipeline

### 5. Canvas.tsx Integration

#### 5.1 Snapshot Subscription
```typescript
useEffect(() => {
  const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
    snapshotRef.current = newSnapshot;  // Store in ref (no React re-render)

    if (newSnapshot.docVersion !== lastDocVersion) {
      // Document change
      if (newSnapshot.dirtyPatch) {
        const { rects, evictIds } = newSnapshot.dirtyPatch;

        // Evict from cache
        const cache = getObjectCacheInstance();
        cache.evictMany(evictIds);

        // Invalidate ONLY visible dirty regions (viewport optimization)
        for (const bounds of rects) {
          if (boundsIntersect(bounds, viewport)) {
            renderLoop.invalidateWorld(bounds);
          }
        }
      }
    } else {
      // Presence-only update
      overlayLoop.invalidateAll();
    }
  });
}, [roomDoc]);
```

**Viewport Optimization**: Canvas performs intersection check before invalidation to avoid unnecessary redraws of offscreen changes.

### 6. Objects Renderer

#### 6.1 drawObjects Main Loop
```typescript
export function drawObjects(ctx, snapshot, viewTransform, viewport): void {
  const { spatialIndex, objectsById } = snapshot;

  // Query visible objects
  const visibleBounds = getVisibleWorldBounds(viewTransform, viewport);
  const entries = spatialIndex.query(visibleBounds);

  // CRITICAL: Sort by ULID for deterministic z-order
  entries.sort((a, b) => a.id.localeCompare(b.id));

  // Render each object
  for (const entry of entries) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    // LOD: Skip objects <2px diagonal
    if (shouldSkipLOD(handle.bbox, viewTransform)) continue;

    drawObject(ctx, handle, viewTransform);
  }
}

function drawObject(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
): void {
  switch (handle.kind) {
    case 'stroke':
      drawStroke(ctx, handle);
      break;
    case 'shape':
      drawShape(ctx, handle);
      break;
    case 'text':
      drawTextBox(ctx, handle);
      break;
    case 'connector':
      drawConnector(ctx, handle);
      break;
  }
}
```

**ULID Sorting Rationale**: RBush query order is non-deterministic. ULID provides monotonic time-based ordering ensuring consistent z-order across tabs/sessions.

#### 6.2 Direct Y.Map Field Access

```typescript
function drawStroke(ctx, handle, view): void {
  const { id, y } = handle;

  // Read style DIRECTLY from Y.Map (no intermediate view!)
  const color = y.get('color') as string ?? '#000';
  const opacity = y.get('opacity') as number ?? 1;
  const tool = y.get('tool') as string ?? 'pen';

  // Get cached Path2D geometry
  const cache = getObjectCacheInstance();
  const path = cache.getOrBuild(id, handle);

  // Render
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.fill(path);  // Strokes are ALWAYS filled polygons
  ctx.restore();
}
```

### 7. Object Cache

#### 7.1 ObjectRenderCache

```typescript
export class ObjectRenderCache {
  private cache = new Map<string, Path2D>();  // No size limit

  getOrBuild(id: string, handle: ObjectHandle): Path2D {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const path = this.buildPath(handle);
    this.cache.set(id, path);
    return path;
  }

  private buildPath(handle: ObjectHandle): Path2D {
    switch (handle.kind) {
      case 'stroke':
        // ALWAYS Perfect Freehand polygon
        const points = handle.y.get('points');
        const width = handle.y.get('width');
        const outline = getStroke(points, {
          ...PF_OPTIONS_BASE,
          size: width,
          last: true  // Finalized geometry
        });
        return new Path2D(getSvgPathFromStroke(outline, false));

      case 'shape':
        // ALWAYS frame-based geometry
        const shapeType = handle.y.get('shapeType');
        const frame = handle.y.get('frame');
        const path = new Path2D();

        switch (shapeType) {
          case 'rect': path.rect(x, y, w, h); break;
          case 'ellipse': path.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); break;
          // ... other shapes
        }
        return path;

      case 'connector':
        // ALWAYS polyline with optional caps
        // ... polyline + arrow construction

      case 'text':
        return new Path2D();  // Text doesn't use Path2D
    }
  }

  evictMany(ids: string[]): void {
    for (const id of ids) {
      this.cache.delete(id);
    }
  }
}
```

**Cache Strategy**:
- DEAD SIMPLE: Just Path2D memoization by ID
- NO size variants (width changes trigger eviction)
- NO LRU eviction (relies on aggressive bbox-based eviction)
- Style changes don't evict (color/opacity don't affect Path2D)

---

## Tool Implementations

### 8. DrawingTool

#### 8.1 Stroke Commit
```typescript
this.room.mutate((ydoc) => {
  const root = ydoc.getMap('root');
  const objects = root.get('objects') as Y.Map<Y.Map<any>>;

  const strokeMap = new Y.Map();
  strokeMap.set('id', strokeId);
  strokeMap.set('kind', 'stroke');
  strokeMap.set('tool', this.state.config.tool);
  strokeMap.set('color', this.state.config.color);
  strokeMap.set('width', this.state.config.size);  // Renamed from 'size'
  strokeMap.set('opacity', this.state.config.opacity);
  strokeMap.set('points', canonicalTuples);  // [number, number][] tuples
  strokeMap.set('ownerId', this.userId);
  strokeMap.set('createdAt', Date.now());

  objects.set(strokeId, strokeMap);  // Add to parent map
});
```

#### 8.2 Perfect Shape Commit
```typescript
const shapeMap = new Y.Map();
shapeMap.set('id', shapeId);
shapeMap.set('kind', 'shape');
shapeMap.set('shapeType', snapKind);  // 'rect', 'circle', 'line', etc.
shapeMap.set('strokeColor', this.state.config.color);
shapeMap.set('strokeWidth', this.state.config.size);
shapeMap.set('opacity', this.state.config.opacity);
shapeMap.set('frame', [x, y, width, height]);
// ... commit
```

### 9. EraserTool

#### 9.1 Atomic Delete
```typescript
this.room.mutate((ydoc) => {
  const root = ydoc.getMap('root');
  const objects = root.get('objects') as Y.Map<Y.Map<any>>;

  // Direct deletion by ID from Y.Map
  for (const id of hitIds) {
    objects.delete(id);
  }
});
```

---

## Migration Gaps & Future Work

### 12. Missing Implementations

#### 12.1 Text Tool (NOT IMPLEMENTED)
- Text rendering exists (objects.ts drawTextBox)
- DOM overlay infrastructure exists (Canvas.tsx)
- Missing: TextTool.ts for authoring text objects
- Will use Y.Text for collaborative editing

#### 12.2 Connector Tool (NOT IMPLEMENTED)
- Connector rendering exists (objects.ts drawConnector)
- Missing: ConnectorTool.ts for authoring connectors
- Future: Sticky connectors that attach to shapes
- Will implement elbow/curved routing

#### 12.3 Select Tool (NOT IMPLEMENTED)
- Referenced in device-ui-store
- Missing: SelectTool.ts
- Future: Bounding box selection, multi-select, transform handles
- Will enable in-place object mutation

#### 12.4 Shape Tool Seperation


---

## Critical Implementation Rules

### 14. Invariants That Must Be Maintained

1. **NEVER store bbox in Y.Map** - Always compute locally
2. **NEVER clone Y.Maps** - Use direct references via handle.y
3. **NEVER create spatial index multiple times** - Singleton in buildSnapshot
4. **ALWAYS check needsSpatialRebuild** in observers
5. **ALWAYS sort by ULID** for deterministic rendering
6. **ALWAYS include width in bbox padding** for strokes/connectors
7. **ALWAYS use tuples for points** - [number, number][] not flat arrays
8. **ALWAYS drain dirtyRects/evictIds** after snapshot build
9. **NEVER mix DPR into world transforms** - Apply once at canvas level
10. **ALWAYS use 'width' field name** - Not 'size' (migration complete)

### 15. Observer Lifecycle

```
1. Create Y.Doc
2. Setup doc-level observer (handleYDocUpdate)
3. Attach IDB provider
4. Attach WS provider
5. Wait for gates (idbReady + wsSynced/timeout)
6. Seed structures if needed (initializeYjsStructures)
7. Attach deep observer (muted by needsSpatialRebuild = true)
8. Attach UndoManager

First buildSnapshot():
9. Create spatial index ONCE (if !this.spatialIndex)
10. Do initial hydration (because needsSpatialRebuild = true)
11. Set needsSpatialRebuild = false
12. Deep observer now active for incremental updates
```

---

## Conclusion

The Y.Map migration represents a fundamental architectural improvement that eliminates data duplication, provides direct Y.Map access throughout the system, and maintains high performance through aggressive caching and dirty tracking. The implementation is production-ready for drawing operations with clear extension points for text editing, connectors, and selection tools.

The architecture successfully balances simplicity (direct Y.Map access) with performance (spatial indexing, caching) while maintaining collaborative editing semantics through Yjs. The two-epoch model elegantly handles both bulk hydration and incremental updates without complex state machines or journals.

Future work should focus on implementing the missing tools (Text, Connector, Select) while maintaining the established patterns of direct Y.Map access, bbox-based cache invalidation, and viewport-aware rendering.