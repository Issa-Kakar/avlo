# Selection System

> **Maintenance:** Architectural overview, not a changelog. Match surrounding detail level when updating.

SelectTool + the SoA transform engine + selection store + hit testing + transform rendering. Handles translate, scale (per-kind-aware), connector endpoint drag, marquee, multi-select, text/code editing entry, and Z-order-aware hit testing.

---

## File Map

| File | Responsibility |
|------|----------------|
| `tools/selection/SelectTool.ts` | State machine, hit dispatch, routes transform lifecycle through the store. Endpoint drag begun via `tf.beginEndpointDrag(...)`; rest of lifecycle flows through `endTransform`/`cancelTransform`. |
| `tools/selection/transform.ts` | **The module-level SoA gesture engine** (no class) — one interleaved Float64 lane buffer, op-partitioned kernel ranges, sparse slot→gesture map, reflow sidecars, stroke pool, endpoint drag, batched damage, commit/cancel, RDM eviction hook, getter surface |
| `tools/selection/transform-kernels.ts` | Pure lane math (canvas-free LEAF): lane/op/meta/tag consts, `BEHAVIOR_LUT`/`OP_LUT`, the six apply kernels, `UniformPack` + `fillUniformPack`, `reflowLeftWidth`. Oracle-proven — see selftest |
| `tools/selection/transform-kernels.selftest.ts` | esbuild+node runner (command in header): verbatim pre-SoA oracle frozen in-file; ≥5k fuzz cases/op asserting EXACT float equality; LUT ≡ `resolveBehavior`; commit-value + `fillFrameFromBind` mirrors; `K_*` ≡ `OBJECT_KINDS` order |
| `tools/selection/transform-damage.ts` | Damage accumulator (LEAF between engine/topology and RenderLoop): `pushDamage(minX,minY,maxX,maxY)` + `flushDamage()` → one `invalidateWorldRects` batch per pointermove |
| `tools/selection/types.ts` | Shared types: `SelectionKind`, `KindCounts`, `TransformState`, `ScaleCtx`, `SelectedStyles`, `InlineStyles`. `EndpointDragTransform` carries renderer/UI fields only. |
| `tools/selection/connector-topology.ts` | `ConnectorEntry` discriminated union (static / translate / reroute / endpoint-drag synthetic; all carry `slot`), per-pipeline Side types (bind sides hold a lane index `gi`), `newTopologyBuilder`, `runTopologyScale/Translate` (lanes threaded), `commitTopology`, `cancelTopology`, `fillFrameFromBind` |
| `tools/selection/selection-utils.ts` | `computeSelectionComposition`, `computeStyles` (declarative `foldField` composition), `computeUniformInlineStyles` |
| `tools/selection/selection-actions.ts` | Mutation wrappers for context menu — each a 1-3 line `applyField`/`toggleField`/`adjustByPresets` call, plus `convertSelectionTo`/`convertSelectionToShape` delegating to `convert-kind.ts` (see `components/context-menu/CLAUDE.md`) |
| `tools/selection/selection-field-table.ts` | `FieldDescriptor<V>` table + `Aggregate<V>` + `foldField`/`applyField`/`toggleField`/`adjustByPresets`/`withEditorOr` primitives + ~17 typed descriptors (one per property). Single source of truth for read/write/persist/accept per kind |
| `tools/selection/convert-kind.ts` | Cross-kind conversion (text ↔ note ↔ shape): in-place kind mutation on the same Y.Map. Per-direction PRE-READ plan builders (center/glyph-preserving geometry, fill palette mapping, `color`↔`labelColor` remap) + one `transact()` commit (`kind` set last, then `renormalizeAttachedAnchors`). Downstream is fully observer-driven — the kind-keychange branch in `room-doc-manager.ts` (incl. `writeSlotKind` + `transformEvictSlot`) + `selection-store.onObjectsKindChanged` |
| `stores/selection-store.ts` | Zustand store, orchestrates the engine via `import * as tf`, `computeSelectionBounds()` |
| `core/geometry/scale-system.ts` | Pure SCALAR atoms only: `scaleAround`, `round3`, `uniformFactor`, `preservePositionMut`, `edgePinPosition1D`, `rawScaleFactorsInto(out,…)`, `MIN_SHAPE_FRAME_DIM`. The old tuple-allocating bbox composites live on only as the selftest oracle |
| `core/geometry/bounds.ts` | Bbox/frame helpers + mutating offset primitives |
| `core/types/handles.ts` | HandleId taxonomy, type guards, `scaleOrigin`, `handleCursor` |
| `core/spatial/` | Hit testing — see `core/spatial/CLAUDE.md` |
| `renderer/layers/objects.ts` | `drawObjects` (kind-code jump table), sparse-map pack skip + slot-keyed inject cull, `renderScaleEntryLanes` (op-dispatched lane paint), `drawConnectorEntry` |
| `renderer/layers/selection-overlay.ts` | Marquee, single-select bounds rect (doubles as highlight), multi-select per-object highlights + union rect, connector mode endpoint dots only. Per-object rects route through the sparse map + lanes/column into module scratches (alloc-free). `shouldHideHandlesForEditing` keeps handles VISIBLE for shape/note label editing (label DOM lives strictly inside the padded bbox) and hides them only when the editor occupies the full bbox (`text` standalone, `code`). |

---

## SelectTool State Machine

```typescript
type Phase = 'idle' | 'pendingClick' | 'marquee' | 'translate' | 'scale' | 'endpointDrag';

/** Discriminated pointer-down classification — payload-per-variant, no `!.` peeks. */
type DownHit =
  | { kind: 'background' }
  | { kind: 'selectionGap' }
  | { kind: 'object';     handle: ObjectHandle; isSelected: boolean }
  | { kind: 'handle';     handleId: HandleId }
  | { kind: 'endpoint';   connectorId: string; slot: Slot }
  | { kind: 'openButton'; handle: ObjectHandle };           // bookmark Open chip

const HIT_RADIUS_PX = 6;       // tolerance = HIT_RADIUS_PX + HIT_SLACK_PX = 8px screen
const HIT_SLACK_PX = 2;
const MOVE_THRESHOLD_PX = 4;
const CLICK_WINDOW_MS = 180;
```

