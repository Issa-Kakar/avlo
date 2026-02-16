# Text Wrapping Pipeline Changelog

**Date:** 2026-02-15
**Scope:** Canvas-side wrapping pipeline in `text-system.ts`, enabling fixed-width text objects.

---

## What Changed (Summary)

Two passes were completed:

### Pass 1: Prerequisites (already committed as `65bd300`)
- Renamed `ParsedRun` → `StyledText`, `isEmpty` → `hasInk` throughout codebase
- Added `TextProps` and `TextWidth` types to `@avlo/shared`
- Created `getTextProps()` accessor in `@avlo/shared`
- Changed Y.Map key from `widthMode: 'auto'` → `width: 'auto' | number`
- Updated `TextTool.createTextObject()` to use `yObj.set('width', 'auto')`
- Updated `computeTextBBox()` to take `TextProps` (no more positional args)
- Updated `room-doc-manager.ts` to use `getTextProps()` → `computeTextBBox(id, props)`

### Pass 2: Pipeline Rewrite (this session)
- Complete rewrite of `text-system.ts` internals — new tokenizer, measurement caches, flow engine with text wrapping
- One-line change in `objects.ts` to pass `props.width` to `getLayout`
- All external API preserved — zero breaking changes to consumers

---

## Y.Map Schema: `width` Key

**Before (original):**
```typescript
yObj.set('widthMode', 'auto');  // string literal, never used
```

**After (prerequisite pass):**
```typescript
yObj.set('width', 'auto');      // TextWidth = 'auto' | number
```

The `width` key is already written by `TextTool.createTextObject()` as `'auto'`. To enable fixed-width mode, set it to a number (world units):
```typescript
yObj.set('width', 200);  // 200 world-unit container width
```

**Reading width** — use `getTextProps()` from `@avlo/shared`:
```typescript
import { getTextProps } from '@avlo/shared';
const props = getTextProps(handle.y);
// props.width: TextWidth — 'auto' | number
```

Or raw:
```typescript
const w = yObj.get('width');
const width: TextWidth = typeof w === 'number' ? w : 'auto';
```

---

## Shared Package Types (`@avlo/shared`)

These were added in the prerequisite pass:

```typescript
// packages/shared/src/accessors/object-accessors.ts

export type TextAlign = 'left' | 'center' | 'right';
export type TextWidth = 'auto' | number;

export interface TextProps {
  content: Y.XmlFragment;
  origin: [number, number];
  fontSize: number;
  align: TextAlign;
  width: TextWidth;
}

export function getTextProps(y: Y.Map<unknown>): TextProps | null {
  const origin = y.get('origin') as [number, number] | undefined;
  const content = y.get('content') as Y.XmlFragment | undefined;
  if (!origin || !content) return null;
  const w = y.get('width');
  return {
    content,
    origin,
    fontSize: (y.get('fontSize') as number) ?? 20,
    align: (y.get('align') as TextAlign) ?? 'left',
    width: typeof w === 'number' ? w : 'auto',
  };
}
```

---

## text-system.ts: Complete Internal Rewrite

### Pipeline Change

**Before:**
```
parseYXmlFragment() → layoutContent() → renderTextLayout()
```

**After:**
```
parseAndTokenize() → measureTokenizedContent() → layoutMeasuredContent() → renderTextLayout()
```

All three intermediate functions are **internal** (not exported). The public API is unchanged:
- `textLayoutCache.getLayout(id, fragment, fontSize, width?)` — gains optional 4th param
- `computeTextBBox(id, props)` — signature unchanged
- `renderTextLayout(ctx, layout, originX, originY, color, align?)` — signature unchanged
- `getTextFrame(id)` — unchanged

### Alignment System Change

**Before:** Per-line alignment via `lineStartX(originX, lineAdvanceWidth, align)`
```typescript
// For center: originX - lineAdvanceWidth / 2
export function lineStartX(originX, lineWidth, align): number
```

