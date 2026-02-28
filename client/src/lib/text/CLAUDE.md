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
| `lib/text/font-config.ts` | `FONT_CONFIG` constants (extracted to avoid circular deps) |
| `lib/text/font-loader.ts` | `ensureFontsLoaded()`, `areFontsLoaded()` |
| `lib/text/TextContextMenu.ts` | Legacy floating toolbar (inactive — will be replaced by new context menu system) |
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
  color: string,                       // Hex color
  align: 'left' | 'center' | 'right', // TextAlign
  width: 'auto' | number,             // TextWidth — 'auto' or fixed width in world units
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
    ↓ measureTokenizedContent(tokenized, fontSize)
MeasuredContent { paragraphs: [{ tokens: MeasuredToken[] }], lineHeight }
    ↓ layoutMeasuredContent(measured, width, fontSize)
TextLayout { lines: MeasuredLine[], boxWidth, ... }
```

All three stages are **internal**. Public API: `textLayoutCache.getLayout()`.

### Font Configuration

```typescript
FONT_CONFIG = {
  family: 'Grandstander',
  fallback: '"Grandstander", cursive, sans-serif',
  weightNormal: 550, weightBold: 800,
  lineHeightMultiplier: 1.3,
}
```

### Font Metrics

```typescript
getMeasuredAscentRatio()    // Canvas fontBoundingBoxAscent at 100px, cached
                            // Handles fonts with line-gap: ascent / totalHeight
                            // Fallback 0.73 if fonts not loaded (would measure wrong font)
getBaselineToTopRatio()     // = halfLeading + ascentRatio = (1.3-1)/2 + measuredAscent
                            // Exact distance from baseline to DOM container top (as fontSize ratio)
resetFontMetrics()          // Clear cached metrics (call after font load)
buildFontString(bold, italic, fontSize)  // → "italic 800 20px ..."
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
3. **Oversized (wider than maxWidth)** → `break-word`: `sliceTextToFit()` does binary search at grapheme boundaries via `Intl.Segmenter`, forces >= 1 grapheme per line for forward progress

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
  getLayout(objectId, fragment, fontSize, width: TextWidth = 'auto'): TextLayout
  // Cache hit logic (checked in order):
  //   same content + fontSize + width → return cached layout
  //   same content + fontSize, different width → re-flow only (layoutMeasuredContent)
  //   same content, different fontSize → re-measure + re-flow
  //   stale content (or no entry) → full pipeline

  invalidateContent(objectId)  // Content changed → nulls tokenized → forces full pipeline
  invalidateLayout(objectId)   // FontSize changed → nulls measuredFontSize → forces re-measure
  invalidateFlow(objectId)     // Width changed → nulls layoutWidth → forces re-flow
  remove(objectId)             // Object deleted
  clear()                      // Full clear (+ all measurement LRUs)
  setFrame(objectId, frame)    // Derived frame storage (set by computeTextBBox)
  getFrame(objectId): FrameTuple | null
  getInlineStyles(objectId): UniformStyles | null  // From cached tokenized content
}
export const textLayoutCache: TextLayoutCache;
```

**Width change detection:** `getLayout()` compares `entry.layoutWidth !== width`. Re-flows automatically — no explicit `invalidateFlow()` needed for the render path (but it exists for the observer path).

### Renderer: `renderTextLayout()`

```typescript
renderTextLayout(ctx, layout, originX, originY, color, align: TextAlign = 'left')
```

1. `textBaseline = 'alphabetic'` — origin is first line baseline
2. Per line: `startX = getLineStartX(originX, boxWidth, lineW, align)` where:
   - `lineW = advanceWidth` in auto mode
   - `lineW = alignmentWidth` in fixed mode (handles both wrap-hanging and paragraph-end cases)
3. Two-pass per line:
   - Pass 1: `fillRect` for runs with `run.highlight` — fixed mode clamps to container bounds (no `ctx.clip`)
   - Pass 2: `fillText` for all runs
4. Highlight rects cover whitespace runs too (matching CSS `<mark>` behavior)
5. Fixed-mode overflow: trailing ws `fillText` past container edge is invisible (no ink); highlight rects are clamped arithmetically via `containerLeft`/`containerRight`

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

**Tracked keys:** `origin`, `fontSize`, `color`, `align`, `width`.

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
private isNew = false;
```

