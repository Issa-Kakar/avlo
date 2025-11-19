# Y.Map Migration Complete Implementation Guide
I need to remove a ton of things from this codebase to achieve what I want. This will be a large process. I still need to remove scene ticks, and remove and reshape everything. It touches a lot, the main idea is to use Y.map's for everything, add a dedicated seperated shape tool, add y.text for text boxes and add y.text for shapes within for new rich formatting, add "connecters" that are sticky, with elbowed arrows that stick to shapes once connected. We still need to add the select tool as well, and also be able to modify existing text/strokes/shapes etc., and in the future: add true collaborative code cells via codemirror with python/js workers sandboxed for code execution. 


# GOALS
- NEW Y.MAP STRUCTURE OF OBJECTS
- SEPERATE SHAPE TOOL FROM DRAWING TOOL AND STROKES
- ADD CONNECTORS AS A SEPERATE TOOL AS WELL
- CONNECTORS WILL HAVE STRAIGHT OR ELBOWED ARROWS WITH STICKINESS TO SHAPES IF CONNECTED. WHEN DRAGGING A SHAPE, A CONNECTOR THAT IS ATTATCHED TO THAT SHAPE WILL STAY ATTATCHED DIRECTLY TO THAT SHAPE AT THAT POINT, WITH THE PATH RECOMPUTING DURING PREVIEW UNTIL COMMIT FINALIZES THE NEW SHAPE POSITION.
- WE WILL CACHE AGGRESSIVELY. FOR EVERYTHING
- WE NEED TO UPDATE OUR CACHING WITH THE NEW DATA TYPES SOMEWHAT.
- WE AIM TO REDUCE BOILERPLATE CODE FOR FASTER ITERATION
- WE NEED A WAY TO FIGURE OUT WHEN TO INVALIDATE CACHES ON NESTED PROPERTIES STILL. SO WE WILL NOT BE USING PLAIN OBSERVERS ON THE OBJECT CONTAINER LIKE WE DO FOR STROKES, SINCE WE ARE NOW DESIGNING A SELECT TOOL TO SUPPORT OBJECTS MUTATION IN PLACE WITHOUT THE Y.ARRAY OVERHEAD OF DELETING+REINSERTING, WHICH HAS WORSE COLLABORATION SEMANTICS AND MORE NETWORK OVERHEAD. SO WE WILL BE USING YJS DEEP OBSERVERS TO FIGURE OUT WHAT TO DO IF WE NEED TO INVALIDATE CACHES.
- WE ARE GOING TO PROPERLY USE ZUSTAND TO THE FULLEST CAPABILITIES IN THE FUTURE FOR TOOLS AND STORES/SUBSCRIPTIONS. THE SELECT TOOL IN THE FUTURE WILL BE PIVOTAL. WE WILL FOCUS ON MIGRATING TO YJS MAP IN THIS FILE
- WE WILL UPDATE THE DRAWING TOOL, SEPERATE THE SHAPE TOOL, PERHAPS SEPERATE THE CONNECTOR TOOL FROM SHAPE TOOL AS WELL
- THE CURRENT PROJECT HAS A PERFECT SHAPE DETECTOR THAT FIRES ON HOLD CURRENTLY. WE WILL NOT STORE REGULAR POINTS ANYMORE AS WE WILL BE STORING TUPLES ONLY. HOWEVER, THE DRAWING TOOL USES THE POINTS WITHOUT TUPLES FOR PROCESSING THE PERFECT SHAPE DETECTOR WITH RAMAS DOUGLAS PEUCKER SIMPLIFICATION. THIS RDP SIMPLIFICATION WHEN THE HOLD DETECTOR FIRES WILL BE CHANGED TO USE RDP ON TUPLES INSTEAD, THUS NOT NEEDING TO KEEP BOTH.
- WHEN THE SHAPE RECOGNIZER IS SUCCESSFUL ON THE DRAWING TOOL: WE WILL ROUTE IMMEDIATLEY TO THE SHAPE TOOL PREVIEW. WE WILL FIGURE OUT HOW TO DO THIS FOR COMMIT THOUGH: DUE TO THE CANVAS CREATING A TOOL FROM ZUSTAND, WE'LL NEED TO CHANGE THIS ANYWAY IN THE FUTURE WITH REMOVING DEPENDENCY ARRAYS. FOR NOW, FOCUS ON YJS 
## Executive Summary

