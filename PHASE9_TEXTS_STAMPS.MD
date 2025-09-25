Issa, here’s a no-shortcuts, soup-to-nuts blueprint for **Phase 9: Texts & Stamps** that plugs cleanly into your current rendering, snapshot, and toolbar architecture. I’m grounding every call in your actual code (and I’ll cite exact places) while pushing where it makes sense so you can ship fast and leave headroom for Phase 10 (undo/redo) and later transforms.

---

# Goals (what “done” looks like)

1. **Two new tools**: **Text** (click to place; DOM editor overlay; single atomic commit) and **Stamps** (click to place; instant commit).
2. **Zero churn to Canvas & loops**: Reuse the **base render loop** for world content and **overlay loop** for previews/presence; respect your event-driven dirty-rect invalidation and docVersion discipline. The base loop already queues world layers (background → strokes → shapes → text). We’ll fill in **drawText** and **drawShapes**.&#x20;
3. **Immutable snapshots & atomic writes**: Only commit via a single `mutate(fn)` per user action; snapshot `docVersion` continues to gate base invalidations while overlay keeps doing presence/preview. &#x20;
4. **Dirty-rects for texts/stamps**: Your `diffBounds()` already accounts for `texts[]`; stamps piggyback strokes or get their own pass (more below). &#x20;
5. **Toolbar integration**: You already expose `text` and `stamps` in Zustand and the ToolPanel has buttons; we only need to wire the tool creation & settings.   &#x20;

---

# Architectural fit (no surprises)

* **Two-canvas discipline** stays: base renders world content with the view transform; overlay draws previews in **world coords** and presence in **screen space**.&#x20;
* **Canvas exposes** a `setPreviewProvider()` hook you already route to the **overlay loop**, and an imperative `worldToClient` that we’ll use to position the DOM text editor. &#x20;
* **Overlay canvas** is `pointer-events: none`, so our DOM editor can sit above and still capture input.&#x20;
* **docVersion-driven invalidation** already distinguishes “presence-only” from “doc changed”; we’ll keep using that to light up base loop rects on commits and only ping overlay for presence/preview.&#x20;

---

# Data model (minimal churn, forward-compatible)

## Text

You already have:

```ts
export interface TextView {
  id: TextId; x: number; y: number; w: number; h: number;
  content: string; color: string; size: number;
  scene: SceneIdx; createdAt: number; userId: string;
}
export interface AddText { type:'AddText'; id: TextId; x; y; w; h; content; color; size; scene; }
```

Keep that shape for MVP. Future additions (lineHeight, font, align) can be added as optional fields without breaking draw or hit-testing.

**Scene assignment at commit** matches your contract: “commit to current scene at time of commit.”&#x20;

**Snapshot rules** (reconfirm): `texts[]` filtered to `scene === currentScene`, arrays frozen, `docVersion` increments on Y changes.&#x20;

## Stamps (MVP)

Treat stamps as **special strokes** for now: `{ tool: 'stamp', stampId, x, y, w, h, bbox }`. This lets you reuse ordering/selection/eraser rules and draw them in the **“shapes”** pass. You can split `stamps[]` later if you want separate draw order or edit affordances.&#x20;
Renderer’s `drawShapes()` becomes “stamps & primitive shapes.” It’s already slotted in your base loop.&#x20;

---

# UI state & toolbar

Zustand **already** holds `activeTool`, `text` settings, and a slot for `stamps`. Keep defaults (size/color) and add a tiny extension for stamps palette and scale if you want:

* `stamps: { selected: string; scale: number }`
* `setStampSettings(partial)`

Your store already manages `activeTool` and text settings; add one action for stamps. &#x20;

The **ToolPanel** already exposes Text and Stamps buttons; no extra UI required to start. &#x20;

---

# Tools (new classes) + unified pointer surface

Your overview already prescribes one tool instance constructed from `activeTool`, providing a **polymorphic** surface and a **preview provider**. We’ll add `TextTool` and `StampTool` that match your existing `DrawingTool`/`EraserTool` API. &#x20;

**PointerTool surface (unchanged):**

