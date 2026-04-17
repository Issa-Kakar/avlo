# Text System Documentation

**Status:** WYSIWYG complete — auto + fixed-width modes verified

> **Maintenance note:** System-level overview for Claude agents. When updating, match surrounding detail — don't inflate coverage of specific changes.

## Overview

WYSIWYG rich text: **DOM overlay editing** (Tiptap/ProseMirror) + **canvas rendering** (custom layout engine). Three text-bearing object types: text objects, shape labels, sticky notes.

- **Editing:** Tiptap editor in absolute-positioned div, synced to Y.XmlFragment via TextCollaboration extension
- **Rendering:** Canvas layout engine (tokenizer → measurement → flow) matching CSS `pre-wrap` + `break-word`
- **Positioning:** Measured font metrics (`fontBoundingBox*`) ensure DOM ↔ canvas baseline alignment
- **Collaboration:** Y.XmlFragment CRDT, two-tier UndoManager (per-session + room-level atomic session merging)
- **WYSIWYG parity:** Same font/weight, same line-height (`fontSize * 1.3`), same baseline positioning via `getBaselineToTopRatio()` (CSS half-leading formula), identical whitespace semantics. Sub-pixel ~0.5px from per-token vs native shaping.

## Files

| File | Purpose |
|------|---------|
| `core/text/text-system.ts` | Layout engine, cache, text/label renderers, text BBox |
| `core/text/sticky-note.ts` | Note constants/geometry, auto-font-size pipeline (`layoutNoteContent`, `getNoteLayout`, `getNoteDerivedFontSize`), 9-slice shadow cache, `renderNoteBody` (shared w/ bookmarks), `drawStickyNote`, `computeNoteBBox` |
| `core/text/extensions.ts` | TextCollaboration: per-session UndoManager, Y.Map observer, session merging |
| `core/text/font-config.ts` | `FONT_WEIGHTS` (450/700), `FONT_FAMILIES` (4 families, all 1.3x line-height) |
| `core/text/font-loader.ts` | `ensureFontsLoaded()` / `areFontsLoaded()` |
| `tools/TextTool.ts` | Editor mounting, positioning, lifecycle — 3-way branch (text/label/note) |

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
// No fontSize (derived), no width (= NOTE_WIDTH * scale), no color (hardcoded '#1a1a1a').
```

See **Sticky Notes** section for full details.

---

## Text System Pipeline (`text-system.ts`)

```
Y.XmlFragment
    ↓ parseAndTokenize()
TokenizedContent { paragraphs, uniformStyles }
    ↓ measureTokenizedContent(tokenized, fontSize, fontFamily)
MeasuredContent { paragraphs: MeasuredToken[][], lineHeight }
    ↓ layoutMeasuredContent(measured, width, fontSize)   ← exported
TextLayout { lines: MeasuredLine[], fontSize, fontFamily, lineHeight, widthMode, boxWidth }
```

Primary API: `textLayoutCache.getLayout()`. `layoutMeasuredContent()` exported for reflow during E/W transforms.

### Font Metrics

Per-family, measured from canvas `fontBoundingBoxAscent/Descent` (not hardcoded):

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

Canvas `measureText()` via singleton offscreen canvas. Caches: `MEASURE_LRU` (75k, key: `font+'\0'+text`), `SPACE_WIDTH_CACHE` (per font), `GRAPHEME_LRU` (10k, `Intl.Segmenter` splits). All cleared on `textLayoutCache.clear()`.

### Stage 3: Flow Engine

Two modes: **auto** (`maxWidth = Infinity`, no wrapping) and **fixed** (wraps at width). Implements CSS `pre-wrap` + `break-word`.

**Pending whitespace state machine:** Leading WS (no ink on line) commits immediately and can overflow. Inter-word WS in fixed mode is *buffered* as pending. On next word: if `current + pending + word <= maxWidth`, commit pending + place word; else push line (pending WS kept for highlight rendering but excluded from `alignmentWidth`), word starts new line.

**Paragraph end:** Trailing WS is content (not hanging), so `alignmentWidth = min(advanceWidth, maxWidth)`.

**Oversized words (break-word):** `sliceTextToFit()` binary-searches grapheme boundaries. Forward-progress: >=1 grapheme per slice. Cross-segment guard: if forced grapheme overflows non-empty line, push line first, retry on fresh line.

**Run coalescing:** Adjacent runs with identical font+highlight merge via string concat.

### Layout Output Types

```typescript
interface MeasuredRun {
  text: string; font: string; highlight: string | null;
  advanceWidth: number; advanceX: number;
}
interface MeasuredLine {
  runs: MeasuredRun[]; index: number;
  advanceWidth: number;      // Total including trailing whitespace
  alignmentWidth: number;    // Wrap-break -> visualWidth (WS hangs); paragraph-end -> min(advance, max)
  baselineY: number;
}
interface TextLayout {
  lines: MeasuredLine[]; fontSize: number; fontFamily: FontFamily;
  lineHeight: number; widthMode: 'auto' | 'fixed';
  boxWidth: number;          // auto -> max advanceWidth; fixed -> explicit width
}
```

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

// Note bridge — narrow read/write surface for sticky-note.ts orchestration.
// `noteDerivedFontSize` still lives on CacheEntry so `invalidateContent` nulls it.
textLayoutCache.getNoteCache(id)         // → NoteCacheSnapshot | null
textLayoutCache.setNoteCache(id, snap)   // upsert; always nulls frame
```

