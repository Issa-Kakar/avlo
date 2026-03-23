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

  invalidateContent(objectId, fragment?)
  // Content changed. When fragment provided: eagerly re-tokenizes via parseAndTokenize(fragment)
  // so getInlineStyles() returns fresh data immediately. Critical for shape labels where no
  // getLayout() call happens before refreshStyles in the observer path.
  // When fragment omitted: nulls tokenized → lazy re-parse on next getLayout().
  // Always nulls measuredFontSize → forces re-measure + re-layout on next getLayout().

  invalidateLayout(objectId)   // FontSize changed → nulls measuredFontSize → forces re-measure
  invalidateFlow(objectId)     // Width changed → nulls layoutWidth → forces re-flow
  remove(objectId)             // Object deleted
  clear()                      // Full clear (+ all measurement LRUs)
  setFrame(objectId, frame)    // Derived frame storage (set by computeTextBBox)
  getFrame(objectId): FrameTuple | null
  getMeasuredContent(objectId): MeasuredContent | null  // For reflow (SelectTool E/W transforms, shape label transforms)
  getInlineStyles(objectId): UniformStyles | null  // From cached tokenized content
}
export const textLayoutCache: TextLayoutCache;
```

**Width change detection:** `getLayout()` compares `entry.layoutWidth !== width`. Re-flows automatically — no explicit `invalidateFlow()` needed for the render path (but it exists for the observer path). FontFamily change detection works the same way: `entry.measuredFontFamily !== fontFamily` triggers re-measure + re-flow.

**Eager vs lazy tokenization:** `invalidateContent(id, fragment)` with a fragment eagerly calls `parseAndTokenize(fragment)` and stores the result, so `getInlineStyles()` returns fresh `UniformStyles` immediately. Without the fragment, tokenized is nulled for lazy re-parse on next `getLayout()`. Both paths null `measuredFontSize` and `frame`, ensuring re-measure and BBox recomputation. The eager path is critical for shape labels — their content changes arrive via the deep observer, and the context menu queries `getInlineStyles()` before any `getLayout()` call would trigger lazy tokenization.

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
  transform: translateX(var(--text-anchor-tx, 0%)) translateY(var(--text-anchor-ty, 0%));
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
// Y.XmlFragment change: eager re-tokenize for inline styles
if (path[1] === 'content') {
  const fragment = objects.get(id)?.get('content');
  textLayoutCache.invalidateContent(
    id,
    fragment instanceof Y.XmlFragment ? fragment : undefined,
  );
}
// 'width', 'fontSize' changes handled by comparison in getLayout()
// 'origin'/'color' don't need cache invalidation
```

The observer retrieves the fresh `Y.XmlFragment` and passes it to `invalidateContent()` for eager tokenization. This ensures `getInlineStyles()` returns fresh data immediately — critical for the context menu's `computeUniformInlineStyles()` which runs in `refreshStyles()` for both `textOnly` and `shapesOnly` selections.

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
- **Fonts:*** Grandstander, Inter, Lora, JetBrains Mono
**All fonts:** variable `wght 450–700`, Latin subset only, `liga`/`calt`/`dlig` stripped at font level (canvas has no `font-variant-ligatures: none` — stripping is the only cross-browser WYSIWYG fix). Features kept: `kern`, `mark`, `mkmk`, `ccmp`, `locl`. 

---

## Shape Labels

Text labels inside shapes (rect, ellipse, diamond, roundedRect). Reuses the full text pipeline — same Y.XmlFragment, same tokenizer/measure/layout, same Tiptap editor — but with shape-aware positioning, text box computation, and a dedicated canvas renderer.

### Y.Doc Schema

Labels are NOT separate objects. They add fields directly to the shape Y.Map:

```typescript
// Label fields (added on first edit, removed if empty on close)
{
  content: Y.XmlFragment,     // Rich text — same structure as text objects
  fontSize: number,            // World units
  fontFamily: FontFamily,      // 'Grandstander' | 'Inter' | 'Lora' | 'JetBrains Mono'
  labelColor: string,          // Text color (separate from shape border `color`)
}
```