### PointerTool Lifecycle

```
begin() → hit test via hitTestVisibleText() → store hitTextId
end()   → hitTextId ? mountEditor(hitTextId, false) : createTextObject → mountEditor(id, true)
```

### createTextObject

```typescript
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
Container top = screenY - (scaledFontSize * getBaselineToTopRatio())
```

### syncProps — Y.Map → DOM Overlay

Called by extension's Y.Map observer on undo/redo of property changes:
- Reads values fresh from `handle.y` — no local state to update
- `color` → sets CSS variable; `align` → `applyAlignCSS()`
- `origin`/`fontSize`/`width` → delegates to `positionEditor()` which reads all from Y.Map

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

No singleton indirection — `textTool` exported directly from `tool-registry.ts`. Public fields: `objectId`, `isEditorMounted()`, `updateColor()`, `updateFontSize()`, `updateTextAlign()`.

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
  font-weight: 550;
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
  background-color: #ffd43b;           /* Default = first HIGHLIGHT_COLORS palette entry */
  padding-block: 0.15em;               /* Extend to full line-height (half-leading each side) */
  margin-block: -0.15em;               /* Cancel layout shift from padding */
  box-decoration-break: clone;         /* Each line fragment gets own background rect */
  -webkit-box-decoration-break: clone;
}
/* Multicolor: Tiptap renders <mark style="background-color: #hex"> which overrides the default */
```

**JS inline styles** (zoom-dependent): `fontSize`, `lineHeight`, `left`, `top`, `width` (fixed mode).

---

## Canvas Rendering (`objects.ts`)

```typescript
function drawText(ctx, handle) {
  if (useSelectionStore.getState().textEditingId === handle.id) return;  // Skip if editing
  const props = getTextProps(handle.y);
  const layout = textLayoutCache.getLayout(id, props.content, props.fontSize, props.width);
  renderTextLayout(ctx, layout, props.origin[0], props.origin[1], color, props.align);
}
```

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
} else if (field === 'fontSize') {
  textLayoutCache.invalidateLayout(id);
}
// 'width' changes handled by comparison in getLayout()
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

## WYSIWYG Parity Contract

DOM and canvas match because:
- Same font (Grandstander 550/800), same `pre-wrap` + `break-word`, same container width
- Same line-height (`fontSize * 1.3`)
- Canvas flow engine implements identical whitespace semantics (pending whitespace pattern)
- Sub-pixel differences (~0.5px) expected from per-token vs native text shaping

---

## Highlight Support

Multicolor text highlighting via `@tiptap/extension-highlight` (DOM) + canvas pipeline.

### DOM (Tiptap)
- `Highlight.configure({ multicolor: true })` in TextTool editor extensions
- Renders `<mark style="background-color: #hex">` for explicit colors, plain `<mark>` for default toggle
- CSS on `.tiptap mark`: `border-radius: 0.25em`, extends background to full line-height via `padding-block: 0.15em` + `margin-block: -0.15em`
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

## Remaining Work

- **`DEV_FORCE_FIXED_WIDTH` removal** — temporary; remove when resize handles land
- **Select tool E/W resize handles** — interactive width setting
- **Live width changes during editing** — resize while editor mounted
- **Text scale transforms** — font size scaling during select transforms
- **New context menu integration** — `TextContextMenu.ts` is legacy (commented out in TextTool); bold/italic/highlight/alignment/color/fontSize will be wired through the new `context-menu/` system using `getInlineStyles()` for non-editing active state