**After:** Container-based alignment via internal `getLineStartX(originX, boxWidth, lineVisualWidth, align)`
```typescript
// For center: boxLeftX + (boxWidth - lineVisualWidth) / 2
function getBoxLeftX(originX, boxWidth, align): number  // internal
function getLineStartX(originX, boxWidth, lineVisualWidth, align): number  // internal
```

**Auto mode equivalence:** When `boxWidth = maxAdvanceWidth` and `lineVisualWidth = line.advanceWidth`, the result is algebraically identical to the old `lineStartX`. Verified for all three alignments.

**Why container-based?** In fixed mode, all lines must be aligned within a fixed container width, not relative to their own width. Container-based alignment handles both modes uniformly.

### Exports Removed (no external consumers — verified by grep)

These were previously exported but had zero imports outside `text-system.ts`:
- `lineStartX` — replaced by internal `getLineStartX`
- `parseYXmlFragment` — replaced by internal `parseAndTokenize`
- `layoutContent` — replaced by internal pipeline
- `StyledText`, `ParsedParagraph`, `ParsedContent` — internal token types now
- `LRU`, `ZERO_INK`, `buildFontString` — made internal

### Exports Preserved (unchanged signatures unless noted)

| Export | Change |
|--------|--------|
| `anchorFactor(align)` | Unchanged |
| `getMeasuredAscentRatio()` | Unchanged |
| `resetFontMetrics()` | Unchanged |
| `getBaselineToTopRatio()` | Unchanged |
| `buildFontString(bold, italic, fontSize)` | No longer exported (internal only) |
| `textLayoutCache` | `getLayout()` gains 4th param `width: TextWidth = 'auto'` |
| `computeTextBBox(id, props)` | Unchanged (already takes TextProps with width) |
| `renderTextLayout(ctx, layout, originX, originY, color, align?)` | Unchanged |
| `getTextFrame(id)` | Unchanged |
| `FONT_CONFIG` | Unchanged (re-export from font-config) |
| `TextAlign`, `TextWidth`, `TextProps` | Unchanged (re-exports from @avlo/shared) |

---

## Type Changes

### MeasuredRun (exported)

**Before:**
```typescript
interface MeasuredRun {
  text: string;
  bold: boolean;
  italic: boolean;
  font: string;
  advanceWidth: number;
  advanceX: number;
}
```

**After:**
```typescript
interface MeasuredRun extends MeasuredSegment {
  advanceX: number;
}
// Inherits from MeasuredSegment: text, bold, italic, font, advanceWidth, ink, isWhitespace
```

**New fields on MeasuredRun:**
- `ink: BBoxTuple` — per-run ink bounds `[left, top, right, bottom]` relative to run origin
- `isWhitespace: boolean` — true for space/tab runs

### MeasuredLine (exported)

**Before:**
```typescript
interface MeasuredLine {
  runs: MeasuredRun[];
  index: number;
  advanceWidth: number;
  ink: BBoxTuple;
  baselineY: number;
  lineHeight: number;
  hasInk: boolean;
}
```

**After:**
```typescript
interface MeasuredLine {
  runs: MeasuredRun[];
  index: number;
  advanceWidth: number;
  visualWidth: number;    // NEW: width up to last non-whitespace run
  ink: BBoxTuple;
  baselineY: number;
  lineHeight: number;
  hasInk: boolean;
}
```

**New field:** `visualWidth` — the width excluding trailing whitespace. Used for text-align in fixed mode. In auto mode, `visualWidth` may differ from `advanceWidth` if the line has trailing spaces, but alignment uses `advanceWidth` in auto mode anyway.

### TextLayout (exported)

**Before:**
```typescript
interface TextLayout {
  lines: MeasuredLine[];
  fontSize: number;
  lineHeight: number;
  inkBBox: FrameTuple;
  logicalBBox: FrameTuple;
}
```

**After:**
```typescript
interface TextLayout {
  lines: MeasuredLine[];
  fontSize: number;
  lineHeight: number;
  widthMode: 'auto' | 'fixed';  // NEW: derived from input TextWidth
  boxWidth: number;              // NEW: auto → maxAdvanceWidth; fixed → explicit width
  inkBBox: FrameTuple;
  logicalBBox: FrameTuple;
}
```