Note-level orchestration (`getNoteLayout`, `getNoteDerivedFontSize`) lives in `sticky-note.ts` — it reads/writes via the bridge above.

---

## Renderers, BBox & Helpers

### `renderTextLayout(ctx, layout, originX, originY, color, align?, fillColor?)`

Pass 0: fillRect background (if fillColor). Per line: compute `startX` via `anchorFactor(align)` + `getLineStartX()`. Pass 1: highlight roundRects (radius `fontSize * 0.25`; fixed mode clamps to container). Pass 2: fillText, `textBaseline = 'alphabetic'`. Fixed mode uses `alignmentWidth` for line width; auto uses `advanceWidth`.

### `renderShapeLabel(ctx, layout, textBox, color, fontFamily, align?, alignV?)`

H+V alignment within text box. Vertical via `getNoteContentOffsetY()`. Overflow clips via `ctx.clip()`.

### Alignment Helpers

```typescript
anchorFactor(align)   // left=0, center=0.5, right=1
getLineStartX(originX, boxWidth, lineW, align)
  // left: boxLeftX, center: boxLeftX+(boxWidth-lineW)/2, right: boxLeftX+(boxWidth-lineW)
computeLabelTextBox(shapeType, frame)
  // Max inscribed rect inset by LABEL_PADDING=10.
  // ellipse: (a/sqrt2)x2 x (b/sqrt2)x2 centered; diamond: w/2 x h/2 centered; rect: simple inset
```

### BBox + Derived Frame

```typescript
computeTextBBox(id, props)   // Derives frame from layout, caches, returns frame + 2px padding
computeNoteBBox(id, props)   // Square frame, caches, returns frame + shadow pad
getTextFrame(id)             // Reads cached frame — used for BOTH text AND note objects
getInlineStyles(id)          // UniformStyles from cached tokenized content
```

Frame consumer pattern: `handle.kind === 'text' || 'note' ? getTextFrame(handle.id) : getFrame(handle.y)`. Used by hit-testing, connectors, eraser, selection-overlay, SelectTool, bounds.

---

## Undo/Redo Architecture

### Two-Tier System

**Per-session** (TextCollaboration extension): Created on editor mount. Scope: `[Y.XmlFragment, Y.Map]` — tracks content edits AND property changes (fontSize, color, align, etc.). Origins: `{ySyncPluginKey, userId}`. Cmd+Z while editing can undo font changes made via context menu.

**Main** (RoomDocManager): Tracks all objects map changes. Origins: `{userId, ySyncPluginKey}` — `ySyncPluginKey` critical so text content edits (which use that origin) are visible to main undo.

### Session Merging

