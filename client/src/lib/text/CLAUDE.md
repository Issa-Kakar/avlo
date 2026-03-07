# Text System Documentation

**Status:** WYSIWYG complete — auto + fixed-width modes verified

> **Maintenance note:** This is a system-level architectural overview, not a changelog. When updating after code changes, match the detail level of surrounding content — don't inflate coverage of your specific change at the expense of the big-picture pipeline flow and cache interactions that make this document useful.

## Overview

WYSIWYG rich text with **DOM overlay editing** and **canvas rendering**, supporting both auto-width and fixed-width (text wrapping) modes.

- **Editing:** Tiptap editor in absolute-positioned div, synced to Y.XmlFragment via custom TextCollaboration extension
- **Rendering:** Canvas-based layout engine with tokenizer + flow engine matching CSS `pre-wrap` + `break-word`
- **Positioning:** Measured font metrics ensure DOM <> canvas baseline alignment
- **Collaboration:** Y.XmlFragment CRDT enables real-time sync
- **Undo/Redo:** Two-tier UndoManager — per-session (in-editor content + property changes) + main (room-level atomic session merging)

## Files

| File | Purpose |
|------|---------|
| `lib/text/text-system.ts` | Layout engine: tokenizer, measurement, flow engine, cache, renderer, BBox |
| `lib/text/extensions.ts` | TextCollaboration extension: per-session UndoManager, Y.Map observer, session merging |
| `lib/text/font-config.ts` | `FONT_WEIGHTS`, `FONT_FAMILIES` per-family config (extracted to avoid circular deps) |
| `lib/text/font-loader.ts` | `ensureFontsLoaded()`, `areFontsLoaded()` — loads all 4 families |
| `lib/text/TextContextMenu.md` | Legacy floating toolbar reference (inactive — superseded by `context-menu/` system) |
| `lib/text/text-menu-icons.ts` | SVG icon builders for context menu |
| `lib/tools/TextTool.ts` | PointerTool: editor mounting, Y.Map creation, live editing, width handling |

---

## Y.Doc Object Schema

```typescript
{
  id: string,                          // ULID
  kind: 'text',
  origin: [number, number],            // [alignmentAnchorX, firstLineBaseline]
  fontSize: number,                    // World units
  fontFamily: FontFamily,              // 'Grandstander' | 'Inter' | 'Lora' | 'JetBrains Mono'
  color: string,                       // Hex color
  align: 'left' | 'center' | 'right', // TextAlign
  width: 'auto' | number,             // TextWidth — 'auto' or fixed width in world units
  fillColor?: string,                 // Optional background fill (reuses shape's Y.Map key + getFillColor accessor)
  content: Y.XmlFragment,             // Rich text (Tiptap structure)
  ownerId: string,
  createdAt: number
}
// No stored 'frame'. Frame is derived in TextLayoutCache via computeTextBBox().
```

### Origin Semantics

`origin[1]` = baseline of first line. `origin[0]` = alignment anchor:

| `align` | `origin[0]` meaning |
|---------|---------------------|
| `'left'` | Left edge of text block |
| `'center'` | Horizontal center of text block |
| `'right'` | Right edge of text block |

Alignment changes adjust `origin[0]` atomically to preserve the left edge position:
```
leftX = originX - anchorFactor(oldAlign) * W
newOriginX = leftX + anchorFactor(newAlign) * W
```

### Y.XmlFragment Structure

```
Y.XmlFragment
├── Y.XmlElement('paragraph')
│   └── Y.XmlText (delta: [{ insert: 'Hello ', attributes: { bold: true } }, ...])
└── ...
```

---

## Text System Pipeline (`text-system.ts`)

### Pipeline Overview

```
Y.XmlFragment
    ↓ parseAndTokenize()
TokenizedContent { paragraphs, uniformStyles: UniformStyles }
    ↓ measureTokenizedContent(tokenized, fontSize, fontFamily)
MeasuredContent { paragraphs: [{ tokens: MeasuredToken[] }], lineHeight, fontFamily }
    ↓ layoutMeasuredContent(measured, width, fontSize)
TextLayout { lines: MeasuredLine[], fontSize, fontFamily, boxWidth, ... }
```

Tokenize and measure are internal. `layoutMeasuredContent()` is exported for reflow during E/W transforms (SelectTool calls it with cached `MeasuredContent` + new target width). Primary public API: `textLayoutCache.getLayout()`.

### Font Configuration

```typescript
FONT_WEIGHTS = { normal: 450, bold: 700 }

FONT_FAMILIES: Record<FontFamily, FontFamilyConfig> = {
  'Grandstander':   { fallback: '"Grandstander", cursive, sans-serif', lineHeightMultiplier: 1.3 },
  'Inter':          { fallback: '"Inter", sans-serif',                  lineHeightMultiplier: 1.3 },
  'Lora':           { fallback: '"Lora", serif',                        lineHeightMultiplier: 1.3 },
  'JetBrains Mono': { fallback: '"JetBrains Mono", monospace',          lineHeightMultiplier: 1.3 },
}
// Record key IS the CSS font-family name — zero indirection.
```

### Font Metrics (per-family)

All metrics cached per `FontFamily` in Maps. Functions accept optional `fontFamily` parameter (defaults to `'Grandstander'`).

```typescript
getMeasuredAscentRatio(fontFamily?)    // fontBoundingBoxAscent / fontSize, cached per family
                                       // Always normalized by fontSize (not contentArea). Fallback 0.8
getBaselineToTopRatio(fontFamily?)     // = ((lineHeight - contentArea) / 2 + ascent) / fontSize
                                       // Uses CSS half-leading: contentArea = ascent + descent (can differ from fontSize)
                                       // Side-populates _measuredAscentRatio cache on first call
getMinCharWidth(fontSize, fontFamily?) // = getMinCharWidthRatio(fontFamily) * fontSize — reflow clamp
getMinCharWidthRatio(fontFamily?)      // Bold 'W' width / fontSize, cached per family (fallback 0.7)
resetFontMetrics()                     // .clear() all 3 maps (call after font load)
buildFontString(bold, italic, fontSize, fontFamily?)  // → "italic 700 20px \"Inter\", sans-serif"
```

### Stage 1: Tokenizer — `parseAndTokenize()`

