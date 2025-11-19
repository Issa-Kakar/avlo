You’re right to be pissed at that last answer. I over‑engineered it and smuggled in a “geometry version” thing you explicitly do **not** need.

Let’s reset and **delete** that whole line of thought.

---

## A) What I will IGNORE from your current setup and WHY

1. **Geometry version counters / “geomVersion BS”**
   You already have a perfectly good signal: **bbox changed ⇒ geometry changed**. Adding an extra version field is just redundant bookkeeping. We don’t need it.

2. **`GeomKey` and any “geometry key” string logic**
   This only existed to distinguish `polyline` vs `polygon` and width variants *before* you read straight from Yjs and before strokes were always PF. In the new world: one object id → one geometry. No keys.

3. **Per‑ID variant maps (`id → { geomKey → geometry }`)**
   That came from “polyline vs polygon for the *same* stroke id”. You’ve killed that condition: strokes are always PF polygons, shapes no longer live in strokes. Variants map = dead weight.

4. **Stroke‑level “kind” driving geometry (freehand vs shape)**
   That was the old hack where shapes were faked as strokes. Now shapes are their own objects with `kind: 'shape'` and `shapeType`. We don’t need `stroke.kind` at all for geometry decisions.

5. **Any cache that stores style together with geometry**
   Color / opacity / width belong to “style at draw time”. Caches should only store derived geometry (PF outline path, connector path, etc.). Mixing style and geometry is exactly what makes invalidation logic explode.

6. **Snapshot‑only caches that don’t read Yjs directly**
   You’re explicitly moving to “renderer reads straight from Y.Map”. Anything that forces you back into cloned views or snapshot‑local models is a step in the wrong direction.

7. **Bounding-box diffs that try to be clever with property‑by‑property comparisons**
   You’ve already said the rule you want: **if bbox changed, we evict geometry**. No need to categorize style vs geometry beyond that unless you really care about micro‑optimizing style changes.

---

## B) Clean‑room plan: one dumb cache, no versions, no keys

You want:

* **ID‑based Y.Map**, separate `stroke` / `shape` / `connector` / `text`
* Renderers **read straight from Y.Map**
* RBush stores **only bbox + id + kind**
* Caches evicted when **bbox changes**
* **No geometry keys, no geometry versions, no “polyline vs polygon” semantics** anymore

So the architecture for drawing is:

1. RBush → you get `(id, kind, bbox)` entries in visible area.
2. For each entry, look up a tiny **handle**: `{ id, kind, y, bbox }`.
3. Call `drawObject(ctx, handle)`:

   * It asks a **single cache** for `geometry` by `id`.
   * If missing: builds from `handle.y` (Y.Map) and stores it.
   * Then reads style directly out of `handle.y` and paints.

The **only invalidation** rule: when `bbox` changes (in your doc manager), call `geometryCache.evict(id)`. That’s it.

### 1. Runtime handle & RBush

```ts
type ObjectKind = 'stroke' | 'shape' | 'connector' | 'text';

interface ObjectHandle {
  id: string;
  kind: ObjectKind;
  y: Y.Map<any>;
  bbox: [number, number, number, number]; // world-space
}

// What RBush stores:
interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  kind: ObjectKind;
}
```

Manager maintains:

* `objectsById: Map<string, ObjectHandle>`
* `spatialIndex: RBush<IndexEntry>`

No versions, no geom keys, nothing special.

---

### 2. New geometry cache: **id → geometry**, nothing else

We only cache heavy stuff:

* PF polygon for strokes
* `Path2D` for shapes
* `Path2D` (+ maybe flattened points) for connectors

**One entry per object id**:

```ts
type StrokeGeom = {
  kind: 'stroke';
  path: Path2D;
  // optionally: pointCount, polygon vertices, etc.
};

type ShapeGeom = {
  kind: 'shape';
  path: Path2D;
};

type ConnectorGeom = {
  kind: 'connector';
  path: Path2D;
  // maybe a Float32Array for hit testing
};

type Geometry = StrokeGeom | ShapeGeom | ConnectorGeom;

class GeometryCache {
  private lru = new Map<string, Geometry>();
  constructor(private maxSize = 3000) {}

  get(id: string): Geometry | undefined {
    const hit = this.lru.get(id);
    if (!hit) return undefined;
    // touch for LRU
    this.lru.delete(id);
    this.lru.set(id, hit);
    return hit;
  }

  set(id: string, geom: Geometry): void {
    this.lru.set(id, geom);
    this.evictIfNeeded();
  }

  evict(id: string): void {
    this.lru.delete(id);
  }

  evictMany(ids: Iterable<string>): void {
    for (const id of ids) this.lru.delete(id);
  }

  clear(): void {
    this.lru.clear();
  }

  private evictIfNeeded(): void {
    while (this.lru.size > this.maxSize) {
      const oldest = this.lru.keys().next().value as string | undefined;
      if (!oldest) break;
      this.lru.delete(oldest);
    }
  }
}
```

**Key design points:**

* No `GeomKey`, no per‑id `variants`.
* No `geomVersion`.
* Geometry is always built from **current Yjs state** when cache misses.
* Width, smoothing, etc. are **read directly from Y.Map** inside builders.

---

### 3. Invalidation rule: **“bbox changed ⇒ delete(id)”**

Your deep observer already has to recompute a bbox per touched id.

Rule:

* When you handle Yjs changes:

  * Compute `newBBox` from Y.Map.
  * Compare with `oldBBox` from the handle.
  * If they differ → geometry changed.

    * Update RBush.
    * **Call `geometryCache.evict(id)`**.
  * If they’re the same → geometry didn’t change.

    * Only style (color/opacity/whatever) might have changed.
    * Don’t touch geometry cache.

This is literally the rule you already wrote in English:

> the point is if bbox changes we're going to evict those caches

And you’re right. That’s enough.

PF strokes: width affects geometry, but your bbox should already be inflated by stroke width. So when width changes, bbox changes → cache evicted → PF recomputed once.

---

### 4. Geometry builders, reading **directly from Y.Map**

We keep them dumb and local. They:

* Read from `handle.y` (Y.Map).
* Produce a `Path2D` in **world space**.
* Do zero fancy caching of their own.

#### 4.1 Stroke PF geometry

Assumptions:

* `kind: 'stroke'`
* Y.Map has `points: [number, number][]` in world units
* `width: number` in world units (PF stroke width)

```ts
function buildStrokeGeometry(handle: ObjectHandle): StrokeGeom {
  const y = handle.y;
  const points = (y.get('points') as [number, number][]) ?? [];
  const width = (y.get('width') as number) ?? 1;

  // Empty / degenerate
  if (points.length < 2) {
    const path = new Path2D();
    return { kind: 'stroke', path };
  }

  // Always PF. No “polyline vs polygon” branch anymore.
  const outline = getPerfectFreehandOutline(points, {
    strokeWidth: width,
    // whatever PF options you choose, constant for now
  });

  const path = new Path2D();
  if (outline.length) {
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      path.lineTo(outline[i][0], outline[i][1]);
    }
  }

  return { kind: 'stroke', path };
}
```

No variants, no width in key. When `points` or `width` change, bbox changes, cache entry gets nuked, builder runs again.

#### 4.2 Shape geometry

Shape only has `frame` (and maybe rotation / cornerRadius). No points.