**Key differences from text objects:** No `origin`, `align`, or `width`. Labels are always center-aligned H+V within the inscribed text box, width derived from shape frame. `hasLabel(y)` (`y.get('content') instanceof Y.XmlFragment`) is the canonical check. `getLabelColor(y)` reads the `labelColor` key. Existing `getFontSize()`, `getFontFamily()`, `getContent()` work unchanged.

### Text Box Computation (`computeLabelTextBox`)

```typescript
computeLabelTextBox(shapeType: string, frame: FrameTuple): FrameTuple
```

Pure function. Returns max inscribed text rectangle within the shape, inset by `LABEL_PADDING = 10`:

| Shape | Math |
|-------|------|
| rect, roundedRect | `[fx+pad, fy+pad, fw-2*pad, fh-2*pad]` |
| ellipse | `a√2 × b√2` centered, then inset by pad |
| diamond | `w/2 × h/2` centered, then inset by pad |

`Math.max(0, ...)` prevents negative dimensions — renderer early-returns when dims ≤ 0.

### Canvas Rendering

**At rest — `drawShapeLabel()`:** Called at end of `drawShape()`, gated by `hasLabel(y)`. Skips if `textEditingId === handle.id`. Uses `textLayoutCache.getLayout()` with text box width — width changes from shape resizing trigger re-flow automatically.

**During transforms — `drawShapeLabelWithFrame()`:** Takes explicit transformed frame. Reads cached `MeasuredContent` via `getMeasuredContent()` and calls `layoutMeasuredContent()` directly — avoids polluting cache with transient widths.

**`renderShapeLabel(ctx, layout, textBox, color, fontFamily)`:** Center-aligned H+V. Overflow clips via `ctx.clip()`. Same highlight rects as `renderTextLayout`.

### DOM Editing (TextTool)

TextTool derives label vs text mode from `handle.kind === 'shape'` inline at every call site — no stored flag.

**Entry:** `startEditing()` creates label fields in a single transaction if `!hasLabel(handle.y)` (`content`, `fontSize`, `fontFamily`, `labelColor` from device-ui-store defaults).

**mountEditor — Label branch:** Positioned at text box center via `worldToClient`, CSS `translate(-50%, -50%)`. Uses `maxWidth`/`maxHeight` (not `width`). `data-width-mode='label'` triggers CSS for center align + hidden-scrollbar overflow. No `backgroundColor` (shape is the background). No Placeholder extension.

**syncProps — Label branch:** `labelColor` → `--text-color`, `frame`/`shapeType`/`fontSize`/`fontFamily` → `positionEditor()`. Does NOT react to shape `fillColor` or `color` changes.

**commitAndClose:** Empty labels: deletes only label fields, shape persists. Sets `justClosedLabelId` for remount prevention.

**SelectTool coordination:**
- **Remount prevention:** `justClosedLabelId` flag prevents click-off → immediate remount cycle. Checked and consumed in SelectTool `end()`.
- **Handles visible:** Label containers don't occlude handles. `isEditingLabel()` allows handle hit-testing/rendering during label editing.

### Extension Observer

Additional tracked keys: `labelColor`, `frame`, `shapeType`. Fires `onPropsSync` on shape resize, type-change, or label color change during editing. Harmless for text objects.

### Cache & Content Invalidation

- **At rest:** `drawShapeLabel` → `textLayoutCache.getLayout(shapeId, ...)` — normal three-tier cache
- **Deep observer:** `path[1] === 'content'` → `invalidateContent(id, fragment)` — eager re-tokenize for inline styles (see TextLayoutCache section above)
- **Transform preview:** `getMeasuredContent()` + `layoutMeasuredContent()` — no cache writes
- **Deletion:** `textLayoutCache.remove(id)` — no-op for shapes without labels

### CSS (`index.css`)

```css
.tiptap {
  transform: translateX(var(--text-anchor-tx, 0%)) translateY(var(--text-anchor-ty, 0%));
  /* --text-anchor-ty defaults to 0% — only labels set -50% */
}

.tiptap[data-width-mode='label'] {
  overflow-x: hidden;
  overflow-y: auto;
  text-align: center;
  scrollbar-width: none;
}
.tiptap[data-width-mode='label']::-webkit-scrollbar { display: none; }
.tiptap[data-width-mode='label'] .is-editor-empty:first-child::before { display: none; }
```

### WYSIWYG Parity