Walks `Y.XmlFragment` → paragraph elements → `Y.XmlText` delta ops. Each delta op's insert string is split by regex `/(\s+|\S+)/g` into alternating word/space tokens. Adjacent segments with same bold/italic/highlight coalesce via string concat (no extra object). Highlight color extracted from `attrs.highlight` — multicolor stores `{ color: '#hex' }`, default toggle (no color) → mapped to `'#ffd43b'`.

```
"hello world"     → [word:"hello", space:" ", word:"world"]
"he<b>llo</b> w"  → [word:{seg:"he", seg:"llo"(bold)}, space:" ", word:{seg:"w"}]
```

```typescript
interface Token { kind: 'word' | 'space'; segments: StyledText[]; }
interface StyledText { text: string; bold: boolean; italic: boolean; highlight: string | null; }
interface UniformStyles { allBold: boolean; allItalic: boolean; uniformHighlight: string | null; }
interface TokenizedContent { paragraphs: TokenizedParagraph[]; uniformStyles: UniformStyles; }
```

`uniformStyles` is computed in the same delta op loop as tokenization (zero extra iteration). Tracks whether all text shares the same bold/italic/highlight — used by the context menu to show active state when the editor is not mounted.

### Stage 2: Measurement — `measureTokenizedContent()`

Converts each `StyledText` segment → `MeasuredSegment` by calling `ctx.measureText()` on a singleton offscreen 1x1 canvas (`textRendering: optimizeSpeed`). Produces advance widths per segment.

**Caches:**

| Cache | Size | Key | Purpose |
|-------|------|-----|---------|
| `MEASURE_LRU` | 75k entries | `font + '\0' + text` | Advance width (`number`) |
| `SPACE_WIDTH_CACHE` | Unbounded Map | font string | Single space advance width per font |
| `GRAPHEME_LRU` | 10k entries | text string | `Intl.Segmenter` grapheme split results |

```typescript
interface MeasuredSegment extends StyledText {
  font: string; advanceWidth: number;
  isWhitespace: boolean;
}
interface MeasuredToken { kind: TokenKind; segments: MeasuredSegment[]; advanceWidth: number; }
```

### Stage 3: Flow Engine — `layoutMeasuredContent()`

Converts `MeasuredContent` → `TextLayout` by placing tokens onto lines. Implements CSS `white-space: pre-wrap` + `overflow-wrap: break-word`.

**Two modes:**
- **Auto:** `maxWidth = Infinity` — no wrapping, each paragraph = one line
- **Fixed:** `maxWidth = width` — words wrap at container boundary

#### LineBuilder

Accumulates runs for the current line:
- `advanceX` — total width including all committed runs
- `visualWidth` — width up to end of last non-whitespace run (internal; becomes `alignmentWidth` on `MeasuredLine` via `pushLine`)
- `hasInk` — at least one non-whitespace run exists (flow engine: leading vs inter-word ws distinction)

`appendRun()` coalesces adjacent runs with identical font+highlight via string concat — reduces run count for the renderer.

#### Pending Whitespace State Machine (CSS `pre-wrap` Semantics)

CSS `pre-wrap`: trailing whitespace doesn't cause wrapping, but leading whitespace does. Implemented via a pending buffer:

```
LEADING ws (no ink on line yet) → commit immediately (can overflow — matches pre-wrap)
INTER-WORD ws (auto mode)      → commit immediately (no wrapping)
INTER-WORD ws (fixed mode)     → buffer as pending (pendingSegs[] + pendingW)
```

When next word token arrives in fixed mode:
```
if (currentAdvance + pendingW + wordW ≤ maxWidth)
  → commit pending whitespace, place word on current line
else
  → commit pending (ws runs kept for highlight rendering), push line, place word on new line
```
Committed pending ws on the wrapped line gets the hanging `alignmentWidth` (= `visualWidth`), so it doesn't affect alignment — but the runs exist for highlight rect rendering.

#### Word Placement: `placeWord()`

Three paths:
1. **Fits on current line** → append all segments as runs
2. **Doesn't fit current line, fits empty line** → push line, start new, append word
3. **Oversized (wider than maxWidth)** → `break-word`: iterates segments, each calling `sliceTextToFit()` (binary search at grapheme boundaries via `Intl.Segmenter`). Forward-progress guarantee forces >= 1 grapheme per slice. **Cross-segment guard:** if the forced grapheme overflows remaining space on a non-empty line (`headW > lineRemaining && b.runs.length > 0`), the line is pushed first and the segment retries on a fresh line — prevents multi-segment words from overflowing at style boundaries

#### Main Flow Loop

```
for each paragraph:
  for each token:
    space → leading: commit; auto: commit; fixed inter-word: buffer as pending
    word  → commit/discard pending per fit test, then placeWord()
  end paragraph → commitPending, pushLine, fixupParagraphEnd, new LineBuilder
```

`commitPending` at paragraph end ensures trailing whitespace runs exist in `line.runs` (needed for highlight rendering). `fixupParagraphEnd` then overrides `alignmentWidth` from the hanging default (`visualWidth`) to `min(advanceWidth, maxWidth)` — trailing ws at paragraph end is content, not hanging.

Empty paragraphs produce a blank line. If no lines produced at all, pushes one empty line.

#### Layout-Level Computation

After all lines placed:
- `boxWidth` = auto: max `advanceWidth` across all lines; fixed: the explicit width

### Exported Types

```typescript
interface MeasuredRun {
  text: string; font: string; highlight: string | null;
  advanceWidth: number; advanceX: number;  // X offset from line start
}

interface MeasuredLine {
  runs: MeasuredRun[]; index: number;
  advanceWidth: number;     // Total advance including trailing whitespace runs
  alignmentWidth: number;   // Width for text-align calculation — two behaviors:
  //   Wrap-caused break  → b.visualWidth (trailing ws hangs, excluded)
  //   Paragraph end      → min(advanceWidth, maxWidth) (trailing ws is content)
  baselineY: number;
}

interface TextLayout {
  lines: MeasuredLine[]; fontSize: number; lineHeight: number;
  widthMode: 'auto' | 'fixed';
  boxWidth: number;        // auto → max advanceWidth; fixed → explicit width
}
```

### TextLayoutCache (singleton)

Three-tier cache: content → measurement → flow. Entry stores intermediate results so width-only changes skip tokenize and measure.