```ts
function buildShapeGeometry(handle: ObjectHandle): ShapeGeom {
  const y = handle.y;
  const shapeType = (y.get('shapeType') as string) ?? 'rect';
  const [x, y0, w, h] =
    (y.get('frame') as [number, number, number, number]) ?? [0, 0, 0, 0];

  const path = new Path2D();

  switch (shapeType) {
    case 'ellipse': {
      const cx = x + w / 2;
      const cy = y0 + h / 2;
      path.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    }
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
    default: {
      path.rect(x, y0, w, h);
      break;
    }
  }

  return { kind: 'shape', path };
}
```

You can either:

* Bake rotation into the path in the builder, or
* Apply rotation in `drawObject` using the bbox center.

Either way, **no extra cache key**.

#### 4.3 Connector geometry

Polylines **do not care about width**, just like you said. So geometry is just the polyline path; width is style.

```ts
function buildConnectorGeometry(handle: ObjectHandle): ConnectorGeom {
  const y = handle.y;
  const points = (y.get('points') as [number, number][]) ?? [];

  const path = new Path2D();
  if (points.length) {
    path.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      path.lineTo(points[i][0], points[i][1]);
    }
  }

  return { kind: 'connector', path };
}
```

If you want curves for `routingType: 'curved'`, you implement that *inside this builder*. Still no keys: any change to `points` or routing will change bbox, which evicts the cached geometry.

---

### 5. `drawObject`: what it actually does

This is where everything comes together. **No geometry keys, no versions.** It just calls the cache, then draws based on `kind`.

```ts
const geometryCache = new GeometryCache();

function drawObject(
  ctx: CanvasRenderingContext2D,
  handle: ObjectHandle,
) {
  // Context should already be in world-space transform:
  // ctx.scale(view.scale, view.scale);
  // ctx.translate(-view.pan.x, -view.pan.y);

  let geom = geometryCache.get(handle.id);
  if (!geom) {
    geom = buildGeometryFor(handle);
    geometryCache.set(handle.id, geom);
  }

  const y = handle.y;

  switch (geom.kind) {
    case 'stroke':
      drawStroke(ctx, geom, y);
      break;
    case 'shape':
      drawShape(ctx, geom, y, handle.bbox);
      break;
    case 'connector':
      drawConnector(ctx, geom, y);
      break;
  }
}
```

The only glue function we need:

```ts
function buildGeometryFor(handle: ObjectHandle): Geometry {
  switch (handle.kind) {
    case 'stroke':
      return buildStrokeGeometry(handle);
    case 'shape':
      return buildShapeGeometry(handle);
    case 'connector':
      return buildConnectorGeometry(handle);
    default:
      throw new Error(`no geometry builder for kind=${handle.kind}`);
  }
}
```

#### 5.1 Stroke draw

```ts
function drawStroke(
  ctx: CanvasRenderingContext2D,
  geom: StrokeGeom,
  y: Y.Map<any>,
) {
  const color = (y.get('color') as string) ?? '#000';
  const opacity = (y.get('opacity') as number) ?? 1;
  const tool = (y.get('tool') as 'pen' | 'highlighter') ?? 'pen';

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;

  if (tool === 'highlighter') {
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.fill(geom.path);
  ctx.restore();
}
```

Width is already baked into PF geometry; line width on the canvas is irrelevant here.

#### 5.2 Shape draw

```ts
function drawShape(
  ctx: CanvasRenderingContext2D,
  geom: ShapeGeom,
  y: Y.Map<any>,
  bbox: [number, number, number, number],
) {
  const fill = y.get('fillColor') as string | undefined;
  const fillOpacity = (y.get('fillOpacity') as number | undefined) ?? 1;
  const stroke = y.get('strokeColor') as string | undefined;
  const strokeWidth = (y.get('strokeWidth') as number | undefined) ?? 1;
  const strokeOpacity = (y.get('strokeOpacity') as number | undefined) ?? 1;
  const rotation = (y.get('rotation') as number | undefined) ?? 0;

  ctx.save();

  // Apply rotation around bbox center if you didn’t bake it into geometry
  if (rotation !== 0) {
    const [minX, minY, maxX, maxY] = bbox;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.translate(-cx, -cy);
  }

  if (fill && fillOpacity > 0) {
    ctx.globalAlpha = fillOpacity;
    ctx.fillStyle = fill;
    ctx.fill(geom.path);
  }

  if (stroke && strokeWidth > 0 && strokeOpacity > 0) {
    ctx.globalAlpha = strokeOpacity;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth; // world units
    ctx.lineJoin = 'round';
    ctx.stroke(geom.path);
  }

  ctx.restore();
}
```

#### 5.3 Connector draw

```ts
function drawConnector(
  ctx: CanvasRenderingContext2D,
  geom: ConnectorGeom,
  y: Y.Map<any>,
) {
  const color = (y.get('color') as string) ?? '#000';
  const width = (y.get('width') as number) ?? 1;
  const opacity = (y.get('opacity') as number) ?? 1;
  const startCap = (y.get('startCap') as string) ?? 'none';
  const endCap = (y.get('endCap') as string) ?? 'arrow';

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.stroke(geom.path);
  drawConnectorCaps(ctx, geom, width, color, startCap, endCap);

  ctx.restore();
}
```

Again: connector **geometry** is the path only; width is style.

---

### 6. Answering your specific question about `computeGeomKey` and `kind`

> *should we just modify the compute GeomKey at all, can't we just make the shape the same but make the "kind" fields literally just based off the object's kind or shapeType as well?*

My answer:

* **Do not modify `computeGeomKey`. Delete it.**
  The “geometry key” concept is obsolete in your new architecture. You’ve changed the core invariants (separate shapes, strokes always PF, direct Yjs reads). Keeping any geom key plumbing is just dragging the old world along.

* **Keep `kind` as the *object type* only**: `'stroke' | 'shape' | 'connector' | 'text'`.
  That’s what you branch on in `buildGeometryFor` and `drawObject`.

* **Use `shapeType` only inside shape geometry**, not as part of cache keys.
  Rect vs ellipse vs diamond is an internal choice for `buildShapeGeometry`. If `shapeType` changes, bbox changes; hence you evict and rebuild. No key string necessary.

So: **no `computeGeomKey`, no “kind” in cache keys, no shape-specific geokeys at all.** Just `id → geometry`, evicted when bbox changes.

---

## C) Why this matches what you actually want (and isn’t just another overfitted plan)

Let’s line this up against your frustrations:

* You’re annoyed by the **geometry key variants** — we’re deleting that whole axis. One id, one geometry entry. Done.
* You now **read directly from Yjs** — we respect that:

  * Geometry builders read from `handle.y` (Y.Map).
  * Style reads in draw functions also read from `handle.y`.
  * No view models, no cloned snapshots, no per-frame copies.
* You want **strokes always PF polygons** — we do that:

  * `buildStrokeGeometry` always calls PF.
  * No “polyline vs polygon” branching, no “stroke.kind = shape/freehand”.
* You want **shapes with frame-only, no point data** — we do that:

  * `buildShapeGeometry` uses just `frame` (+ optional rotation / cornerRadius / shapeType).
  * No shapes stored as strokes, no shapes going through the stroke cache.
* You want **rbush bbox as your invalidation signal** — we anchor on that:

  * Manager recomputes bbox from current Y.Map.
  * If bbox changed: update RBush, `geometryCache.evict(id)`.
  * Otherwise: leave geometry alone.

