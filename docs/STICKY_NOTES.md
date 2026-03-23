# Sticky Notes — Implementation Documentation

## Status

**Working MVP.** WYSIWYG sticky notes with dual-layer 9-slice Gaussian shadow, DPR-aware cache, width-based dimensional model. Shadow quality is close to Miro.

**Scope:** Every new text object is temporarily created as a sticky note for testing. No SelectTool integration, no device-ui-store changes, no dedicated tool mode.

---

## Architecture

Sticky notes are **text objects with `note: true`** — they reuse the entire text pipeline (Y.XmlFragment, Tiptap editor, TextLayoutCache, three-tier invalidation) but with different positioning, rendering, and BBox semantics.

| Aspect | Regular Text | Sticky Note |
|--------|-------------|-------------|
| `origin` meaning | `[alignmentAnchorX, firstLineBaseline]` | `[topLeftX, topLeftY]` of note body |
| `width` | `'auto' \| number` | Always `number` (NOTE_WIDTH=280) |
| Background | Optional `fillColor` via `fillRect` | Always filled, canvas draws body+shadow |
| Height | Derived from content | `max(width, contentHeight + 2*padding)` — square minimum |
| Shadow | None | 9-slice cached dual-layer Gaussian |
| During editing | Canvas skips entirely | Canvas draws body+shadow, DOM handles text only |

### Key Design Decisions

1. **`kind: 'text'` with `note: true` flag** — avoids new ObjectKind, reuses text pipeline entirely
2. **Canvas draws body during editing** — unlike regular text (where DOM overlay replaces canvas), notes always render their yellow body + shadow on the base canvas. The DOM overlay only handles the text input area inside the padded content region.
3. **Origin = top-left** — simpler than text's anchor+baseline system since notes are always left-aligned, fixed-width rectangles
4. **Width-based visual properties** — shadow pad and corner radius are derived from `noteWidth`, not `fontSize`. Changing font size only affects text layout inside the note; the body, shadow, and corners are stable. Padding remains fontSize-based (content layout concern, not visual appearance).

---

## Y.Map Schema

```typescript
{
  id: string,
  kind: 'text',
  note: true,                     // Distinguishes from regular text
  origin: [number, number],       // [topLeftX, topLeftY] — NOT baseline
  fontSize: number,               // Default from device-ui-store textSize
  fontFamily: FontFamily,         // Default from device-ui-store textFontFamily
  color: '#1a1a1a',              // Dark text on yellow (hardcoded for now)
  align: 'left',                 // Always left (hardcoded for now)
  width: 280,                    // NOTE_WIDTH — fixed, never 'auto'
  fillColor: '#FEF3AC',          // NOTE_FILL_COLOR — warm sticky yellow
  content: Y.XmlFragment,
  ownerId: string,
  createdAt: number
}
```

---

## Dimensional Model

Two categories of note dimensions — **body properties** scale with `noteWidth`, **content properties** scale with `fontSize`:

| Property | Basis | Ratio | At defaults (w=280, fs=20) |
|----------|-------|-------|---------------------------|
| Shadow pad | `noteWidth` | 0.15 | 42wu |
| Corner radius | `noteWidth` | 0.011 | 3.08wu |
| Content padding | `fontSize` | 0.6 | 12wu |
| Content width | derived | `noteWidth - 2*padding` | 256wu |
| Height | derived | `max(noteWidth, contentH + 2*padding)` | 280wu min |

**Why width-based shadow/radius:** The shadow and corner radius are visual properties of the note body — a physical sticky note's shadow doesn't change when you write smaller text on it. Basing them on `noteWidth` ensures the note's appearance is invariant to font size changes. When notes gain resize support, these properties will scale naturally with the note's frame.

**Why fontSize-based padding:** The padding defines the margin between the note edge and the text area. Larger text needs more breathing room, smaller text can sit tighter. This is a content-layout concern, not a visual-appearance concern.

---

## Shadow System — 9-Slice Cache

### Technique

Pre-render shadow once on a DPR-scaled `OffscreenCanvas`, then stretch via 8 `drawImage` calls (9-slice, center skipped). Zero per-frame shadow cost.

### Source Canvas

```
[100px pad][80px rect][100px pad]  = 280px logical
× devicePixelRatio for actual canvas dimensions
```

The canvas is created at `280 * dpr × 280 * dpr` pixels with `ctx.scale(dpr, dpr)`, so all drawing coordinates remain in logical pixels. The cache auto-invalidates when `window.devicePixelRatio` changes (e.g., moving window to a different-DPR monitor).

### Dual-Layer Shadow

Both layers are drawn with opaque `#000` fill, then the body area is punched out with `destination-out`:

| Layer | Purpose | shadowColor | blur | offsetY | σ |
|-------|---------|-------------|------|---------|---|
| Floor | Long bottom tail, 3D lift | `rgba(0,0,0,0.10)` | 34 | 28 | 17 |
| Contact | Soft edge definition | `rgba(0,0,0,0.06)` | 10 | 3 | 5 |

**Why dual-layer:** A single Gaussian can't produce the extreme asymmetry of a real sticky note shadow (minimal top, wide bottom). The floor shadow's large offsetY (28px) pushes it almost entirely below the body rect in the source canvas, creating a long bottom tail while leaving the top nearly invisible. The contact shadow adds soft edge definition on all sides.

**Why opaque fill + punch-out:** Browsers optimize away shadow rendering when `fillStyle` has zero alpha. Using `#000` fill ensures the shadow actually renders. The `destination-out` compositing removes the opaque fill from the body area, leaving only the shadow fringe.

### Punch-Out Expansion

The punch-out rect is expanded by 1px on each side beyond the body rect: `roundRect(padPx - 1, padPx - 1, rectPx + 2, rectPx + 2, radius)`. This eliminates the anti-aliased fringe that would otherwise appear where the shadow edge meets the body fill — the two roundRects (shadow punchout in source canvas vs body fill on main canvas) render at different resolutions and can't perfectly align at sub-pixel level. The 1px expansion clears shadow from under the body's anti-aliased edge, so the body edge blends cleanly with the background instead of with a dark shadow fringe.

### Graduated Side Effect

The 9-slice corner pieces (100×100 logical pixels each) capture the 2D shadow around each corner of the body rect. With offsetY=28:

- **Top corners** capture shadow from a floor shadow rect whose top edge is 28px below the body top — very little shadow reaches these regions
- **Bottom corners** capture shadow from a floor shadow rect whose bottom extends 28px past the body — strong shadow that fans out diagonally

When the 9-slice is drawn, the transition from faint-top-corners → moderate-side-edges → wide-bottom-corners creates a visual graduation along the sides, matching the "paper pinned at top, lifting at bottom" look.

### Shadow Compression

The source canvas has `padPx=100` logical pixels of shadow space. The destination pad at default note width is `280 * 0.15 = 42wu`. The compression ratio is `100 / 42 ≈ 2.4×` at DPR=1, zoom=1. At DPR=2, the destination occupies `42 * 2 = 84` device pixels vs `100 * 2 = 200` source pixels — still 2.4× compression, but the DPR-scaled source provides enough resolution for smooth gradients at any DPR.

### 9-Slice Drawing (`drawNoteShadow`)

8 `drawImage` calls map source corner/edge regions to destination world-coordinate positions. Source coordinates are in device pixels (`padPx * dpr`, `rectPx * dpr`), destination coordinates are in world units. The camera transform on the main canvas handles world→screen mapping. Center slice is skipped (empty after punch-out).

### Cache Headroom

Floor shadow max extent below body: `offsetY + 3σ = 28 + 51 = 79px`. Source pad: 100px. Headroom: 21px (21%). No clipping.

---

## Body Renderer

`renderNoteBody(ctx, x, y, w, h, fillColor)`:

1. `drawNoteShadow(ctx, x, y, w, h)` — 9-slice shadow
2. `roundRect` fill with `fillColor` — corner radius from `getNoteCornerRadius(w)`

No highlight strip — removed to eliminate the anti-aliased edge artifact that a sub-1px rounded rect path creates at the top of the body.

---

## BBox

`computeNoteBBox(objectId, props)` returns body frame + `getNoteShadowPad(noteWidth)` on all sides for dirty rect tracking. The frame cached via `textLayoutCache.setFrame()` is the body rectangle only (no shadow) — used by hit testing, selection overlay, etc.

At default width: BBox extends 42wu beyond the body on all sides. This is conservative (the top shadow is nearly invisible and the side shadow is ~20wu), but the extra BBox padding is harmless for dirty rect purposes.

---

## Files Modified

### `packages/shared/src/accessors/object-accessors.ts`

Added `isNote(y)` accessor:
```typescript
export function isNote(y: Y.Map<unknown>): boolean {
  return y.get('note') === true;
}
```

### `client/src/lib/text/text-system.ts`

~160 lines added. All note-specific code lives here, organized into sections:

#### Constants & Helpers

```typescript
NOTE_WIDTH = 280                  // Default note body width (world units)
NOTE_FILL_COLOR = '#FEF3AC'       // Warm sticky yellow
NOTE_PADDING_RATIO = 0.6          // padding = fontSize * 0.6 → 12wu at fs20
NOTE_CORNER_RADIUS_RATIO = 0.011  // radius = noteWidth * 0.011 → 3.08wu at w280
NOTE_SHADOW_PAD_RATIO = 0.15      // shadow pad = noteWidth * 0.15 → 42wu at w280
```