This document provides the complete, step-by-step implementation guide for migrating AVLO from Y.Array-based storage to Y.Map<Y.Map> architecture. The migration eliminates intermediate views and simplifies the entire rendering pipeline.

**Core Principles:**
- Direct Y.Map reading in renderers (NO StrokeView/TextView clones)
- BBox computed locally, includes width padding (width change = bbox change = evict)
- Clear object separation: strokes (ALWAYS PF polygon), shapes (ALWAYS frame-based), connectors (ALWAYS polyline)
- Single geometry cache with NO variants - just Path2D by ID
- Spatial index created ONCE in buildSnapshot, never recreated
- Two-epoch model: initial hydration, then incremental updates via deep observer
- Manager computes dirty rects during observer callbacks, Canvas just uses them

**Design Decision**: Use consistent field names across all object types for easier multi-select mutations.

```typescript
// Universal fields (all objects)
id: string                  // ULID
kind: 'stroke' | 'shape' | 'text' | 'connector'
ownerId: string             // User who created
createdAt: number           // ms epoch
locked?: boolean            // Future: prevent edits

// Visual styling (strokes, shapes, connectors share these)
color: string               // Stroke/fill/text color
width: number               // Stroke width (not "size")
opacity: number             // Universal opacity

// Text styling (shapes with labels, text boxes share these)
fontSize: number            // Not "size"
fontFamily: string
fontWeight: 'normal' | 'bold'
fontStyle: 'normal' | 'italic'
textAlign: 'left' | 'center' | 'right'

// Stroke-specific
tool: 'pen' | 'highlighter'
points: [number, number][]  // Tuples only, no flattened arrays

// Shape-specific
shapeType: 'rect' | 'ellipse' | 'diamond' | 'roundedRect'
frame: [number, number, number, number]  // [x, y, w, h]
fillColor?: string          // Optional fill
strokeColor?: string        // Optional outline (uses width/opacity)
label?: Y.Text              // Collaborative text
padding?: [number, number, number, number] // text label padding in shape
textAlignV: 'top' | 'middle' | 'bottom'
connectorIds?: string[]     // Reverse lookup for attached connectors

// Connector-specific
fromId?: string             // Attached shape ID
fromAnchor?: 'top' | 'right' | 'bottom' | 'left'
toId?: string
toAnchor?: 'top' | 'right' | 'bottom' | 'left'
points: [number, number][]  // Path points
routingMode: 'auto' | 'manual'
routingType: 'linear' | 'elbow' | 'curved'
startCap: 'none' | 'arrow' | 'circle'
endCap: 'none' | 'arrow' | 'circle'
label?: Y.Text
labelOffset?: number

// Text box specific
frame: [number, number, number, number]  // [x, y, w, h]
text: Y.Text                // Collaborative text content
padding?: [number, number, number, number]
---
```
## Phase 1: Core Type Definitions

### 1.1 Create New Types (`packages/shared/src/types/objects.ts`)

```typescript
// Object types - STRICT SEMANTIC SEPARATION
// stroke = pen/highlighter (ALWAYS Perfect Freehand polygon)
// shape = geometric shapes (ALWAYS polyline: rect/ellipse/line)
// text = text blocks (frame-based positioning)
// connector = connection lines/arrows (ALWAYS polyline)
export type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector';

// Lightweight handle pointing to Y.Map
export interface ObjectHandle {
  id: string;
  kind: ObjectKind;
  y: Y.Map<any>;  // Direct Y.Map reference
  bbox: [number, number, number, number];  // Computed locally, NOT stored in Y.Map
}

// Spatial index entry (minimal)
export interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  kind: ObjectKind;
  // NO data field - lookup via objectsById
}

// Dirty tracking
export type WorldBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export interface DirtyPatch {
  rects: WorldBounds[];
  evictIds: string[];
}
```

### 1.2 Update Snapshot Type (`packages/shared/src/types/snapshot.ts`)

```typescript
export interface Snapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;  // Live references
  spatialIndex: ObjectSpatialIndex | null;
  presence: PresenceView;
  view: ViewTransform;
  meta: SnapshotMeta;
  createdAt: number;
  dirtyPatch?: DirtyPatch | null;

  // Temporary backward compatibility (optional)
  get strokes(): ReadonlyArray<StrokeView>;
  get texts(): ReadonlyArray<TextView>;
}
```