The end result:

* `drawObject` is tiny and predictable.
* The cache is as simple as it can get while still avoiding PF re-runs for every frame.
* There is zero “hidden” versioning or key logic; all object state lives in Yjs, and the cache is strictly “id → derived geometry”.

If you still feel like nuking the cache entirely: you can. The stepping stone looks like this:

* Step 1: delete all caching, build geometry on every draw from Y.Map.
* Step 2 (when perf actually demands it): add this minimal `GeometryCache` keyed by id + bbox‑change invalidation.

This plan is compatible with both steps. The important thing is: nothing in here forces you back into the old variant/key mental model.

---

## D) Integration DELTAS vs your current repo

Now, concretely, how this lands against your existing stuff.

1. **Delete `StrokeRenderCache`’s variant logic and `computeGeomKey`**

   * Rip out:

     * `type GeomKey = string`
     * `type Variants = Map<GeomKey, StrokeRenderData>`
     * `computeGeomKey(...)`
     * Any `entry.variants` map and all `variants.get(key)` calls. 
   * Replace it with a `GeometryCache` that is:

     * `Map<string, Geometry>` (one geometry per id),
     * No concept of variants or geometry keys.

2. **Stop treating shapes as stroke variants at all**

   * Anywhere you branch `stroke.kind === 'freehand' ? polygon : polyline`, delete the “polyline” branch for shapes — shapes no longer live in `strokes`.
   * Shapes should be their own `kind: 'shape'` objects in the `objects` map, with their own `buildShapeGeometry`/`drawShape` path.

3. **Anchor the new cache on your `objects` Y.Map + object handles**

   * You already have a plan for `root.objects: Y.Map<Y.Map>` and an `ObjectHandle` layer in the migration doc. That’s the layer that should own `bbox` and feed RBush and `drawObject`.
   * Plug the new `GeometryCache` into that manager (not into the old stroke‑only path).

4. **Wire invalidation to your deep observer’s bbox logic, not stroke‑diffs**

   * In your new `applyObjectChanges` (the one driven by `observeDeep` on `objects`), after you compute `newBBox` and compare with `oldBBox`, call `geometryCache.evict(id)` whenever they differ.
   * Delete any “evict by style diff” paths that used to live in `diffBoundsAndEvicts` for strokes only — they’re now redundant, bbox handles geometry.

5. **Change the render loop to `drawObject` instead of stroke/text arrays**

   * In your base `RenderLoop`, where you currently call `drawStrokes(snapshot, ...)` and use stroke‑only caches, flip it to:

     * Query RBush → entries `(id, kind, bbox)`
     * Look up `handle = objectsById.get(id)`
     * Call `drawObject(ctx, handle)` which uses `GeometryCache` under the hood.

6. **Keep using the Y.Map schema you sketched, just stop encoding geometry logic in strings**

   * The `root.objects` + standardized fields (kind, color, width, shapeType, frame, connector points, etc.) from your migration doc are fine.
   * The change is: geometry is chosen purely by `object.kind` (and `shapeType` inside shapes), not by “semantic kind” encoded into geom keys.

7. **Update your prompts / design docs to explicitly ban `GeomKey` going forward**

   * In your prompt / overview docs where you describe the architecture to future agents, strip all mention of:

     * geometry keys,
     * “polyline vs polygon” for the same stroke,
     * stroke `kind` driving geometry.
   * Replace with: “one geometry per object id, cached by id only, invalidated when bbox changes.”

---
You’re right: in the new Y.Map world, the old “hydrate views → composeSnapshotFromMaps” two‑epoch thing is dead weight. Let’s kill it and make the RoomDocManager do exactly what you described.

---

## A) What I will IGNORE from your current code and WHY

1. **The two‑epoch `needsSpatialRebuild + hydrateViewsFromY + rebuildSpatialIndexFromViews` setup**
   That was a bandaid over Y.Array + StrokeView/TextView cloning. Once you’re on `objects: Y.Map<Y.Map>`, there is no separate “views” layer to rebuild. Keeping this pattern will just confuse you.

2. **`StrokeView` / `TextView` as snapshot types**
   These are pure projection artifacts. You don’t want “cloned JS models”; you want thin handles pointing at Y.Map with precomputed bbox and kind. Snapshot doesn’t need its own StrokeView/TextView arrays at all.

3. **`composeSnapshotFromMaps()`**
   This function exists to re‑clone `strokesById` / `textsById` into snapshot arrays, filter by scene, etc. In the new design snapshot is literally “a reference to the maps + spatial index + presence + view”. No extra composition pass.

4. **Array observers (`setupArrayObservers`, `_strokesObserver`, `_textsObserver`)**
   They are tightly coupled to `strokes: Y.Array` / `texts: Y.Array` and to the two‑epoch design. Once you have `root.objects`, these are just legacy complexity.

5. **Scene‑driven rebuild logic in `buildSnapshot`**
   The `getCurrentScene()`, `prevScene`, and “scene change => needsSpatialRebuild” bits are part of the old scene‑ticks model. You already said you want to remove scene ticks; I’ll treat them as non‑core for the new design. (You can keep a `scene` number in meta if you still need it, but it shouldn’t drive hydration.)

6. **The idea that `buildSnapshot()` should rebuild internal state**
   Right now `buildSnapshot()` can trigger a full hydration (rebuilding views and RBush). That makes reasoning about lifecycle miserable. In the Y.Map design, `buildSnapshot()` should *only* package current in‑memory state into a snapshot, never mutate internal registries.

7. **Any assumption that renderers must not see Yjs containers**
   Your whole migration doc explicitly says “render straight from Y.Map.” So I’m not going to preserve patterns whose only job is to hide Yjs and duplicate data.

---

## B) Clean‑room plan: initialization + snapshot, step by step

I’ll give you a concrete flow that matches what you want:

* One `root.objects: Y.Map<Y.Map<any>>`
* One `objectsById: Map<string, ObjectHandle>`
* One `spatialIndex: ObjectSpatialIndex`
* One deep observer on `objects`
* `buildSnapshot()` = **no rebuilding**, only packaging

I’ll walk it in time order, then show what replaces `hydrateViewsFromY` and `composeSnapshotFromMaps`.

---

### 1. Core invariants (new world)

**Y.Doc schema (relevant parts)**

```ts
root: Y.Map => {
  v: number;                     // schema version
  meta: Y.Map<unknown>;          // TTL, etc
  objects: Y.Map<Y.Map<any>>;    // all strokes/shapes/text/connectors
  code: Y.Map<unknown>;
  outputs: Y.Array<Output>;
}
```

**In‑memory state inside RoomDocManagerImpl**

```ts
type ObjectKind = 'stroke' | 'shape' | 'text' | 'connector';

interface ObjectHandle {
  id: string;
  kind: ObjectKind;
  y: Y.Map<any>;                           // direct Y.Map reference
  bbox: [number, number, number, number];  // world bbox
}

class RoomDocManagerImpl {
  // ...

  private objectsById = new Map<string, ObjectHandle>();
  private spatialIndex: ObjectSpatialIndex | null = null;

  // Deep observer
  private objectsObserver:
    | ((events: Y.YEvent<any>[], tx: Y.Transaction) => void)
    | null = null;

  // Dirty tracking for caches + render loop
  private dirtyRects: [number, number, number, number][] = [];
  private cacheEvictIds = new Set<string>(); // for geometry caches
}
```