Exported helpers:
- `getNotePadding(fontSize)` — inner padding between body edge and text area
- `getNoteCornerRadius(noteWidth)` — rounded corner radius for body fill
- `getNoteContentWidth(noteWidth, fontSize)` — text area width (`noteWidth - 2*padding`)
- `computeNoteHeight(layout, fontSize, noteWidth)` — `max(noteWidth, contentHeight + 2*padding)`

Internal helpers:
- `getNoteShadowPad(noteWidth)` — BBox and 9-slice destination pad
- `ensureShadowCache()` — DPR-aware lazy singleton, rebuilds on DPR change
- `drawNoteShadow(ctx, x, y, w, h)` — 8 drawImage calls for 9-slice

#### Shadow Cache Lifecycle

```
ensureShadowCache()
  ├─ check window.devicePixelRatio vs cached dpr → rebuild if changed
  ├─ create OffscreenCanvas at (280 * dpr) × (280 * dpr)
  ├─ ctx.scale(dpr, dpr) → all coords remain logical
  ├─ draw floor shadow (blur=34, offsetY=28, α=0.10)
  ├─ draw contact shadow (blur=10, offsetY=3, α=0.06)
  ├─ punch out body rect (expanded 1px for AA fringe)
  └─ store { canvas, padPx: 100, rectPx: 80, dpr }
```

### `client/src/renderer/layers/objects.ts`

`drawText()` restructured — note dispatch comes **before** the `textEditingId` early-return guard:

```
if (isNote(y)) {
  // Always draw body + shadow (even during editing)
  renderNoteBody(ctx, origin[0], origin[1], noteWidth, noteHeight, fillColor)
  if (textEditingId === id) return  // DOM overlay handles text
  // Draw text inside note at padding offset
  renderTextLayout(ctx, layout, textX, textY, color, align)  // No fillColor arg
  return
}
// Regular text (unchanged)
if (textEditingId === id) return
...
```

Text positioning inside note:
- `textX = origin[0] + padding`
- `textY = origin[1] + padding + fontSize * baselineToTopRatio` (first line baseline)
- No `fillColor` passed to `renderTextLayout` — the note body already provides the background

### `client/src/lib/tools/TextTool.ts`

#### `createTextObject()`

Temporarily creates ALL new text objects as sticky notes:
- Sets `note: true`, `width: NOTE_WIDTH`, `fillColor: NOTE_FILL_COLOR`
- Hardcodes `color: '#1a1a1a'`, `align: 'left'`
- Reads `fontSize` and `fontFamily` from device-ui-store

#### `mountEditor()` — note branch

Added between `isLabel` and regular text branches:
```typescript
const isNoteObj = !isLabel && isNote(handle.y);
```

Note positioning: DOM overlay placed at `origin + padding` (top-left of text area within note body). Width set to `contentWidth * scale`. No CSS `translateX/Y` transforms needed (origin is top-left, not anchor+baseline). `data-width-mode='note'` triggers note CSS. No `backgroundColor` — canvas draws the body underneath.

#### `positionEditor()` — note branch

Same padding-offset logic as `mountEditor`. Reads fresh from Y.Map on every call (pan/zoom, property changes).

#### `syncProps()` — fillColor guard

Notes skip the `fillColor → backgroundColor` sync (canvas handles the note body fill):
```typescript
if (keys.has('fillColor') && !isNote(handle.y))
  this.container.style.backgroundColor = getFillColor(handle.y) ?? '';
```

### `client/src/lib/room-doc-manager.ts`

Both BBox computation call sites (steady-state deep observer ~line 1048, hydration ~line 1149) dispatch to `computeNoteBBox` when `isNote(yObj)`:
```typescript
newBBox = isNote(yObj) ? computeNoteBBox(id, props) : computeTextBBox(id, props);
```

### `client/src/index.css`

```css
.tiptap[data-width-mode='note'] {
  overflow: visible;
  text-align: left;
}
.tiptap[data-width-mode='note'] p {
  margin: 0;
}
.tiptap[data-width-mode='note'] .is-editor-empty:first-child::before {
  display: none;
}
```

- `overflow: visible` — no clipping, note body grows to match content
- `text-align: left` — explicit override
- `p { margin: 0 }` — prevents ProseMirror paragraph margins from breaking WYSIWYG parity
- Placeholder hidden (empty notes get deleted on close)

---

## Shadow Iteration History