---

## Phase 2: Spatial Index Updates

### 2.1 Create New Spatial Index (`packages/shared/src/spatial/object-spatial-index.ts`)

```typescript
import RBush from 'rbush';
import type { ObjectKind, IndexEntry, ObjectHandle } from '../types/objects';

export class ObjectSpatialIndex {
  private tree = new RBush<IndexEntry>(9);

  insert(id: string, bbox: [number, number, number, number], kind: ObjectKind): void {
    const [minX, minY, maxX, maxY] = bbox;
    this.tree.insert({ minX, minY, maxX, maxY, id, kind });
  }

  update(id: string, oldBBox: [number, number, number, number], newBBox: [number, number, number, number], kind: ObjectKind): void {
    // Remove old entry
    const [minX, minY, maxX, maxY] = oldBBox;
    this.tree.remove(
      { minX, minY, maxX, maxY, id, kind } as IndexEntry,
      (a, b) => a.id === b.id
    );

    // Insert new entry
    this.insert(id, newBBox, kind);
  }

  remove(id: string, bbox: [number, number, number, number]): void {
    const [minX, minY, maxX, maxY] = bbox;
    // Remove by ID only - kind doesn't matter for removal
    this.tree.remove(
      { minX, minY, maxX, maxY, id } as any,
      (a, b) => a.id === b.id
    );
  }

  query(bounds: { minX: number; minY: number; maxX: number; maxY: number }): IndexEntry[] {
    return this.tree.search(bounds);
  }

  bulkLoad(handles: ObjectHandle[]): void {
    const items: IndexEntry[] = handles.map(h => {
      const [minX, minY, maxX, maxY] = h.bbox;
      return { minX, minY, maxX, maxY, id: h.id, kind: h.kind };
    });

    if (items.length > 0) {
      this.tree.load(items);
    }
  }

  clear(): void {
    this.tree.clear();
  }
}
```

---

## Phase 3: BBox Computation Utilities

### 3.1 Create Unified BBox Helper (`packages/shared/src/utils/bbox.ts`)

```typescript
export function computeBBoxFor(kind: ObjectKind, yMap: Y.Map<any>): [number, number, number, number] {
  switch (kind) {
    case 'stroke': {
      const points = (yMap.get('points') as [number, number][]) ?? [];
      if (points.length < 2) return [0, 0, 0, 0];

      let minX = points[0][0], minY = points[0][1];
      let maxX = minX, maxY = minY;

      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      // CRITICAL: Width IS part of bbox!
      // If width changes → bbox changes → geometry eviction
      const width = (yMap.get('width') as number) ?? 1;
      const padding = width * 0.5 + 1;

      return [
        minX - padding,
        minY - padding,
        maxX + padding,
        maxY + padding
      ];
    }

    case 'shape':
    case 'text': {
      const frame = (yMap.get('frame') as [number, number, number, number]) ?? [0, 0, 0, 0];
      return [
        frame[0],
        frame[1],
        frame[0] + frame[2],
        frame[1] + frame[3]
      ];
    }

    case 'connector': {
      const points = (yMap.get('points') as [number, number][]) ?? [];
      if (points.length < 2) return [0, 0, 0, 0];

      let minX = points[0][0], minY = points[0][1];
      let maxX = minX, maxY = minY;

      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }

      const width = (yMap.get('width') as number) ?? 2;
      const padding = width * 0.5 + 1;

      return [
        minX - padding,
        minY - padding,
        maxX + padding,
        maxY + padding
      ];
    }

    default:
      return [0, 0, 0, 0];
  }
}

export function bboxEquals(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function bboxToBounds(bbox: [number, number, number, number]): WorldBounds {
  return {
    minX: bbox[0],
    minY: bbox[1],
    maxX: bbox[2],
    maxY: bbox[3]
  };
}
```

---

## Phase 4: RoomDocManager Updates

### 4.1 Update State Management (`client/src/lib/room-doc-manager.ts`)

Replace current state with:

```typescript
// Remove these:
// private strokesById = new Map<string, StrokeView>();
// private textsById = new Map<string, TextView>();
// private _arraysObserved = false;

// Add these:
private objectsById = new Map<string, ObjectHandle>();
private spatialIndex: ObjectSpatialIndex | null = null;  // Created ONCE in buildSnapshot
private dirtyRects: WorldBounds[] = [];
private cacheEvictIds = new Set<string>();
private objectsObserver: ((events: Y.YEvent<any>[], tx: Y.Transaction) => void) | null = null;
private needsSpatialRebuild = true;  // Start true, goes false after first hydration
```

### 4.2 Update Structure Initialization

```typescript
private initializeYjsStructures(): void {
  this.ydoc.transact(() => {
    const root = this.ydoc.getMap('root');

    // Bump schema version
    root.set('v', 2);

    // Keep meta
    if (!root.has('meta')) {
      root.set('meta', new Y.Map());
    }

    // NEW: Create objects map instead of arrays
    if (!root.has('objects')) {
      root.set('objects', new Y.Map());
    }

    // Keep code and outputs
    if (!root.has('code')) {
      root.set('code', new Y.Map());
    }

    if (!root.has('outputs')) {
      root.set('outputs', new Y.Array());
    }
  });
}

private getObjects(): Y.Map<Y.Map<any>> {
  const root = this.getRoot();
  const objects = root.get('objects');
  if (!(objects instanceof Y.Map)) {
    throw new Error('objects map not initialized');
  }
  return objects as Y.Map<Y.Map<any>>;
}
```

### 4.3 Replace Array Observers with Deep Observer

```typescript
private setupObjectsObserver(): void {
  if (this.objectsObserver) return; // idempotent

  const objects = this.getObjects();

  this.objectsObserver = (events, tx) => {
    // CRITICAL: Ignore during rebuild epoch
    if (this.needsSpatialRebuild) return;

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
      const path = ev.path as (string | number)[];
      const id = String(path[0] ?? '');
      if (!id) continue;

      touchedIds.add(id);

      // Track text-only changes for optimization
      if (ev instanceof Y.YTextEvent) {
        const field = String(path[1] ?? '');
        if (field === 'text' || field === 'label') {
          textOnlyIds.add(id);
        }
      }
    }

    if (touchedIds.size === 0 && deletedIds.size === 0) return;

    this.applyObjectChanges({ touchedIds, deletedIds, textOnlyIds });
    // No need to set isDirty - handleYDocUpdate already does that
  };

  objects.observeDeep(this.objectsObserver);
  // needsSpatialRebuild is already true from initialization
}
```

### 4.4 Implement applyObjectChanges

```typescript
private applyObjectChanges(args: {
  touchedIds: Set<string>;
  deletedIds: Set<string>;
  textOnlyIds: Set<string>;
}): void {
  const { touchedIds, deletedIds, textOnlyIds } = args;
  const objects = this.getObjects();

  // Process deletions
  for (const id of deletedIds) {
    const handle = this.objectsById.get(id);
    if (!handle) continue;

    // Update spatial index
    if (this.spatialIndex) {
      this.spatialIndex.remove(id, handle.bbox);
    }

    // Track for cache eviction
    this.cacheEvictIds.add(id);

    // Mark dirty
    this.dirtyRects.push(bboxToBounds(handle.bbox));

    // Remove from registry
    this.objectsById.delete(id);
  }

  // Process additions/updates
  for (const id of touchedIds) {
    const yObj = objects.get(id);
    if (!yObj) continue;

    const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';
    const prev = this.objectsById.get(id);
    const oldBBox = prev?.bbox ?? null;

    // Compute new bbox
    const newBBox = computeBBoxFor(kind, yObj);

    const handle: ObjectHandle = {
      id,
      kind,
      y: yObj,
      bbox: newBBox
    };

    this.objectsById.set(id, handle);

    // Update spatial index (already exists from buildSnapshot)
    if (this.spatialIndex) {
      if (oldBBox) {
        this.spatialIndex.update(id, oldBBox, newBBox, kind);
      } else {
        this.spatialIndex.insert(id, newBBox, kind);
      }
    }

    // Handle cache and dirty rects
    const textOnly = textOnlyIds.has(id);

    if (!oldBBox) {
      // New object
      this.dirtyRects.push(bboxToBounds(newBBox));
    } else {
      const bboxChanged = !bboxEquals(oldBBox, newBBox);

      if (bboxChanged) {
        // Geometry changed (INCLUDING width changes since bbox includes width!)
        this.cacheEvictIds.add(id);
        this.dirtyRects.push(bboxToBounds(oldBBox));
        this.dirtyRects.push(bboxToBounds(newBBox));
      } else {
        // Style-only change (color, opacity) - bbox unchanged
        if (!textOnly) {
          this.dirtyRects.push(bboxToBounds(newBBox));
        }
      }
    }
  }
}
```