**Snapshot type (post‑migration)**

```ts
interface Snapshot {
  docVersion: number;
  objectsById: ReadonlyMap<string, ObjectHandle>;
  spatialIndex: ObjectSpatialIndex | null;
  presence: PresenceView;
  view: ViewTransform;
  meta: SnapshotMeta;
  createdAt: number;
  patch?: {
    dirtyRects: [number, number, number, number][];
    evictIds: string[];
  } | null;
}
```

Key changes:

* No more `strokes: StrokeView[]` / `texts: TextView[]` in snapshot.
* No scene‑based filtering during snapshot build.
* Snapshot just carries references to the live registries.

---

### 2. Initialization timeline (actual steps in constructor)

You already have the gating logic: attach IndexedDB, attach WS, wait for `idbReady`, maybe wait for `wsSynced`, then init structures and attach observers. We keep that structure, but swap in the new pieces.

**Constructor stays roughly as‑is until this block:**

```ts
this.whenGateOpen('idbReady').then(async () => {
  await Promise.race([
    this.whenGateOpen('wsSynced'),
    this.delay(5_000),
  ]);

  const root = this.ydoc.getMap('root');
  if (!root.has('meta')) {
    this.initializeYjsStructures();   // NEW: creates meta + objects map
    console.log('Initialized Y.js structures');
  } else {
    console.log('Loaded from IDB or WS');
  }

  // NEW: after structures exist, attach deep observer + hydrate
  this.setupObjectsObserver();
  this.hydrateObjectsFromY();
  this.attachUndoManager();          // now attached to root.objects
});
```

So the sequence becomes:

1. Y.Doc is created, Y.Doc `update` listener attached (`setupObservers()`), RAF publish loop started. 
2. IDB provider syncs the doc (or times out).
3. `whenGateOpen('idbReady')` fires.
4. We optionally wait up to 5s for WS sync.
5. We ensure `root.meta` and `root.objects` exist (`initializeYjsStructures`).
6. Then we:

   * attach the deep observer on `objects`, and
   * hydrate `objectsById + spatialIndex` from Y.Doc once,
   * attach UndoManager scoped to `objects`.

Importantly: you **do not** attach `objects.observeDeep` before `root.objects` exists, so you avoid the old “arrays don’t exist yet” risk.

---

### 3. Initial hydration: replace `hydrateViewsFromY`

Old world:

* `hydrateViewsFromY()` walked `strokes: Y.Array` and `texts: Y.Array`, built StrokeView/TextView and filled `strokesById`/`textsById`. 

New world:

* `hydrateObjectsFromY()` walks `root.objects`, builds `ObjectHandle` and fills `objectsById` + `spatialIndex`.

```ts
private getObjects(): Y.Map<Y.Map<any>> {
  const root = this.getRoot();
  const objects = root.get('objects');
  if (!(objects instanceof Y.Map)) {
    throw new Error('objects map not initialized');
  }
  return objects as Y.Map<Y.Map<any>>;
}

private hydrateObjectsFromY(): void {
  const objects = this.getObjects();

  // Reset everything
  this.objectsById.clear();
  this.spatialIndex = new ObjectSpatialIndex();
  this.dirtyRects.length = 0;
  this.cacheEvictIds.clear();

  objects.forEach((yObj, key) => {
    const id = String(key);
    const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';
    const bbox = this.computeBBoxFor(kind, yObj); // single source of truth for geometry

    const handle: ObjectHandle = { id, kind, y: yObj, bbox };
    this.objectsById.set(id, handle);
    this.spatialIndex!.insert(id, bbox, kind);
  });

  // First hydration → everything is "dirty" to the renderer.
  // Simplest: mark one big dirty rect (world covering) and let Canvas do full clear.
  // If you want, you can skip this and let Canvas diff detect new objects.
  this.publishState.isDirty = true;
}
```

This *replaces* `hydrateViewsFromY()`. There is no StrokeView/TextView involved; you only ever hydrate:

* `ObjectHandle` map (id → {id, kind, yMap, bbox}),
* Spatial index entries (id + kind + bbox).

You can reuse your existing rbush wrapper by changing the entry type.

---

### 4. Deep observer: steady‑state updates

Instead of two array observers, you have one deep observer on `objects`:

```ts
private setupObjectsObserver(): void {
  const objects = this.getObjects();

  this.objectsObserver = (events, tx) => {
    const touchedIds = new Set<string>();
    const deletedIds = new Set<string>();
    const textOnlyIds = new Set<string>(); // optional optimization for text layout cache

    for (const ev of events) {
      // Top-level changes: object added/updated/deleted
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

      // Nested changes: ev.path[0] is object id
      const path = ev.path as (string | number)[];
      const id = String(path[0] ?? '');
      if (!id) continue;

      touchedIds.add(id);

      // Optional: mark text-only changes for label/text caches
      if (ev instanceof Y.YTextEvent) {
        const field = String(path[1] ?? '');
        if (field === 'text' || field === 'labelText') {
          textOnlyIds.add(id);
        }
      }
    }

    if (touchedIds.size === 0 && deletedIds.size === 0) return;

    this.applyObjectChanges({ touchedIds, deletedIds, textOnlyIds });
    this.publishState.isDirty = true;
  };

  objects.observeDeep(this.objectsObserver);
}
```

So: **only this code** updates `objectsById`, `spatialIndex`, `dirtyRects`, and `cacheEvictIds` after the initial hydration.

---

### 5. `applyObjectChanges`: where spatial index + eviction happens

This is the new version of your “steady‑state epoch” that used to live in the array observers. Now it works on the `objects` map.

```ts
private applyObjectChanges(args: {
  touchedIds: Set<string>;
  deletedIds: Set<string>;
  textOnlyIds: Set<string>;
}): void {
  const { touchedIds, deletedIds, textOnlyIds } = args;
  const objects = this.getObjects();

  // 1) Deletions
  for (const id of deletedIds) {
    const handle = this.objectsById.get(id);
    if (!handle) continue;

    // Spatial index
    if (this.spatialIndex) {
      this.spatialIndex.remove(id, handle.bbox);
    }

    // Caches
    this.cacheEvictIds.add(id);

    // Dirty rect
    this.dirtyRects.push(handle.bbox);

    this.objectsById.delete(id);
  }

  // 2) Additions / updates
  for (const id of touchedIds) {
    const yObj = objects.get(id);
    if (!yObj) continue; // might have been deleted in the same tx

    const kind = (yObj.get('kind') as ObjectKind) ?? 'stroke';
    const prev = this.objectsById.get(id) ?? null;
    const oldBBox = prev?.bbox ?? null;

    const newBBox = this.computeBBoxFor(kind, yObj);
    const handle: ObjectHandle = { id, kind, y: yObj, bbox: newBBox };
    this.objectsById.set(id, handle);

    if (!this.spatialIndex) {
      this.spatialIndex = new ObjectSpatialIndex();
    }

    if (oldBBox) {
      this.spatialIndex.update(id, oldBBox, newBBox, kind);
    } else {
      this.spatialIndex.insert(id, newBBox, kind);
    }

    const textOnly = textOnlyIds.has(id);

    if (!oldBBox) {
      // brand‑new object
      this.dirtyRects.push(newBBox);
      continue;
    }

    const bboxChanged = !this.bboxEqual(oldBBox, newBBox);

    if (bboxChanged) {
      // geometry changed: evict caches
      this.cacheEvictIds.add(id);
      this.dirtyRects.push(oldBBox);
      this.dirtyRects.push(newBBox);
    } else {
      // style / text only
      this.dirtyRects.push(newBBox);
      if (textOnly) {
        // if you later add a text layout cache, evict it here
      }
    }
  }
}
```