| Version | Technique | Result |
|---------|-----------|--------|
| v1 | Transparent fill (`rgba(0,0,0,0)`) + dual shadow | Shadow invisible — browsers skip shadow for zero-alpha fill |
| v2 | Opaque fill + dual (ambient blur=24 + contact blur=6) | Contact shadow (σ=3, 24% opacity) created hard dark edge at body boundary |
| v3 | Opaque fill + single Gaussian (blur=35, offset=12) | Too symmetric — sides 4x too wide, top 10x too visible, bottom too short |
| v4 | Opaque fill + dual floor/contact (blur=30/8, offset=25/2, α=0.06/0.05) | Close to Miro, but shadow pad was fontSize-based (compressed Gaussian ~3x), faint AA fringe at body edge from highlight strip + punchout alignment |
| v5 | Width-based pad, DPR-scaled cache, expanded punchout, highlight strip removed | Current. Floor blur=34, offset=28, α=0.10. Contact blur=10, offset=3, α=0.06. Source 280×280 logical (padPx=100, rectPx=80). Destination pad = noteWidth * 0.15 = 42wu. Compression ~2.4× at DPR=1. Clean body edge, no fringe. |

### Key v5 Fixes

**fontSize → width-based shadow:** Shadow pad and corner radius are now derived from `noteWidth`, not `fontSize`. Previously, changing font size from 20→10 would halve the shadow pad from 30→15wu, visually shrinking and compressing the shadow despite the note body staying the same size.

**Compression reduction:** v4 had padPx=80 mapping to `fontSize * 1.5 = 30wu` (compression 2.67×). v5 has padPx=100 mapping to `noteWidth * 0.15 = 42wu` (compression 2.38×). The Gaussian gradients are softer and wider at the same shadow parameters.

**DPR-aware cache:** OffscreenCanvas dimensions scaled by `devicePixelRatio`, auto-invalidated on DPR change. At DPR=2 the source has 4× the pixels, preventing blurry shadow at high zoom.

**Punchout expansion:** 1px expansion eliminates the anti-aliased fringe between shadow and body that occurred because the source-canvas punchout and the main-canvas body fill have different anti-aliasing at different resolutions.

**Highlight strip removed:** The sub-1px `roundRect` path for the highlight strip created an anti-aliased edge artifact that read as a faint border at the top of the note.

---

## Tool Infrastructure (Post-MVP)

Sticky notes are now a separate tool mode in the toolbar, independent from the text tool.

### Device UI Store

`'note'` added to the `Tool` union type. Maps to the same `textTool` singleton in `tool-registry.ts` (same pattern as `'pen'`/`'highlighter'`/`'shape'` all mapping to `drawingTool`). `TextTool.createTextObject()` reads `activeTool` at creation time to decide note vs regular text.

Separate persisted settings for notes (independent from text defaults):
- `noteSize: number` (default 20)
- `noteAlign: TextAlign` (default `'left'`)
- `noteFontFamily: FontFamily` (default `'Grandstander'`)

### Toolbar & Keyboard

- **Icon:** `IconStickyNote` — Mural Lottie transforms resolved to `fillRule="evenodd"` compound path (body with folded bottom-right corner + two text-line cutouts) + separate fold triangle path. `viewBox="0 0 24 24"`.
- **Placement:** 3rd button — after Pan, before Pen (after the navigation divider).
- **Keybinding:** `N` switches to note tool.
- **Cursor:** `'text'` cursor (same as text tool) via `computeBaseCursor`.
- **Inspector:** Shows for `'note'` tool (colors visible, sizes empty like text).

### Empty Note Behavior

Empty sticky notes are **not deleted** on editor close (unlike regular text objects). An empty note is a valid visual element — the yellow body + shadow render regardless of content.

### Text-System Reorganization

Note rendering code (shadow cache, `drawNoteShadow`, `renderNoteBody`, `computeNoteBBox`) moved from the top of `text-system.ts` to §7 (Output section), adjacent to `renderShapeLabel` and `computeTextBBox`. Constants and exported helpers (`NOTE_WIDTH`, `NOTE_FILL_COLOR`, `getNotePadding`, etc.) remain at the top with other configuration.

---

## NOT Implemented Yet

- **SelectTool integration** — no transform/scale/translate behavior for notes
- **Clipboard support** — `isNote` flag not serialized/deserialized in clipboard-serializer
- **Context menu** — no note-specific options (fill color change, etc.)
- **Connector anchoring** — notes don't participate as connector endpoints
- **Note resize** — no drag-to-resize on note edges
- **Multiple note colors** — only `#FEF3AC` (warm yellow) currently
- **Separate ObjectKind** — notes are currently `kind: 'text'` with a flag; future: `kind: 'note'`