Extension manipulates main UndoManager on lifecycle:
```
onCreate():   mainUM.stopCapturing() + captureTimeout = 600_000  -> new group, merge all
onDestroy():  mainUM.stopCapturing() + captureTimeout = 500      -> seal group, restore
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
| `kind === 'note'` | Note | origin + padding + alignment | contentWidth | hardcoded `'#1a1a1a'` |
| else | Text | origin (anchor + baseline) | `width` field | `color` |

### Lifecycle

```
begin() -> hit test (hitTestVisibleNote for note tool, hitTestVisibleText otherwise)
end()   -> hitTextId ? mountEditor(hitTextId) : createTextObject -> mountEditor(id)
```

SelectTool enters editing via `textTool.startEditing(id)` — two-click state machine: click 1 on unselected text → `setSelection([id])`. Click 2 on sole-selected text → `startEditing()`. Double-click works naturally (no timer). Multi-selection drill-down: click 1 drills to single, click 2 mounts.

**Access:** `textTool` exported directly from `tool-registry.ts`. Public fields: `objectId`, `isEditorMounted()`, `getEditor()`, `getContainer()`.

### SelectTool Guards During Editing

SelectTool reads `store.textEditingId`:
- Handle hit testing and hover cursors skipped — no scale gestures while editing
- Visual handles hidden in `getPreview()`
- `onViewChange()` forwarded to `textTool.onViewChange()` for DOM repositioning on zoom/pan
- Exception: `isEditingLabel()` allows handle hit-testing/rendering during label editing (label containers don't occlude handles)

### mountEditor Per-Mode

Editor configured with `TextCollaboration.configure({ fragment, yObj: handle.y, userId, mainUndoManager, onPropsSync })`.

**Text:** Position at `origin[0], origin[1] - fontSize * baselineToTopRatio`. Width: fixed -> explicit px, auto -> CSS `max-content`. `data-width-mode='auto'|'fixed'`.

**Label:** Position within `computeLabelTextBox()`. Anchored at `tbx + anchorFactor(align) * tbw` / `tby + vFactor * tbh`. Uses `maxWidth`/`maxHeight`. `data-width-mode='label'`. No backgroundColor, no Placeholder.

**Note:** Position at `origin + padding + anchorFactor(align) * contentWidth`. Vertical uses CSS `clamp()` for clamped centering. `fontSize = derivedFontSize * noteScale`. Uses `maxWidth`/`maxHeight`. `data-width-mode='note'`. No backgroundColor. See Sticky Notes for detail.

### syncProps (Y.Map -> DOM on undo/redo)

- **Text:** `color` -> CSS var; `fillColor` -> backgroundColor; `align` -> CSS vars; spatial props -> `positionEditor()`
- **Label:** `labelColor` -> `--text-color`; `frame/shapeType/fontSize/fontFamily/align/alignV` -> `positionEditor()`
- **Note:** `fontFamily` -> eagerly calls `getNoteLayout()` before `positionEditor()` (ensures correct derivedFontSize); `align/alignV/origin/scale` -> `positionEditor()`. Skips fillColor and applyAlignCSS (needs full repositioning).

### commitAndClose

- Empty labels: delete label fields, shape persists
- Empty text: delete entire object
- Empty notes: preserved (valid visual elements)
- `(editor as any).editorState = null` — Tiptap doesn't null this; release EditorState + plugin states

### Click-Outside

`pointerdown` on document (capture phase, 100ms delayed registration — delay prevents catching the opening click). Uses `pointerdown` not `mousedown` because CanvasRuntime's `preventDefault()` suppresses compatibility mousedown per spec.

After `commitAndClose()`, `e.stopPropagation()` fires **only when `activeTool === 'text'|'note'` AND target is canvas** — prevents creating a new text/note object on click-off. When SelectTool is active (e.g., label editing), the event intentionally propagates so the clicked object gets selected normally in one click.

### Remount Prevention

`justClosedLabelId` set for shapes AND notes on `commitAndClose()`. Prevents the immediate remount cycle: pointerdown on shape body while editing label → `commitAndClose()` fires → event propagates → SelectTool's `end()` sees same shape hit → would call `startEditing()` again. SelectTool checks and consumes this flag before calling `startEditing()`, breaking the loop.

---

## CSS Architecture

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

`computeLabelTextBox(shapeType, frame)` -> max inscribed rect, inset by `LABEL_PADDING = 10`. Ellipse: `(a/sqrt2)*2 x (b/sqrt2)*2`; diamond: `w/2 x h/2`; rect: simple inset. `Math.max(0, ...)` prevents negative dims.

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

First-class `kind: 'note'` with **scale-based rendering** and **auto font sizing**. Font size is never stored — fully derived from content via a two-phase search algorithm. The Y.Map stores `scale` (default 1) that uniformly scales the entire note. Canvas renders at fixed base dimensions (280x280) via `ctx.scale(noteScale)`, so scale changes never re-run auto-sizing.

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

Everything derives from `NOTE_WIDTH (280) * scale`. All helpers take `scale`:

```typescript
getNotePadding(scale)       -> NOTE_WIDTH * scale * (12/280)    // 12wu at scale=1
getNoteContentWidth(scale)  -> NOTE_WIDTH * scale * (1-2*12/280) // 256wu at scale=1
getNoteCornerRadius(scale)  -> NOTE_WIDTH * scale * 0.011       // 3.08wu at scale=1
getNoteShadowPad(scale)     -> NOTE_WIDTH * scale * 0.15        // 42wu at scale=1
```

| Property | At scale=1 |
|----------|-----------|
| Note width/height | 280wu (always square) |
| Content padding | 12wu per side |
| Content width/height | 256wu (square content box) |
| Corner radius | 3.08wu |
| Shadow pad | 42wu |

`maxContentH = contentWidth = 256` — threshold where vertical alignment transitions from centering to clamping.

**Key invariant:** Auto-sizing always operates at base dimensions (`BASE_CONTENT_WIDTH = 256`). Scale only affects world-space size — never the layout algorithm. Scale changes don't invalidate cache.

### Auto Font Size Algorithm — `layoutNoteContent`

#### 100px Ratio Strategy

Font glyph widths scale linearly. Measure once at 100px via `measureTokenizedContent(tokenized, 100, fontFamily)`. For candidate step `s`: `maxW100 = contentWidth / (s / 100)`. Zero per-token multiplication during search. Height: `maxLines = floor(contentHeight / (s * lineHeightMultiplier))`.

#### Font Size Steps

```typescript
NOTE_FONT_STEPS = [72, 64, 56, 48, 44, 40, 36, 34, 32, 30, 28, 26, 24, 22, 20,
                   18, 16, 15, 14, 13, 12, 11, 10, 9, 8]