This is where your rule “if bbox changes, we evict caches” is enforced. The only source of truth is `computeBBoxFor(kind, yObj)`. That function decides which fields count as geometry (points, frame, rotation, maybe width).

Notice there is **no** call into snapshot logic here. This is pure internal state maintenance.

---

### 6. Snapshot building: replace `composeSnapshotFromMaps` + kill two‑epoch logic

Old `buildSnapshot()`:

* Checked `meta`,
* Managed `needsSpatialRebuild` and `prevScene`,
* Rebuilt views + RBush if needed,
* Called `composeSnapshotFromMaps()` to create `strokes[]`/`texts[]`,
* Opened `firstSnapshot` gate. 

New `buildSnapshot()`:

* Checks that `meta` and `objects` exist.
* Ensures we at least hydrated once.
* Packages current `objectsById`, `spatialIndex`, presence, view, meta.
* Attaches a `patch` built from `dirtyRects` + `cacheEvictIds`.
* Does **not** rebuild anything.

```ts
private buildSnapshot(): Snapshot {
  const root = this.getRoot();
  const metaMap = root.get('meta') as Y.Map<unknown> | undefined;
  if (!metaMap) {
    // Structures not initialized yet → keep previous snapshot
    return this._currentSnapshot;
  }

  // Ensure objects map exists
  const objects = root.get('objects');
  if (!(objects instanceof Y.Map)) {
    // Corrupt or pre-migration doc, bail out
    return this._currentSnapshot;
  }

  // One-time safety: if we somehow got an update before hydration, hydrate now.
  if (!this.spatialIndex || this.objectsById.size === 0) {
    this.hydrateObjectsFromY();
  }

  // Build patch from dirty tracking
  let patch: Snapshot['patch'] = null;
  if (this.dirtyRects.length > 0 || this.cacheEvictIds.size > 0) {
    patch = {
      dirtyRects: this.dirtyRects.splice(0),
      evictIds: Array.from(this.cacheEvictIds),
    };
    this.cacheEvictIds.clear();
  }

  const meta: SnapshotMeta = {
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
    meta,
    createdAt: Date.now(),
    patch,
  };

  if (!this.gates.firstSnapshot && this.sawAnyDocUpdate) {
    this.openGate('firstSnapshot');
  }

  return snap;
}
```

**What’s gone:**

* No `needsSpatialRebuild` flag.
* No `prevScene` logic.
* No `hydrateViewsFromY()` call from inside `buildSnapshot`.
* No `composeSnapshotFromMaps()` function at all.

`buildSnapshot()` is now pure “assemble view model from already‑maintained state”.

---

### 7. Rendering & caches: how snapshots get used

From the renderer’s perspective:

* It subscribes to snapshots like before.
* On each snapshot:

  * It uses `spatialIndex` to query which IDs are visible.
  * It looks up the handle `snapshot.objectsById.get(id)`.
  * It calls `drawObject(ctx, handle, view, geometryCache)` (the thing we designed in your previous thread).
  * It uses `snapshot.patch?.evictIds` to evict geometry caches and `snapshot.patch?.dirtyRects` to invalidate world regions in RenderLoop. 

The important change: `Canvas.tsx` no longer diffs `strokes[]`/`texts[]` between snapshots to compute `evictIds`. The RoomDocManager gives it the patch directly.

---

## C) Why this plan actually fixes your pain

1. **You stop rebuilding from Y.Doc inside snapshot building.**
   Before: `buildSnapshot` sometimes rebuilt `strokesById`/`textsById` + RBush from scratch via `hydrateViewsFromY` and `rebuildSpatialIndexFromViews`. That’s exactly the “why are we doing this?” feeling you have. Now all mutation happens in:

   * `hydrateObjectsFromY()` once on init,
   * `applyObjectChanges()` on deep events.

   `buildSnapshot()` just reads.

2. **“Hydration” now means what you intuitively expect.**
   In your words: “hydratingViewsFromY is just computing the bbox for everything and setting kind and IDs and whatnot.”
   That’s literally what `hydrateObjectsFromY()` does now: walk `objects`, compute bbox, fill `objectsById` + `spatialIndex`. Period.

3. **Snapshot is a thin lens over live state.**
   No more `StrokeView`/`TextView` copies. The renderers see `ObjectHandle` which has:

   * `id`
   * `kind`
   * `bbox`
   * and a `y: Y.Map` you can read directly.

   Add a key to Y.Map → read it in a draw function. No changes to RoomDocManager.

4. **Spatial index is hydrated once, then incrementally maintained.**
   After that first `hydrateObjectsFromY()`, RBush is updated only by `applyObjectChanges`. There is no “rebuild everything because scene changed” nonsense. If you still want scenes later, add `scene` to objects and filter in the renderer, not in the manager’s hydration logic.

5. **You have a clear, explicit point where Yjs structures must exist.**
   The only place we touch `root.objects` is:

   * in `initializeYjsStructures()` (creation),
   * in `setupObjectsObserver()`/`hydrateObjectsFromY()`,
   * inside `applyObjectChanges()` using `getObjects()`.

   All of those are called *after* `idbReady` and after `root.meta` is guaranteed to be present. So you don’t have the old risk of attaching observers before containers exist.

6. **Cache eviction is tied to bbox changes and nothing else.**
   Your rule “if bbox changes we evict those caches” is enforced centrally in `applyObjectChanges` by comparing `oldBBox` vs `newBBox`. The geometry caches themselves don’t keep any extra “version” or “geomKey” metadata; they just support `invalidateMany(evictIds)`.

7. **High ceiling: adding more object kinds doesn’t touch initialization or snapshot.**
   New object type? Add a `kind`, update `computeBBoxFor(kind, yObj)`, add a branch in `drawObject`, maybe extra cache map. Initialization and snapshot logic remain unchanged; they don’t know or care what fields shapes vs connectors vs text boxes have.

---

## D) Integration DELTAS (concrete changes in your actual files)

Here’s how this maps onto the code you actually have.

1. **RoomDocManagerImpl — kill array‑based two‑epoch, add objects map** 

   * Delete:

     * `private strokesById = new Map<string, StrokeView>();`
     * `private textsById = new Map<string, TextView>();`
     * `private _strokesObserver`, `_textsObserver`, and `setupArrayObservers()`.
     * `hydrateViewsFromY()`, `rebuildSpatialIndexFromViews()`, and any `needsSpatialRebuild`/`prevScene` logic.
     * `composeSnapshotFromMaps()`.
   * Add:

     * `objectsById: Map<string, ObjectHandle>`
     * `spatialIndex: ObjectSpatialIndex | null`
     * `objectsObserver` + `dirtyRects` + `cacheEvictIds`.
   * Change `initializeYjsStructures()` to create `root.objects = new Y.Map()` instead of `root.strokes`/`root.texts`.

2. **RoomDocManagerImpl — update constructor gating block** 

   * In the `whenGateOpen('idbReady')` block, after ensure `meta`:

     * Replace `this.setupArrayObservers();` with:

       * `this.setupObjectsObserver();`
       * `this.hydrateObjectsFromY();`
     * Attach UndoManager on `root.objects`, not on strokes/texts arrays.