### 4.5 Update Hydration

```typescript
private hydrateObjectsFromY(): void {
  const objects = this.getObjects();

  // Reset everything EXCEPT spatial index (already created in buildSnapshot)
  this.objectsById.clear();
  if (this.spatialIndex) {
    this.spatialIndex.clear();
  }
  // Clear dirty tracking - this is a full rebuild
  this.dirtyRects.length = 0;
  this.cacheEvictIds.clear();

  // Build handles from Y.Doc
  const handles: ObjectHandle[] = [];
  objects.forEach((yObj, key) => {
    const id = String(key);
    const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';
    const bbox = computeBBoxFor(kind, yObj);

    const handle: ObjectHandle = { id, kind, y: yObj, bbox };
    this.objectsById.set(id, handle);
    handles.push(handle);
  });

  // Bulk load spatial index
  if (this.spatialIndex && handles.length > 0) {
    this.spatialIndex.bulkLoad(handles);
  }

  // No need to set isDirty - buildSnapshot will handle publishing
}
```

### 4.6 Update buildSnapshot

```typescript
private buildSnapshot(): Snapshot {
  const root = this.getRoot();
  const meta = root.get('meta') as Y.Map<unknown> | undefined;
  const objects = root.get('objects') as Y.Map<Y.Map<any>> | undefined;

  // Guard: structures must exist
  if (!meta || !objects) {
    return this._currentSnapshot;
  }

  // Create spatial index ONCE (first time only)
  if (!this.spatialIndex) {
    this.spatialIndex = new ObjectSpatialIndex();
    // needsSpatialRebuild is already true from initialization
  }

  // Two-epoch model: rebuild on first run or when flagged
  if (this.needsSpatialRebuild) {
    this.hydrateObjectsFromY();
    this.needsSpatialRebuild = false;
  }

  // Build dirty patch from accumulated changes
  let dirtyPatch: DirtyPatch | null = null;
  if (this.dirtyRects.length > 0 || this.cacheEvictIds.size > 0) {
    dirtyPatch = {
      rects: this.dirtyRects.splice(0),
      evictIds: Array.from(this.cacheEvictIds)
    };
    this.cacheEvictIds.clear();
  }

  const metaData: SnapshotMeta = {
    cap: ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES,
    readOnly: this.roomStats?.bytes
      ? this.roomStats.bytes >= ROOM_CONFIG.ROOM_SIZE_READONLY_BYTES
      : false,
    bytes: this.roomStats?.bytes,
    expiresAt: this.roomStats?.expiresAt,
  };

  const snap: Snapshot = {
    docVersion: this.docVersion,
    objectsById: this.objectsById,
    spatialIndex: this.spatialIndex,
    presence: this.buildPresenceView(),
    view: this.getViewTransform(),
    meta: metaData,
    createdAt: Date.now(),
    dirtyPatch,
  };

  // Open first snapshot gate if applicable
  if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
    this.openGate('firstSnapshot');
  }

  return snap;
}
```

### 4.7 Update Constructor Initialization

```typescript
// In constructor, replace setupArrayObservers with:
this.whenGateOpen('idbReady').then(async () => {
  // Wait for WS sync or timeout
  await Promise.race([
    this.whenGateOpen('wsSynced'),
    this.delay(5_000),
  ]);

  const root = this.ydoc.getMap('root');

  // Seed structures if needed
  if (!root.has('meta')) {
    this.initializeYjsStructures();
  }

  // Setup deep observer (muted by needsSpatialRebuild = true initially)
  this.setupObjectsObserver();

  // Attach UndoManager scoped to objects map
  this.attachUndoManager();

  // First buildSnapshot() will:
  // 1. Create spatial index (once)
  // 2. Do initial hydration (needsSpatialRebuild = true)
  // 3. Set needsSpatialRebuild = false
  // 4. Enable deep observer for incremental updates
});
```

### 4.8 Update UndoManager