```typescript
class TextLayoutCache {
  getLayout(objectId, fragment, fontSize, fontFamily: FontFamily = 'Grandstander', width: TextWidth = 'auto'): TextLayout
  // Cache hit logic (checked in order):
  //   same content + fontSize + fontFamily + width → return cached layout
  //   same content + fontSize + fontFamily, different width → re-flow only
  //   same content, different fontSize or fontFamily → re-measure + re-flow
  //   stale content (or no entry) → full pipeline

  invalidateContent(objectId)  // Content changed → nulls tokenized → forces full pipeline
  invalidateLayout(objectId)   // FontSize changed → nulls measuredFontSize → forces re-measure
  invalidateFlow(objectId)     // Width changed → nulls layoutWidth → forces re-flow
  remove(objectId)             // Object deleted
  clear()                      // Full clear (+ all measurement LRUs)
  setFrame(objectId, frame)    // Derived frame storage (set by computeTextBBox)
  getFrame(objectId): FrameTuple | null
  getMeasuredContent(objectId): MeasuredContent | null  // For reflow (SelectTool E/W transforms)
  getInlineStyles(objectId): UniformStyles | null  // From cached tokenized content
}
export const textLayoutCache: TextLayoutCache;
```

**Width change detection:** `getLayout()` compares `entry.layoutWidth !== width`. Re-flows automatically — no explicit `invalidateFlow()` needed for the render path (but it exists for the observer path). FontFamily change detection works the same way: `entry.measuredFontFamily !== fontFamily` triggers re-measure + re-flow.

### Renderer: `renderTextLayout()`

```typescript
renderTextLayout(ctx, layout, originX, originY, color, align: TextAlign = 'left', fillColor?: string)
```

1. `textBaseline = 'alphabetic'` — origin is first line baseline
2. **Pass 0 (optional):** If `fillColor`, draws a `fillRect` covering the full text block — `getBoxLeftX` for left edge, `boxWidth` for width, `originY - baselineToTop` for top, `lines.length * lineHeight` for height. Works for both auto and fixed modes, scales naturally via `ctx.scale()` during transforms.
3. Per line: `startX = getLineStartX(originX, boxWidth, lineW, align)` where:
   - `lineW = advanceWidth` in auto mode
   - `lineW = alignmentWidth` in fixed mode (handles both wrap-hanging and paragraph-end cases)
4. Pass 1: `fillRect` for runs with `run.highlight` — fixed mode clamps to container bounds (no `ctx.clip`)
5. Pass 2: `fillText` for all runs
6. Highlight rects cover whitespace runs too (matching CSS `<mark>` behavior)
7. Fixed-mode overflow: trailing ws `fillText` past container edge is invisible (no ink); highlight rects are clamped arithmetically via `containerLeft`/`containerRight`

### Alignment Math

```typescript
anchorFactor(align)  // left=0, center=0.5, right=1
getBoxLeftX(originX, boxWidth, align)       // originX - anchorFactor * boxWidth
getLineStartX(originX, boxWidth, lineW, align)
  // left:   boxLeftX
  // center: boxLeftX + (boxWidth - lineW) / 2
  // right:  boxLeftX + (boxWidth - lineW)
```

### BBox + Derived Frame: `computeTextBBox()`

```typescript
computeTextBBox(objectId: string, props: TextProps): BBoxTuple
```

Called from `room-doc-manager` for spatial index (both steady-state and hydration).

1. Gets layout via cache
2. **Derives and caches frame:**
   - `x = getBoxLeftX(originX, boxWidth, align)`
   - `y = originY - fontSize * getBaselineToTopRatio()` (matches DOM container top)
   - `w = boxWidth`, `h = numLines * lineHeight`
3. **Returns frame + 2px padding** as BBoxTuple — matches DOM overlay bounds exactly, covers highlight rects

### Frame Getter

```typescript
getTextFrame(objectId): FrameTuple | null  // Reads derived frame from cache
```

All call sites: `handle.kind === 'text' ? getTextFrame(handle.id) : getFrame(handle.y)`

### Inline Styles Getter

```typescript
getInlineStyles(objectId): UniformStyles | null  // From cached tokenized content
```

Returns `null` if the object hasn't been cached yet. Used by context menu for bold/italic/highlight active state when the editor is not mounted.

---

## Undo/Redo Architecture

Two-tier UndoManager system for text editing.

### Per-Session UndoManager (TextCollaboration extension)

Created fresh on each editor mount. Provides in-editor Cmd+Z/Cmd+Y.

**Scope:** `[Y.XmlFragment, Y.Map]` — tracks both content edits AND property changes (fontSize, color, align, origin, width). This means Cmd+Z while editing can undo a font size change made via the context menu.

**Tracked origins:**
- `ySyncPluginKey` — ProseMirror → Y.XmlFragment sync transactions (typing, formatting)
- `userId` — `roomDoc.mutate()` changes to Y.Map properties (context menu actions)

**Cursor fix:** yUndoPlugin stores cursors as Y.js RelativePositions (buggy). `selectionFixPlugin` stores raw ProseMirror positions on stack items, corrects selection after undo/redo via `applyPendingSelection()`.

**Cleanup:** Extension `onDestroy()` calls `undoManager.clear()` to release CRDT GC protection held by stack items.

### Main UndoManager (room-level, RoomDocManager)

Tracks all objects map changes. Tracked origins: `[userId, ySyncPluginKey]` — the `ySyncPluginKey` origin is critical: without it, text content edits (which use `ySyncPluginKey` as transaction origin) would be invisible to the main undo stack.

The TextCollaboration extension manipulates it for **atomic session merging**:

```
onCreate():                                    // Editor mounted
  mainUndoManager.stopCapturing()              // Force new capture group boundary
  mainUndoManager.captureTimeout = 600_000     // 10 min — merge all edits into one item

onDestroy():                                   // Editor unmounting
  mainUndoManager.stopCapturing()              // Seal the capture group
  mainUndoManager.captureTimeout = 500         // Restore normal batching
```

**Effect:** All text edits during one editing session (content + properties) merge into a single undo item on the main stack. After closing the editor, Cmd+Z at room level undoes the entire text session atomically.

### Y.Map Observer (DOM Sync on Undo/Redo)

The extension registers a Y.Map observer that fires when tracked properties change. When the per-session UndoManager undoes/redoes a property change, the observer calls `TextTool.syncProps()` to update the DOM overlay:

```
Per-session undo of fontSize change
  → Y.Map 'fontSize' mutated
  → observer fires (keysChanged has 'fontSize')
  → onPropsSync(keys) → TextTool.syncProps()
    → reads fresh from Y.Map → updates container CSS / repositions editor
```

Without this observer, undoing a property change would update the CRDT but the DOM overlay would show stale values.