**New fields:**
- `widthMode` — `'auto'` when no wrapping, `'fixed'` when container has explicit width
- `boxWidth` — container width for alignment. In auto mode, equals the widest line's advance width.

---

## Cache Changes

### Cache Entry Structure

**Before:**
```typescript
interface CacheEntry {
  parsed: ParsedContent | null;
  layout: TextLayout;
  layoutFontSize: number | null;
  frame: FrameTuple | null;
}
```

**After:**
```typescript
interface CacheEntry {
  tokenized: TokenizedContent | null;  // null = content stale
  measured: MeasuredContent;           // NEW: intermediate measured content
  measuredFontSize: number | null;     // null = fontSize stale
  layout: TextLayout;
  layoutWidth: TextWidth | null;       // NEW: null = width stale
  frame: FrameTuple | null;
}
```

### Three-Tier Invalidation

| Tier | Trigger | What's Recomputed | Method |
|------|---------|-------------------|--------|
| Content | Y.XmlFragment edit | tokenize → measure → flow | `invalidateContent(id)` |
| FontSize | fontSize change | measure → flow | `invalidateLayout(id)` |
| Width | width change | flow only | `invalidateFlow(id)` |

**Width comparison-based detection:** `getLayout()` compares `entry.layoutWidth !== width`. If different, re-flows without re-measuring. This means changing from `'auto'` to a number (or vice versa) correctly triggers re-flow even without explicit `invalidateFlow()`.

### getLayout Signature

**Before:**
```typescript
getLayout(objectId: string, fragment: Y.XmlFragment, fontSize: number): TextLayout
```

**After:**
```typescript
getLayout(objectId: string, fragment: Y.XmlFragment, fontSize: number, width: TextWidth = 'auto'): TextLayout
```

Default `'auto'` preserves backward compatibility. Existing call sites that don't pass `width` behave identically.

---

## Internal Architecture: Tokenizer + Flow Engine

### Token Model

Text is split into **word** and **space** tokens at whitespace boundaries:

```
"hello world"     → [word:"hello", space:" ", word:"world"]
"he<b>llo</b> w"  → [word:{seg:"he"(normal), seg:"llo"(bold)}, space:" ", word:{seg:"w"}]
"  hello  "       → [space:"  ", word:"hello", space:"  "]
```

Each token can have multiple **segments** with different formatting (bold/italic). The tokenizer coalesces adjacent same-style segments within a token to minimize objects.

### Flow Engine: CSS pre-wrap + break-word

The flow engine in `layoutMeasuredContent()` implements:

| CSS Property | Canvas Implementation |
|-------------|----------------------|
| `white-space: pre-wrap` | Pending whitespace pattern (see below) |
| `overflow-wrap: break-word` | `sliceTextToFit()` — binary search at grapheme boundaries |
| `text-align` within container | `getLineStartX()` using `visualWidth` |