Both DOM and canvas center content H+V within text box, clip overflow (`overflow-y: auto` + `maxHeight` ↔ `ctx.clip()`), use same font metrics/lineHeight/baselineToTop. ProseMirror scrollTop resets on close — canvas "rest position" matches un-scrolled DOM state.

### Edge Cases

- **Empty label:** Fields deleted on close, shape persists, cache cleaned
- **Undo label creation:** Main UndoManager reverses field additions; `hasLabel()` returns false
- **Shape resize during editing:** `frame` key → extension observer → `positionEditor()` updates DOM
- **Tiny shapes:** `computeLabelTextBox` returns 0 dims → rendering early-returns, content preserved
- **Click shape body during editing:** Editor closes, shape stays selected, `justClosedLabelId` prevents remount
- **Handle click during editing:** Capture phase closes editor → handle gesture starts normally

---

## Sticky Notes

First-class `kind: 'note'` ObjectKind — a separate object type that reuses the text pipeline (Y.XmlFragment, Tiptap editor, TextLayoutCache, three-tier invalidation) like shape labels. Key differences from text objects: origin = top-left (not anchor+baseline), width always fixed, padding/dimensions width-based (not fontSize-based), canvas always draws body+shadow (even during editing). Supports full horizontal + vertical alignment with auto-grow height and vertical clamping.

### Y.Doc Schema

```typescript
{
  id: string,
  kind: 'note',
  origin: [number, number],     // [topLeftX, topLeftY] — always top-left (doesn't shift with alignment)
  fontSize: number,              // Default 20 (from device-ui-store noteSize)
  fontFamily: FontFamily,        // Default 'Grandstander' (from noteFontFamily)
  align: TextAlign,              // 'left' | 'center' | 'right' — horizontal, default 'center'
  alignV: TextAlignV,            // 'top' | 'middle' | 'bottom' — vertical, default 'middle'
  width: number,                 // Always fixed number (NOTE_WIDTH = 280), never 'auto'
  fillColor: string,             // Note background color (NOTE_FILL_COLOR = '#FEF3AC')
  content: Y.XmlFragment,
  ownerId: string,
  createdAt: number
}
```

No `color` field — text is hardcoded to `'#1a1a1a'`. No `note: true` flag. Separate device-ui-store settings: `noteSize`, `noteAlign`, `noteAlignV`, `noteFontFamily`. Defaults: `align: 'center'`, `alignV: 'middle'`.

**Origin semantics differ from text objects:** `origin` is always the top-left corner of the note body, regardless of alignment. For text objects, `origin[0]` shifts with horizontal alignment (left/center/right anchor). For notes, alignment is applied as an offset within the content area — origin stays fixed.

### Dimensional Model

Two categories — **body properties** scale with `noteWidth`, **content properties** derive from width:

| Property | Formula | At defaults (w=280) |
|----------|---------|---------------------|
| Content padding | `noteWidth * (12/280)` | 12wu |
| Content width | `noteWidth - 2*padding` | 256wu |
| Max content height | `contentWidth` (= square content box) | 256wu |
| Height | `max(noteWidth, contentH + 2*padding)` | 280wu min (square) |
| Corner radius | `noteWidth * 0.011` | 3.08wu |
| Shadow pad | `noteWidth * 0.15` | 42wu |

Changing font size only affects text layout inside the note — body, shadow, corners, and padding are stable. This is the key difference from text objects where everything derives from fontSize.

`maxContentH = contentWidth` — the height of the content area when the note is a perfect square. This is the threshold where vertical alignment transitions from centering within available space to clamping at the top.

### Alignment System

Notes support 3×3 alignment (H×V) with two key behaviors:

1. **Horizontal alignment** — auto-grow width (like shape labels): container uses `width: max-content` + `maxWidth`, growing to fit content up to the full content width. Position anchored at `contentLeft + anchorFactor(align) * contentWidth`, then `translateX` offsets the container (`0%` / `-50%` / `-100%`). `text-align` CSS variable aligns lines within the container.

2. **Vertical alignment with clamping** — CSS `clamp()` in `translateY` prevents content from overflowing the top of the note body when it exceeds the square content box height.

#### Vertical Alignment Math — CSS `clamp()` Approach

Position `top` at the vertical anchor point within the content area, then clamp `translateY`:

```
vFactor = top:0, middle:0.5, bottom:1
topWorldY = origin[1] + padding + vFactor * maxContentH
maxTy = vFactor * maxContentH * scale
--text-anchor-ty = alignV === 'top' ? '0%' : clamp(-maxTy px, -vFactor*100 %, 0px)
```

**How it works (middle, vFactor=0.5):**
- Container `top` set at vertical middle of content area (screen px)
- `translateY(clamp(-maxTy, -50%, 0px))` — CSS resolves `%` to element height at used-value time
- When element height H < maxContentH: `-50%` (= `-H/2`) is less negative than `-maxTy` → clamp picks `-50%` → perfectly centered
- When H > maxContentH: `-50%` is more negative than `-maxTy` → clamp picks `-maxTy` → top clamped at padding edge
- Transition is continuous: centering offset smoothly decreases to 0 as content fills the available space

**Clamping behavior:** Once content exceeds the square content box height, the note body auto-grows downward only. The text top edge stays pinned at the padding boundary — identical to how horizontal center alignment works on the longest line that defines the width (centering is always based on *available* space).

#### Canvas Alignment — Matching Formulas

Canvas uses `getNoteContentOffsetY` which produces identical positions to the CSS clamp:

```typescript
getNoteContentOffsetY(alignV, maxContentH, contentH):
  if (alignV === 'top') return 0
  space = max(0, maxContentH - contentH)
  return alignV === 'middle' ? space / 2 : space
```

**Proof of equivalence (middle):**
- CSS effective offset: position at middle → translateY picks `min(-H/2, -maxTy)` → top = `padding + max(0, (maxContentH - H)/2)`
- Canvas: `padding + getNoteContentOffsetY('middle', maxContentH, contentH)` = `padding + max(0, (maxContentH - contentH)/2)`
- Identical for all H values, continuous transition at H = maxContentH ✓

Horizontal alignment uses `getLineStartX` with a virtual anchor:
```
noteAnchorX = origin[0] + padding + anchorFactor(align) * contentWidth
startX = getLineStartX(noteAnchorX, contentWidth, lineW, align)
```
The anchor factor cancels with `getBoxLeftX` internally, producing `contentLeft + alignment offset` — correct for all 3 modes.

### Canvas Rendering — `drawStickyNote` (`objects.ts`)

Own case in `drawObject` switch — does NOT call `renderTextLayout`. Instead replicates the fixed-mode rendering logic with alignment:

```
drawStickyNote(ctx, handle):
  1. getNoteProps(y) → { origin, fontSize, fontFamily, width, fillColor, content, align, alignV }
  2. textLayoutCache.getLayout(id, content, fontSize, fontFamily, contentWidth)
  3. computeNoteHeight(layout, noteWidth)
  4. renderNoteBody(ctx, x, y, w, h, fillColor)    ← always drawn, even during editing
  5. if textEditingId === id → return              ← DOM overlay handles text
  6. Compute alignment offsets:
     - vOffset = getNoteContentOffsetY(alignV, maxContentH, contentH)
     - textY = origin[1] + padding + vOffset + baselineToTop
     - noteAnchorX = origin[0] + padding + anchorFactor(align) * contentWidth
  7. Two-pass per line:
     - startX = getLineStartX(noteAnchorX, contentWidth, line.alignmentWidth, align)
     - Pass 1: highlight roundRects clamped to [containerLeft, containerRight]
       - Radius: fontSize * 0.25 (matches CSS border-radius: 0.25em)
       - Clamped sides get flat edge (radius 0) — matches CSS overflow:hidden
     - Pass 2: fillText with hardcoded '#1a1a1a'
```

Key differences from `renderTextLayout`:
- No `fillColor` background rect (body drawn by `renderNoteBody` instead)
- Container bounds = note content area (always `origin[0]+padding` to `+contentWidth`), not text block box
- Uses `getLineStartX` with virtual anchor (not `getBoxLeftX` with origin-based anchor)
- Vertical offset via `getNoteContentOffsetY` (not origin-baseline positioning)
- Color hardcoded, not from Y.Map

### Shadow System — 9-Slice Cache

Dual-layer Gaussian shadow pre-rendered on a DPR-scaled `OffscreenCanvas`, drawn via 8 `drawImage` calls (9-slice, center skipped). Zero per-frame shadow cost.

