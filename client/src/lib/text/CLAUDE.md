# Text System Documentation

**Status:** WYSIWYG complete — auto + fixed-width modes verified
**Last Updated:** 2026-02-15

## Overview

WYSIWYG rich text with **DOM overlay editing** and **canvas rendering**, supporting both auto-width and fixed-width (text wrapping) modes.

- **Editing:** Tiptap editor in absolute-positioned div, synced to Y.XmlFragment via custom TextCollaboration extension
- **Rendering:** Canvas-based layout engine with tokenizer + flow engine matching CSS `pre-wrap` + `break-word`
- **Positioning:** Measured font metrics ensure DOM ↔ canvas baseline alignment
- **Collaboration:** Y.XmlFragment CRDT enables real-time sync

## Files

| File | Purpose |
|------|---------|
| `lib/text/text-system.ts` | Layout engine: tokenizer, measurement, flow engine, cache, renderer, BBox |
| `lib/text/extensions.ts` | Custom TextCollaboration extension (replaces @tiptap/extension-collaboration) |
| `lib/text/font-config.ts` | `FONT_CONFIG` constants (extracted to avoid circular deps) |
| `lib/text/font-loader.ts` | `ensureFontsLoaded()`, `areFontsLoaded()` |
| `lib/text/TextContextMenu.ts` | Floating toolbar: bold/italic/alignment/color/size (imperative DOM) |
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

### Internal Pipeline

```
parseAndTokenize(fragment) → TokenizedContent
    ↓
measureTokenizedContent(tokenized, fontSize) → MeasuredContent
    ↓
layoutMeasuredContent(measured, width) → TextLayout
```

All three are **internal**. Public API: `textLayoutCache.getLayout()`.

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
getMeasuredAscentRatio()    // Canvas fontBoundingBoxAscent measurement, cached
getBaselineToTopRatio()     // = halfLeading(0.15) + ascentRatio(~0.88) ≈ 1.03
resetFontMetrics()          // Clear cached metrics after font load
buildFontString(bold, italic, fontSize)  // → "italic 800 20px ..."
```

### Tokenizer: `parseAndTokenize()`

Converts Y.XmlFragment → word/space tokens with styled segments:
```
"hello world"     → [word:"hello", space:" ", word:"world"]
"he<b>llo</b> w"  → [word:{seg:"he", seg:"llo"(bold)}, space:" ", word:{seg:"w"}]
```

### Flow Engine: `layoutMeasuredContent()`

Implements CSS `white-space: pre-wrap` + `overflow-wrap: break-word`:

| CSS Property | Canvas Implementation |
|-------------|----------------------|
| `pre-wrap` | Pending whitespace pattern: leading ws committed, inter-word ws buffered, trailing ws dropped |
| `break-word` | `sliceTextToFit()` — binary search at grapheme boundaries via `Intl.Segmenter` |
| `text-align` | `getLineStartX(originX, boxWidth, lineVisualWidth, align)` |

**Auto mode:** `maxWidth = Infinity` — no wrapping, each paragraph = one line.
**Fixed mode:** `maxWidth = width` — words wrap at container boundary, oversized words break at grapheme boundaries.

### Measurement Caches

| Cache | Size | Key |
|-------|------|-----|
| `MEASURE_LRU` | 75k entries | `font + '\0' + text` |
| `SPACE_WIDTH_CACHE` | Unbounded Map | font string |
| `GRAPHEME_LRU` | 10k entries | text string |

### Exported Types

```typescript
interface MeasuredRun {
  text: string; bold: boolean; italic: boolean; font: string;
  advanceWidth: number; advanceX: number;  // X offset from line start
  ink: BBoxTuple; isWhitespace: boolean;
}

interface MeasuredLine {
  runs: MeasuredRun[]; index: number;
  advanceWidth: number;    // Total advance including trailing whitespace
  visualWidth: number;     // Width up to last non-whitespace run
  ink: BBoxTuple; baselineY: number; lineHeight: number; hasInk: boolean;
}