```typescript
private attachUndoManager(): void {
  if (this.undoManager) return;

  const objects = this.getObjects();

  // Track changes to objects map
  this.undoManager = new Y.UndoManager([objects], {
    trackedOrigins: new Set([this.userId]),
    captureTimeout: 500,
  });
}
```

---

## Phase 5: New Geometry Cache

### 5.1 Create Object Cache (`client/src/renderer/object-cache.ts`)

```typescript
import type { ObjectHandle } from '@avlo/shared';
import { getStroke } from 'perfect-freehand';
import { PF_OPTIONS_BASE } from './stroke-builder/pf-config';
import { getSvgPathFromStroke } from './stroke-builder/pf-svg';

// DEAD SIMPLE: Just Path2D memoization by ID
export class ObjectRenderCache {
  private cache = new Map<string, Path2D>();
  // No size limit - we already evict aggressively on bbox changes

  getOrBuild(id: string, handle: ObjectHandle): Path2D {
    // Check cache
    const cached = this.cache.get(id);
    if (cached) return cached;

    // Build and store
    const path = this.buildPath(handle);
    this.cache.set(id, path);
    return path;
  }

  private buildPath(handle: ObjectHandle): Path2D {
    const { kind, y } = handle;

    switch (kind) {
      case 'stroke': {
        // STROKES ARE ALWAYS PERFECT FREEHAND POLYGONS
        const points = y.get('points') as [number, number][];
        const width = y.get('width') as number;

        if (!points) {
          return new Path2D();
        }

        // Generate Perfect Freehand outline
        const outline = getStroke(points, {
          ...PF_OPTIONS_BASE,
          size: width,
          last: true,
        });

        return new Path2D(getSvgPathFromStroke(outline, false));
      }

      case 'shape': {
        // SHAPES ARE ALWAYS GEOMETRIC POLYLINES (built from frame)
        const shapeType = y.get('shapeType') as string;
        const frame = y.get('frame') as [number, number, number, number];

        if (!frame) return new Path2D();

        const [x, y0, w, h] = frame;
        const path = new Path2D();

        switch (shapeType) {
          case 'rect':
            path.rect(x, y0, w, h);
            break;
          case 'ellipse':
            path.ellipse(x + w/2, y0 + h/2, w/2, h/2, 0, 0, Math.PI * 2);
            break;
          case 'diamond': {
            const cx = x + w / 2;
            const cy = y0 + h / 2;
            path.moveTo(cx, y0);
            path.lineTo(x + w, cy);
            path.lineTo(cx, y0 + h);
            path.lineTo(x, cy);
            path.closePath();
            break;
          }
          case 'roundedRect': {
            const r = Math.min((y.get('cornerRadius') as number) ?? 8, w / 2, h / 2);
            roundedRect(path, x, y0, w, h, r);
            break;
          }
          default:
            path.rect(x, y0, w, h);
        }

        return path;
      }

      case 'connector': {
        // CONNECTORS ARE ALWAYS POLYLINES (including arrows)
        // stub
      }

      case 'text':
        // Text doesn't use Path2D
        return new Path2D();

      default:
        return new Path2D();
    }
  }

  evict(id: string): void {
    this.cache.delete(id);
  }

  evictMany(ids: string[]): void {
    for (const id of ids) {
      this.cache.delete(id);
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

// Singleton instance
let globalCache: ObjectRenderCache | null = null;

export function getObjectCacheInstance(): ObjectRenderCache {
  if (!globalCache) {
    globalCache = new ObjectRenderCache();
  }
  return globalCache;
}
```

---

## Phase 6: Unified Renderer

### 6.1 Create Objects Renderer (`client/src/renderer/layers/objects.ts`)