**Tracked keys:** `origin`, `fontSize`, `fontFamily`, `color`, `fillColor`, `align`, `width`.

---

## TextTool (`TextTool.ts`)

### State

Flat class fields — no wrapper objects. Editor state reads Y.Map fresh (no duplicated fields for origin/fontSize/color/align/width):

```typescript
// Gesture state
private gestureActive = false;
private pointerId: number | null = null;
private downWorld: [number, number] | null = null;
private hitTextId: string | null = null;

// Editor state
private container: HTMLDivElement | null = null;
private editor: Editor | null = null;
objectId: string | null = null;  // public — mirrors textEditingId
```

### PointerTool Lifecycle

```
begin() → hit test via hitTestVisibleText() → store hitTextId
end()   → hitTextId ? mountEditor(hitTextId, false) : createTextObject → mountEditor(id, true)
```

### SelectTool Integration

SelectTool mounts the editor for existing text via `textTool.startEditing(objectId, entryPoint)`:

```
Click 1 (unselected text): objectOutsideSelection → setSelection([id]) — text is now sole selection
Click 2 (single selected text): objectInSelection → textTool.startEditing() → editor mounts
```

Double-click works naturally via this two-click state machine (no timer needed). Multi-selection drill-down follows the same pattern: click 1 drills to single, click 2 mounts.

**Guards during text editing** (SelectTool reads `store.textEditingId`):
- Handle hit testing skipped in `begin()` — no scale gestures while editing
- Handle hover cursors skipped in `handleHoverCursor()` — no resize cursors
- Handles nulled in `getPreview()` — no visual handles on overlay
- `onViewChange()` forwards to `textTool.onViewChange()` — repositions DOM overlay on zoom/pan

**Click-outside:** `pointerdown` on document (capture phase, 100ms delayed registration). Uses `pointerdown` not `mousedown` because CanvasRuntime calls `e.preventDefault()` which suppresses compatibility `mousedown` per spec. Guards:
- `e.button !== 0` → skip (MMB pan / right-click work while editing)
- Target inside container or `.ctx-menu` → skip (editing / menu clicks pass through)
- After `commitAndClose()`: `e.stopPropagation()` only when `activeTool === 'text'` AND target is canvas — prevents creating a new text object on click-off. When SelectTool is active, the event passes through so the clicked object gets selected in one click.

### createTextObject

```typescript
yObj.set('fontFamily', fontFamily);      // From useDeviceUIStore.textFontFamily
if (textFillColor) yObj.set('fillColor', textFillColor);  // From useDeviceUIStore.textFillColor
yObj.set('width', DEV_FORCE_FIXED_WIDTH ? 270 : 'auto');  // Temporary dev boolean
```

### mountEditor

Reads props from Y.Map, creates container div, positions it, then creates Tiptap Editor with:

```typescript
TextCollaboration.configure({
  fragment,                                        // Y.XmlFragment for content sync
  yObj: handle.y,                                  // Y.Map — added to per-session UM scope
  userId: userProfileManager.getIdentity().userId, // For tracked origins
  mainUndoManager: roomDoc.getUndoManager(),       // For session merging
  onPropsSync: (keys) => this.syncProps(keys),     // DOM sync on undo/redo
})
```

**Font family:** `container.style.fontFamily = FONT_FAMILIES[fontFamily].fallback` — inline style overrides CSS default.

**Fill color:** If `getFillColor(handle.y)` is truthy, sets `container.style.backgroundColor` — plain rect matching canvas `fillRect` (WYSIWYG).

**Width handling:**
```typescript
if (typeof width === 'number') {
  container.style.width = `${width * scale}px`;  // World units → screen pixels
  container.dataset.widthMode = 'fixed';
} else {
  container.dataset.widthMode = 'auto';           // CSS max-content applies
}
```

### DOM Positioning Math

```
Container top = screenY - (scaledFontSize * getBaselineToTopRatio(fontFamily))
```

Also sets `--hl-pad` CSS variable for dynamic highlight padding (see CSS Architecture).

### syncProps — Y.Map → DOM Overlay

Called by extension's Y.Map observer on undo/redo of property changes:
- Reads values fresh from `handle.y` — no local state to update
- `color` → sets CSS variable; `fillColor` → sets `container.style.backgroundColor` (or clears it); `align` → `applyAlignCSS()`
- `origin`/`fontSize`/`fontFamily`/`width` → delegates to `positionEditor()` which reads all from Y.Map

### commitAndClose

```typescript
editor.destroy();                          // Triggers extension onDestroy → seals session, clears per-session UM
(editor as any).editorState = null;        // Tiptap doesn't null this — release EditorState + plugin states
```

Empty new text objects are deleted before destroy.

### Alignment CSS

```typescript
container.style.setProperty('--text-align', align);
container.style.setProperty('--text-anchor-tx',
  align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%');
```

### Access

No singleton indirection — `textTool` exported directly from `tool-registry.ts`. Public fields: `objectId`, `isEditorMounted()`, `getEditor()`, `getContainer()`.

---

## TextCollaboration Extension (`extensions.ts`)

Custom Tiptap extension replacing `@tiptap/extension-collaboration`.

### Options

```typescript
interface TextCollaborationOptions {
  fragment: XmlFragment | null;           // Y.XmlFragment for content sync
  yObj: Y.Map<unknown> | null;            // Y.Map — added to per-session UM scope
  userId: string | null;                  // mutate() origin for tracked origins
  mainUndoManager: Y.UndoManager | null;  // Room-level UM for session merging
  onPropsSync: ((keys: Set<string>) => void) | null;  // DOM sync callback
}
```

### Plugin Setup (`addProseMirrorPlugins`)

```typescript
scope = [fragment, yObj]                           // Content + property undo
origins = new Set([ySyncPluginKey, userId])         // Sync plugin + mutate()
undoManager = new Y.UndoManager(scope, { trackedOrigins: origins, captureTimeout: 500 })
plugins = [ySyncPlugin(fragment), yUndoPlugin({ undoManager }), selectionFixPlugin]
```

### Lifecycle

```
onCreate():   stopCapturing + set captureTimeout=10min on main UM; observe yObj for property changes
onDestroy():  unobserve yObj; stopCapturing + restore captureTimeout=500 on main UM; clear per-session UM
```

### Memory Leak Fix

Official `@tiptap/extension-collaboration` captures `_observers` into a restore closure on destroy, preventing GC of detached EditorView DOM trees (linear leak in short-lived editors). This extension registers plugins directly without suspend/restore.