**Pending whitespace pattern:**
1. **Leading whitespace** (no word on line yet): committed immediately, can overflow container
2. **Inter-word whitespace** (word already on line): buffered as "pending". Committed only when next word fits. If word doesn't fit → spaces hang, word wraps.
3. **Trailing whitespace** at paragraph end: dropped (via `clearPending()`)
4. **Spaces never split across lines** (that's `break-spaces`, not `pre-wrap`)

**Break-word:** When a single word is wider than `maxWidth`, `sliceTextToFit()` uses binary search over graphemes (via `Intl.Segmenter` with `Array.from` fallback) to find the largest prefix that fits. Always emits >=1 grapheme per line to guarantee forward progress.

**Auto mode:** `maxWidth = Infinity` — all tokens are committed immediately, each paragraph = one line, no wrapping. Behavior is identical to the previous implementation.

### Measurement Caches

Three global caches avoid redundant `ctx.measureText()` calls:

| Cache | Size | Key | Hit Rate |
|-------|------|-----|----------|
| `MEASURE_LRU` | 75k entries | `font + '\0' + text` | Very high (same words recur) |
| `SPACE_WIDTH_CACHE` | Unbounded Map | font string | ~100% after warmup |
| `GRAPHEME_LRU` | 10k entries | text string | High for break-word |

---

## Call-Site Changes

### objects.ts — `drawText()`

```typescript
// Before:
const layout = textLayoutCache.getLayout(id, props.content, props.fontSize);

// After:
const layout = textLayoutCache.getLayout(id, props.content, props.fontSize, props.width);
```

One-line change. The `props` object comes from `getTextProps(y)` which already includes `width`.

### room-doc-manager.ts — Observer

No changes in this pass. The observer already calls `invalidateContent(id)` for content changes and `invalidateLayout(id)` for fontSize changes. Width changes are handled by comparison-based detection in `getLayout()`.

**Note:** The `field === 'fontSize'` check in the observer (path.length >= 2) is technically dead code — Y.Map direct property changes fire at path.length 1, not 2. But it's harmless; `getLayout()` comparison handles fontSize changes correctly either way.

---

## Renderer Behavior Change

### Auto mode (identical to before)
```typescript
const lineW = layout.widthMode === 'auto' ? line.advanceWidth : line.visualWidth;
const startX = getLineStartX(originX, boxWidth, lineW, align);
```
For auto: `getLineStartX(originX, maxAdvanceWidth, line.advanceWidth, align)` produces the same X position as the old `lineStartX(originX, line.advanceWidth, align)`. Algebraically verified for left/center/right.

### Fixed mode (new)
Uses `line.visualWidth` (excluding trailing whitespace) for alignment within the fixed container. This matches how CSS `text-align` works with `white-space: pre-wrap`.

### computeTextBBox — Frame Derivation

**Before:**
```typescript
const fixedWidth = typeof width === 'number' ? width : null;
const fw = fixedWidth ?? layout.logicalBBox[2];
const fx = ox - anchorFactor(align) * fw;
```

**After:**
```typescript
const fx = getBoxLeftX(ox, layout.boxWidth, align);
// layout.boxWidth = isFixed ? width : maxAdvanceWidth  (same as fw above)
```

Equivalent computation, but `boxWidth` is now part of `TextLayout` instead of derived ad-hoc.

---

## What the Text CLAUDE.md Gets Wrong (Outdated Sections)

These sections in `CLAUDE.md` describe the **old** system. Reference this changelog for current behavior:

1. **Architecture Diagram (line 55):** Says `parseYXmlFragment() → layoutContent() → renderTextLayout()`. Now internal pipeline.

2. **Section 3: Parser (lines 188-215):** `parseYXmlFragment()` no longer exists. Replaced by internal `parseAndTokenize()` which produces tokens, not parsed paragraphs. Types `ParsedContent`, `ParsedParagraph`, `ParsedRun` no longer exist.

3. **Section 4: Layout Engine (lines 217-259):** `layoutContent()` no longer exists. Replaced by internal `measureTokenizedContent()` → `layoutMeasuredContent()`. Type fields changed — see Type Changes above.

4. **Section 5: Cache (lines 261-296):** Entry structure changed. `getLayout()` now takes 4 params. `invalidateFlow()` now invalidates width, not just frame. See Cache Changes above.

5. **Section 6: Renderer (line 307):** `lineStartX` reference is wrong. Now uses container-based `getLineStartX` internally.

6. **Section 7: BBox Computation (line 313):** Signature shown is old positional args `(objectId, fragment, fontSize, origin, align, fixedWidth?)`. Actual current signature is `(objectId: string, props: TextProps)`.

7. **Room Doc Manager Integration (lines 636-673):** Shows `textLayoutCache.invalidate(id)` — actual method is `textLayoutCache.invalidateContent(id)`. BBox computation section shows raw Y.Map reads — now uses `getTextProps(yObj)` → `computeTextBBox(id, props)`.

8. **objects.ts drawText (lines 560-584):** Shows raw Y.Map reads and 3-param `getLayout`. Now uses `getTextProps(y)` and 4-param `getLayout` with `props.width`.

9. **Y.Doc Schema (line 99):** Shows `widthMode: 'auto'`. Now `width: 'auto' | number` (TextWidth type).

---

## What's NOT Done Yet (Next Session Scope)

### 1. TextTool.ts — Fixed-Width Support

**Current state:** TextTool creates objects with `width: 'auto'`. No mechanism to set or change width.

**Needed for fixed-width mode:**
- E/W resize handles on the DOM overlay container during editing
- Dragging a resize handle writes `width: <number>` to Y.Map
- Switching from auto → fixed: measure current DOM width, set as initial fixed width
- Switching from fixed → auto: set `width: 'auto'`
- `repositionEditor()` must set DOM container width when in fixed mode

### 2. CSS for Fixed-Width DOM Overlay

**Current CSS (auto mode only):**
```css
.text-editor-container {
  width: max-content;          /* auto: grows with content */
  white-space: pre-wrap;
  /* no overflow-wrap */
}
```

**Needed for fixed mode:**
```css
.text-editor-container[data-width-mode="fixed"] {
  /* width set via inline style (JS) */
  white-space: pre-wrap;       /* already present */
  overflow-wrap: break-word;   /* break long words at grapheme boundaries */
  word-break: normal;          /* don't break CJK differently */
}
```

**Key CSS requirements for canvas ↔ DOM matching:**

| Property | Value | Why |
|----------|-------|-----|
| `white-space` | `pre-wrap` | Already set. Wraps at soft breaks, preserves whitespace. |
| `overflow-wrap` | `break-word` | Break oversized words at arbitrary points. |
| `word-break` | `normal` | Default. Don't use `break-all` (breaks mid-word even when not needed). |
| `width` | `{fixedWidth * scale}px` (inline) | Set by JS from Y.Map `width` value. |
| `text-align` | Already handled via `--text-align` | Lines align within fixed container. |

**Auto mode CSS must stay as-is:** `width: max-content` ensures the container grows with content and never wraps.

### 3. Width in Observer (Optional Enhancement)

The deep observer in `room-doc-manager.ts` doesn't explicitly handle `width` changes. Currently works via comparison-based detection in `getLayout()`: when `computeTextBBox` is called with the new width, `getLayout` detects `layoutWidth !== width` and re-flows.

For explicit invalidation (faster path), could add:
```typescript
} else if (field === 'width') {
  textLayoutCache.invalidateFlow(id);
}
```

But this is optional — the comparison-based approach already works correctly.

### 4. TextTool EditorState

`EditorState` may need a `widthMode` or `width` field to track whether the editor is in auto or fixed mode, for:
- Deciding whether to set explicit CSS width on the container
- Resize handle visibility
- Width persistence on commitAndClose

---

## Testing Guide

### Auto Mode Regression (must be visually identical)

1. Create text objects with different alignments (left/center/right)
2. Type multi-line text (press Enter for new paragraphs)
3. Mix bold/italic within lines
4. Verify canvas rendering matches DOM overlay exactly
5. Test with different font sizes (20/30/40/50)

### Fixed Mode Verification (after TextTool changes)

1. Set `width` to a number on a Y.Map via console:
   ```javascript
   // In browser console, find a text object's Y.Map and set width
   roomDoc.mutate(ydoc => {
     const objects = ydoc.getMap('root').get('objects');
     const textObj = objects.get('<text-object-id>');
     textObj.set('width', 200);
   });
   ```
2. Verify canvas wrapping matches a `<div>` with:
   ```css
   width: 200px; /* at scale=1 */
   white-space: pre-wrap;
   overflow-wrap: break-word;
   font-family: "Grandstander", cursive, sans-serif;
   font-size: <same>px;
   line-height: <fontSize * 1.3>px;
   ```
3. Test edge cases:
   - Empty text
   - Single space
   - Long word wider than container (should break at grapheme boundaries)
   - Mixed bold/italic mid-word
   - Trailing spaces (should hang, not affect alignment)
   - Leading spaces (committed, can overflow)
   - Center/right alignment within fixed container

### Sub-pixel Differences (Expected)

In auto mode, the old code measured entire paragraph text as one `measureText()` call. The new code measures per-word/space token separately, then sums widths. This may produce sub-pixel width differences due to kerning, but matches CSS behavior more accurately. Visually imperceptible.