* `begin(pointerId, wx, wy)`, `move(wx, wy)`, `end(wx?, wy?)`, `cancel()`, `getPreview()` etc. (exact surface in OVERVIEW).&#x20;

Canvas continues to **set the overlay preview provider once**, and swap tool objects when `activeTool` changes.&#x20;

---

# TextTool (authoring + commit)

## Behavior

* **Click** anywhere in world space to open a **DOM editor** (contenteditable or textarea) at a precise pixel position computed via `worldToClient(wx, wy)`.&#x20;
* The editor runs **outside** canvases so caret/IME/selection are native; overlay canvas still renders presence and any lightweight authoring hints.
* **Enter** or **blur** commits exactly **one** Yjs transaction: push `Text` to `yTexts`, derive `w/h` from measured content (see below), set `scene` from current scene, keep `id`/`createdAt`/`userId`. (One transact = one undo step later.)&#x20;

## DOM editor positioning

* On `begin(wx, wy)`, compute `[clientX, clientY] = worldToClient(wx, wy)` and absolutely position a portal’ed `<div contenteditable>` there. The overlay canvas is `pointer-events:none`, so the editor receives input. &#x20;
* Keep the editor **pixel-anchored** (screen space). When the user pans/zooms, **close and re-open** at the corresponding world point, or (simpler MVP) **lock the view** while editing.

## Measuring & storing `w/h`

* After commit key/blur, measure the DOM node’s bounding box (`getBoundingClientRect`) and convert back to world units with the **current scale** (divide by `view.scale`). Persist those as `w/h`. The base loop uses `w/h` for bounds diffing. Your `diffBounds()` already includes texts. &#x20;
* For MVP, support single-line or soft-wrap within a **max width** (e.g., 320 CSS px). You store the final `w/h` computed at commit time to match what renders.

## Commit flow (atomic)

* `room.mutate(ydoc => yTexts.push({...}))` in one transact; assign `scene=currentScene`, set `id=ulid()`, `createdAt=Date.now()`, `userId=session user`. Your guides already establish scene assignment on commit and transact-only writes. &#x20;
* After the mutate publishes, Canvas will detect `docVersion` change, **hold the preview for one frame** (you already call `holdPreviewForOneFrame()`), and dirty only the text’s bbox via `diffBounds()`.&#x20;

## Overlay preview

* Minimal MVP: none. (The DOM editor is the preview.)
* Optional nicety: show a faint **text bounding box** in overlay while editing. Overlay should apply the **world transform once** if you render any world-space hints.&#x20;

## Rendering text (base loop)