3. **RoomDocManagerImpl — new deep observer** 

   * Implement `setupObjectsObserver()` and `applyObjectChanges()` exactly as laid out above.
   * `applyObjectChanges` uses `computeBBoxFor(kind, yObj)` to derive geometry and drive cache eviction + dirtyRects + RBush updates.

4. **RoomDocManagerImpl — new buildSnapshot implementation** 

   * Replace current `buildSnapshot` two‑epoch code with the “pure packaging” version that:

     * early‑returns when `meta`/`objects` don’t exist,
     * ensures one‑time hydration fallback if needed,
     * builds `patch` from `dirtyRects` + `cacheEvictIds`,
     * returns `{ docVersion, objectsById, spatialIndex, presence, view, meta, createdAt, patch }`.

5. **Snapshot type in `@avlo/shared` — switch to objects** 

   * Replace `strokes: ReadonlyArray<StrokeView>` and `texts: ReadonlyArray<TextView>` with:

     * `objectsById: ReadonlyMap<string, ObjectHandle>`
     * `spatialIndex: ObjectSpatialIndex | null`
     * `patch?: { dirtyRects: WorldBounds[]; evictIds: string[] } | null`
   * Optionally, for gradual migration, add temporary getters that derive `strokes`/`texts` arrays from `objectsById` by filtering on `kind`. That lets you keep old renderers compiling while you switch them over.

6. **RenderLoop + Canvas.tsx — consume patch, don’t diff objects yourself** 

   * In your snapshot subscription (where you currently do `diffBoundsAndEvict(prevSnapshot, newSnapshot)`), change to:

     * `const patch = newSnapshot.patch;`
     * If `patch`, call `geometryCache.invalidateMany(patch.evictIds);`
     * For each `rect` in `patch.dirtyRects`, call `renderLoop.invalidateWorld(rect);`
   * Eventually remove `diffBoundsAndEvict` entirely once you rely on the manager’s patch.

7. **StrokeRenderCache / future geometry caches — only keyed by id** 

   * We already talked about nuking `computeGeomKey` and variants. In this new world, those caches will be fed with `evictIds` coming straight from RoomDocManager’s `patch`. You can simplify your stroke cache exactly as we discussed earlier:

     * `Map<string, StrokeGeom>` keyed by id only,
     * `invalidateMany(ids)` taking the patch’s evictIds,
     * no geomKey, no geometryVersion.

8. **Y.Map migration plan — treat “objectsById + spatialIndex + patch” as the canonical manager contract** 

   * The migration doc already sketches a lot of this; the main missing part was the explicit initialization order and the fact that `buildSnapshot()` should not be doing any rebuild work. The plan above fills that gap:

     * One‑time `hydrateObjectsFromY()` after structures exist,
     * Deep observer updating `objectsById` + `spatialIndex` + patch state,
     * Pure `buildSnapshot()`.

If you implement exactly this, you end up with:

* **Initialization**: wait for IDB/WS → ensure `root.meta`/`objects` → attach deep observer → hydrate handles + RBush once.
* **Steady state**: deep observer nudges `objectsById` + RBush + dirtyRects/evictIds; Y.Doc `update` just flips `isDirty`.
* **Snapshot**: dumb packaging function; no more mystery “hydrate views from Y” inside your publishing path.

That’s the version where the architecture actually matches the mental model you described: live Y.Map refs, a single spatial index hydrated once, and a snapshot that’s just a lens over that.
Short answer: yes, the plan *can* be made solid – but it only works if we’re explicit about 3 things:

* when `objects` exists
* when the deep observer is allowed to do anything
* when `buildSnapshot` is allowed to rebuild

I’ll walk that carefully and then tell you exactly where the sharp edges are. I’m not going to promise “zero chance of bugs” because that’s nonsense, but there are no hidden ordering bombs in this design if you wire it the way I spell out.

---

## A) What I will IGNORE from your current code and WHY

1. **Anything about strokes/texts arrays in the manager**
   I’m treating `strokes`, `texts`, `strokesById`, `textsById`, `_arraysObserved`, etc. as dead. The check here is *only* for the new `objects` + deep observer path. 

2. **Old snapshot shape (`scene`, `strokes[]`, `texts[]`)**
   I don’t care how that works now; I’m assuming snapshot becomes `{ objectsById, spatialIndex, presence, ... }` and that old callers get updated / shimmed.

3. **Anything in the renderer / stroke cache internals**
   Those are relevant for caching, but not for the init/observer/snapshot ordering that you’re worried is fragile. 

4. **Connector / shape schema details**
   All I need for this is “we have `root.objects: Y.Map<Y.Map>` and compute bbox from each object”. I’m not re‑deriving field names here.

5. **Awareness, gates visual debouncing, stats, etc.**
   Those parts of `RoomDocManagerImpl` stay as they are. I’m only touching: Yjs init, observers, in‑memory maps, `buildSnapshot`.

6. **Scene ticks and scene changes**
   You’re planning to kill them anyway. For the new world I assume snapshots are not keyed by `scene`, and `needsSpatialRebuild` is about “spatial index health,” not “scene changed”. 

7. **Any background “geometry version” or “geom key” nonsense**
   You already said you’re ready to nuke it; I’m not carrying any of that into the safety check.

---

## B) Double‑check of the proposal, with explicit ordering

I’ll go through this as four flows:

1. What invariants we rely on
2. Fresh room (no persisted doc)
3. Existing room (doc in IDB / WS)
4. Mutations before seeding / race with gates
5. Observer flags & `needsSpatialRebuild`

### 1. Invariants we actually need

If we get these right, the rest is implementation detail:

1. **Init guard:**
   `buildSnapshot()` must *never* touch `root.objects` unless **both** `meta` and `objects` exist. Until then it just returns the previous snapshot (usually the empty one).

2. **Single source of truth:**

   * Canonical geometry lives in `root.objects: Y.Map<Y.Map<any>>`.
   * Manager‑side mirrors are:

     * `objectsById: Map<string, ObjectHandle>`
     * `spatialIndex: RBushSpatialIndex | null`
       They must either both be “empty/uninitialized” or both reflect the same Y state.

3. **Epoch meaning:**

   * `needsSpatialRebuild === true` means:
     “Ignore incremental observer updates; next `buildSnapshot` will **throw away** manager state and rebuild `objectsById` + `spatialIndex` by walking Y.Objects.”
   * `needsSpatialRebuild === false` means:
     “Deep observer is authoritative; `objectsById` + `spatialIndex` are updated *incrementally* and `buildSnapshot` just packages them.”

4. **Observer ordering:**
   Yjs semantics: deep observers fire inside a transaction; your `ydoc.on('update')` handler fires after. That’s fine as long as *during* rebuild epoch both:

   * deep observer is a no‑op (`if (needsSpatialRebuild) return`)
   * rebuild is done inside `buildSnapshot()` based on the current Y state (which already includes the transaction that just happened).

5. **UndoManager scope:**
   Undo/redo tracks `root.objects` only; it doesn’t know about `objectsById`/RBush at all. After undo/redo transactions, Yjs fires deep observer + update; the same rules as above apply.

If we can preserve those invariants in all the boot / race scenarios, we’re fine.

---