interface TextLayout {
  lines: MeasuredLine[]; fontSize: number; lineHeight: number;
  widthMode: 'auto' | 'fixed';
  boxWidth: number;        // auto → maxAdvanceWidth; fixed → explicit width
  inkBBox: FrameTuple;     // [x, y, w, h] actual drawn bounds
  logicalBBox: FrameTuple; // [x, y, w, h] advance-based bounds
}
```

### TextLayoutCache (singleton)

Three-tier cache: content → measurement → flow.

```typescript
class TextLayoutCache {
  getLayout(objectId, fragment, fontSize, width: TextWidth = 'auto'): TextLayout
  invalidateContent(objectId)  // Content changed → re-tokenize + re-measure + re-flow
  invalidateLayout(objectId)   // FontSize changed → re-measure + re-flow
  invalidateFlow(objectId)     // Width changed → re-flow only
  remove(objectId)             // Object deleted
  clear()                      // Full clear (+ measurement caches)
  setFrame(objectId, frame)    // Derived frame storage
  getFrame(objectId): FrameTuple | null
}
export const textLayoutCache: TextLayoutCache;
```

**Cache entry:**
```typescript
interface CacheEntry {
  tokenized: TokenizedContent | null;  // null = content stale
  measured: MeasuredContent;
  measuredFontSize: number | null;     // null = fontSize stale
  layout: TextLayout;
  layoutWidth: TextWidth | null;       // null = width stale
  frame: FrameTuple | null;
}
```

**Width change detection:** `getLayout()` compares `entry.layoutWidth !== width`. If different, re-flows without re-measuring — no explicit `invalidateFlow()` needed (but it exists for the observer path).

### Renderer: `renderTextLayout()`

```typescript
renderTextLayout(ctx, layout, originX, originY, color, align: TextAlign = 'left')
```
- `textBaseline = 'alphabetic'`, origin = first line baseline
- Per-line X: `getLineStartX(originX, boxWidth, lineW, align)` where `lineW` = `advanceWidth` (auto) or `visualWidth` (fixed)

### BBox + Derived Frame: `computeTextBBox()`

```typescript
computeTextBBox(objectId: string, props: TextProps): BBoxTuple
```
- Gets layout via cache, computes ink-tight bounds + 2px padding
- **Derives and caches frame:** `[getBoxLeftX(ox, boxWidth, align), oy - fontSize * btRatio, boxWidth, logicalBBox[3]]`
- Called from `room-doc-manager` for spatial index (both steady-state and hydration)

### Frame Getter

```typescript
getTextFrame(objectId): FrameTuple | null  // Reads from cache
```

**All call sites** use the pattern:
```typescript
const frame = handle.kind === 'text' ? getTextFrame(handle.id) : getFrame(handle.y);
```

---

## TextTool (`TextTool.ts`)

### State

```typescript
interface EditorState {
  container: HTMLDivElement | null;
  editor: Editor | null;
  objectId: string | null;
  originWorld: [number, number] | null;
  fontSize: number;
  color: string;
  align: TextAlign;
  width: TextWidth;      // 'auto' | number — stored from Y.Map on mount
  isNew: boolean;
}
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

### mountEditor — Width Handling

Reads `width` from `getTextProps()`, sets container width:

```typescript
if (typeof width === 'number') {
  container.style.width = `${width * scale}px`;  // World units → screen pixels
  container.dataset.widthMode = 'fixed';
} else {
  container.dataset.widthMode = 'auto';           // CSS max-content applies
}
```

### repositionEditor — Zoom Sync

```typescript
if (typeof this.editorState.width === 'number') {
  container.style.width = `${this.editorState.width * scale}px`;
}
```

### DOM Positioning Math

```
Container top = screenY - (scaledFontSize * getBaselineToTopRatio())
```
Where `getBaselineToTopRatio() ≈ 1.03` = halfLeading(0.15) + measuredAscent(~0.88).

### Alignment CSS

```typescript
container.style.setProperty('--text-align', align);
container.style.setProperty('--text-anchor-tx',
  align === 'left' ? '0%' : align === 'center' ? '-50%' : '-100%');
```

### commitAndClose — Memory Leak Prevention

```typescript
// Capture UndoManager ref before destroy (view.state inaccessible after)
const undoManager = yUndoPluginKey.getState(editor.view.state)?.undoManager;
editor.destroy();
(editor as any).editorState = null;   // Tiptap doesn't null this
if (undoManager) undoManager.clear();  // Release CRDT GC protection
```

### Module Exports

```typescript
setTextToolInstance(tool)          // Called by tool-registry
getTextToolInstance(): TextTool    // Used by context menu
getActiveEditorContainer()         // DOM element access
getActiveTiptapEditor()            // Tiptap Editor access
```