* Implement `drawText(ctx, snapshot, view, viewport)` to iterate `snapshot.texts` and draw with `ctx.font = \`\${size}px Inter, system-ui\``; `ctx.fillStyle = color`. The draw call runs in **world transform** (base loop already scales/translates once), so positions are just `{x,y}`and dimensions`{w,h}\` in world units. &#x20;

## Erasing text (fits your eraser discipline)

* Your **atomic deletion** already hints at deleting from `yTexts` in the same reverse-index pass (“// Same for texts”). When you hook up hit-testing later, reuse the same single-transaction delete to keep undo atomic. &#x20;

---

# StampTool (click-to-place)

## Behavior

* On click in world space, create a **stamp object** at `(wx, wy)`; commit once.
* A stamp has `stampId` (atlas key or SVG id), `w/h` in **world units** (derive from a base px size divided by `view.scale` for “size \~ constant in screen px” feel, or store a fixed world size for map-like fidelity).
* **BBox** is `[x, y, x+w, y+h]` for dirty-rects.

## Commit flow

* `room.mutate(...)` → push **either**:

  * a **stroke-like** object with `tool: 'stamp'` in `strokes[]` (lowest churn; draw from `drawShapes()`), or
  * a new `stamps[]` if you prefer separation (requires snapshot & diff updates).
* I recommend piggybacking **strokes\[]** with subtype `tool:'stamp'` for MVP, as your overview suggests, so selection/eraser/ordering work out of the box.&#x20;

## Rendering stamps

* Fill `drawShapes()` to branch on `tool === 'stamp'` and blit from an **in-memory atlas** (sprite sheet) or draw an inline SVG path. It already sits between strokes and text in your base loop. &#x20;

---

# Canvas wiring (exactly what to change)

1. **Tool construction**: in the `useEffect` that selects a tool from `activeTool`, add:

   * `text → new TextTool(roomDoc, deviceUI.text, userId, canvasHandle, onInvalidate)`
   * `stamps → new StampTool(roomDoc, deviceUI.stamps, userId, onInvalidate)`
     (You already set the preview provider once and route it to **overlay**.)&#x20;
2. **Preview provider**: `TextTool.getPreview()` likely returns `null` (DOM editor handles UX). `StampTool.getPreview()` can return a ghost rect or sprite; overlay draws it in **world space** (do not reapply transform).&#x20;
3. **Invalidation**: On pointer moves with a live preview (stamps), call `overlayLoop.invalidateAll()`. On commit, let `docVersion` bump and `diffBounds()` trigger base invalidation; `Canvas` already **holds** one preview frame on publish to hide flicker.&#x20;

---

# Rendering & invalidation details (so it stays fast)

* Base loop applies world transform once, culls by visible world bounds, and draws **background → strokes → shapes(stamps) → text**. Keep hairline policy as is. &#x20;
* **Dirty rects**: you already diff text rects; stamps either reuse stroke bbox or add a stamps pass later. `invalidateWorld(bounds)` is the right API (already implemented). &#x20;
* **docVersion discipline**: Presence doesn’t bump; commits do; Canvas promotes targeted rects to frames and holds preview for a frame. All in code today.&#x20;

---

# Minimal API contracts for the two tools (sketch)

```ts
// TextTool.ts
class TextTool implements PointerTool {
  constructor(
    private room: RoomDoc,
    private settings: { size: number; color: string },
    private userId: string,
    private canvas: CanvasHandle,            // for worldToClient
    private onInvalidate: () => void
  ) {}

  begin(id: number, wx: number, wy: number) {
    // Spawn DOM editor at worldToClient(wx, wy), focus, hook blur/Enter to commit.
    // No overlay preview required.
  }

  end() {/* no-op (commit happens on blur/Enter) */}
  move() {/* no-op */}
  cancel() {/* remove editor if present */}
  getPreview() { return null; }
}
```

```ts
// StampTool.ts
class StampTool implements PointerTool {
  constructor(private room: RoomDoc,
              private settings: { selected: string; scale: number },
              private userId: string,
              private onInvalidate: () => void) {}

  begin(id: number, wx: number, wy: number) {
    // Option A: show overlay ghost for current stamp (return from getPreview()).
    // Option B (MVP fastest): commit immediately.
  }

  end(wx?: number, wy?: number) {
    // if previewing, commit here: mutate(() => push stamp)
  }