```typescript
import type { Snapshot, ViewTransform, ObjectHandle } from '@avlo/shared';
import type { ViewportInfo } from '../types';
import { getObjectCacheInstance } from '../object-cache';

export function drawObjects(
  ctx: CanvasRenderingContext2D,
  snapshot: Snapshot,
  viewTransform: ViewTransform,
  viewport: ViewportInfo,
): void {
  const { spatialIndex, objectsById } = snapshot;
  if (!spatialIndex) return;

  // Query visible objects
  const visibleBounds = getVisibleWorldBounds(viewTransform, viewport);
  const entries = spatialIndex.query(visibleBounds);

  // Sort by ULID for deterministic z-order
  entries.sort((a, b) => a.id.localeCompare(b.id));

  // Render each object
  for (const entry of entries) {
    const handle = objectsById.get(entry.id);
    if (!handle) continue;

    // LOD check
    if (shouldSkipLOD(handle.bbox, viewTransform)) continue;

    drawObject(ctx, handle, viewTransform);
  }
}

function drawObject(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  view: ViewTransform,
): void {
  switch (handle.kind) {
    case 'stroke':
      drawStroke(ctx, handle, view);
      break;
    case 'shape':
      drawShape(ctx, handle, view);
      break;
    case 'text':
      drawTextBox(ctx, handle, view);
      break;
    case 'connector':
      drawConnector(ctx, handle, view);
      break;
  }
}

function drawStroke(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  view: ViewTransform,
): void {
  const { id, y } = handle;

  // Read style directly from Y.Map
  const color = (y.get('color') as string) ?? '#000';
  const width = (y.get('width') as number) ?? 1;
  const opacity = (y.get('opacity') as number) ?? 1;
  const tool = (y.get('tool') as string) ?? 'pen';

  // Get cached geometry by ID
  const cache = getObjectCacheInstance();
  const path = cache.getOrBuild(id, handle);

  ctx.save();
  ctx.globalAlpha = opacity;

  // STROKES ARE ALWAYS FILLED POLYGONS
  ctx.fillStyle = color;
  if (tool === 'highlighter') {
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fill(path);

  ctx.restore();
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  view: ViewTransform,
): void {
  const { id, y } = handle;

  const fillColor = y.get('fillColor') as string | undefined;
  const strokeColor = y.get('strokeColor') as string | undefined;
  const strokeWidth = (y.get('strokeWidth') as number) ?? 1;
  const opacity = (y.get('opacity') as number) ?? 1;

  const cache = getObjectCacheInstance();
  const path = cache.getOrBuild(id, handle);

  ctx.save();
  ctx.globalAlpha = opacity;

  if (fillColor) {
    ctx.fillStyle = fillColor;
    ctx.fill(path);
  }

  if (strokeColor && strokeWidth > 0) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }

  ctx.restore();
}

function drawTextBox(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  view: ViewTransform,
): void {
  // Text rendering implementation
  // stub
}

function drawConnector(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
  view: ViewTransform,
): void {
  // stub
}

function getVisibleWorldBounds(
  viewTransform: ViewTransform,
  viewport: ViewportInfo
): { minX: number; minY: number; maxX: number; maxY: number } {
  const [minX, minY] = viewTransform.canvasToWorld(0, 0);
  const [maxX, maxY] = viewTransform.canvasToWorld(viewport.cssWidth, viewport.cssHeight);
  const margin = 50 / viewTransform.scale;

  return {
    minX: minX - margin,
    minY: minY - margin,
    maxX: maxX + margin,
    maxY: maxY + margin,
  };
}

function shouldSkipLOD(
  bbox: [number, number, number, number],
  view: ViewTransform
): boolean {
  const [minX, minY, maxX, maxY] = bbox;
  const diagonal = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
  const screenDiagonal = diagonal * view.scale;
  return screenDiagonal < 2;
}
```

---

## Phase 7: Update Canvas.tsx

### 7.1 Replace Diffing Logic (`client/src/canvas/Canvas.tsx`)

```typescript
// SIMPLIFIED: Just use the dirty patch from manager
// Manager already computed everything during observer callbacks

// Update subscription
useEffect(() => {
  const unsubscribe = roomDoc.subscribeSnapshot((newSnapshot) => {
    const prevSnapshot = snapshotRef.current;
    snapshotRef.current = newSnapshot;

    if (newSnapshot.docVersion !== lastDocVersion) {
      lastDocVersion = newSnapshot.docVersion;

      overlayLoopRef.current?.holdPreviewForOneFrame();

      // SIMPLIFIED: Just use dirtyPatch from manager
      // Manager already computed everything during observer callbacks
      if (newSnapshot.dirtyPatch) {
        const { rects, evictIds } = newSnapshot.dirtyPatch;

        // Evict from cache
        const cache = getObjectCacheInstance();
        cache.evictMany(evictIds);

        // Invalidate dirty regions
        for (const bounds of rects) {
          renderLoopRef.current?.invalidateWorld(bounds);
        }
      }

      overlayLoopRef.current?.invalidateAll();
    } else {
      // Presence-only update
      overlayLoopRef.current?.invalidateAll();
    }
  });

  return unsubscribe;
}, [roomDoc]);
```