---

## CSS Architecture (`index.css`)

Container element IS the Tiptap/ProseMirror element directly (Tiptap v3 `{mount: container}` API — no wrapper div). Container gets `.tiptap` + `.ProseMirror` classes on the same element.

```css
.tiptap {
  font-family: "Grandstander", cursive, sans-serif;
  font-weight: 450;
  white-space: pre-wrap;
  overflow-wrap: break-word;       /* Safe default — no-op in auto (max-content) */
  width: max-content;              /* Auto mode: grows with content */
  transform: translateX(var(--text-anchor-tx, 0%));
  text-align: var(--text-align, left);
  color: var(--text-color, #000000);
}

.tiptap[data-width-mode="fixed"] {
  outline: 1px solid #1d4ed8;
  overflow: hidden;                /* Clip trailing whitespace + highlight overflow */
}

.tiptap mark {
  background-color: #ffd43b;
  padding-block: var(--hl-pad, 0.15em);          /* Extends to full line-height */
  margin-block: calc(-1 * var(--hl-pad, 0.15em)); /* Cancel layout shift */
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
```

**`--hl-pad` CSS variable:** Set by TextTool in `mountEditor()` and `positionEditor()` as `getBaselineToTopRatio(fontFamily) - getMeasuredAscentRatio(fontFamily)` — this is the actual CSS half-leading for the current font. For Grandstander (content area ≈ em-square) it's ~0.15em. For fonts with larger content areas (Inter, Lora, JetBrains Mono) it's smaller, preventing highlight backgrounds from overflowing line box boundaries. The 0.15em fallback covers the case where the variable isn't set.

**JS inline styles** (zoom-dependent): `fontSize`, `lineHeight`, `left`, `top`, `width` (fixed mode), `--hl-pad`.

---

## Canvas Rendering (`objects.ts`)

```typescript
function drawText(ctx, handle) {
  if (useSelectionStore.getState().textEditingId === handle.id) return;  // Skip if editing
  const props = getTextProps(handle.y);
  const fillColor = getFillColor(handle.y);
  const layout = textLayoutCache.getLayout(id, props.content, props.fontSize, props.width);
  renderTextLayout(ctx, layout, props.origin[0], props.origin[1], color, props.align, fillColor);
}
```

`fillColor` is also passed through in `drawScaledTextPreview` and `drawReflowedTextPreview` — the fill rect scales naturally via `ctx.scale()` or adapts to reflow layout dimensions.

### Scale Transform Preview (`drawScaledTextPreview` / `drawReflowedTextPreview`)

**Corner handles:** `drawScaledTextPreview` — renders via `ctx.scale()` on the cached layout, no re-layout per frame. Computes new virtual origin in scaled frame, then `ctx.translate + ctx.scale + renderTextLayout(ctx, layout, 0, 0, ...)`.

**E/W side handles:** `drawReflowedTextPreview` — reads pre-computed `TextLayout` and origin from `TextReflowState` on the selection store (computed per-frame in `invalidateTransformPreview`). Calls `renderTextLayout` with the reflow layout directly — no ctx transform needed.

---

## Room Doc Manager Integration

### Main UndoManager

```typescript
this.undoManager = new Y.UndoManager([objects], {
  trackedOrigins: new Set([this.userId, ySyncPluginKey]),
  captureTimeout: 500,
});
```

`ySyncPluginKey` is critical: ProseMirror's Y.js sync plugin writes to Y.XmlFragment with this origin. Without tracking it, the main UndoManager would ignore text content changes.

### Deep Observer

```typescript
if (field === 'content') {
  textLayoutCache.invalidateContent(id);
  textContentChangedIds.add(id);
} 
// 'width', 'fontSize', changes handled by comparison in getLayout()
// 'origin'/'color' don't need cache invalidation
```

### Deletion / Rebuild

```typescript
if (handle.kind === 'text') textLayoutCache.remove(id);  // Deletion
textLayoutCache.clear();                                   // Full rebuild
```

---

## Derived Frame

Text has no stored `frame` in Y.Map — derived from origin/fontSize/align/content/width, cached in `TextLayoutCache`, read via `getTextFrame(objectId)`.

**Frame = BBox:** `computeTextBBox()` returns frame + 2px padding — matches DOM overlay bounds exactly. Both `getTextFrame()` and the spatial index BBox derive from the same logical frame.

**Frame consumers:** `hit-testing.ts`, `EraserTool.ts`, `selection-overlay.ts`, `SelectTool.ts`, `connectors/*`, `bounds.ts`.

---

## Scale Transforms (SelectTool)

Uniform scaling of text via corner and N/S handle drag. Matches stroke uniform-scale pattern — center-based position preservation with `computePreservedPosition()`.

### Handle Behavior

| Selection | Handle | Text behavior |
|-----------|--------|---------------|
| textOnly / mixed | corner | Uniform scale (fontSize + origin + width) |
| textOnly / mixed | E/W side | Reflow: changes width, re-layouts text, converts auto→fixed on commit |
| textOnly | N/S side | Uniform scale (mirrors corner — fontSize + origin + width) |
| mixed | N/S side | Edge-pin translate via `computeEdgePinTranslation()` (mirrors stroke mixed+side) |

### Math — Font Size Rounding

Font size is rounded to 3 decimal places (`Math.round(fontSize * absScale * 1000) / 1000`). The effective scale is then derived back from the rounded font size (`roundedFontSize / originalFontSize`). This ensures preview and commit produce identical geometry. At fontSize 20, this gives 20,000 distinct steps between scale 1.0→2.0 — visually imperceptible.

### Math — Origin Derivation

Text frame is derived (not stored). After computing the new scaled frame `[nfx, nfy, nfw, nfh]`:

```
newOriginX = nfx + anchorFactor(align) * nfw    // left=0, center=0.5, right=1
newOriginY = nfy + roundedFontSize * getBaselineToTopRatio()
```

Position preservation uses raw `uniformScale` (continuous cursor tracking). Font size and dimensions use `effectiveAbsScale` (rounded/quantized).

### Preview (`objects.ts` → `drawScaledTextPreview`)

Corner + textOnly N/S: no re-layout per frame — reuses the cached `TextLayout` at the original font size. Visual scaling via `ctx.translate(newOriginX, newOriginY)` + `ctx.scale(effectiveAbsScale, effectiveAbsScale)` + `renderTextLayout(ctx, layout, 0, 0, ...)`. Mixed N/S: `ctx.translate(dx, dy)` + `drawText()` (edge-pin, no scaling).