  getPreview() { /* return {kind:'stamp', ...} or null */ }
}
```

The **Canvas** side remains unchanged except for constructing these tools and passing `setPreviewProvider` (already routed to overlay).&#x20;

---

# Text rendering specifics (MVP that looks good)

* **Font**: `ctx.font = \`\${size}px Inter, system-ui, -apple-system, Segoe UI, Roboto\`\`.
* **Baseline**: Draw at `(x, y + size)` to approximate ascent; if you want precise baseline, store `y` as baseline in world space.
* **Wrap**: Simple word-wrap to a target max width: compute `ctx.measureText()` in the world context (already scaled), break lines, set `w` to the max line width and `h = lines.length * (size * 1.2)`. Persist those back on commit.
* **Hit testing** (later): text hit = point inside `[x, y, x+w, y+h]`.

---

# Stamps rendering specifics

* Maintain a **sprite atlas** in memory keyed by `stampId` (SVG rendered to offscreen canvas or <img> atlas). On draw: `ctx.drawImage(sprite, x, y, w, h)`.
* For **screen-constant size** stamps (stickers vibe), compute `w,h` at placement time from a **desired CSS px** divided by `view.scale`. For **map-like** stamps, use fixed world units; either way, persist `w,h` in the object so reflows don’t change draw size.

---

# Edge cases & policies

* **Read-only/mobile**: Respect the same write guards in `mutate(fn)`; tools should early-exit on begin in those cases. (Your manager has the guards already.)&#x20;
* **Scene ticks**: On scene change, base + overlay do full clears; all objects commit with `scene` at commit moment (your contract). &#x20;
* **Presence**: unchanged; overlay draws it in screen space; text editing doesn’t publish awareness spam.
* **Undo/redo**: Defer to Phase 10; our atomic single-transact commits make it trivial later.

---

# Step-by-step implementation plan (with acceptance criteria)

### 1) Device UI

* [ ] Add `stamps` bucket to Zustand: `{ selected: 'stamp.heart', scale: 1 }` + `setStampSettings`. (Text settings already present.)&#x20;
* ✅ Toolbar buttons already exist; verify they set `activeTool`. &#x20;

**Criteria:** switching tools changes cursor/preview state; state persists via `persist()` as with others.&#x20;

### 2) Rendering layers

* [ ] Implement `drawText(...)` in renderer’s layers. It’s already called by the base loop (no wire-up required).&#x20;
* [ ] Implement `drawShapes(...)` to render stamps (`tool:'stamp'`). Already in base loop.&#x20;

**Criteria:** After fake data is inserted (hardcoded object), it draws, pans/zooms correctly, and base loop culls outside visible bounds.&#x20;

### 3) TextTool

* [ ] Create `TextTool` with the unified pointer surface; on `begin()` compute `worldToClient` and spawn editor; on commit measure and call `room.mutate` to push `Text`.&#x20;
* [ ] Compute `w/h`: measure DOM rect, convert to world units via current scale; store into object for `diffBounds`.

**Criteria:** Click to place, type, press Enter → the editor disappears; the text renders on base canvas; panning/zooming after commit is stable; only a small rect invalidates (watch frame stats/rectCount). &#x20;

### 4) StampTool

* [ ] Create `StampTool`; on click, either (A) commit immediately or (B) preview then commit on release.
* [ ] Mutate into `strokes[]` with `tool:'stamp'`, `stampId`, `x,y,w,h,bbox`, `scene`. (Or a `stamps[]` array if you prefer to split.)

**Criteria:** Click drops a stamp; zoom level at placement doesn’t cause resize surprises (per your chosen size policy); `diffBounds()` invalidates the right region.

### 5) Canvas glue

* [ ] In the tool construction effect, branch for `'text'` and `'stamps'`, set preview provider once (it’s already routed to overlay).&#x20;
* [ ] Keep overlay `pointer-events:none` (already the case).&#x20;

**Criteria:** No React re-render storms; overlay only redraws on preview/presence; base redraws on `docVersion` change (verify via logs—Canvas already checks this).&#x20;

---

# Testing checklist (fast manual QA)

* **Placement** at various zooms: text editor appears exactly under the cursor; stamp size policy behaves as chosen.
* **Dirty rect counts** rise by a small number on commit; presence-only activity doesn’t invalidate base (watch docVersion gate).&#x20;
* **Scene change**: switch scenes → both canvases full-clear; prior text/stamps not drawn.&#x20;
* **Eraser** compatibility: later add text hit-testing to include text ids in the same **single deletion transaction** (your guide already sketches this).&#x20;

---

# Nice-to-have polish (safe to defer)

* **Inline formatting** (bold/italic) → store as Markdown subset or spans; still commit atomically.
* **Text selection handles** in overlay; caret blink (screen-space) while the editor is open.
* **Stamp rotations** (add `rot`), and uniform scale via upcoming Transform tool.

---

If you follow this plan, adding Texts and Stamps is mostly **filling in two tools + two renderer passes**, without touching your carefully-tuned loops, transforms, or snapshot publisher. Everything aligns with the current contracts:

* **View/overlay discipline** (world vs screen)&#x20;
* **Preview provider & one-frame hold**&#x20;
* **Unified tool surface & construction**&#x20;
* **docVersion gating & bbox diff** already wired in Canvas.tsx. &#x20;