---

## Phase 8: Update Tools

### 8.1 Update DrawingTool (`client/src/lib/tools/DrawingTool.ts`)

```typescript
// In commitStroke method:
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
  strokeMap.set('points', canonicalTuples);  // Store as tuples
  strokeMap.set('ownerId', this.userId);
  strokeMap.set('createdAt', Date.now());

  objects.set(strokeId, strokeMap);
});
```

### 8.2 Update EraserTool (`client/src/lib/tools/EraserTool.ts`)

```typescript
// In commit method:
this.room.mutate((ydoc) => {
  const root = ydoc.getMap('root');
  const objects = root.get('objects') as Y.Map<Y.Map<any>>;

  // Direct deletion by ID
  for (const id of hitIds) {
    objects.delete(id);
  }
});
```

---

## Phase 9: Update RenderLoop

### 9.1 Update RenderLoop (`client/src/renderer/RenderLoop.ts`)

```typescript
// Replace drawStrokes call with:
import { drawObjects } from './layers/objects';

// In render method:
drawObjects(ctx, snapshot, viewTransform, viewport);
```

---

## Phase 10: Cleanup

### 10.1 Files to Delete

- ❌ `client/src/renderer/stroke-builder/stroke-cache.ts`
- ❌ `client/src/renderer/layers/strokes.ts`
- ❌ `client/src/renderer/layers/text.ts` (if separate)

### 10.2 Code to Remove

From `room-doc-manager.ts`:
- ❌ `strokesById` and `textsById` Maps
- ❌ `setupArrayObservers()` method
- ❌ `_strokesObserver` and `_textsObserver`
- ❌ `hydrateViewsFromY()` (replaced by `hydrateObjectsFromY()`)
- ❌ `composeSnapshotFromMaps()` (integrated into `buildSnapshot()`)

From types:
- ❌ `StrokeView` interface
- ❌ `TextView` interface

---

---

## Critical Implementation Notes

### 1. Initialization Order (MUST preserve)
```
1. Create Y.Doc
2. Setup doc-level observer (handleYDocUpdate)
3. Attach IDB provider
4. Attach WS provider
5. Wait for gates (idbReady + wsSynced/grace)
6. Seed structures if needed (initializeYjsStructures)
7. Attach deep observer (muted by needsSpatialRebuild = true)
8. Attach UndoManager

First buildSnapshot() will then:
9. Create spatial index ONCE (if !this.spatialIndex)
10. Do initial hydration (because needsSpatialRebuild = true)
11. Set needsSpatialRebuild = false
12. Deep observer now active for incremental updates
```

### 2. Two-Epoch Model & Observer Separation
```typescript
// needsSpatialRebuild = true (initial state):
// - Deep observer returns early (muted)
// - buildSnapshot() does full hydration from Y.Doc
// - After hydration, sets needsSpatialRebuild = false

// needsSpatialRebuild = false (steady state):
// - Deep observer active, updates objectsById + spatial index
// - buildSnapshot() just packages current state

// Observer responsibilities:
// - handleYDocUpdate (doc-level): increments docVersion, sets isDirty
// - Deep observer: computes dirty rects/evictions ONLY (no isDirty)
```

### 3. Spatial Index Creation
```typescript
// Created ONCE in buildSnapshot:
if (!this.spatialIndex) {
  this.spatialIndex = new ObjectSpatialIndex();
}
// NEVER create in applyObjectChanges or hydrateObjectsFromY
```

### 4. Deep Observer Guard
Always check `needsSpatialRebuild` flag:
```typescript
if (this.needsSpatialRebuild) return; // Ignore during rebuild epoch
```

### 5. BBox Inflation
Always inflate stroke/connector bbox by `(width * 0.5 + 1)`

### 6. ULID Sorting
Always sort query results for deterministic z-order:
```typescript
entries.sort((a, b) => a.id.localeCompare(b.id));
```

---

This completes the Y.Map migration guide. Follow the phases in order, test thoroughly after each phase, and ensure all critical notes are followed.