### Commit (`SelectTool.ts` → `commitScale`)

Corner + textOnly N/S: writes to Y.Map: `origin` (derived from new frame), `fontSize` (rounded), and `width` (scaled, only if fixed-width). Mixed N/S: translates `origin[1]` by `dy` from `computeEdgePinTranslation()`. The deep observer fires → `computeTextBBox()` re-derives the frame from the new properties → spatial index updates.

### Topology Integration (`transform.ts`)

`transformFrameForTopology` and `transformPositionForTopology` use uniform scale for `textOnly` (not just `mixed`), ensuring connectors attached to text objects reroute correctly during scale drag and on commit.

### E/W Reflow (Side Handle Width Change)

`TextReflowState` on the selection store holds mutable per-frame maps (`layouts`, `origins`). Initialized in `beginScale` when E/W handle + text objects present.

**Per-frame in `invalidateTransformPreview`:**
1. Scale both frame edges from origin: `scaledLeft = ox + (fx - ox) * scaleX`, same for right
2. `min/max` normalization handles handle crossing (scaleX < 0)
3. Width clamped to `getMinCharWidth(fontSize)` — natural dead zone at minimum
4. Anchor clamping: when clamped, pins edge closest to scale origin
5. `layoutMeasuredContent(measured, targetWidth, fontSize)` — reuses cached `MeasuredContent` (skips tokenize + measure)
6. New origin: `newOriginX = newLeft + anchorFactor(align) * targetWidth`, Y unchanged
7. Results stored in `textReflow.layouts` / `textReflow.origins`

**Commit:** Writes `width` (= `layout.boxWidth`) + `origin` to Y.Map. Converts auto-width text to fixed-width. Deep observer fires → `computeTextBBox()` re-derives frame.

**Rendering:** `drawReflowedTextPreview` in `objects.ts` reads pre-computed layout/origin from store.

### Dirty Rect Tracking (`invalidateTransformPreview`)

Corner + textOnly N/S: `getTextFrame()` → `frameTupleToWorldBounds()` → `computeUniformScaleBounds()`. E/W handles: derives bounds from reflow layout (`[newLeft, fy, targetWidth, newHeight]`). Mixed N/S: `computeEdgePinTranslation()` → `translateBounds()`.

---

## WYSIWYG Parity Contract

DOM and canvas match because:
- Same font (per-family, 450/700 weight), same `pre-wrap` + `break-word`, same container width
- Same line-height (`fontSize * lineHeightMultiplier`)
- Same vertical positioning via `getBaselineToTopRatio(fontFamily)` — uses CSS half-leading formula with measured `fontBoundingBoxAscent`/`Descent`, correct for all fonts regardless of content area size
- Canvas flow engine implements identical whitespace semantics (pending whitespace pattern)
- Fill color: CSS `background-color` on container ↔ canvas `fillRect` covering same block bounds
- Sub-pixel differences (~0.5px) expected from per-token vs native text shaping

---

## Highlight Support

Multicolor text highlighting via `@tiptap/extension-highlight` (DOM) + canvas pipeline.

### DOM (Tiptap)
- `Highlight.configure({ multicolor: true })` in TextTool editor extensions
- Renders `<mark style="background-color: #hex">` for explicit colors, plain `<mark>` for default toggle
- CSS on `.tiptap mark`: `border-radius: 0.25em`, extends background to full line-height via `padding-block: var(--hl-pad)` + `margin-block: calc(-1 * var(--hl-pad))` — `--hl-pad` is the per-font half-leading set by TextTool
- Default color: `#ffd43b` (first entry in `HIGHLIGHT_COLORS` palette)

### Canvas Pipeline
- `highlight: string | null` field on `StyledText` → threaded through tokenizer, measurement, flow engine coalesce checks, renderer
- `parseAndTokenize()`: extracts from `attrs.highlight` — `{ color: '#hex' }` → that color, presence without color → `'#ffd43b'`
- `renderTextLayout()`: two-pass per line — pass 1 draws `roundRect` (radius `fontSize * 0.25`, matches CSS `border-radius: 0.25em`) for highlighted runs, pass 2 draws `fillText`
- Fixed-mode highlight rects clamped to `[containerLeft, containerRight]` via arithmetic (no `ctx.clip`); clamped sides get flat edge (radius 0) to match CSS `overflow:hidden`
- Highlight rects cover whitespace runs too (matching CSS `<mark>` behavior) — trailing ws runs are committed (not discarded) at wrap points so highlights render
- No measurement impact — highlight is rendering-only, rides existing pipeline

### Context Menu
- `editor.isActive('highlight')` drives button active state
- `editor.isActive('highlight', { color })` drives per-swatch active state in submenu
- Click swatch → `editor.chain().focus().setHighlight({ color }).run()`
- Click none → `editor.chain().focus().unsetHighlight().run()`
- Icon color synced from `editor.getAttributes('highlight').color` on every selection/transaction

---

## Changelog — Multi-Font Setup

### Font Files (`client/public/fonts/`)

Replaced 4 static single-weight Grandstander files with 8 variable fonts (4 families × upright + italic):

| File | Size | Notes |
|------|------|-------|
| `Grandstander.woff2` / `-Italic.woff2` | 34 / 35 KB | ss01 baked as default glyphs, ss02/dlig/liga stripped |
| `Inter.woff2` / `-Italic.woff2` | 26 / 28 KB | `opsz` axis pinned to 14 (eliminates WYSIWYG variability) |
| `Lora.woff2` / `-Italic.woff2` | 34 / 37 KB | — |
| `JetBrainsMono.woff2` / `-Italic.woff2` | 15 / 16 KB | No kern (monospace), `calt` stripped (coding ligatures) |

**All fonts:** variable `wght 450–700`, Latin subset only, `liga`/`calt`/`dlig` stripped at font level (canvas has no `font-variant-ligatures: none` — stripping is the only cross-browser WYSIWYG fix). Features kept: `kern`, `mark`, `mkmk`, `ccmp`, `locl`. Hints removed. Total: 223 KB (down from 1250 KB source).

**Subsetting pipeline:** `fontTools.varLib.instancer` (axis restriction) → `normalize_font()` (BytesIO round-trip to fix stale HVAR refs) → ss01 baking (Grandstander only: 59 cmap remaps) → `fontTools.subset` (Latin range, feature allowlist, dehint) → woff2 compress. Python venv at `.venv/` (gitignored).