### `begin()` flow

1. `contextMenuController.hide()`, then `clearBookmarkOpenHoverIfAny()`. The hover gets re-set below only on the openButton branch.
2. Mode-specific priority: standard mode (selection + not editing) → `hitResizeHandle()` → `'handle'`. Connector mode → `hitEndpointDot()` → `'endpoint'`.
3. Common: `hitTestObjects()` → object hit. Bookmark hit + no shift/ctrl + `hitTestOpenButton()` → `'openButton'` (sets `hoveredOpenBookmarkId`). Otherwise → `'object'` (carries `isSelected`).
4. No object hit: standard mode + inside selection bbox → `'selectionGap'`; else `'background'` (clears selection).
5. `phase = 'pendingClick'` for all targets.

**Single editable re-click exception:** clicking a single-selected text/code/note/shape calls `cancelHide()` immediately after `hide()` to prevent context menu flash. Shape is included because label-less shapes create the label on first click — same edit-entry path.

### `pendingClick → Phase` (in `move()`)

Transition gated by `passMove` (`dist > MOVE_THRESHOLD_PX`). Gap/background also accept `passTime` (≥ `CLICK_WINDOW_MS`).

| DownHit kind | Transition | Notes |
|---|---|---|
| `handle`     | `scale`        | `store.beginScale(handleId, downWorld)` |
| `endpoint`   | `endpointDrag` | Drill to single connector if multi-selected. The engine owns the gesture (RouteContext + buffer + bbox snapshots). |
| `object` (unselected) | `translate` | Selects first. Durably-locked objects + anchored connectors → `marquee` instead. |
| `object` (selected)   | `translate` | Durably-locked objects + anchored connectors → `marquee` instead. |
| `openButton` | `translate`    | Drift on a pressed Open button = translate intent (user moving the bookmark). Hover stays painted; `ctx.translate(tdx, tdy)` in `objects.ts` carries the hovered chip with the card. |
| `selectionGap`        | `translate` | Drag = translate entire selection. |
| `background`          | `marquee`   | Empty area drag = marquee select. |

### Scale phase

SelectTool hands the store raw cursor coords; **all gesture math lives in the store**.

`store.beginScale(handleId, downWorld)`:
1. `computeSelectionBounds()` → selBounds.
2. `scaleOrigin(handleId, selBounds)` → origin; `handlePosition` → handlePos.
3. `initialDelta = handlePos - origin`; `clickOffset = downWorld - handlePos`.
4. `tf.beginScale(selectedIdSet, handleId, origin, selBounds)`.
5. `transform = { kind: 'scale', initialDelta, clickOffset }`.

`store.updateScale(worldX, worldY)`: read `scaleCtx` via `tf.getTransformScaleCtx()`, `rawScaleFactorsInto(_rsf, worldX - clickOffset[0], worldY - clickOffset[1], origin, initialDelta, handleId)` (module scratch — no tuple alloc), then `tf.updateScale(_rsf[0], _rsf[1])`.