NOTE_PHASE1_FLOOR = 18   // Below this, char-breaking activates
```

#### Phase 1: Words Atomic (floor 18px)

**Educated start:** Scans tokens for `maxWordW100` (widest word at 100px), computes upper bound: `min(contentWidth*100/maxWordW100, contentHeight/(paraCount*lhMult))`. Starts at first step <= bound.

Top-down search. For each step, `noteFlowCheck(measured, maxW100, maxLines, phase2=false, contentWidth)`:
- `'fits'` -> this step is the answer
- `'heightOverflow'` -> too large, continue
- `number` (step index) -> word too wide, `findStepForWord` computed exact step. Jump directly. If jumped step < 18 -> Phase 2.

```typescript
function findStepForWord(wordW100: number, contentWidth: number): number {
  const maxStep = (contentWidth * 100) / wordW100;
  // Return first step index where NOTE_FONT_STEPS[i] <= maxStep
}
```

#### Phase 2: Character Breaking (from top)

Restarts from step 0 (72px). `noteFlowCheck` breaks oversized words at grapheme boundaries via `sliceTextToFit`. Font can jump **up** (e.g., 18->48) because multi-line wrapping allows larger fonts.

**Fallback:** If no step fits, `derivedFontSize = 8`. Empty text returns 72.

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

#### Phase B: Mutate + Build Layout

After finding `derivedFontSize`, mutates `MeasuredContent` (100px) in place:

```typescript
const ratio = derivedFontSize / 100;
for (tok) { tok.advanceWidth *= ratio; seg.advanceWidth *= ratio; seg.font = rebuild; }
measured.lineHeight = derivedFontSize * lhMult;
layoutMeasuredContent(measured, contentWidth, derivedFontSize);
```

Safe — mutated content never reused for 100px work. Fresh measurement on next cache miss.

### Cache — `getNoteLayout`

Lives in `sticky-note.ts` as a module function (not on `TextLayoutCache`). No fontSize/width params — always at base dimensions. Reads/writes the shared cache via `textLayoutCache.getNoteCache(id)` / `setNoteCache(id, snap)`.

```typescript
getNoteLayout(id, fragment, fontFamily): TextLayout   // sticky-note.ts
getNoteDerivedFontSize(id): number                    // sticky-note.ts, fallback 72
```

**Two-tier:**
1. **Hit:** tokenized valid + fontFamily matches + noteDerivedFontSize valid -> cached layout
2. **Stale:** Re-measure at 100px + `layoutNoteContent` (reuses tokenized if content unchanged)
3. **Full miss:** `parseAndTokenize` -> measure at 100px -> `layoutNoteContent`

**Invalidation:** `invalidateContent(id)` on `TextLayoutCache` nulls tokenized + `noteDerivedFontSize` (field still on `CacheEntry`, so no extra coordination needed). Scale changes don't invalidate. FontFamily detected by comparison.

### Canvas Rendering — `drawStickyNote`

Renders inside `ctx.translate(origin) + ctx.scale(noteScale)` at **base dimensions** (280x280). Does NOT call `renderTextLayout` — custom rendering with alignment.

```
drawStickyNote(ctx, handle):
  1. getNoteProps(y) -> origin, scale, fontFamily, fillColor, content, align, alignV
  2. getNoteLayout(id, content, fontFamily) -> layout at base dimensions
  3. getNoteDerivedFontSize(id) -> derived font size
  4. ctx.translate(origin) + ctx.scale(noteScale)
  5. renderNoteBody(ctx, 0, 0, NOTE_WIDTH, NOTE_WIDTH, fillColor) -- always drawn, even during editing
  6. if textEditingId === id -> return (DOM overlay handles text)
  7. Alignment at base dimensions:
     padding = getNotePadding(1), contentWidth = getNoteContentWidth(1)
     vOffset = getNoteContentOffsetY(alignV, maxContentH, contentH)
     textY = padding + vOffset + baselineToTop
     noteAnchorX = padding + anchorFactor(align) * contentWidth
  8. Clip if contentH > maxContentH
  9. Two-pass per line: highlights -> fillText ('#1a1a1a')