### 2. Fresh room: no persisted doc, no remote state

Timeline with the new design, grounded in your current `RoomDocManagerImpl`:

**t0 – constructor**

* You create `ydoc`, `yAwareness`, set up `sizeEstimator`, publish loop, etc.
* You call `setupObservers()` → this attaches `ydoc.on('update', handleYDocUpdate)`.
* You set `_currentSnapshot = createEmptySnapshot()` – which has empty data.
* You call `initializeIndexedDBProvider()` and `initializeWebSocketProvider()`; IDB attach happens **before** any Y structures are created, which is the whole point of the CRITICAL comment in your file. 

**t1 – IDB gate opens**

* IDB has nothing, so doc is still empty.
* `handleIDBReady()` opens `G_IDB_READY`.

**t2 – WS sync grace window**

In the constructor you have:

```ts
this.whenGateOpen('idbReady').then(async () => {
  await Promise.race([
    this.whenGateOpen('wsSynced'),
    this.delay(5_000),
  ]);

  const root = this.ydoc.getMap('root');
  if (!root.has('meta')) {
    this.initializeYjsStructures();
  }

  this.setupObjectsObserver();
  this.attachUndoManager();
});
```

(You’ll replace `setupArrayObservers` with `setupObjectsObserver`.)

* There is no `meta`, so `initializeYjsStructures()` runs once:

  * sets `root.v`, `root.meta`, `root.objects`, `root.code`, `root.outputs`.
* That transaction triggers `handleYDocUpdate` after it commits:

  * `docVersion++`, `sawAnyDocUpdate = true`, `publishState.isDirty = true`.

Then, still inside the same `then` callback, you call `setupObjectsObserver()`:

```ts
private setupObjectsObserver(): void {
  if (this.objectsObserver) return; // idempotent

  const root = this.getRoot();
  const objects = root.get('objects') as Y.Map<Y.Map<any>>;
  if (!(objects instanceof Y.Map)) {
    throw new Error('objects structure corrupted');
  }

  this.objectsObserver = (events, tx) => {
    if (this.needsSpatialRebuild) return;  // ignore during rebuild epoch
    this.handleObjectsDeepEvents(events, tx);
  };

  objects.observeDeep(this.objectsObserver);
}
```

And you set `needsSpatialRebuild = true` either here or in `buildSnapshot`; either way its initial value is `true`.

**t3 – first RAF publish after init**

The RAF loop already exists. Because `publishState.isDirty` was set by `handleYDocUpdate`, it calls `buildSnapshot()`:

Inside `buildSnapshot()` with the new logic:

1. `const root = this.getRoot();`
2. `const meta = root.get('meta'); const objects = root.get('objects');`
   Both exist (we just created them).
3. `if (!this.spatialIndex) { this.spatialIndex = new RBushSpatialIndex(); this.needsSpatialRebuild = true; }`
4. `if (this.needsSpatialRebuild) {`

   * `this.hydrateObjectsFromY();` → walks `objects` and populates `objectsById`.
   * `this.rebuildSpatialIndexFromObjects();` → bulk loads RBush from `objectsById`.
   * `this.needsSpatialRebuild = false;`
5. Build snapshot struct `{ docVersion, objectsById, spatialIndex, presence, view, meta, createdAt }`.
6. If `!gates.firstSnapshot && sawAnyDocUpdate`: open `firstSnapshot`.

At this point:

* `objectsById` and `spatialIndex` are in sync.
* Deep observer is attached but has been ignoring events so far (because `needsSpatialRebuild` was true until now). That’s correct; hydration just read the *current* Y state.

Any future writes go through Yjs → deep observer → `applyObjectChanges` → `publishState.isDirty` → RAF → `buildSnapshot` (no rebuild, just package). That preserves invariants.

**Is there a hole here?** No:

* We never read `objects` before it exists (guard on `meta` + `objects`).
* We don’t trust deep observer until after `hydrateObjectsFromY()` finishes once.
* First snapshot is built *after* `initializeYjsStructures`, so it sees real data, not empty doc.

---

### 3. Existing room: doc already in IDB (or via WS)

This is the other edge case you have to worry about.

**t0–t1 – constructor + IDB attach**

Same as before, except this time IndexedDB actually loads an existing doc:

* `indexeddbProvider.whenSynced` resolves, you call `handleIDBReady()`, which opens `G_IDB_READY`.
* While IDB applies its snapshot, Yjs fires `update` events; `handleYDocUpdate` runs and sets `publishState.isDirty`.
* During this phase `root.meta` *might* already exist, or might not, depending on when the IDB snapshot comes in. That’s fine; `buildSnapshot()` will early‑return until `meta` is present.

**t2 – the constructor’s `whenGateOpen('idbReady')` block**

You hit:

```ts
await Promise.race([ wsSynced, delay(5_000) ]);

const root = this.ydoc.getMap('root');
if (!root.has('meta')) {
  this.initializeYjsStructures(); // but in this scenario, it DOES have meta
} else {
  console.log('Loaded from IDB or WS');
}

this.setupObjectsObserver();
this.attachUndoManager();
```

* Since the doc is already persisted, `root.has('meta') === true`, so **no seeding happens here**.
* Then `setupObjectsObserver()` attaches deep observer to the existing `objects` map.
* `needsSpatialRebuild` remains `true` (initial), so deep observer is effectively muted until first rebuild.

**t3 – first `buildSnapshot()` after attach**

Because IDB updates already set `publishState.isDirty`, the RAF loop calls `buildSnapshot()`:

* `meta` exists, `objects` exists, so we don’t bail.
* We lazily create `spatialIndex` and ensure `needsSpatialRebuild = true`.
* We enter the rebuild branch:

  * `hydrateObjectsFromY()` reads **all existing persisted objects**, builds `objectsById`.
  * `rebuildSpatialIndexFromObjects()` bulk loads RBush.
  * `needsSpatialRebuild = false`.

Now `objectsById` and `spatialIndex` reflect whatever persisted Yjs doc you loaded from IDB/WS.

Again, the order is safe:

* We didn’t try to read from containers that weren’t there.
* We didn’t rely on deep observer to reconstruct history; we always do one full hydration.
* We only start incremental tracking *after* we have that baseline.

---

### 4. Mutations before seeding / “race with gates”

You already have a pre‑init guard in `mutate` that defers writes until after IDB/WS have had a chance to give you a real doc:

```ts
const root = this.ydoc.getMap('root');
if (!root.has('meta')) {
  this.whenGateOpen('idbReady').then(async () => {
    await Promise.race([this.whenGateOpen('wsSynced'), this.delay(5_000)]);
    const r = this.ydoc.getMap('root');
    if (!r.has('meta')) {
      this.initializeYjsStructures();
    }
    this.mutate(fn); // replay the write
  });
  return;
}
```

With the new design, you **do not change that logic**, you just change what `initializeYjsStructures` creates (meta + objects instead of meta + strokes/texts). That gives you two possibilities:

1. **No doc persisted yet**

   * The constructor’s `idbReady/wsSynced` block and the `mutate` pre‑init block both race to run `initializeYjsStructures()`.
   * They both guard with `if (!root.has('meta'))`, so only the **first** one actually seeds. The second sees meta and does nothing.
   * Either way, `mutate(fn)` runs *after* meta+objects exist, so the user write will operate on the right schema.
   * Afterwards, your constructor block still calls `setupObjectsObserver()` exactly once.