**Source canvas:** `(280 * dpr) × (280 * dpr)` pixels. Logical layout: `[100px pad][80px rect][100px pad]`. `ctx.scale(dpr, dpr)` — all drawing in logical pixels.

**Dual layers** (both drawn with opaque `#000` fill, body area punched out with `destination-out`):

| Layer | Purpose | blur | offsetY | α |
|-------|---------|------|---------|---|
| Floor | Long bottom tail, 3D lift | 34 | 28 | 0.10 |
| Contact | Soft edge definition | 10 | 3 | 0.06 |

Why dual-layer: a single Gaussian can't produce the asymmetry of a real sticky note shadow. The floor shadow's large offsetY pushes it below the body, creating a long bottom tail while leaving the top nearly invisible. The contact shadow adds soft edge definition on all sides.

Why opaque fill + punch-out: browsers skip shadow rendering for zero-alpha fill. The `destination-out` compositing removes the opaque fill from the body area, leaving only the shadow fringe. Punch-out rect expanded 1px beyond body to eliminate the anti-aliased fringe at the shadow-body boundary.

**Cache invalidation:** Auto-rebuilds when `window.devicePixelRatio` changes. Module-level singleton (`_shadowCache`).

**Destination mapping:** Source pad (100px) maps to `noteWidth * 0.15` destination world units. At w=280, this is 42wu — compression ~2.4× at DPR=1. The DPR-scaled source provides enough resolution for smooth gradients at any DPR/zoom.

**`renderNoteBody(ctx, x, y, w, h, fillColor)`:** Calls `drawNoteShadow` (9-slice), then `roundRect` fill with `fillColor` at `getNoteCornerRadius(w)`.

### BBox + Derived Frame

`computeNoteBBox(objectId, props: NoteProps)` — called from room-doc-manager (steady-state + hydration):

1. `getNoteContentWidth(width)` → layout via cache → `computeNoteHeight(layout, width)`
2. Frame cached via `textLayoutCache.setFrame(id, [origin[0], origin[1], width, noteHeight])`
3. Returns frame + shadow pad on all sides

Frame = body rectangle (no shadow). BBox = body + shadow pad. Hit testing and selection use `getTextFrame(id)` (body only). Dirty rect tracking uses BBox (includes shadow).

Alignment does not affect BBox or frame — the body rectangle is determined by origin + width + content height. Alignment only shifts text *within* the body.

Fallback in `computeBBoxFor` (`bbox.ts`): `[origin[0], origin[1], origin[0]+w, origin[1]+w]` — safety net only.

### TextTool — Creation and Editing

**Tool mode:** `'note'` in `Tool` union. Maps to `textTool` singleton in `tool-registry.ts` (same pattern as pen/highlighter/shape). `activeTool` read at creation time to branch note vs text.

**`begin()`:** Branches hit testing by tool mode — `hitTestVisibleNote` for note tool, `hitTestVisibleText` for text tool. Same occlusion model (unfilled shape interiors transparent, everything else occludes).

**`createTextObject()`:** Note mode:
```
kind: 'note', fontSize: store.noteSize, fontFamily: store.noteFontFamily,
align: store.noteAlign, alignV: store.noteAlignV, width: NOTE_WIDTH, fillColor: NOTE_FILL_COLOR
```
No `color` field (unlike text objects). No `note: true` flag.

**`mountEditor()` — note branch:** `handle.kind === 'note'` detected inline (no stored flag). Uses `getNoteProps`. Alignment-aware positioning:
- Horizontal: container positioned at `origin + padding + anchorFactor(align) * contentWidth`, translated via `--text-anchor-tx` (`0%`/`-50%`/`-100%`). `--text-align` CSS variable set for multi-line alignment.
- Vertical: container positioned at `origin + padding + vFactor * maxContentH`, translated via `--text-anchor-ty` with CSS `clamp()` for clamped centering.
- Uses `maxWidth` (NOT `width`) — container is `width: max-content` from base CSS, auto-growing horizontally up to `contentWidth * scale`.
- `data-width-mode='note'`. No `backgroundColor` (canvas draws body underneath). Text color hardcoded to `'#1a1a1a'`.

**`positionEditor()` — note branch:** Same alignment logic as mount — reads fresh `getNoteProps`, recomputes anchor positions + clamp values. Pan/zoom updates recalculate screen positions.