### Weight Change (550/800 → 450/700)

Lora's max weight is 700, so all fonts are now clamped to `wght 450–700`.

- `font-config.ts`: `weightNormal: 450`, `weightBold: 700` — propagates to `buildFontString()` (canvas) and `font-loader.ts`
- `index.css`: `.tiptap { font-weight: 450 }`, `.tiptap strong { font-weight: 700 }`
- `index.css`: 8 `@font-face` declarations with `font-weight: 450 700` range syntax
- Tiptap Bold extension unchanged — renders `<strong>`, CSS controls weight

---

## Shape Labels

Text labels inside shapes (rect, ellipse, diamond, roundedRect). Reuses the full text pipeline — same Y.XmlFragment, same tokenizer/measure/layout, same Tiptap editor — but with shape-aware positioning, text box computation, and a dedicated canvas renderer.

### Y.Doc Schema (Label Fields on Shape Object)

Labels are NOT separate objects. They add fields directly to the existing shape Y.Map:

```typescript
// Existing shape fields (unchanged)
{ id, kind: 'shape', shapeType, color, width, opacity, fillColor?, frame, ownerId, createdAt }

// Label fields (added on first edit, removed if empty on close)
{
  content: Y.XmlFragment,     // Rich text — same structure as text objects
  fontSize: number,            // World units
  fontFamily: FontFamily,      // 'Grandstander' | 'Inter' | 'Lora' | 'JetBrains Mono'
  labelColor: string,          // Text color (separate from shape border `color`)
}
```

**Key difference from text objects:** No `origin`, `align`, or `width` fields. Labels are always center-aligned H+V within the inscribed text box, and width is derived from the shape frame. Color uses `labelColor` (not `color`, which is the shape border color).

### Accessors (`object-accessors.ts`)

```typescript
getLabelColor(y, fallback = '#000'): string   // Reads 'labelColor' key
hasLabel(y): boolean                           // y.get('content') instanceof Y.XmlFragment
```

`hasLabel()` is the canonical check — shapes without labels have no `content` key. Existing `getFontSize()`, `getFontFamily()`, `getContent()` work unchanged (same key names, separate Y.Map instances).

### Text Box Computation (`text-system.ts` → `computeLabelTextBox`)

```typescript
computeLabelTextBox(shapeType: string, frame: FrameTuple): FrameTuple
```

Pure function. Returns the max inscribed text rectangle within the shape, inset by `LABEL_PADDING = 10`:

| Shape | Inscribed rect | Math |
|-------|---------------|------|
| rect, roundedRect | Frame minus padding | `[fx+pad, fy+pad, fw-2*pad, fh-2*pad]` |
| ellipse | Max inscribed rect of ellipse, minus padding | `a√2 × b√2` centered, then inset by pad |
| diamond | Half-size rect centered | `w/2 × h/2` centered, then inset by pad |

`Math.max(0, ...)` prevents negative dimensions on tiny shapes — `renderShapeLabel` and `drawShapeLabel` early-return when dims ≤ 0.

Rect and roundedRect share the same formula — roundedRect's max corner inset (~5.86px at default radius) is less than the 10px padding, so the full inscribed rect is within the rounded area.

### Canvas Rendering

**At rest — `drawShapeLabel()`** (`objects.ts`):

Called at end of `drawShape()` inside the opacity `ctx.save()`/`ctx.restore()` scope, gated by `hasLabel(y)`. Skips if `textEditingId === handle.id` (DOM overlay handles it during editing).

```
drawShape() → stroke/fill shape → if (hasLabel) drawShapeLabel() → ctx.restore()
```

Calls `textLayoutCache.getLayout()` with the text box width — this goes through the normal three-tier cache (content → measure → layout). Width changes from shape resizing trigger re-flow automatically via the cache's width comparison.

**During transforms — `drawShapeLabelWithFrame()`** (`objects.ts`):

Used by `drawShapeWithTransform()` (non-uniform scale) and `drawShapeWithUniformScale()` (mixed + corner). Takes an explicit transformed frame instead of reading from Y.Map.

Does NOT call `textLayoutCache.getLayout()` — instead reads cached `MeasuredContent` via `textLayoutCache.getMeasuredContent()` and calls `layoutMeasuredContent()` directly with the ephemeral text box width. This avoids polluting the cache with transient transform frame widths that would cause staleness bugs on gesture cancel. The `MeasuredContent` is guaranteed fresh because the shape was rendered at rest (triggering `getLayout`) before any transform begins.

**Translate transforms** work automatically — `ctx.translate(dx,dy)` + `drawObject` → `drawShape` → `drawShapeLabel` inherits the translate context.

### Shape Label Renderer (`text-system.ts` → `renderShapeLabel`)

```typescript
renderShapeLabel(ctx, layout, textBox, color, fontFamily)
```

Differs from `renderTextLayout` in positioning strategy:

- **Horizontal:** Always center-aligned. `startX = tbx + (tbw - lineW) / 2` — no origin/anchorFactor indirection
- **Vertical:** Content block centered in text box. `contentTopY = tby + (tbh - contentHeight) / 2`. First baseline = `contentTopY + baselineToTop`
- **Overflow:** When `contentHeight > tbh`, content clamps to top of text box (`contentTopY = tby`) and clips via `ctx.clip()` with a rect matching the text box. This matches the DOM behavior where `overflow: hidden` + ProseMirror internal scroll clips at the container edge
- **Highlights:** Same highlight rect rendering as `renderTextLayout` — `roundRect` with `fontSize * 0.25` radius, clamped to text box bounds

### DOM Editing (TextTool)

#### Entry Point

SelectTool drill-down handles both text objects and shapes:

```
Click 1 on shape → select
Click 2 on selected shape → textTool.startEditing(shapeId, clickPos)
```

`startEditing()` checks `handle.kind === 'shape'`:
- If no label exists (`!hasLabel(handle.y)`): creates label fields in a single transaction (`content`, `fontSize`, `fontFamily`, `labelColor` from device-ui-store defaults)
- Then mounts editor with `isNew = isNewLabel`

#### No Stored `isLabel` Flag

TextTool derives label vs text mode from `handle.kind === 'shape'` inline at every call site (mountEditor, positionEditor, syncProps, commitAndClose). No stored `isLabel` field — future object kind mutations (text↔shape) convert seamlessly.