```

Key differences from `renderTextLayout`:
- All coordinates in base space, GPU handles scaling
- No fillColor background rect (body drawn by `renderNoteBody`)
- Container bounds = content area (not text block box)
- Uses `getLineStartX` with virtual anchor
- Vertical offset via `getNoteContentOffsetY` (not baseline positioning)
- Clips overflow at content area boundary

### Shadow System — 9-Slice Cache

Dual-layer Gaussian shadow pre-rendered on DPR-scaled `OffscreenCanvas`, drawn via 8 `drawImage` calls (9-slice, center skipped).

**Source canvas:** `(280 * dpr) x (280 * dpr)` px. Layout: `[100px pad][80px rect][100px pad]`.

**Dual layers** (opaque `#000` fill, body punched out with `destination-out`):

| Layer | blur | offsetY | alpha | Purpose |
|-------|------|---------|-------|---------|
| Floor | 34 | 28 | 0.10 | Long bottom tail, 3D lift |
| Contact | 10 | 3 | 0.06 | Soft edge definition |

Why dual-layer: single Gaussian can't produce asymmetric sticky-note shadow. Floor's large offsetY pushes it below body. Contact adds soft edges.

Why opaque + punch-out: browsers skip shadow rendering for zero-alpha fill. Punch-out expanded 1px to eliminate anti-aliased fringe.

**Cache invalidation:** Auto-rebuilds on DPR change. Module-level singleton.

**Destination mapping:** Source pad (100px) -> `w * NOTE_SHADOW_PAD_RATIO` (42wu at scale=1). Inside `ctx.scale(noteScale)`, draws at base dimensions.

**`renderNoteBody(ctx, x, y, w, h, fillColor)`:** `drawNoteShadow` (9-slice) + `roundRect` fill at `w * NOTE_CORNER_RADIUS_RATIO`.

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
  return frame +/- getNoteShadowPad(scale)
```

Frame = body (square, no shadow). BBox = body + shadow. Alignment doesn't affect BBox. Fallback in room-doc-manager: `w = 280 * ((y.get('scale') as number) ?? 1)`.

### TextTool — Note-Specific

**Creation:** `kind: 'note', scale: 1, fontFamily: store.noteFontFamily, align: store.noteAlign, alignV: store.noteAlignV, fillColor: NOTE_FILL_COLOR`.

**mountEditor:** Populates cache via `getNoteLayout()`, sets `fontSize = derivedFontSize * noteScale`. Generic CSS block computes `scaledFontSize = fontSize * cameraScale` -> correct screen-space size.

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

**Preview:** `drawScaledNotePreview` nests `ctx.scale(effectiveAbsScale)` before `drawStickyNote` (which applies its own `ctx.scale(noteScale)`). No re-layout per frame.

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

### NOT Implemented Yet

- **Eraser** — no eraser integration for notes

---

## Scale Transforms (SelectTool)

Full transform behavior matrix in `tools/selection/CLAUDE.md`. Text/note-specific details:

- **Text uniform (corner + textOnly N/S):** fontSize rounded to 3dp, origin recomputed from frame center via `anchorFactor(align)` + `baselineToTopRatio`. Preview via `ctx.scale()` on cached layout — no per-frame re-layout
- **Text E/W reflow:** `TextReflowState` on selection store. Uses `layoutMeasuredContent(cached measured, targetWidth, fontSize)` — skips tokenize + measure. Commit writes `width = layout.boxWidth` + `origin`. Converts auto→fixed
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