**`commitAndClose()`:** Empty notes preserved — the `handle.kind !== 'note'` guard skips deletion. Empty notes are valid visual elements (body + shadow render regardless of content).

**`syncProps()`:** Notes skip `fillColor → backgroundColor` sync (`handle.kind !== 'note'`). For notes, `align` and `alignV` changes route through `positionEditor()` (anchor point shifts) rather than `applyAlignCSS()` — notes need full repositioning because the DOM anchor point changes with alignment.

### Extension Observer (`extensions.ts`)

Tracked keys include `alignV` alongside `origin`, `fontSize`, `fontFamily`, `color`, `fillColor`, `align`, `width`, `labelColor`, `frame`, `shapeType`. When the per-session UndoManager undoes/redoes an `alignV` change, the observer fires `onPropsSync(keys)` → `TextTool.syncProps()` → `positionEditor()` updates the DOM overlay.

### Hit Testing (`hit-testing.ts`)

**`testObjectHit`** — `case 'note'`: uses `getTextFrame(handle.id)` + `shapeHitTest` with `'rect'`. Always `isFilled: true` — note body is always opaque for Z-order occlusion.

**`objectIntersectsRect`** — `case 'note'`: uses `getTextFrame` + `rectsIntersect`. Standard marquee intersection.

**`hitTestVisibleNote`:** Clone of `hitTestVisibleText` — same spatial query, same occlusion scan, but returns on `c.kind === 'note'` instead of `'text'`.

### Selection System

**`SelectionKind`:** `'notesOnly'` added to union. Derived in `computeSelectionComposition` via `notes` counter in `KindCounts`.

**`computeStyles` for `'notesOnly'`:** Early return with `fillColor`, `fontSize`, `fontFamily` from first note.

**`computeUniformInlineStyles`:** Notes included alongside text and labeled shapes — bold/italic/highlight tracking works for selected notes.

**`refreshStyles`:** `'notesOnly'` included in inline styles gate (alongside `'textOnly'`, `'shapesOnly'`).

**Selection actions:** Notes included in `setSelectedFillColor`, `setSelectedFontSize`, `setSelectedFontFamily`, `toggleSelectedBold`, `toggleSelectedItalic`, `setSelectedHighlight`. NOT included in `setSelectedTextColor` (no `color` field).

**SelectTool:** Double-click on note → `textTool.startEditing(id)`. Keyboard Enter-to-edit: notes use `getTextFrame` for frame resolution.

### CSS (`index.css`)

```css
.tiptap[data-width-mode='note'] {
  overflow: visible;
  text-align: var(--text-align, center);
}
.tiptap[data-width-mode='note'] p { margin: 0; }
.tiptap[data-width-mode='note'] .is-editor-empty:first-child::before { display: none; }
```

`overflow: visible` — no clipping, note body grows with content. `text-align: var(--text-align, center)` — horizontal alignment driven by JS via CSS variable (default center). `p { margin: 0 }` — prevents ProseMirror paragraph margins from breaking WYSIWYG parity. Placeholder hidden — empty notes are preserved (unlike text).

Base `.tiptap` CSS provides `width: max-content` and `transform: translateX(var(--text-anchor-tx, 0%)) translateY(var(--text-anchor-ty, 0%))` — notes reuse these for alignment positioning. JS sets `maxWidth` (not `width`) so the container auto-grows horizontally.

### Room Doc Manager

**BBox dispatch** (deep observer + hydration): `kind === 'note'` → `getNoteProps` + `computeNoteBBox`. Separate from text case.

**Content invalidation:** Caught implicitly by `content instanceof Y.XmlFragment` check — no kind gate needed.

**Deletion cleanup:** `handle.kind === 'note'` included in `textLayoutCache.remove(id)` guard.

### NOT Implemented Yet

- **Transforms** — no SelectTool scale/translate for notes
- **Eraser** — no eraser integration
- **Connector anchoring** — notes don't participate as connector endpoints
- **Note resize** — no drag-to-resize
- **Multiple note colors** — only `'#FEF3AC'` in creation, but fillColor can be changed via selection actions
- **Context menu** — no note-specific filtering
- **Alignment UI** — alignment is plumbed and defaults to center/middle, but no context menu controls to change it yet
