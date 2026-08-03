# Text System Documentation

**Status:** WYSIWYG complete — auto + fixed-width modes verified

> **Maintenance note:** System-level overview for Claude agents. When updating, match surrounding detail — don't inflate coverage of specific changes.

## Overview

WYSIWYG rich text: **DOM overlay editing** (Tiptap/ProseMirror) + **canvas rendering** (custom layout engine). Three text-bearing object types: text objects, shape labels, sticky notes.

- **Editing:** Tiptap editor (lazy chunk — loaded on text/note tool select; see Lazy Mount) in absolute-positioned div, synced to Y.XmlFragment via TextCollaboration extension
- **Rendering:** Canvas layout engine (tokenizer → measurement → flow) matching CSS `pre-wrap` + `break-word`
- **Positioning:** Measured font metrics (`fontBoundingBox*`) ensure DOM ↔ canvas baseline alignment
- **Collaboration:** Y.XmlFragment CRDT, two-tier UndoManager (per-session + room-level atomic session merging)
- **WYSIWYG parity:** Same font/weight, same line-height (`fontSize * 1.3`), same baseline positioning via `getBaselineToTopRatio()` (CSS half-leading formula), identical whitespace semantics. 

## Files

| File | Purpose |
|------|---------|
| `core/text/text-system.ts` | Layout engine, three-tier cache, text renderer, text BBox |
| `core/text/line-break.ts` | UAX #14 soft-break machinery (`nextSoftBreak`, `isBreakOpportunity`) — pure char-code logic, leaf module |
| `core/text/text-measure.ts` | Measure context, font-string builders, measured font metrics, measurement caches — shared boundary (code-system, bookmark-render, transform, TextTool, sticky-note) |
| `core/text/shape-label.ts` | Shape-label text box (`computeLabelTextBox` — writes a shared scratch) + `renderShapeLabel` + `layoutIntoLabelScratch` |
| `core/text/sticky-note.ts` | Note constants/geometry, auto-font-size pipeline (`layoutNoteContent`, `getNoteLayout`, `getNoteDerivedFontSize`), single-entry shadow cache, `drawStickyNote`, `computeNoteBBox` |
| `core/text/extensions.ts` | TextCollaboration: per-session UndoManager, Y.Map observer, session merging, lazy ySync-origin registration. Lives in the lazy editor chunk (sole importer is `tiptap-editor.ts`) |
| `core/text/tiptap-loader.ts` | **Eager** — cached `loadTiptapEditor()`/`loadTiptapBase()` (only dynamic `import()`s, zero `@tiptap` value import) + tool-select preload subscription |
| `core/text/tiptap-editor.ts` | **Lazy** editor chunk — `import './tiptap.css'` + re-exported `Editor` + `buildTextExtensions()` (Placeholder + base defs + TextCollaboration) |
| `core/text/tiptap-base.ts` | **Lazy** shared chunk — `generateJSON` + 6 base extension re-exports (pm-model only; shared by the editor and the clipboard's external-HTML paste) |
| `core/text/tiptap.css` | `.tiptap*` rules — ship with the editor chunk (relocated from the eager `index.css`) |
| `core/text/font-config.ts` | `FONT_WEIGHTS` (450/700), `FONT_FAMILIES` (4 families, all 1.3x line-height) |
| `core/text/font-loader.ts` | `ensureFontsLoaded()` / `areFontsLoaded()` |
| `tools/TextTool.ts` | Editor mounting (async six-phase lazy mount), positioning, lifecycle — 3-way branch (text/label/note) |

**Fonts:** Grandstander, Inter, Lora, JetBrains Mono. All variable `wght 450-700`, Latin subset, ligatures (`liga`/`calt`/`dlig`) stripped at font level (canvas has no `font-variant-ligatures: none` — stripping is the only cross-browser WYSIWYG fix).

---

## Y.Doc Schemas

### Text Object

```typescript
{
  id, kind: 'text',
  origin: [anchorX, baseline],       // [0] = alignment anchor, [1] = first line baseline
  fontSize, fontFamily, color,
  align: 'left' | 'center' | 'right',
  width: 'auto' | number,            // 'auto' = max-content, number = fixed wrapping width
  fillColor?: string,                 // Optional background fill
  content: Y.XmlFragment,
  ownerId, createdAt
}
// No stored frame. Derived via computeTextBBox(), read via getTextFrame(id).
```

**Origin semantics:** `origin[0]` shifts with alignment (left=left edge, center=center, right=right edge). Alignment changes recompute `origin[0]` to preserve left edge: `newOriginX = leftX + anchorFactor(newAlign) * W`.

**Y.XmlFragment structure:**
```
Y.XmlFragment
├── Y.XmlElement('paragraph')
│   └── Y.XmlText (delta: [{ insert: 'Hello ', attributes: { bold: true } }, ...])
└── ...
```

### Shape Label (fields on shape Y.Map)

Labels are NOT separate objects — they add fields to the shape:

```typescript
{
  content: Y.XmlFragment,
  fontSize, fontFamily,
  labelColor: string,                 // Separate from shape border color
  align?: TextAlign,                  // Default 'center'
  alignV?: TextAlignV,               // Default 'middle'
}
```

No `origin` or `width` — width derived from shape frame. `hasLabel(y)` = `y.get('content') instanceof Y.XmlFragment`. Fields deleted if label empty on editor close.

### Sticky Note

```typescript
{
  id, kind: 'note',
  origin: [topLeftX, topLeftY],       // Always top-left (NOT shifted by alignment)
  scale: number,                       // Default 1 — uniform scale for entire note
  fontFamily, align, alignV,
  fillColor: string,                   // Default '#FEF3AC'
  content: Y.XmlFragment,
  ownerId, createdAt
}
// No fontSize (derived), no width (= NOTE_WIDTH * scale), no color (contrast-derived from fillColor via getStickyNoteTextColor).
```

See **Sticky Notes** section for full details.

---

## Text System Pipeline (`text-system.ts`)

```
Y.XmlFragment
    ↓ parseAndTokenize(fragment, out?)
TokenizedContent (SOA: paragraphTokenStart, tokenSegStart, tokenKind, segText, segBold, segItalic, segHighlight, segSpaceMode)
    ↓ measureTokenizedContent(tokenized, fontSize, fontFamily, out?)
MeasuredContent (SOA: + tokenAdvanceWidth, segFont, segAdvanceWidth; lineHeight, fontFamily)
    ↓ layoutMeasuredContent(measured, width, fontSize, out?)   ← exported
TextLayout (SOA: lineRunStart, lineAdvanceWidth, lineAlignmentWidth, lineBaselineY, runText, runFont,
            runHighlight, runAdvanceWidth, runAdvanceX; fontSize, fontFamily, lineHeight, widthMode, boxWidth)
```

All three stages are **parallel-array (SOA) buffers**: `out?` parameters let callers reuse a buffer across re-tokenize / re-measure / re-flow. Capacities double on grow; counts reset between calls. Renderers iterate via `for (let li=0; li<lineCount; li++) { for (let r=lineRunStart[li]; r<lineRunStart[li+1]; r++) ... }`. Per-line / per-run object allocations are eliminated entirely after the first call.

Primary API: `textLayoutCache.getLayout()` (auto-wires per-id buffers). `layoutMeasuredContent()` is exported for reflow during E/W transforms; the `out` param lets the transform's `Entry<'text'>.out.layout` be reused per pointermove. `layoutIntoLabelScratch()` (in `shape-label.ts`) writes into a single module-level scratch shared across all labeled shapes per frame.

### Font Metrics

Per-family, measured from canvas `fontBoundingBoxAscent/Descent` (not hardcoded). Live in `text-measure.ts` alongside the measure context and font-string builders:

| Function | Returns |
|----------|---------|
| `getBaselineToTopRatio(ff?)` | CSS half-leading: `((lineHeight - contentArea) / 2 + ascent) / fontSize` |
| `getMeasuredAscentRatio(ff?)` | `fontBoundingBoxAscent / fontSize` (fallback 0.8) |
| `getMinCharWidth(fs, ff?)` | Bold 'W' width — reflow minimum clamp |
| `buildFontString(bold, italic, fs, ff?)` | `"italic 700 20px \"Inter\", sans-serif"` |
| `resetFontMetrics()` | Clear all caches (call after font load) |

### Stage 1: Tokenizer

Walks Y.XmlFragment → paragraphs → delta ops → regex split `/(\s+|\S+)/g` into word/space tokens. Adjacent same-styled segments coalesce via string concat. Tracks `UniformStyles` (allBold/allItalic/uniformHighlight) in same loop — used by context menu for active state when editor isn't mounted.

Highlight extraction: `attrs.highlight` with `{ color: '#hex' }` → that color; presence without color → default `'#ffd43b'`. Highlight is rendering-only — `highlight` field threads through tokenizer → measurement → flow engine coalesce → renderer, but has zero impact on width calculation.

### Stage 2: Measurement

Canvas `measureText()` via singleton offscreen canvas. The measure context, font-string builders, and the caches below all live in `text-measure.ts` (shared measurement boundary — no dependency on text-system):
- `MEASURE_BY_FONT: Map<font, Map<text, width>>` — two-level cache, no concat-key allocation per call. Soft-cap at 200k entries (clears on overflow).
- `SPACE_WIDTH_CACHE` — per-font space char width.
- `CHAR_ENDS_CACHE: Map<text, Uint32Array>` — grapheme end-offsets (font-independent). Powers `sliceTextToFit`'s grapheme-aligned binary search.

All cleared on `textLayoutCache.clear()` via `clearMeasurementCaches()`. Per-token measure pre-builds the four (bold × italic) font strings once via exported `buildFontMatrix(fontSize, fontFamily)` and indexes via `fontFromMatrix(F, bold, italic)` — eliminates O(segments) `buildFontString` calls; sticky-note's Phase B reuses both helpers when projecting 100px measurements onto the derived font size. Each whitespace segment carries a `segSpaceMode` flag (1=all-ASCII-space → fast `getSpaceWidth × len`, 2=mixed-WS → falls through to `measureTextCached`). Token kind for word vs whitespace dispatch in the flow engine reads `tokenKind[ti]` directly — no per-segment whitespace flag is stored.

### Stage 3: Flow Engine

Two modes: **auto** (`maxWidth = Infinity`, no wrapping) and **fixed** (wraps at width). Implements CSS `pre-wrap` + `break-word`.

**Pending whitespace state machine:** Leading WS (no ink on line) commits immediately and can overflow. Inter-word WS in fixed mode is *buffered* as pending. On next word: if `current + pending + word <= maxWidth`, commit pending + place word; else push line (pending WS kept for highlight rendering but excluded from `alignmentWidth`), word starts new line.

**Paragraph end:** Trailing WS is content (not hanging), so `alignmentWidth = min(advanceWidth, maxWidth)`.

**Word placement — two decision systems:** `placeWord` drives a per-sub-segment Q1/Q2/Q3 ladder over UAX#14 break opportunities within each style segment of a word. Mirrors CSS's layered pipeline:
- **Q1** — chunk fits current line as-is. Always allowed.
- **Q2** — UAX#14 soft break: place atomic on a fresh line. Gated by `canSoftBreak` so style-only seams (a bold/highlight boundary inside an otherwise unbroken AL run) don't behave as break opportunities.
- **Q3** — `overflow-wrap: break-word` char-slice via `sliceTextToFit`. Operates *exactly where* UAX#14 forbids a break, so NOT gated by `canSoftBreak`. Pre-emptive `pushLine` fires only when truly oversized (`chunkW > maxWidth`) at a real break op (matches DOM: oversized words start fresh); non-break seams fall straight into the slice loop and char-fill the remaining line space.
- **Slice-loop guards** — (a) `lineRemaining ≤ 0` on a non-empty line → wrap before slicing (otherwise the slicer's forward-progress strands a grapheme on a full line, overflow); (b) slicer hands back a grapheme wider than available width on a non-empty line → wrap and retry on the fresh line. Both no-op on an empty line — a single oversized grapheme is appended unavoidably.

Style seams are classified via `isBreakOpportunity(prevCharCode, currCharCode)` (`line-break.ts`) between the previous segment's last char and the current segment's first char. Within a segment after the first chunk, `cursor > 0` implies a real break op (it's what `nextSoftBreak` just returned). `noteFlowCheck` (sticky-note search predicate) mirrors the same ladder.

**Oversized words — slicer mechanics:** `sliceTextToFit(font, text, maxW, start?, endChar?)` and `nextSoftBreak(text, start?)` accept a cursor offset, so the char-break loop walks a segment without per-iteration `text.substring(cursor)` allocation. The slicer reads grapheme boundaries from `CHAR_ENDS_CACHE` (font-independent) and probes each binary-search candidate via `measureTextCached(font, text.substring(start, charEnds[mid]))` — direct shaping captures kerning exactly, so each broken line's width matches what the DOM would render for that line shaped independently. (The previous per-grapheme cumulative-widths approach summed individual char advances, missing cumulative kerning and evicting trailing chars near the line edge.) Fast path: if `[start..endChar]` fits as a whole, returns in one measureText call. Forward-progress: >=1 grapheme advances from `start` per slice.

**Run coalescing:** Adjacent runs with identical font+highlight merge via string concat.

### Layout Output Types (SOA)

```typescript
interface TextLayout {
  fontSize: number; fontFamily: FontFamily; lineHeight: number;
  widthMode: 'auto' | 'fixed'; boxWidth: number;

  lineCount: number; lineCap: number;
  lineRunStart: Uint32Array;       // [lineCap+1] — runs of line i are [lineRunStart[i], lineRunStart[i+1])
  lineAdvanceWidth: Float64Array;  // total incl. trailing whitespace
  lineAlignmentWidth: Float64Array; // wrap-break → visualWidth; paragraph-end → min(advance,max)
  lineBaselineY: Float64Array;     // i * lineHeight, cached for hot read

  runCount: number; runCap: number;
  runText: string[];               // grow but never shrink; slots overwritten in-place
  runFont: string[];
  runHighlight: (string | null)[];
  runAdvanceWidth: Float64Array;
  runAdvanceX: Float64Array;
}
```

`createTextLayout()` allocates an empty buffer with default capacities; `resetTextLayout(l)` zeros counts (preserves capacity). `layoutMeasuredContent(content, width, fontSize, out?)` writes into `out` if provided. Layout coalescing (adjacent runs with identical font+highlight merge via `runText[r] += text`) and the pending-WS state machine are unchanged.

---

## TextLayoutCache (singleton)

Three-tier cache: content → measurement → flow.

```typescript
textLayoutCache.getLayout(id, fragment, fontSize, fontFamily?, width?)
  // Hit order:
  //   same content + fontSize + fontFamily + width -> cached layout
  //   same content + fontSize + fontFamily, diff width -> reflow only
  //   same content, diff fontSize/fontFamily -> re-measure + reflow
  //   stale -> full pipeline
  // Width/fontFamily changes detected by inline comparison — no explicit invalidation needed.

textLayoutCache.invalidateContent(id, fragment?)
  // fragment provided -> eager re-tokenize (critical for shape labels — context menu
  // queries getInlineStyles() before getLayout() runs)
  // fragment omitted -> lazy re-parse on next getLayout()
  // Both null measuredFontSize + frame -> forces re-measure + BBox recompute

textLayoutCache.invalidateLayout(id)     // fontSize changed -> forces re-measure
textLayoutCache.invalidateFlow(id)       // width changed -> forces reflow
textLayoutCache.remove(id) / clear()     // Deletion / full rebuild (clear also clears LRUs)

textLayoutCache.setFrame(id, frame)      // Derived frame (set by computeTextBBox/computeNoteBBox)
textLayoutCache.getFrame(id)             // Read derived frame
textLayoutCache.getMeasuredContent(id)   // For E/W reflow (skips tokenize + measure)
textLayoutCache.getInlineStyles(id)      // UniformStyles from cached tokenized content

// Note bridge — narrow, allocation-free accessors. `noteDerivedFontSize` lives on
// CacheEntry so `invalidateContent` nulls it.
textLayoutCache.noteCachedTokenized(id)         // → TokenizedContent | null
textLayoutCache.noteCachedMeasured(id)          // → MeasuredContent | null
textLayoutCache.noteCachedFontFamily(id)        // → FontFamily | null
textLayoutCache.noteCachedDerivedFontSize(id)   // → number | null
textLayoutCache.noteCachedLayout(id)            // → TextLayout | null
textLayoutCache.setNoteResults(id, tokenized, measured, fontFamily, derivedFontSize, layout)
```

Note-level orchestration (`getNoteLayout`, `getNoteDerivedFontSize`) lives in `sticky-note.ts` — it reads/writes via the field accessors above. The previous `NoteCacheSnapshot` wrapper has been removed; readers now poll fields directly without per-call object allocation.

---

## Renderers, BBox & Helpers

### `renderTextLayout(ctx, layout, originX, originY, color, align?, fillColor?)`

Pass 0: fillRect background (if fillColor). Per line: compute `startX` via `anchorFactor(align)` + `getLineStartX()`. Pass 1: highlight roundRects (radius `fontSize * 0.25`; fixed mode clamps to container). Pass 2: fillText, `textBaseline = 'alphabetic'`. Fixed mode uses `alignmentWidth` for line width; auto uses `advanceWidth`.

### `renderShapeLabel(ctx, layout, textBox, color, fontFamily, align?, alignV?)` — `shape-label.ts`

H+V alignment within text box. Vertical via `getNoteContentOffsetY()`. Overflow clips via `ctx.clip()`.

### Alignment Helpers

```typescript
anchorFactor(align)   // left=0, center=0.5, right=1
getLineStartX(originX, boxWidth, lineW, align)
  // left: boxLeftX, center: boxLeftX+(boxWidth-lineW)/2, right: boxLeftX+(boxWidth-lineW)
computeLabelTextBox(shapeType, frame)   // shape-label.ts — writes + returns a shared module scratch
  // Max inscribed rect inset by LABEL_PADDING=8 (exported — convert-kind.ts's frame inversion reuses it).
  // ellipse: (a/sqrt2)x2 x (b/sqrt2)x2 centered; diamond: w/2 x h/2 centered; rect: simple inset
```

### BBox + Derived Frame

```typescript
computeTextBBox(id, props)   // Derives frame from layout, caches, returns frame + 2px vert pad
                              // + horizontal italic-overhang pad (getItalicOverhangPad(fontSize) —
                              // fontSize × Inter-bold-W ratio × 0.45, floored at 2; family-agnostic
                              // upper bound so swapping fonts can't escape the dirty rect)
computeNoteBBox(id, props)   // Square frame, caches, returns frame + shadow pad
getTextFrame(id)             // Reads cached frame — used for BOTH text AND note objects
getInlineStyles(id)          // UniformStyles from cached tokenized content
```

Frame consumer pattern: `handle.kind === 'text' || 'note' ? getTextFrame(handle.id) : getFrame(handle.y)`. Used by hit-testing, connectors, eraser, selection-overlay, SelectTool, bounds.

---

## Undo/Redo Architecture

### Two-Tier System

**Per-session** (TextCollaboration extension): Created on editor mount. Scope: `[Y.XmlFragment, Y.Map]` — tracks content edits AND property changes (fontSize, color, align, etc.). Origins: `{ySyncPluginKey, userId}`. Cmd+Z while editing can undo font changes made via context menu.

**Main** (RoomDocManager): Tracks all objects map changes. Origins: `{userId}` at room-connect; `ySyncPluginKey` is added **lazily** by `TextCollaboration.onCreate` (first editor mount) and never removed — text content edits use that origin and must be room-level undoable, but no ySync transactions exist before the first edit, so deferring the registration is behaviorally identical and keeps `@tiptap/y-tiptap` out of the eager bundle.

### Session Merging

Extension manipulates main UndoManager on lifecycle:
```
onCreate():   mainUM.addTrackedOrigin(ySyncPluginKey) + stopCapturing() + captureTimeout = 600_000  -> register origin (1st mount) + new group
onDestroy():  mainUM.stopCapturing() + captureTimeout = 500                                          -> seal group, restore
```
Effect: Room-level Cmd+Z undoes entire editing session atomically.

**Cursor fix:** yUndoPlugin stores cursors as buggy Y.js RelativePositions. `selectionFixPlugin` stores raw ProseMirror positions on stack items, corrects selection after undo/redo via `applyPendingSelection()`.

### Y.Map Observer

Extension observes Y.Map keys: `origin`, `fontSize`, `fontFamily`, `color`, `fillColor`, `align`, `alignV`, `width`, `scale`, `labelColor`, `frame`, `shapeType`. On per-session undo/redo of property changes -> `TextTool.syncProps()` updates DOM overlay.

### Why Custom Extension

Official `@tiptap/extension-collaboration` captures `_observers` on destroy, preventing GC of detached EditorView DOM trees (linear leak in short-lived editors). This extension registers plugins directly without suspend/restore.

---

## TextTool (`TextTool.ts`)

### Three-Way Branching

Mode determined inline from `handle.kind` at every call site — no stored flag:

| Check | Mode | Position basis | Width source | Color field |
|-------|------|---------------|-------------|-------------|
| `kind === 'shape'` | Label | Shape textBox | textBox width | `labelColor` |
| `kind === 'note'` | Note | origin + padding + alignment | contentWidth | derived: `getStickyNoteTextColor(fill)` |
| else | Text | origin (anchor + baseline) | `width` field | `color` |

### Lifecycle

```
begin() -> hit test (hitTestVisibleNote for note tool, hitTestVisibleText otherwise)
end()   -> hitTextId ? mountEditor(hitTextId) : createTextObject -> mountEditor(id)
```

SelectTool enters editing via `textTool.startEditing(id)` — two-click state machine: click 1 on unselected text → `setSelection([id])`. Click 2 on sole-selected text → `startEditing()`. Double-click works naturally (no timer). Multi-selection drill-down: click 1 drills to single, click 2 mounts.

**Access:** `textTool` exported directly from `tool-registry.ts`. Public fields: `objectId`, `isEditorMounted()`, `getEditor()`, `getContainer()`, `onEditingKindChanged()` (editor re-skin after in-place kind conversion).

### SelectTool Guards During Editing

SelectTool reads `store.textEditingId`:
- Handle hit testing and hover cursors skipped — no scale gestures while editing
- Visual handles hidden in `getPreview()`
- `onViewChange()` forwarded to `textTool.onViewChange()` for DOM repositioning on zoom/pan
- Exception: `isEditingLabel()` allows handle hit-testing/rendering during label editing (label containers don't occlude handles)

### Lazy Mount (async, atomic — mirrors CodeTool)

Tiptap is a lazy chunk (`tiptap-editor.ts`, fetched via `tiptap-loader.ts`'s cached `loadTiptapEditor()`; warmed by a `tool.active → 'text'|'note'` preload subscription). `mountEditor(objectId, isNew)` is therefore **async**, six-phase:

1. **Pre-await:** resolve host + handle; capture the click world point (callers run `resetGesture()` during the await, nulling `downWorld`); defensively `commitAndClose()` any open editor; set `pendingMountId = objectId`.
2. **Await** `loadTiptapEditor()` (cached — instant once warm/preloaded).
3. **Race fence:** bail if `pendingMountId` changed (a newer edit/create superseded this one) or the object was deleted / changed to a non-editable kind during the wait.
4. **Build off-DOM:** `container` + `applyEditorSkin()` (skin statics only) + `new Editor({ extensions: buildTextExtensions({ isLabel, fragment, yObj, userId, mainUndoManager, onPropsSync }) })` (both from the awaited chunk).
5. **Atomic swap** (one synchronous tick, no paint between): `appendChild` → store refs → `pendingMountId = null` → `positionEditor()` → `beginTextEditing(id)` → `invalidateOverlay()` + `invalidateWorldAll()`.
6. **Post-swap:** cursor placement maps the world click through a **live** `worldToClient` inside a rAF (camera may have moved during the import); then `setupEditorHandlers()`.

**Timing contract (no glyph flicker):** `beginTextEditing` + invalidations are deferred from the callers (`end`/`endPlace`/`startEditing`) into the swap. Through phases 2–4 `textEditingId` stays unset, so the canvas keeps painting the real glyphs across the whole import window; it stops only in the same tick the positioned DOM editor appears — one frame, no gap.

**Race-window defenses:** `pendingMountId` (set pre-await, cleared in the swap and in `commitAndClose`'s `finally`) is the re-entrancy fence — first mount to reach the swap wins, others bail at phase 3. `deleteIfEmptyCreated(id)` cleans up an object a NEW mount created before the await but never edited (shape → drop the 6 label fields; text → delete; note → keep — reuses `commitAndClose`'s empty policy). `positionEditor()` is the **single geometry authority** (swap calls it once, then every `onViewChange`); mount no longer duplicates positioning.

### Per-Mode Geometry (applyEditorSkin + positionEditor)

`applyEditorSkin()` sets per-kind skin statics (`data-width-mode`, `--text-color`, text-mode `applyAlignCSS` + background fill) — shared with `onEditingKindChanged`. `positionEditor()` owns all geometry (left/top/dims/fontSize/anchors):

**Text:** Position at `origin[0], origin[1] - fontSize * baselineToTopRatio`. Width: fixed -> explicit px, auto -> CSS `max-content`. `data-width-mode='auto'|'fixed'`.

**Label:** Position within `computeLabelTextBox()`. Anchored at `tbx + anchorFactor(align) * tbw` / `tby + vFactor * tbh`. Uses `maxWidth`/`maxHeight`. `data-width-mode='label'`. No backgroundColor, no Placeholder.

**Note:** Position at `origin + padding + anchorFactor(align) * contentWidth`. Vertical uses CSS `clamp()` for clamped centering. `fontSize = derivedFontSize * noteScale`. Uses `maxWidth`/`maxHeight`. `data-width-mode='note'`. No backgroundColor. See Sticky Notes for detail.

### syncProps (Y.Map -> DOM on undo/redo)

- **Kind bail:** `keys.has('kind')` -> return. A cross-kind conversion fires this extension observer BEFORE the deep observer mutates `handle.kind`, so every branch below would dispatch on the stale kind; the authoritative re-skin runs via `onEditingKindChanged()` after.
- **Text:** `color` -> CSS var; `fillColor` -> backgroundColor; `align` -> CSS vars; spatial props -> `positionEditor()`
- **Label:** `labelColor` -> `--text-color`; `frame/shapeType/fontSize/fontFamily/align/alignV` -> `positionEditor()`
- **Note:** `fontFamily` -> eagerly calls `getNoteLayout()` before `positionEditor()` (ensures correct derivedFontSize); `align/alignV/origin/scale` -> `positionEditor()`. Skips fillColor and applyAlignCSS (needs full repositioning).

### onEditingKindChanged (cross-kind conversion while editing)

Public; called by `selection-store.onObjectsKindChanged` when the edited object's kind flips in place (`tools/selection/convert-kind.ts`) — AFTER the deep observer rebuilt caches and the `handle.kind` mirror. Resets cross-mode residue (`width`/`maxWidth`/`maxHeight`/`backgroundColor`/`--text-anchor-ty`), re-applies mount-time statics for the new kind (`data-width-mode`, `--text-color`, text-mode `applyAlignCSS` + background fill), then `positionEditor()` + `invalidateOverlay()`. Idempotent, reads fresh state, no memo field. The editor, fragment binding, caret, and undo session all survive — same Y.XmlFragment instance, no remount.

### commitAndClose

- Empty labels: delete label fields, shape persists
- Empty text: delete entire object
- Empty notes: preserved (valid visual elements)
- `(editor as any).editorState = null` — Tiptap doesn't null this; release EditorState + plugin states
- Clears `pendingMountId` in the `finally` — any in-flight async mount then bails at its phase-3 fence (mirrors CodeTool)

**Re-entrancy guard (`closing` flag).** Empty-text deletion via `transact(getObjects().delete(...))` fires the deep observer synchronously → `selection-store.onObjectsDeleted` → recursive `textTool.commitAndClose()`. Without the guard, the inner call destroys the editor + nulls fields, outer's `editor.destroy()` throws on null, the click-outside handler exits before its `e.stopPropagation()` runs, and the same pointerdown spawns a fresh text object via the canvas handler. Outer owns teardown; inner is a no-op. The standalone observer-driven path (remote peer deletes my edited text) is a single call — guard lets it through.

**ProseMirror DOMObserver selectionchange leak.** PM's `DOMObserver.start/stop` is reference-counted; our `onTransaction → syncInlineStylesToStore` re-enters start/stop overlapping a mid-flight selection, leaving one `start` unmatched per editor lifetime. `editor.destroy()`'s final `stop()` removes only one listener; the orphan keeps `document → bound onSelectionChange → DOMObserver → view → view.dom` alive — ~0.5 kB detached `.tiptap` tree per close, linear accumulation. Snapshot `view.domObserver.onSelectionChange` BEFORE `editor.destroy()`, force-remove after. No-op when PM cleaned up correctly. Verify with `getEventListeners(document).selectionchange?.length` in DevTools — bounded across cycles (1 when an editor is mounted or transient, not N after N closes).

### Click-Outside

`pointerdown` on document (capture phase, 100ms delayed registration — delay prevents catching the opening click). Uses `pointerdown` not `mousedown` because CanvasRuntime's `preventDefault()` suppresses compatibility mousedown per spec.

After `commitAndClose()`, `e.stopPropagation()` fires **only when `activeTool === 'text'|'note'` AND target is canvas** — prevents creating a new text/note object on click-off. When SelectTool is active (e.g., label editing), the event intentionally propagates so the clicked object gets selected normally in one click. The stopPropagation is load-bearing: anything throwing inside `commitAndClose()` exits the handler before it runs, and the same pointerdown spawns a new editor through the canvas handler (see commitAndClose §Re-entrancy guard for the concrete bug this prevented).

### Remount Prevention

`justClosedLabelId` set for shapes AND notes on `commitAndClose()`. Prevents the immediate remount cycle: pointerdown on shape body while editing label → `commitAndClose()` fires → event propagates → SelectTool's `end()` sees same shape hit → would call `startEditing()` again. SelectTool checks and consumes this flag before calling `startEditing()`, breaking the loop.

---

## CSS Architecture

The `.tiptap*` rules live in `core/text/tiptap.css`, imported by `tiptap-editor.ts` so they ship with the **lazy editor chunk** (relocated from the eager global `index.css`). FOUC-safe: Vite's dynamic-import preload helper inserts + awaits the chunk's `<style>` before `import()` resolves, and the `.tiptap` node is built off-DOM and appended only in the atomic swap (see Lazy Mount) — so it never hits the DOM unstyled.

```css
.tiptap {
  font-family: "Grandstander", cursive, sans-serif; font-weight: 450;
  white-space: pre-wrap; overflow-wrap: break-word;
  width: max-content;
  transform: translateX(var(--text-anchor-tx, 0%)) translateY(var(--text-anchor-ty, 0%));
  text-align: var(--text-align, left); color: var(--text-color, #000000);
}
.tiptap[data-width-mode="fixed"] { outline: 1px solid #1d4ed8; overflow: hidden; }
.tiptap[data-width-mode='label'] { overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
.tiptap[data-width-mode='note']  { overflow: visible; text-align: var(--text-align, center); }
.tiptap[data-width-mode='note'] p { margin: 0; }
.tiptap mark {
  background-color: #ffd43b;
  padding-block: var(--hl-pad, 0.15em);
  margin-block: calc(-1 * var(--hl-pad, 0.15em));
  box-decoration-break: clone;
}
```

**`--hl-pad`:** Set by TextTool as `baselineToTopRatio - measuredAscentRatio` — per-font CSS half-leading. Prevents highlight backgrounds from overflowing line boundaries.

JS inline styles (zoom-dependent): `fontSize`, `lineHeight`, `left`, `top`, `width`/`maxWidth`/`maxHeight`, `--hl-pad`.

---

## Shape Labels

Reuses the full text pipeline with shape-aware positioning.

### Text Box

`computeLabelTextBox(shapeType, frame)` -> max inscribed rect, inset by `LABEL_PADDING = 8`. Ellipse: `(a/sqrt2)*2 x (b/sqrt2)*2`; diamond: `w/2 x h/2`; rect: simple inset. `Math.max(0, ...)` prevents negative dims.

### Canvas Rendering

**At rest:** `drawShapeLabel()` at end of `drawShape()`, gated by `hasLabel(y)`. Uses `textLayoutCache.getLayout()` with textBox width.

**During transforms:** `drawShapeLabelWithFrame()` takes explicit frame, uses `getMeasuredContent()` + `layoutMeasuredContent()` directly — avoids polluting cache.

### DOM Editing

`startEditing()` creates label fields in a single transaction if `!hasLabel(handle.y)`. Alignment-aware positioning matching the note pattern (CSS `clamp()` for vertical overflow). Label containers don't occlude selection handles — `isEditingLabel()` allows handle interaction during editing.

### Cache Invalidation

- Deep observer: `path[1] === 'content'` -> `invalidateContent(id, fragment)` — eager re-tokenize for inline styles
- Transform preview: `getMeasuredContent()` + `layoutMeasuredContent()` — no cache writes

---

## Sticky Notes

First-class `kind: 'note'` with **scale-based rendering** and **auto font sizing**. Font size is never stored — fully derived from content via a two-phase search algorithm. The Y.Map stores `scale` (default 1) that uniformly scales the entire note. Canvas renders at fixed base dimensions (145×145) via `ctx.scale(noteScale)`, so scale changes never re-run auto-sizing.

Reuses text pipeline (Y.XmlFragment, Tiptap, TextLayoutCache) with dedicated cache path (`getNoteLayout`) that measures at 100px and auto-sizes via ratio scaling. Notes are always fixed squares. Overflow at min font step clips.

### NoteProps Accessor

```typescript
interface NoteProps {
  content: Y.XmlFragment;
  origin: [number, number];
  scale: number;           // (y.get('scale') as number) ?? 1
  fontFamily: FontFamily;
  align: TextAlign;        // ?? 'center'
  alignV: TextAlignV;      // ?? 'middle'
  fillColor: string;       // ?? '#FEF3AC'
}
```

**Origin differs from text:** Always top-left corner regardless of alignment. Text `origin[0]` shifts with align. Note alignment is an offset within the content area — origin stays fixed.

### Dimensional Model

Everything derives from `NOTE_WIDTH (145) * scale`:

```typescript
getNotePadding(scale)       -> NOTE_WIDTH * scale * NOTE_PADDING_RATIO        // ~10.4wu at scale=1
getNoteContentWidth(scale)  -> NOTE_WIDTH * scale * (1 - 2*NOTE_PADDING_RATIO) // ~124wu at scale=1
getNoteCornerRadius(w)      -> w * NOTE_CORNER_RADIUS_RATIO (0.06)            // ~8.7wu at scale=1 (private)
getNoteShadowPad{Top,Side,Bottom}(scale) -> NOTE_WIDTH * scale * {0.06, 0.075, 0.12} // asymmetric (private)
```

`NOTE_PADDING_RATIO = 20/280` (kept as `/280` so future width tweaks don't drift the visual padding feel).

| Property | At scale=1 |
|----------|-----------|
| Note width/height | 145wu (always square) |
| Content padding | ~10.4wu per side |
| Content width/height | ~124wu (square content box) |
| Corner radius | ~8.7wu |
| Shadow pad | 8.7 top / ~10.9 sides / 17.4 bottom |

`maxContentH = contentWidth ≈ 124` — threshold where vertical alignment transitions from centering to clamping.

**Key invariant:** Auto-sizing always operates at base dimensions (`BASE_CONTENT_WIDTH`, derived from `NOTE_WIDTH * (1 - 2 * NOTE_PADDING_RATIO)`). Scale only affects world-space size — never the layout algorithm. Scale changes don't invalidate cache.

### Auto Font Size Algorithm — `layoutNoteContent`

#### 100px Ratio Strategy

Font glyph widths scale linearly. Measure once at 100px via `measureTokenizedContent(tokenized, 100, fontFamily)`. For candidate step `s`: `maxW100 = contentWidth / (s / 100)`. Zero per-token multiplication during search. Height: `maxLines = floor(contentHeight / (s * lineHeightMultiplier))`.

#### Font Size Steps

```typescript
NOTE_FONT_STEPS = [54, 48, 44, 43, 42, 41, 40, 38, 37, 36, 35, 34, 33, 32, 31, 30,
                   29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14,
                   13, 12, 11, 10, 9, 8]
NOTE_PHASE1_FLOOR = 11   // Below this, char-breaking activates
```

Dense, mostly per-1 in the mid range with strategically placed odd values so that small content edits (a single character that pushes wrap, or pressing Enter) land on a neighbor step instead of jumping a full size class. Strictly descending — both phases binary-search this array, which requires monotonicity of `noteFlowCheck` in font size (smaller step ⇒ `maxW100` and `maxLines` both grow ⇒ any layout that fits at step `s` also fits at any smaller step).

`NOTE_PHASE1_FLOOR_IDX` is precomputed at module load — the exclusive upper bound for phase-1 search.

#### Educated Starts (single scan)

One pass over tokens finds `maxWordW100`. Then:
- `heightMax = contentHeight / (paraCount * lhMult)` — max step allowed by paragraph count alone.
- `phase1Max = min((contentWidth * 100) / maxWordW100, heightMax)` — phase 1 also respects widest-word-fits-on-one-line.

Single descending sweep through `NOTE_FONT_STEPS` captures both `startIdxP2` (first idx where step ≤ `heightMax`) and `startIdxP1` (first idx where step ≤ `phase1Max`, always ≥ `startIdxP2`).

#### Phase 1: Words Atomic (floor 11px), Binary Search

Binary search `[startIdxP1, NOTE_PHASE1_FLOOR_IDX)` for smallest index where `noteFlowCheck(..., phase2=false)` returns `'fits'`:
- `'fits'` -> record `answer = mid`, `hi = mid` (try smaller step, larger font)
- `'heightOverflow'` -> `lo = mid + 1`
- `number` (step index from `findStepForWord`) -> word-too-wide lower bound. `lo = max(mid + 1, jumpIdx)`. If `jumpIdx >= NOTE_PHASE1_FLOOR_IDX`, break to phase 2.

~6 probes typical vs ~15–20 for the old linear scan.

```typescript
function findStepForWord(wordW100: number, contentWidth: number): number {
  const maxStep = (contentWidth * 100) / wordW100;
  // Return first step index where NOTE_FONT_STEPS[i] <= maxStep
}
```

#### Phase 2: Character Breaking, Binary Search

Binary search `[startIdxP2, length)` — char-breaking relaxes the word-width constraint, so height is the only remaining bound. `noteFlowCheck(..., phase2=true)` returns only `'fits'` / `'heightOverflow'`. Font can jump **up** from phase 1's floor (e.g., 11→40) because multi-line wrapping allows larger fonts.

**Fallback:** If no step fits, `derivedFontSize = 8`. Empty text returns `NOTE_FONT_STEPS[0]` (54).

#### `noteFlowCheck` — Inline Flow Simulation

```typescript
type NoteFlowResult = 'fits' | 'heightOverflow' | number; // number = jumpToStepIdx
```

Mirrors `layoutMeasuredContent`'s pending whitespace state machine:
- Leading WS: committed immediately (can overflow)
- Inter-word WS: buffered as `pendingW`, commit/discard on next word
- Paragraph boundaries: reset line, increment `lineCount`
- Early bail when `lineCount > maxLines`
- Phase 1: returns `findStepForWord(wordW, contentWidth)` for oversized words
- Phase 2: char-breaks oversized words segment by segment

Sub-segment ladder is the same two-decision-system structure as `placeWord` (Stage 3 §Word placement) — `canSoftBreak` gates Q2 only; Q3 char-slices across non-break style seams to match DOM. Phase 1 may char-slice at style seams (line count then matches DOM); the `tokAdvance > maxW` bail still ensures truly oversized words defer to phase 2.

#### Phase B: Mutate + Build Layout

After finding `derivedFontSize`, mutates `MeasuredContent` (100px) in place:

```typescript
const ratio = derivedFontSize / 100;
const F = buildFontMatrix(derivedFontSize, fontFamily);
for (seg) { seg.advanceWidth *= ratio; seg.font = fontFromMatrix(F, bold, italic); }
for (tok) { tok.advanceWidth *= ratio; }
measured.lineHeight = derivedFontSize * lhMult;
layoutMeasuredContent(measured, contentWidth, derivedFontSize);
```

Safe — mutated content never reused for 100px work. Fresh measurement on next cache miss.

### Cache — `getNoteLayout`

Lives in `sticky-note.ts` as a module function (not on `TextLayoutCache`). No fontSize/width params — always at base dimensions. Reads/writes the shared cache via the `noteCached*` field accessors / `setNoteResults`.

```typescript
getNoteLayout(id, fragment, fontFamily): TextLayout   // sticky-note.ts
getNoteDerivedFontSize(id): number                    // sticky-note.ts, fallback NOTE_FONT_STEPS[0]
```

**Two-tier:**
1. **Hit:** tokenized valid + fontFamily matches + noteDerivedFontSize valid -> cached layout
2. **Stale:** Re-measure at 100px + `layoutNoteContent` (reuses tokenized if content unchanged)
3. **Full miss:** `parseAndTokenize` -> measure at 100px -> `layoutNoteContent`

**Invalidation:** `invalidateContent(id)` on `TextLayoutCache` nulls tokenized + `noteDerivedFontSize` (field still on `CacheEntry`, so no extra coordination needed). Scale changes don't invalidate. FontFamily detected by comparison.

### Canvas Rendering — `drawStickyNote`

Renders inside `ctx.translate(origin) + ctx.scale(noteScale)` at **base dimensions** (145×145). Does NOT call `renderTextLayout` — custom rendering with alignment.

```
drawStickyNote(ctx, handle):
  1. getNoteProps(y) -> origin, scale, fontFamily, fillColor, content, align, alignV
  2. getNoteLayout(id, content, fontFamily) -> layout at base dimensions
  3. getNoteDerivedFontSize(id) -> derived font size
  4. ctx.translate(origin) + ctx.scale(noteScale)
  5. renderNoteBody(ctx, 0, 0, fillColor) -- always drawn, even during editing
  6. if textEditingId === id -> return (DOM overlay handles text)
  7. Alignment at base dimensions:
     padding = getNotePadding(1), contentWidth = getNoteContentWidth(1)
     vOffset = getNoteContentOffsetY(alignV, maxContentH, contentH)
     textY = padding + vOffset + baselineToTop
     noteAnchorX = padding + anchorFactor(align) * contentWidth
  8. Clip if contentH > maxContentH
  9. Two-pass per line: highlights -> fillText (contrast color via getStickyNoteTextColor)
```

Key differences from `renderTextLayout`:
- All coordinates in base space, GPU handles scaling
- No fillColor background rect (body drawn by `renderNoteBody`)
- Container bounds = content area (not text block box)
- Uses `getLineStartX` with virtual anchor
- Vertical offset via `getNoteContentOffsetY` (not baseline positioning)
- Clips overflow at content area boundary

### Shadow System — Directional Drop Shadow, Single-Entry Cache

Real drop shadows under gravity reach *long below*, *barely on the sides*, *not above*. Native canvas `shadowBlur` is gaussian + isotropic — blur alone always spreads side-to-side. Two knobs make it directional:

1. **Small blur (`0.04·w`)** — keeps side spread tight.
2. **OffsetY > blur (`0.045·w` vs `0.04·w`)** — pushes the gaussian's mass below the body. Above-extent collapses to ~0.

Spread (à la CSS `box-shadow`) was tried and abandoned: the only way to fake it in canvas is to draw a wider rounded-rect fill, but then either you leave the expanded fill in (visible black ring around the body) or you punch the expanded silhouette (transparent ring around the body where the real body fill doesn't reach). Both visibly broken. Instead, a **contact layer** is filled on top of the drop layer using the *same* body path — it anchors the shadow at the body edge so the visible halo reads as connected to the body even when drop's near edge is faint.

Crucial: both layers fill the **identical** body path. The final `destination-out` punch on that same path removes every black pixel deposited by the fills, leaving only the gaussian halo. No mismatched paths → no surviving opaque pixels → no black AA stroke.

| Layer | blur ratio | offsetY ratio | color |
|-------|-----------|--------------|-------|
| Drop | 0.04 | 0.045 | `rgba(0,0,0,0.11)` |
| Contact | 0.013 | 0.008 | `rgba(0,0,0,0.07)` |

**Single-entry cache.** Notes always render inside `ctx.scale(noteScale)` at fixed base dimensions `(NOTE_WIDTH, NOTE_WIDTH)`, so the cache content is dimension-invariant — one DPR-scaled `OffscreenCanvas` (`_noteShadow`), baked once by `ensureNoteShadow(dpr)`, drawn with a single `drawImage` per note. `_noteShadowDpr` tracks the DPR; a mismatch re-bakes. No keying, no LRU, no eviction. Bookmarks keep their own 3-slice cache (`core/bookmark/CLAUDE.md`) since their height varies — the two no longer share shadow code.

The cache uses an **asymmetric pad** — top/sides hold a tight halo, bottom holds the long downward tail — so the canvas isn't wasted on transparent pixels above the body.

| Constant | Value | Purpose |
|----------|-------|---------|
| `NOTE_SHADOW_TOP_RATIO` | 0.06 | Slight halo from drop's blur tail |
| `NOTE_SHADOW_SIDE_RATIO` | 0.075 | Fits drop's gaussian tail (1.5·blur) |
| `NOTE_SHADOW_BOTTOM_RATIO` | 0.12 | Fits drop's blur·1.5 + offset with headroom |

`computeNoteBBox` pads the bbox by these ratios (via `getNoteShadowPad*`) — the dirty-rect invariant requires bbox pad ≥ painted shadow pad on every side.

Why opaque + punch-out: browsers skip shadow rendering for zero-alpha fill. Punch matches the body's `roundRect` **exactly** — because the cached canvas is sized at the body's exact dimensions, the punched silhouette aligns 1:1 with the body fill drawn next by `renderNoteBody`. No corner wedge possible.

**`renderNoteBody(ctx, x, y, fillColor)`:** `drawNoteShadow` (single drawImage) + `roundRect` fill at `NOTE_CORNER_R`. The cached shadow's punched body silhouette is at the destination's exact dimensions, so the subsequent body fill covers any AA fringe at the body edge. Exported — `renderer/layers/tool-preview.ts` reuses it for the toolbar drag-place note preview (empty note at scale 1 = exact WYSIWYG). Not shared with bookmarks.

### Alignment System

3x3 alignment (H x V).

#### Horizontal

Container `width: max-content` + `maxWidth`, growing to fit content. Anchored at `contentLeft + anchorFactor(align) * contentWidth`, then `translateX` offsets (`0%`/`-50%`/`-100%`). `text-align` CSS variable aligns lines.

#### Vertical — CSS `clamp()`

Position `top` at vertical anchor, clamp `translateY`:

```
vFactor = top:0, middle:0.5, bottom:1
topWorldY = origin[1] + padding + vFactor * maxContentH
maxTy = vFactor * maxContentH * cameraScale
--text-anchor-ty = alignV === 'top' ? '0%' : clamp(-maxTy px, -vFactor*100%, 0px)
```

- Content fits (H < maxContentH): `-vFactor*100%` wins -> centered
- Content overflows: `-maxTy` wins -> top clamped at padding edge
- Transition is continuous

#### Canvas Matching

```typescript
getNoteContentOffsetY(alignV, maxContentH, contentH):
  if (alignV === 'top') return 0
  space = max(0, maxContentH - contentH)
  return alignV === 'middle' ? space / 2 : space
```

Horizontal: `noteAnchorX = padding + anchorFactor(align) * contentWidth` -> `getLineStartX(noteAnchorX, contentWidth, lineW, align)`.

### BBox + Frame

```typescript
computeNoteBBox(id, props):
  frame = [origin[0], origin[1], NOTE_WIDTH*scale, NOTE_WIDTH*scale]  // always square
  getNoteLayout(id, content, fontFamily)  // populate cache
  setFrame(id, frame)
  return frame padded by getNoteShadowPad{Top,Side,Bottom}(scale)
```

Frame = body (square, no shadow). BBox = body + shadow. Alignment doesn't affect BBox. Fallback in `bbox.ts`: `w = NOTE_WIDTH * ((y.get('scale') as number) ?? 1)`.

### TextTool — Note-Specific

**Creation:** `kind: 'note', scale: 1, fontFamily: store.noteFontFamily, align: store.noteAlign, alignV: store.noteAlignV, fillColor: store.note.fillColor`. Text color is **not stored** — derived per-render from `fillColor` via `getStickyNoteTextColor()` (Map-cached luminance pick: `#1a1a1a` for light fills, `#ffffff` for the near-black sticky). Both the canvas draw and Tiptap's `--text-color` CSS var read through it.

**mountEditor:** `applyEditorSkin()` populates the note cache via `getNoteLayout()` + sets the contrast `--text-color`; `positionEditor()` sets `fontSize = derivedFontSize · noteScale · cameraScale` (screen-space).

**positionEditor:** Reads fresh `getNoteProps`, recomputes alignment anchors + clamp values + CSS.

**updateNoteAutoSize:** Called from `onTransaction` when `docChanged`. Forces cache repopulation via `getNoteLayout()`, reads fresh `derivedFontSize`, updates container CSS.

**syncProps:** `fontFamily` -> eagerly calls `getNoteLayout()` before `positionEditor()` (extension observer fires before deep observer). `align/alignV/origin/scale` -> `positionEditor()`. Skips fillColor->backgroundColor, skips applyAlignCSS (needs full repositioning).

**commitAndClose:** Empty notes preserved (valid visual elements).

### Scale Transform

Quantizes `scale` (not fontSize). Bbox-center position preservation:

```typescript
roundedScale = Math.round(props.scale * rawAbsScale * 1000) / 1000;
effectiveAbsScale = roundedScale / props.scale;
yMap.set('origin', [newOriginX, newOriginY]);
yMap.set('scale', roundedScale);
```

**Preview:** `renderScaleEntryLanes`' note arm nests `ctx.scale(outScale / frozenScale)` (aux lanes 14/6) around the out-origin lanes before `drawObject` (which applies its own `ctx.scale(noteScale)`). No re-layout per frame.

Mixed + side handle -> edge-pin translate (only origin, no scale change).

### Hit Testing & Selection

- Hit: `getTextFrame(id)` + `shapeHitTest('rect')`, always `isFilled: true`
- Marquee: `getTextFrame` + `rectsIntersect`
- `hitTestVisibleNote`: same spatial query as `hitTestVisibleText` but returns `kind === 'note'`
- SelectionKind: `'notesOnly'`. Included in fillColor, fontFamily, bold/italic/highlight actions. NOT in textColor or fontSize.
- Double-click/Enter -> `textTool.startEditing(id)`

### CSS

```css
.tiptap[data-width-mode='note'] { overflow: visible; text-align: var(--text-align, center); }
.tiptap[data-width-mode='note'] p { margin: 0; }
.tiptap[data-width-mode='note'] .is-editor-empty:first-child::before { display: none; }
```

`p { margin: 0 }` prevents ProseMirror paragraph margins from breaking WYSIWYG. Placeholder hidden — empty notes preserved.

---

## Scale Transforms (SelectTool)

Full transform behavior matrix in `tools/selection/CLAUDE.md`. Text/note-specific details:

- **Text uniform (corner + textOnly N/S):** fontSize rounded to 3dp, origin recomputed from frame center via `anchorFactor(align)` + `baselineToTopRatio`. Preview via `ctx.scale()` on cached layout — no per-frame re-layout
- **Text E/W reflow:** reflow sidecar on the transform engine (pooled `TextLayout` buffer reused per pointermove; measured-content ref + minW + anchor frozen at begin). Uses `layoutMeasuredContent(cached measured, targetWidth, fontSize)` — skips tokenize + measure. Commit writes `width = layout.boxWidth` + `origin`. Converts auto→fixed
- **Note uniform:** Quantizes `scale` to 3dp (not fontSize). Bbox-center position preservation. Nested `ctx.scale` composition — no re-layout
- **Mixed N/S:** Edge-pin translate (origin offset only, no scale change)
- **Labels:** Follow shape frame transform

---

## Room Doc Manager Integration

### Deep Observer

Content changes (`path[1] === 'content'`): `textLayoutCache.invalidateContent(id, fragment)` with fresh `Y.XmlFragment` for eager tokenization. Other property changes (`fontSize`, `width`) handled by comparison in `getLayout()`.

### BBox Dispatch

- `kind === 'text'` -> `computeTextBBox(id, textProps)`
- `kind === 'note'` -> `computeNoteBBox(id, noteProps)`
- Labels: BBox from shape frame

Deletion: `textLayoutCache.remove(id)`. Rebuild: `textLayoutCache.clear()`.