#### mountEditor — Label Branch

Positioning: text box center via `worldToClient(tbx + tbw/2, tby + tbh/2)`, CSS transform `translate(-50%, -50%)` centers the DOM content block at that point.

```typescript
container.style.setProperty('--text-anchor-tx', '-50%');
container.style.setProperty('--text-anchor-ty', '-50%');
container.style.maxWidth = `${tbw * scale}px`;
container.style.maxHeight = `${tbh * scale}px`;
container.dataset.widthMode = 'label';
container.style.setProperty('--text-color', getLabelColor(handle.y));
```

Key differences from text objects:
- Uses `maxWidth`/`maxHeight` (not `width`) — content auto-grows up to text box bounds
- Color from `getLabelColor()` (not `getColor()`)
- No `backgroundColor` — the shape itself is the visual background
- No Placeholder extension — empty labels show nothing
- `data-width-mode='label'` — triggers CSS for center align + scrollable overflow (hidden scrollbar) + placeholder suppression

#### positionEditor — Label Branch

Reads `getFrame(handle.y)` + `getShapeType(handle.y)` → `computeLabelTextBox()` → updates `left`, `top`, `maxWidth`, `maxHeight`, font sizing. Called on pan/zoom (`onViewChange`) and on undo/redo of shape properties.

#### syncProps — Label Branch

Tracked keys for labels: `labelColor` → `--text-color`, `frame`/`shapeType`/`fontSize`/`fontFamily` → `positionEditor()`. Does NOT react to `fillColor` changes (shape IS the background) or `color` changes (that's the shape border).

#### commitAndClose — Label Cleanup

If `editor.isEmpty` and `handle.kind === 'shape'`: deletes only label fields (`content`, `fontSize`, `fontFamily`, `labelColor`). The shape persists. Text objects still delete the entire object. On close, sets `justClosedLabelId` for shape labels to prevent remount (see below).

#### Label Editing UX (TextTool ↔ SelectTool coordination)

Shape label containers are smaller than the shape bounds (inscribed text box). This creates two interactions that differ from text objects:

1. **Remount prevention:** Clicking the shape body outside the text container fires `commitAndClose()` (capture phase) then reaches SelectTool `end()` (bubble phase). Without a guard, SelectTool sees an in-selection shape with no editor and calls `startEditing()` — unwanted remount. Fix: `justClosedLabelId` flag set in `commitAndClose()`, checked and consumed in SelectTool `end()`. Unconditionally cleared at end of `end()`/`cancel()`.

2. **Handles visible during label editing:** Unlike text objects (whose container covers the full bounds), label containers don't occlude handles. SelectTool's `isEditingLabel()` checks allow handle hit-testing, handle rendering, and hover cursor during shape label editing. Text object editing still suppresses handles.

### CSS (`index.css`)

```css
.tiptap {
  transform: translateX(var(--text-anchor-tx, 0%)) translateY(var(--text-anchor-ty, 0%));
  /* --text-anchor-ty added for label vertical centering, defaults to 0% — existing text unaffected */
}

.tiptap[data-width-mode='label'] {
  overflow-x: hidden;
  overflow-y: auto;
  text-align: center;
  scrollbar-width: none;  /* Firefox */
}
.tiptap[data-width-mode='label']::-webkit-scrollbar {
  display: none;           /* Chrome/Safari */
}

.tiptap[data-width-mode='label'] .is-editor-empty:first-child::before {
  display: none;
}
```

### Extension Observer (`extensions.ts`)

Additional tracked keys: `labelColor`, `frame`, `shapeType`. These fire `onPropsSync` when the shape is resized, type-changed, or label color is changed during editing. Harmless for text objects (they never have these keys changed during editing).

### Cache Integration

- **At rest:** `drawShapeLabel` → `textLayoutCache.getLayout(shapeId, ...)` — normal three-tier cache, width = text box width
- **Deep observer:** `field === 'content'` → `invalidateContent(id)` — works for shapes too (same key name)
- **Deletion:** `textLayoutCache.remove(id)` for both `kind === 'text'` and `kind === 'shape'` — no-op for shapes without labels (no cache entry)
- **Transform preview:** `getMeasuredContent()` + `layoutMeasuredContent()` — no cache writes, no staleness

### WYSIWYG Parity

DOM and canvas label rendering match because:
- Both center content horizontally within the text box (`text-align: center` ↔ `tbx + (tbw - lineW) / 2`)
- Both center content vertically (CSS `translate(-50%, -50%)` from text box center ↔ canvas `tby + (tbh - contentHeight) / 2`)
- Both clip overflow (`overflow-y: auto` + `maxHeight` ↔ `ctx.clip()`) — DOM scrolls during editing, canvas clips at rest
- Same font metrics, same line height, same `baselineToTop` ratio
- After editor close, ProseMirror scrollTop resets — canvas "rest position" matches the DOM un-scrolled state

### Edge Cases

- **Empty label on close:** Label fields deleted, shape persists, layout cache cleaned up
- **Shape deletion with label:** `textLayoutCache.remove(id)` cleans cache; Y.Map deletion includes label fields
- **Undo label creation:** Main UndoManager reverses field additions; `hasLabel()` returns false; shape renders without label
- **Shape resize during editing:** `frame` key change → extension observer fires → `syncProps` → `positionEditor()` updates DOM position + maxWidth/maxHeight
- **Tiny shapes:** `computeLabelTextBox` returns 0 dims → rendering early-returns → label invisible but Y.XmlFragment content preserved
- **Collaboration:** Y.XmlFragment CRDT + TextCollaboration ySyncPlugin handle concurrent label edits identically to text objects
- **Shape type change during editing:** `shapeType` key tracked by extension observer → `positionEditor()` recomputes text box for new shape geometry
- **Click shape body during label editing:** Editor closes, shape stays selected, editor does NOT remount (justClosedLabelId guard); next click re-opens
- **Handle click during label editing:** Capture phase closes editor → textEditingId null → begin() tests handles normally → scale gesture starts

### Not Yet Implemented

- Context menu `labelColor` vs `color` routing
- `computeStyles` / `selection-actions` adaptations for label-aware text controls on shapes
- Font size scaling of labels during shape uniform-scale transforms (font size stays fixed, only text box adapts)

---

## Remaining Work

- **`DEV_FORCE_FIXED_WIDTH` removal** — temporary; remove now that resize handles have landed
- **Live width changes during editing** — resize while editor mounted