The split: the engine owns `handleId`/`origin`/`selBounds` (COPIED into module-owned arrays at begin — a single-selected handle's live geometry must never alias the gesture baseline); the store owns `initialDelta`/`clickOffset` (gesture math feeding `rawScaleFactorsInto`). Per-frame `sx`/`sy` stay in the engine — mutating the Zustand discriminant on every pointermove would fire subscribers wastefully.

### Translate phase

```ts
store.updateTranslate(worldX - downWorld[0], worldY - downWorld[1])
```

### `end()` finalization

Click (no drag): handle → no-op; endpoint → drill to single; openButton → re-verify against fresh handle and re-test rect, then `openBookmarkUrl(id)` (the bookmark may have been deleted mid-press; drift >MOVE_THRESHOLD_PX would have promoted to translate already); outside → shift/ctrl additive xor replace; in-selection → shift/ctrl subtractive xor (multi: drill, single text/note/shape: enter text edit, single code: enter code edit); gap → quick tap deselects; background → deselect.

Drag commit: `store.endTransform()` routes endpointDrag → `tf.commitEndpointDrag(snap)`, else `tf.transformHasChange() ? tf.commitTransform() : tf.clearTransform()`, and resets the discriminant. `store.cancelTransform()` does the same for Esc.

After every `end()` / `cancel()`: `rehoverFromLastCursor()` re-runs `handleHoverCursor` against `getLastCursorWorld()` so a just-committed bookmark scale immediately reflects in the hover indicator without requiring a cursor wiggle.

**Modifiers:** Shift/Ctrl = additive/subtractive multi-select. Ctrl during endpoint drag suppresses snapping.

### Hover & Cursor

When idle, `move()` calls `handleHoverCursor(worldX, worldY)`. Priority (first match wins, all others fall through to default cursor):

1. **Pan ownership guard.** `panTool.isActive()` → bail (panTool owns 'grabbing' during MMB/spacebar pan; camera subscription routes those through `onViewChange` → here, so don't clobber).
2. Standard mode + selection + not editing → `hitResizeHandle` → `handleCursor(handle)`.
3. Connector mode → `hitEndpointDot` → 'grab'.
4. **Bookmark Open chip** (occlusion-aware via `pickTopmostPaint` — framed kinds paint `'ink'` on hit, so a bookmark winning the picker means the cursor is on visible bookmark pixels). On enter/leave, `invalidateWorldBBox(getOpenButtonWorldBBox(id))` so the base canvas repaints the chip's hover-fill. Cursor → 'pointer'.

SelectTool exposes `getHoveredOpenBookmarkId(): string | null` — `objects.ts` hoists this once per frame into `_hoveredOpenBookmarkId` and `drawObject`'s bookmark branch passes `_hoveredOpenBookmarkId === handle.id` to `drawBookmark`. `clearBookmarkOpenHoverIfAny()` runs at the start of every `begin()` (re-set by the openButton branch), on `cancel()`, on `onPointerLeave()`, and whenever a higher-priority cursor wins.

---

## Transform Engine (`transform.ts` + `transform-kernels.ts`)

Module-level SoA state, no class, no controller object. The store consumes via `import * as tf`; the renderer/overlay read typed-array buffers through per-frame getters (FlatRTree `results` idiom: refs valid within a frame, refetch per frame — arrays swap only at begin/growth). Steady-state begin/update/commit allocates nothing except reflow-sidecar field writes and cold pool growth.

### Lane buffer — stride 16, one Float64Array

Per gesture entry `gi`, `base = gi * G_STRIDE` (consts in `transform-kernels.ts`: `G_STRIDE=16, GF_BBOX=0, GF_AUX=4, GO_BBOX=8, GO_AUX=12`):

| lanes | meaning |
|---|---|
| `+0..3` | fBBox — frozen bbox (text: TIGHT frame bbox, OFFSET null-frame fallback = padded column rect; code: column ≡ tight; others: column rect) |
| `+4..7` | fAux (table below) |
| `+8..11` | oBBox — output bbox, seeded = fBBox at freeze |
| `+12..15` | oAux — seeded = fAux, ⚠ EXCEPT STROKE_UNIFORM entries seed `[frozenCx, frozenCy, 1, 0]` — the renderer's stroke arm reads oAux as fcx/fcy/factor from the first overlapping repaint in the begin→first-move window; a blind fAux copy would paint the stroke scaled `width`× around `(ptsOff, ptsCount)` |

| kind | fAux `[0] [1] [2] [3]` |
|---|---|
| shape, image | frame `x, y, w, h` |
| stroke | `ptsOff, ptsCount, width, 0` (width always filled; OFFSET commit ignores it — uniform freeze body) |
| text | `originX, originY, fontSize, width` (NaN = `'auto'`) |
| code | `originX, originY, fontSize, width` (OFFSET freeze leaves `[2..3]` = 0 — unread) |
| note, bookmark | `originX, originY, scale, 0` |

Post-OFFSET stroke oAux is documented garbage (aux0..1 offset, aux2..3 copied) — the stroke offset commit reads frozen lanes + oBBox only.

Parallel per-gi arrays: `_meta: Uint32Array` (bits 0–2 kindCode · 3–5 op · 6 DEAD · 7–9 code lineNumbers/headerVisible/outputVisible), `_gslot: Uint32Array`, `_gy: (Y.Map|null)[]` (commit refs; `length = 0` at dispose so deleted maps aren't rooted).

Stroke frozen points: packed x,y pairs in `_strokePool: Float64Array` (pow2, reset per begin); per-entry `[off, count]` in fAux. Reflow sidecars (`_textSidecars`/`_codeSidecars`, pooled, dense index `gi - opStart[op]`): measured/source ref + minW + anchor/output + a pooled layout (`createTextLayout()`/`createCodeLayout()` once per pool slot, `lineCount`/`visualLineCount` zeroed at freeze so a begin→first-move repaint paints nothing rather than a previous gesture's stale glyphs); refs nulled at dispose.

### Ops + LUTs

```
OP_OFFSET=0  OP_FRAME_UNIFORM=1  OP_FRAME_EDGES=2  OP_STROKE_UNIFORM=3
OP_ORIGIN_UNIFORM=4  OP_REFLOW_TEXT=5  OP_REFLOW_CODE=6            (OP_COUNT=7)
BEH_UNIFORM=0  BEH_NON_UNIFORM=1  BEH_EDGE_PIN=2  BEH_REFLOW=3
```

`BEHAVIOR_LUT: Uint8Array(64)`, index `kindCode*8 + cat*2 + (single?1:0)` (cat: corner=0 hSide=1 vSide=2; `cat`/`single` computed once per beginScale; `single = selectedIds.size === 1`, connectors included — legacy rule). Built from the same declarative rules as the old `resolveBehavior`: defaults corner→UNIFORM, sides→single UNIFORM / multi EDGE_PIN; overrides shape corner-single + shape sides → NON_UNIFORM, text/code hSide → REFLOW. `OP_LUT: Uint8Array(32)`, `kindCode*4 + behavior` → op; populated cells mirror the old APPLY_SCALE table exactly, everything else 0xFF — unreachable by construction (shape-edgePin can't be produced by BEHAVIOR_LUT; connectors branch to the topology builder before LUT resolution). The selftest proves both LUTs against verbatim oracle copies.

Behavior is a pure fn of kind per gesture ⇒ op is too ⇒ begin counting-sorts entries into contiguous op ranges (`_opStart`/`_opCount`). Scale update = one tight kernel per non-empty op; translate ignores ops entirely — ONE branchless `applyOffsetRange` over `[0, count)`.

### Kernels (`transform-kernels.ts`)

Exact ports of the old apply fns, operation order preserved — the selftest asserts BIT-IDENTICAL output, so never "simplify" float expressions (`scaleAround(fx + fw, …)` ≠ `scaleAround(maxX, …)`; `ob2 - ob0` ≠ `w`):

- `applyOffsetRange(lanes, start, end, dx, dy)` — branch-free 8-lane copy+add (old `applyOffset` + its fontSize/scale propagation; kind-blind because every layout puts "the coords that move" in aux 0–1 and "scalars that ride along" in aux 2–3).
- `applyEdgePinRange(lanes, start, end, ox, oy, sx, sy, sel0..3)` — per-entry per-axis `edgePinPosition1D` delta, then the offset writes.
- `applyFrameUniformRange(lanes, start, end, U)` — uniform bbox scale + inline `derivePaddedFrame` with the max(0)-clamped frame BACK-WRITTEN into oBBox (load-bearing at small scales).
- `applyFrameEdgesRange(lanes, start, end, ox, oy, sx, sy)` — per-axis `reflowLeftWidth` with `minDim = MIN_SHAPE_FRAME_DIM + 2*pad(axis)`, then the same derive + back-write.
- `applyStrokeUniformRange(lanes, start, end, U)` — uniform bbox scale; oAux ← `[frozenCx, frozenCy, af]` (af is ABS — strokes never mirror on flip).
- `applyOriginUniformRange(lanes, start, end, U)` — uniform bbox scale; inline roundProp (`r = round(prop·af·1000)/1000; ef = r/prop`); origin reprojects with **ef** (not af); aux3 rides `· ef` (NaN flows for text `'auto'`).
- `reflowLeftWidth(fx, fw, originX, sx, minW)` → 2-slot `reflowOut` scratch — old `computeReflowWidth`, shared by FRAME_EDGES and the reflow arms.
- `UniformPack` + `fillUniformPack(sx, sy, handleId, sel0..3, ox, oy)` — the per-frame hoist: uf/af + scaled selection corners (old `uniformFactor` + `preservePositionMut` gesture-global prefix); per-entry residue is tx/ty (0.5 fallback on degenerate axes) + center + dims.

Reflow arms live in `transform.ts` (heap sidecars + layout engines): REFLOW_TEXT runs `layoutMeasuredContent(measured, targetWidth, fontSize, sidecar.layout)`, writes origin = `newLeft + anchor·targetWidth`, width = `layout.boxWidth`, height = `lineCount·lineHeight`; REFLOW_CODE runs `layoutCodeSourceInto`, height = `blockHeight(layout, fontSize, headerBit, outputBit, sidecar.output)` — WITHOUT outputCache (legacy parity).

### Sparse slot routing

`_slotGesture: Int32Array` — maintained −1; capacity ensured ≥ `slotHighWater()` at begin AND by `getGestureSlotMap()` each frame (peers mint slots mid-gesture; growth copies live tags + fills −1). Encodings (consts in kernels): `-1` not in gesture · `gi` gesture entry · `TOPO_TAG|ti` (1<<30) topology connector (index into `topology.entries`) · `EPDRAG_TAG` (1<<29) the endpoint-drag connector; `GIDX_MASK = (1<<29)-1`.

Populated at begin (pass 2, topology finalize walk, epDrag), cleared by `derender()` walking `_gslot` + topology entry slots + epSlot. Replaces in hot paths: the pack-loop string-Set probes (and the handle recovery they forced), the paint `Map.get`/id-equality, the cull's per-id `objectsById.get`.

`_injectSlots: Uint32Array` + count — gesture slots + topology entry slots + epSlot; the cull re-validates each against `_slotGesture` (tag mismatch ⇒ evicted mid-gesture ⇒ skip — prevents recycled-slot aliasing AND double-pack).

`_injectIds: string[]` survives for LOCKS ONLY (`acquireLocalLocks` is id-keyed): all non-locked selected ids incl. freeze-bailed ones + the FULL `attachedConnectorIds` set (an attached connector whose entry construction bailed is still lock-acquired) or the epDrag id. Consumed only by selection-store's `acquireTransformLocks`; the renderer never sees it.

### Freeze (begin) — two passes over `selectedIds` (cold)

**Pass 1** (validate + count): per id → `getHandle`; skip null / remote-locked / durably-locked (BEFORE the injectIds push); push id; connector → `builder.onSelectedConnector` + continue; resolve behavior/op via the LUTs; run the **op-qualified bail predicate** (OFFSET freezes are minimal: shape/image `getFrame`, stroke non-empty points, text `getTextProps` ONLY — null `getTextFrame` falls back to the column rect, code `getOrigin` ONLY, note/bkmk `getOrigin`; uniform adds the frame getters; reflow adds measured/source). A bailed id stays in `_injectIds` (locked, draws in place — ledgered) but gets no lanes. **Prefix-sum** `_opStart`. **Pass 2**: `gi = opStart[op] + cursor[op]++`; write `_gslot`/`_gy`/`_meta`; register `_slotGesture[slot] = gi` + inject slot; `freezeLanes` fills fBBox (column, text = tight frame) + fAux + sidecars and seeds out = frozen; bindables → `builder.onSelectedBindable(id, kind, gi, handle)`. Accessors return LIVE Yjs refs — the lane writes ARE the copy; zero `[...x]` clones. Then `builder.finalize()`, register topo entries (`TOPO_TAG|ti`), push attached ids, compute `_overlayUniform` (`count===0 ? topology && corner : all behaviors uniform`).

### Per-frame update

```
updateScale(sx, sy):  ctx.sx/sy = …
  pushAllDamage()                        // OLD: every entry's current oBBox (+ text italic pad)
  per non-empty op: kernel range loop    // UniformPack hoisted once for the three *_UNIFORM ops
  runTopologyScale(topology, ctx, lanes) // pushes its own old/new pairs internally
  pushAllDamage()                        // NEW rects — without this the preview trails/vanishes
  flushDamage()                          // ONE invalidateWorldRects batch
updateTranslate(dx, dy): pushAllDamage(); applyOffsetRange(lanes, 0, count, dx, dy);
  runTopologyTranslate(topology, dx, dy, lanes); pushAllDamage(); flushDamage()
```

`pushAllDamage()` walks `[0, count)`: text entries pad horizontally by `getItalicOverhangPad(oAux2)` ±2 vertical (the real fn — memoized 'Inter' factor, ≥2 floor); op-sorted entries make the branch perfectly predicted. Two rects per entry per frame (old, new) — parity with the old per-entry publishes (union rejected: inflates repaint on fast drags). First frame is exact: seeded oBBox = fBBox, and for text tight+pad ≡ the column bbox (`computeTextBBox` uses the identical `[padH, 2]` pads). Dead entries' stale lanes are pushed too — erases their last preview pixels harmlessly. Damage is markDirty-gated end-to-end: fully-offscreen gesture damage never schedules a base-canvas rAF.

### Commit / clear / cancel

`commitTransform()`: capture locals → **derender FIRST** (mode→0, sparse map + inject reset — the renderer sees idle before the observer repaints; old clear-first glitch guard) → ONE `transact`: per gi skip `META_DEAD` (dead FIRST — a recycled slot's lock lanes belong to someone else) then skip `lo[slot]>1 || lf[slot]===1` (loser's heal) → build values from lanes → `_gy[gi]!.set(…)`:
- FRAME ops + shape/image OFFSET → `frame` from oAux.
- STROKE_UNIFORM → points from `_strokePool` mapped `[ncx + (px−fcx)·af, ncy + (py−fcy)·af]` (ncx/ncy = oBBox center, fcx/fcy/af = oAux) + `width = fWidth·af`.
- stroke OFFSET → pool + `(oBBox0−fBBox0, oBBox1−fBBox1)`.
- origin-kind OFFSET → `origin` ONLY. ORIGIN_UNIFORM → origin + fontSize (+ width unless NaN) / code width / note-bkmk `scale`. REFLOW_* → origin + width ONLY (no fontSize).

Then `commitTopology(topology, mode, dx, dy)` inside the same transact (id-keyed lock rechecks stay — slots recycle, ids can't). Finally dispose (release `_gy`/sidecar refs, reset counters). `clearTransform()` = derender + dispose. `cancelTransform()`: epDrag → precise prev/curr damage + flush + teardown; else `invalidateWorldAll()` + `cancelTopology` + teardown (full-repaint parity — cancel is rare). `transformHasChange()`: scale → sx/sy ≠ 1; translate → dx/dy ≠ 0; else false.

### Endpoint drag — ported, slot-registered

`beginEndpointDrag(connectorId, slot, handle)`: lock guard, `buildRouteContext` (false on failure → SelectTool stays idle), scratch resets — `currBbox`/`prevBbox` seeds read the COLUMN at `handle.slot*4`; registers `EPDRAG_TAG` + inject slot + inject id. `updateEndpointDrag`: snapshot curr→prev BEFORE the reroute (load-bearing), push OLD, `rerouteEndpointDragInto`, then GATED on `count > 0`: `unionConnectorLabelRectInto` + push NEW; flush unconditionally. `commitEndpointDrag(snap)`: damage + flush, validCount≥2 gate, id-keyed lock/handle rechecks, one `transact` writing `slotKey(slot)` = anchor record xor cloned free Point; teardown clears the sparse slot on EVERY exit. `EndpointDragEntry` gains mutable `slot` (the reused scratch, reassigned per gesture — unlike `BaseEntry.slot`'s readonly).

### Mid-gesture eviction — `transformEvictSlot(slot)`

RoomDocManager calls it in Phase A (after `zOrder.noteRemove`, BEFORE `releaseSlot` — the finalize-before-release invariant) and in the kind-keychange branch. No-op when idle/OOB/absent; clears the map cell; gesture entries also get `META_DEAD` (commit-skip only — hot loops never test it, `pushAllDamage` keeps erasing the dead preview). Fires inside the synchronous observer, never between the renderer's `ensureRanksValid()` and its pack loop — the rank-stability contract holds. Import-cycle: RDM→transform exists transitively (via selection-store); runtime calls only, no module-eval reads across the cycle.

Fallout semantics (deliberate, ledgered in the plan): remote delete mid-gesture → dead entries evict, SURVIVORS keep their preview and commit at pointerup (the renderer keys off module mode, not the store discriminant, so the store's clear-selection-without-cancel no longer strands previews); remote kind-conversion mid-gesture → the object draws canonically in its new kind, commit skips; locked/freeze-bailed selected objects draw in place instead of vanishing.

### Export surface

Lifecycle (store via `import * as tf`; SelectTool for epDrag): `beginScale(selectedIds, handleId, origin, selBounds)` · `updateScale(sx, sy)` · `beginTranslate(selectedIds, selBounds)` · `updateTranslate(dx, dy)` · `beginEndpointDrag(id, slot, handle): boolean` · `updateEndpointDrag(x, y, snap)` · `commitEndpointDrag(snap): boolean` · `commitTransform()` · `clearTransform()` · `cancelTransform()` · `transformHasChange()`.

Consumers: `getTransformModeCode()` (0/1/2/3 = none/scale/translate/epDrag) · `getGestureSlotMap()` (capacity-ensured) · `getGestureLanes()` · `getGestureMeta()` · `getGestureCount()` · `getInjectSlots()`/`getInjectSlotCount()` · `getTopoEntries()` · `getEndpointDragEntry()` · `getTranslateDX()/DY()` · `getTransformScaleCtx()` (null unless scaling — persistent object must not leak stale consts) · `isOverlayUniform()` (gated on scale mode) · `getTranslateSelBounds()` · `getReflowLayout(gi)` · `readGestureOutBBox(slot, out): boolean` (image-manager's narrow accessor; guards OOB — `undefined < 0` is false and would decode gi 0 — non-membership, and tags) · `getTransformInjectIds()` (LOCKS ONLY) · `transformEvictSlot(slot)` (RDM only).

---

## Connector Topology (`connector-topology.ts`)

Connectors never enter the lane buffer. The engine drives a builder inline with its begin passes. **One `getHandle` per selected id, one per non-selected attached connector.**

### Endpoint state × connector mode

Two orthogonal classifications, decided at begin.

**Endpoint state** (per side, via `classifyEndpoint`):

| State | When | Side variant |
|---|---|---|
| `canonical` | anchored to non-selected bindable, OR free + connector unselected | `'static'` — endpoint baked once via `bakeCanonicalEndpoint` |
| `frame-bound` | anchored to a selected bindable | `'bind'` — `Pipeline.newAnchored`; per-frame `fillFrameFromBind` + `Pipeline.configAnchored` |
| `free-moving` | not anchored AND connector is selected | `'free'` — `Pipeline.newFree(scratch)`, `endpoint.pos === scratch` (alias) |

**Connector mode** (per connector, discriminant of `ConnectorEntry`):

| Mode | Condition | Per-frame |
|---|---|---|
| `static` | both endpoints canonical (only selected connectors enter) | none — renderer draws stored route |
| `translate` | both non-canonical AND gesture is `translate` | rigid bbox shift; renderer reads cached route + `ctx.translate(dx, dy)` |
| `reroute` | anything else | rebake non-static sides; `Pipeline.routeInto(start.endpoint, end.endpoint, ...)` |

### Shape

```typescript
type ConnectorEntry =
  | StaticEntry
  | TranslateEntry             // frozenStart/frozenEnd: Point | null  (cloned at begin; null = bound)
  | ElbowRerouteEntry          // RerouteEntryBase<ElbowSide>
  | StraightRerouteEntry;      // RerouteEntryBase<StraightSide>

type ConnectorTopology = {
  entries:              readonly ConnectorEntry[];          // registration order (selected, then attached);
                                                            // entry i is registered as TOPO_TAG|i in the sparse map
  translates:           readonly TranslateEntry[];
  elbowReroutes:        readonly ElbowRerouteEntry[];       // partitioned for monomorphic apply
  straightReroutes:     readonly StraightRerouteEntry[];
  attachedConnectorIds: ReadonlySet<string>;                // LOCKS ONLY — must stay the FULL attached set
};                                                          // (bailed entries are still lock-acquired)
```

`BaseEntry` carries `readonly slot` (from `conn.slot` at build); all bbox triples (`originalBbox`/`currBbox`/`prevBbox`) are CLONED from the global bbox column at `conn.slot*4` — never aliased to live geometry (a peer moving a non-selected anchor mid-gesture reroutes this connector and upsertHandle rewrites the lane in place). `finalize()` is null iff `entries.length === 0`.

Bind sides hold `readonly gi` (lane index of the bind target) instead of an entry object; the lane buffer is THREADED into `runTopologyScale/Translate(…, lanes)` per frame — no topology→transform import. `AnchorSource` fields (anchor / shapeId / interior) stay inlined on the bind variant so `side` IS structurally an `AnchorSource`. ELBOW bind also carries `shapeType` (frozen at begin) and `frame` (aliased to `endpoint.frame`); STRAIGHT bind the same minus `shapeType` (`frame` aliased for `interior`, standalone scratch for `edge`).

**See `core/connectors/CLAUDE.md` "Side ownership model" for the full alias contract and frozen-at-begin invariants.**

### `fillFrameFromBind(scratch, side, lanes)` (bind-side frame derivation)

Per frame, for each bind side, write the live anchor frame into `side.frame` off the lane buffer at `side.gi`:

| `bindKind` | Read |
|---|---|
| `shape`, `image` | oAux lanes ARE the live frame |
| `text`, `code` | oBBox lanes read as a frame (out bboxes are tight for these kinds) |
| `note`, `bookmark` | `ratio = oAux2/fAux2` (OFFSET's aux-copy gives ratio = 1 under translate/edgePin); `[oAux0, oAux1, frozenFrame·ratio]` — the frozen frame clone stays load-bearing (bookmark height isn't in the lanes) |

Mode-agnostic: whatever the kernels just wrote is what it reads. After `fillFrameFromBind`, the apply loop calls `Pipeline.configAnchored(side.endpoint, side.frame, side.shapeType, side)`. Frame slots written by `configAnchored` are self-writes when aliased.

### Free-side aliasing

Each free side owns a private `scratch: Point` allocated once at build. `Pipeline.newFree(scratch)` preserves the reference, so `endpoint.pos === scratch`. Per-frame apply mutates scratch slots; the endpoint sees updates automatically. Per-side (not module-shared): the routing pipeline holds free `Point`s by reference and writes them into the returned route. `originalPos` is cloned at begin.

Free-apply math: translate → `offsetPoint(scratch, originalPos, dx, dy)`; scale → corner (hoisted with `uf = uniformFactor(...)`) → `preservePositionMut`, side handles → axis-aligned `scaleAround` (inactive axis hardcoded 1 by `rawScaleFactorsInto`).

### Monomorphic apply loops + damage

Reroute entries are partitioned at finalize into `elbowReroutes` / `straightReroutes`; each pipeline gets its own apply loop calling ELBOW or STRAIGHT directly. Dirty publication goes through `pushDamage` (old/new pairs per entry, inside `applyTranslates`/`publish*Route`) — flushed once per pointermove by the engine's update fns. `cancelTopology` keeps `invalidateWorldAll()`.

### Commit rule

> **Free endpoints commit a Point. Bound (and static) endpoints commit nothing. `points` is never committed.**

The bound shape's frame write in the same `transact()` triggers the observer reroute on tx end → `ConnectorRouter.rerouteCanonical` populates the local route cache → off-gesture consumers read the fresh cache. `commitTopology` is id-keyed (`lockedElsewhere` via `getObjectsById` — slots recycle, ids don't); the attachedIds durable-lock asymmetry (`lo` only at build, `lf` caught at commit) is deliberate legacy parity.

### Topology-specific invariants

1. **Zero per-frame allocation.** Per-side scratches built once at gesture begin; `pointsBuf` mutated find-or-push and grows only past its high-water mark.
2. **Zero per-frame Y.Map reads.** `RouteContext` built ONCE at `processConnector`; per-frame apply reads only side state + bind lanes.
3. **No null Side slots.** Canonical sides are `kind: 'static'` — apply loop never branches on null.
4. **Reroute internals are deferred surface** — typed routes / SoA entries come in a later slice; the draw-loop dispatch, bind-side reads, and dirty publishing already run the new architecture.

---

## Hit Testing

All hit logic in `core/spatial/` (see its CLAUDE.md). SelectTool is a pure consumer.

| Phase | Call | Returns | Behavior |
|---|---|---|---|
| Click target | `pickTopmostPaint([x, y], { px: 8 })` | `ObjectHandle \| null` | **Best candidate, not just topmost.** Frame-aware area tournament — small unfilled shape stacked above larger filled shape: smaller wins. |
| Marquee | `queryHandleIds(inBBox(marqueeBBox))` | `string[]` | **Precise per-kind intersection.** Shape-type aware (ellipse perimeter, diamond edges); polylines segment-wise; framed kinds against derived frame. |
| Resize handle | `hitResizeHandle([x, y], selectionBounds)` | `HandleId \| null` | Screen-space ~10px probe. Internally gates on `shouldShowHandles(bbox)` — `Math.max(w, h) * scale ≥ HANDLE_MIN_BBOX_PX (12)`. Same gate drives overlay visibility + cursor — render/hit/cursor always agree. |
| Endpoint dot | `hitEndpointDot([x, y], selectedIds)` | `EndpointHit \| null` | Screen-space nearest probe over selected connectors' endpoints. `EndpointHit.slot: Slot` (`0 \| 1`). |

Marquee uses no tolerance (exact region intersect).

---

## Rendering During Transforms (`renderer/layers/objects.ts`)

Frame-top hoists: editing ids, `tmode = getTransformModeCode()`, `sg = getGestureSlotMap()`, gesture lanes/meta (module lets), `topoEntries`, `epEntry`, `tdx/tdy`, kind codes + bbox column. **`drawObjects` does not read `sel.transform`** — module mode is the single render truth (the store discriminant remains for React/overlay/keyboard).

- **Pack loop** skip: `if (transforming && sg[slot] >= 0) continue;` — one load + sign test, zero handle recovery pre-sort even mid-gesture. Clip test unchanged (column reads).
- **Cull** (`cullInjectedSlots`): walk `injectSlots[0..count)`; re-validate `g = sg[slot]` (−1 ⇒ evicted ⇒ skip); `TOPO_TAG` → entry `currBbox`; `EPDRAG_TAG` → `epEntry.currBbox`; translate → LIVE column + delta (paint draws live geometry offset by d — the cull must track the live rect); scale → out-bbox lanes (paint is frozen-derived preview). Pack `ranks[slot]`. Zero Map/handle lookups.
- **Paint routing**: `g = sg[handle.slot]`; `g >= 0` → tag branches to `drawConnectorEntry` (string `ce.mode` switch stays — 3 interned strings, deliberate), translate → `ctx.translate(tdx, tdy)` + `drawObject`, scale → `renderScaleEntryLanes(ctx, handle, g)`. Everything else → `drawObject` (kind-code int jump table off the slot column; images draw at their column rect via the scalar-signature `drawImage`).
- **`renderScaleEntryLanes`** dispatches on the meta op: FRAME ops → shape `paintShapeFrame` + `drawShapeLabelWithFrame` from a frame scratch filled off oAux / image at oBBox; STROKE_UNIFORM → cached Path2D under `translate·scale·translate` (fcx/fcy/factor from oAux); ORIGIN_UNIFORM → per-kind cached-layout `ctx.scale(oAux2/fAux2)` arms (text around out-origin, code around oBBox corner, note/bkmk around out-origin with `-fAux` back-shift + recursive `drawObject`); REFLOW_* → sidecar layout at out-origin lanes (code gated `visualLineCount > 0`, else in-place fallback); OFFSET → translated draw by `oBBox − fBBox`. sg membership ⇒ entry exists — no null probes.

---

## Selection Store (`stores/selection-store.ts`)

```typescript
interface SelectionState {
  selectedIds, mode, selectionKind, selectedIdSet, kindCounts, selectionLocked,
  menuOpen, selectedStyles, inlineStyles, boundsVersion,
  transform: TransformState,    // {kind:'none'} | TranslateTransform | ScaleTransform | EndpointDragTransform
  marquee, textEditingId, codeEditingId,
}
```

`TranslateTransform` is a thin marker. `ScaleTransform` carries `{kind, initialDelta, clickOffset}` (gesture-frame constants for `rawScaleFactorsInto`). `EndpointDragTransform` carries `{kind, connectorId, slot: Slot, currentPosition, currentSnap}` — renderer/UI only; route buffer + bbox snapshots + `RouteContext` live in the engine. The store orchestrates the whole gesture via `import * as tf`; SelectTool never touches the engine directly except `tf.beginEndpointDrag(...)`/`tf.updateEndpointDrag(...)` at gesture start/move (the engine needs the live handle/coords).

| Action | Effect |
|---|---|
| `setSelection(ids)` | Compose, reset transform/marquee, bump boundsVersion, refreshStyles |
| `clearSelection()` | Reset to defaults |
| `beginTranslate()` | `computeSelectionBounds()` → `tf.beginTranslate(selectedIdSet, selBounds)` + `{kind:'translate'}`. Bails early on null union. |
| `updateTranslate(dx, dy)` | `tf.updateTranslate` |
| `beginScale(handleId, downWorld)` | bounds → origin/handlePos → gesture math → `tf.beginScale` + `{kind:'scale', ...}` |
| `updateScale(worldX, worldY)` | `rawScaleFactorsInto(_rsf, …)` → `tf.updateScale(_rsf[0], _rsf[1])` |
| `endTransform()` | Routes by `transform.kind`: endpointDrag → `tf.commitEndpointDrag(currentSnap)`; else `tf.transformHasChange() ? tf.commitTransform() : tf.clearTransform()`. Then `{kind:'none'}`, release locks. |
| `cancelTransform()` | `tf.cancelTransform()` (all gesture modes) + `{kind:'none'}`, release locks |
| `beginEndpointDrag(connectorId, slot)` | Set endpointDrag transform discriminant (engine already begun by SelectTool); acquire locks. |
| `updateEndpointDrag(currentPosition, currentSnap)` | Patch the discriminant — overlay reads it for snap feedback + dragged dot. |
| `begin/endTextEditing`, `begin/endCodeEditing`, `refreshStyles` | Editing state + style snapshot upkeep |

`computeSelectionBounds()` (zero-arg) serves triple duty: idle overlay bounds, scale gesture bounds, translate-frozen union. Reads `selectedIds → textEditingId → codeEditingId` fallback chain. Returns `null` on empty selection (causes both begin-fns to bail). Text uses `frameToBbox(getTextFrame())`; all others use `handle.bbox`. The engine COPIES origin/selBounds at begin, so the single-selection live-bbox alias can no longer drift the gesture baseline.

Lock choreography: `acquireTransformLocks` reads `tf.getTransformInjectIds()`; `_lockPrunePending`/`_persistLockPending` defer selection prunes to `releaseTransformLocks` (mutating the selection mid-gesture would desync the renderer). `onObjectsDeleted`'s partial-delete clear-without-cancel is now benign: the renderer keys off module mode, so survivors keep previewing and commit at pointerup (the selection overlay vanishes early — accepted).

---

## Endpoint Drag

Only in connector mode (single connector selected). **Owned by the transform engine** as the third gesture mode. SelectTool delegates lifecycle; the engine's synthetic `EndpointDragEntry` (`mode: 'reroute'`, mutable `id`/`slot`, `currBbox`, `pointsBuf`, `validCount` — one reused scratch) flows through `drawConnectorEntry` via the `EPDRAG_TAG` sparse-map registration — same dispatch as topology reroute entries. The renderer cannot tell endpoint drag from a single-connector reroute and shouldn't have to.

Engine state: `_epSlot` (object slot; −1 idle), `_epDragSlotArg: Slot` (which endpoint), `_epRouteCtx` (built once at begin; gesture-stable), `_epDragPrevBbox` scratch. Lifecycle §Transform Engine above. Bbox seeds read the COLUMN; teardown clears the sparse slot on every exit (commit, failed commit, cancel, evict).

**Commit rule.** Free Point xor `StoredAnchor` via `slotKey(slot)`. The deep observer reroutes canonically post-tx, populating the local route cache.

**Slot naming.** `Slot = 0 | 1` (`SLOT_START`/`SLOT_END`) lives in `core/connectors/reroute-connector.ts`. Helpers there: `slotKey(s)`, `slotOther(s)`, `slotPointIndex(s, count)` (branchless: `s * (count - 1)`). Distinct from the object-slot fabric (`handle.slot`).

---

## Selection Utils + Field Table

Two collaborating files:

- **`selection-utils.ts`** — composition + style aggregation:
  - `computeSelectionComposition(ids)` — single-pass `counts[handle.kind]++` → `KindCounts = Record<ObjectKind, number> & { total }`. Derive `selectionKind` by counting non-zero buckets.
  - `computeStyles(ids, kind)` — declarative `foldField` composition over the field table. Returns `EMPTY_STYLES` for `none`/`mixed`/`image`/`bookmark`. Code-only fields gate on `kind === 'code'` so non-code selections don't surface stale values.
  - `computeUniformInlineStyles(ids)` — bold/italic/highlight across text/labeled-shape/note. Stays standalone (its bool-AND-fold doesn't fit `Aggregate<V>`'s "first-or-mixed" shape).

- **`selection-field-table.ts`** — single source of truth for "what fields exist, how they're read/written/persisted per kind". Adding a property = appending one `FieldDescriptor` entry.

```ts
interface FieldDescriptor<V> {
  read:    { [K in ObjectKind]?: (h: ObjectHandle) => V | undefined };
  write:   { [K in ObjectKind]?: (h: ObjectHandle, v: V) => void };
  accepts?: { [K in ObjectKind]?: (h: ObjectHandle) => boolean };
  persist?: { [K in SelectionKind]?: (v: V) => void };
  equals?:  (a: V, b: V) => boolean;
}
interface Aggregate<V> { value: V | null; mixed: boolean; second: V | null }
```

**Primitives:**
- `foldField(handles, f) → Aggregate<V>` — first-or-mixed read aggregation.
- `applyField(ids, f, value)` — opens one `transact()`, dispatches per-kind writes, persists by `SelectionKind` (skipped on `mixed`/`none`), refreshes styles. Multi-key writes (e.g. `TEXT_ALIGN`'s origin recompute, `CODE_FONT_SIZE`'s proportional width) live inside the writer closure — atomic inside the open transact.
- `toggleField(ids, f, fallback)` — first-applicable read → `applyField(!current)`. Replaces the 3 byte-identical code-toggle clones (line-numbers / header / output) and bold/italic.
- `adjustByPresets(ids, f, presets, dir, current, min, max)` — clamp or step through preset list. Replaces both inc/dec preset pairs (text + code).
- `withEditorOr(whenEditor, otherwise)` — Tiptap fast-path for bold/italic/highlight. The field layer never depends on Tiptap.

**Descriptors** (~17): `COLOR`, `WIDTH`, `FILL_COLOR`, `SHAPE_TYPE`, `TEXT_COLOR`, `FONT_SIZE`, `FONT_FAMILY`, `TEXT_ALIGN`, `TEXT_ALIGN_V`, `BOLD`, `ITALIC`, `HIGHLIGHT`, `CODE_LANGUAGE`, `CODE_FONT_SIZE`, `LINE_NUMBERS`, `HEADER_VISIBLE`, `OUTPUT_VISIBLE`. All reuse existing accessors and persist sinks.

**Source-of-ids selection** (`getSelectedIds()` / `getTextSelectionIds()` / `getCodeIds()`) lives at the action layer in `selection-actions.ts`. It's "who's calling," not "what the field is." Trying to model it on the descriptor adds the wrong axis.

**Correlated-union cast** at the dispatch boundary (`(f as AnyDescriptor).write[h.kind]`) — one cast per loop with `// biome-ignore`; the mapped table proves correctness at definition. (Spatial hit dispatch and the transform engine both moved to switch/LUT dispatch — this is the canonical remaining example.)

**Adding a property** is four mechanical edits, no control-flow change:
1. Append one `FieldDescriptor` entry to `selection-field-table.ts`.
2. Add one line to `selection-actions.ts`: `export const setSelectedX = (v) => applyField(getSelectedIds(), X, v);`.
3. Add one `foldField` call + one record field to `computeStyles` in `selection-utils.ts`.
4. Add the field to `SelectedStyles` + `EMPTY_STYLES` + `stylesEqual` in `types.ts`.

`deleteSelected` stays imperative — it's a structural op with a connector-detach prelude, not a property write. Uniformity for its own sake is anti-leverage.

---

## Context Menu

SelectTool controls visibility:
- `begin()` → `contextMenuController.hide()` (always)
- `end()` / `cancel()` → `contextMenuController.show()` (if selection or editing active)
- Single text re-click → `cancelHide()` to prevent flash

Store fields consumed by context menu are documented in `components/context-menu/CLAUDE.md`.