2. **Doc already persisted**

   * `mutate` pre‑init guard runs after IDB+WS grace, sees `root.has('meta') === true`, so it does **not** seed. It just calls `this.mutate(fn)` again inside, which falls into the normal path and writes against the existing doc.
   * The constructor block also sees `root.has('meta') === true` and skips seeding; it only attaches the deep observer/UndoManager.

The two seeding paths are compatible; only one can actually seed because both check `!root.has('meta')` before calling `initializeYjsStructures()`.

The important thing for your ordering paranoia: **`setupObjectsObserver()` is only called in the constructor’s `idbReady` block**, not from `mutate`. So there’s exactly one place where we attach the deep observer.

---

### 5. Observers, flags and “is this attached or not?”

> “so no more marking observers attached as true or anything right?”

There are two separate concerns here:

* **(a) do we still need an “observer attached” flag?**
* **(b) does that flag interact with rebuild logic / snapshots?**

My answer:

* **Yes to (a)**:
  You still need a guard to avoid double‑attaching, but it can be just `this.objectsObserver !== null`. No `_arraysObserved` sprinkled throughout the code.

* **No to (b)**:
  Nothing in the rebuild / snapshot path should ever check “are observers attached?” The *only* flag that matters for behavior is `needsSpatialRebuild`.

Concrete:

```ts
// state fields
private objectsObserver: ((events: Y.YEvent<any>[], tx: Y.Transaction) => void) | null = null;
private needsSpatialRebuild = true;
private spatialIndex: RBushSpatialIndex | null = null;
private objectsById = new Map<string, ObjectHandle>();

// setup
private setupObjectsObserver(): void {
  if (this.objectsObserver) return; // idempotent

  const root = this.getRoot();
  const objects = root.get('objects') as Y.Map<Y.Map<any>>;
  if (!(objects instanceof Y.Map)) throw new Error('objects structure corrupted');

  this.objectsObserver = (events, tx) => {
    if (this.needsSpatialRebuild) return;  // muted during rebuild epoch
    this.handleObjectsDeepEvents(events, tx);
  };

  objects.observeDeep(this.objectsObserver);
}

// destroy
if (this.objectsObserver) {
  try {
    const root = this.getRoot();
    const objects = root.get('objects');
    if (objects instanceof Y.Map) {
      (objects as Y.Map<any>).unobserveDeep(this.objectsObserver);
    }
  } catch {
    // ignore
  }
  this.objectsObserver = null;
}
```

No “observer attached” boolean is ever read in `buildSnapshot()`. The rebuild path is driven **only** by:

* meta/objects existence,
* `spatialIndex` existence,
* `needsSpatialRebuild`.

So you’re not in the old situation where `_arraysObserved` + `needsSpatialRebuild` made the control flow impossible to hold in your head.

---

## C) Sanity verdict / “green light” level honesty

Here’s the blunt take after running through the flows:

* There is **no hidden requirement on the ordering** of:

  * `setupObjectsObserver()` vs `initializeYjsStructures()` vs `buildSnapshot()`,
    other than the obvious “don’t call `setupObjectsObserver()` before `objects` exists”, which we satisfy by only calling it after `idbReady + wsSynced/grace` and after the local seeding check.

* The deep observer is **completely safe to attach early** because it’s muted while `needsSpatialRebuild === true`, and we rely on a full `hydrateObjectsFromY()` read to establish baseline state before we ever trust it.

* The existing `mutate` pre‑init guard already protects you from the “I wrote into a half‑initialized doc” race; we’re not introducing any new subtlety there – just swapping strokes/texts arrays for `objects` map.

* Gate interactions (`idbReady`, `wsSynced`, `firstSnapshot`, `awarenessReady`) remain consistent; first snapshot still only opens after the first doc‑derived snapshot was published, and that’s now based on `objectsById` instead of `strokes`/`texts`.

Is it “100% foolproof, no chance of errors”? No – that depends on you not accidentally doing something dumb like:

* reading `objects` without guarding `meta`/`objects` existence,
* calling `setupObjectsObserver()` from another path,
* forgetting the `if (this.needsSpatialRebuild) return;` guard in the observer,
* or mutating `objectsById` from anywhere other than `hydrateObjectsFromY` and `applyObjectChanges`.

But **as an architecture**, with those three rules respected:

1. guard `meta` + `objects` in `buildSnapshot`
2. one‑time hydration under `needsSpatialRebuild`
3. deep observer no‑op while `needsSpatialRebuild` is true

—I’m comfortable telling you: **yes, go ahead and implement this.** The ordering is coherent, you don’t need any “observer attached” flags in the core logic, and there are no obvious race conditions left lurking.

---

## D) Integration DELTAS to actually make this safe

Just to be concrete about the edits you need in `RoomDocManagerImpl` to land this without surprises:

1. **Init guard in `buildSnapshot`**
   Keep the guard you already have for meta, extend it to objects:

   ```ts
   const root = this.getRoot();
   const meta = root.get('meta') as Y.Map<unknown> | undefined;
   const objects = root.get('objects') as Y.Map<Y.Map<any>> | undefined;
   if (!meta || !objects) return this._currentSnapshot;
   ```

   That guarantees you never touch `objects` before they exist, no matter how early `buildSnapshot` runs. 

2. **Replace `_arraysObserved` with `objectsObserver` pointer**
   Delete `_arraysObserved`, `_strokesObserver`, `_textsObserver` and all references. Add `objectsObserver` as shown and only guard in `setupObjectsObserver()` with `if (this.objectsObserver) return;`.

3. **Guard deep observer with `needsSpatialRebuild`**
   Inside `setupObjectsObserver` wrap the handler:

   ```ts
   this.objectsObserver = (events, tx) => {
     if (this.needsSpatialRebuild) return;
     this.handleObjectsDeepEvents(events, tx);
   };
   ```

   so you never interleave incremental updates with a rebuild epoch.

4. **Set `needsSpatialRebuild = true` whenever you create a new `spatialIndex`**
   In `buildSnapshot`:

   ```ts
   if (!this.spatialIndex) {
     this.spatialIndex = new RBushSpatialIndex();
     this.needsSpatialRebuild = true;
   }
   ```

   That covers the case where snapshots are called before observers attach – you still get one clean full rebuild.

5. **Only hydrate in one place**
   `hydrateObjectsFromY()` must be called **only** from the `if (this.needsSpatialRebuild)` branch in `buildSnapshot()`. Don’t call it from anywhere else (tools, observers, etc.), or you’ll reintroduce weird ordering issues.

6. **UndoManager attaches after object init, before first snapshot**
   `attachUndoManager()` should still run in the `idbReady/wsSynced` `then` block, after `initializeYjsStructures` / meta detection, but before or after `setupObjectsObserver()`; order doesn’t matter for safety, it just affects exactly which transaction gets tracked first.

7. **Destroy: unobservedeep on `objects`**
   Add the `objects.unobserveDeep(this.objectsObserver)` cleanup I showed above into your `destroy()` right next to where you currently unobserve `strokes`/`texts`. That keeps teardown symmetric. 

If you wire those pieces exactly, I’m comfortable calling this “safe enough to ship” from an ordering standpoint. The behaviour you want—**live Y.Map refs, one deep observer, one hydration epoch, and snapshots that just wrap `objectsById` + RBush**—will hold without needing any more weird boolean flags or half‑secret state.