---

## TextCollaboration Extension (`extensions.ts`)

Custom Tiptap extension replacing `@tiptap/extension-collaboration` to fix memory leaks.

**Problem:** Official extension captures `_observers` (closures over EditorView) into a restore closure on destroy, preventing GC of detached DOM trees — linear leak in short-lived editors.

**Solution:** Registers `ySyncPlugin + yUndoPlugin` directly without suspend/restore wrapper.

**Cursor Fix:** yUndoPlugin's RelativePosition restoration is buggy. A `selectionFixPlugin` stores raw ProseMirror positions on undo stack items, corrects selection after undo/redo via `applyPendingSelection()`.

```typescript
export const TextCollaboration = Extension.create<{ fragment: XmlFragment | null }>({
  addProseMirrorPlugins() {
    return [ySyncPlugin(fragment), yUndoPlugin(), selectionFixPlugin];
  },
  addCommands() { return { undo, redo }; },
  addKeyboardShortcuts() { return { 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo }; },
});
```

---

## CSS Architecture (`index.css`)

```css
.text-editor-container {
  font-family: "Grandstander", cursive, sans-serif;
  font-weight: 550;
  white-space: pre-wrap;
  overflow-wrap: break-word;       /* Safe default — no-op in auto (max-content) */
  width: max-content;              /* Auto mode: grows with content */
  transform: translateX(var(--text-anchor-tx, 0%));
  text-align: var(--text-align, left);
  color: var(--text-color, #000000);
}

/* Fixed-width: outline, clip hanging whitespace, suppress placeholder */
.text-editor-container[data-width-mode="fixed"] {
  outline: 1px solid #1d4ed8;     /* Matches SELECTION_STYLE.PRIMARY */
  overflow: hidden;                /* Clip trailing whitespace → prevent event leaks */
}

.text-editor-container[data-width-mode="fixed"] .tiptap p.is-editor-empty:first-child::before {
  display: none;                   /* Placeholder wraps/looks broken in narrow containers */
}
```

**JS inline styles** (zoom-dependent): `fontSize`, `lineHeight`, `left`, `top`, `width` (fixed mode).

---

## Canvas Rendering (`objects.ts`)

```typescript
function drawText(ctx, handle) {
  if (useSelectionStore.getState().textEditingId === handle.id) return;  // Skip if editing
  const props = getTextProps(handle.y);
  if (!props) return;
  const color = getColor(handle.y);
  const layout = textLayoutCache.getLayout(id, props.content, props.fontSize, props.width);
  renderTextLayout(ctx, layout, props.origin[0], props.origin[1], color, props.align);
}
```

**Transform behavior:** Translate offsets `origin` in Y.Map. Scale is a currently no-op (text transforms are deferred to later phases).

---

## Room Doc Manager Integration

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

### BBox Computation

```typescript
if (kind === 'text') {
  const props = getTextProps(yObj);
  if (props) newBBox = computeTextBBox(id, props);
}
```

### Deletion / Rebuild

```typescript
if (handle.kind === 'text') textLayoutCache.remove(id);  // Deletion
textLayoutCache.clear();                                   // Full rebuild
```

---

## Derived Frame

Text has no stored `frame` in Y.Map — derived from origin/fontSize/align/content/width, cached in `TextLayoutCache`, read via `getTextFrame(objectId)`.

**Frame vs BBox:** Text's bbox is ink-tight + 2px padding (can be smaller than logical frame). Frame matches DOM overlay rect exactly — used by selection, connectors, hit testing.

**Consumers:** `hit-testing.ts`, `EraserTool.ts`, `selection-overlay.ts`, `SelectTool.ts`, `connectors/*`, `bounds.ts`.

---

## WYSIWYG Parity Contract

DOM and canvas match because:
- Same font (Grandstander 550/800), same `pre-wrap` + `break-word`, same container width
- Same line-height (`fontSize * 1.3`)
- Canvas flow engine implements identical whitespace semantics (pending whitespace pattern)
- Sub-pixel differences (~0.5px) expected from per-token vs native text shaping

---

## Remaining Work

- **`DEV_FORCE_FIXED_WIDTH` removal** — temporary; remove when resize handles land
- **Select tool E/W resize handles** — interactive width setting
- **Live width changes during editing** — resize while editor mounted
- **Text scale transforms** — font size scaling during select transforms
