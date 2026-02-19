# PLAN_DRAFT_1.md — Implementation Follow-Up (v2)

## Prerequisite Pass Changelog (completed)

The following changes were applied as a prerequisite pass before implementing the wrapping pipeline. The implementing agent should treat these as already done in the codebase:

- **`object-accessors.ts`:** Added `TextAlign`, `TextWidth` types, `TextProps` interface, `getTextProps()`, `getTextWidth()` accessors. Updated `getAlign()` return type to `TextAlign`. Removed `getWidthMode()`.
- **`text-system.ts`:** Re-exported `TextAlign`/`TextWidth`/`TextProps` from `@avlo/shared` (removed local `TextAlign` def). Renamed `ParsedRun` → `StyledText`, `MeasuredLine.isEmpty` → `hasInk` (inverted), `MeasuredLine.inkBounds` → `ink`. Removed `structuralHash`/`charCount` from `ParsedContent`/`TextLayout`, `isEmpty` from `ParsedParagraph`, `simpleHash()`. Cache uses null-sentinel pattern (`parsed: null`, `layoutFontSize: null`), renamed `invalidate()` → `invalidateContent()`, added `invalidateFlow()`, `remove()`. Updated `computeTextBBox()` signature to `(objectId, props: TextProps)`. Added standalone `LRU` class and `ZERO_INK` constant.
- **`TextTool.ts`:** Changed `widthMode` → `width` Y.Map key. Used `getTextProps()`/`getColor()` from shared in `mountEditor()`.
- **`room-doc-manager.ts`:** Uses `getTextProps()` in both `applyObjectChanges` and `hydrateObjectsFromY`. Observer uses `invalidateContent()`, deletion uses `remove()`.
- **`objects.ts`:** `drawText()` uses `getTextProps()`. Removed unused `import * as Y`.

**Not done:** The wrapping pipeline itself (tokenizer, flow engine, break-word). The followup's §2–§10 type system overhaul and fused parse+tokenize are part of the full implementation.

---

**Purpose:** Corrections, refinements, and type system overhaul for the implementing agent. Read alongside `PLAN_DRAFT_1.md`. Where this document specifies a change, override the plan with the code below. Everything NOT mentioned here is verified correct in the plan and should be implemented as-is.

---

## 1. Y.Map Schema: Single `width` Key

The plan uses two Y.Map keys (`widthMode` + `width`). Replace with a single `width` key storing `'auto' | number`.

**Remove from Y.Map schema:**
- `widthMode` key (eliminated)

**The `width` key stores:** `'auto'` (string) or a positive number (world units).

**Discrimination is via `typeof`:**
```ts
const w = y.get('width');
// typeof w === 'number' → fixed mode
// otherwise → auto mode
```

**TextTool `createTextObject` change:**
```ts
// Old:
yObj.set('widthMode', 'auto');
// New:
yObj.set('width', 'auto');
```

**SelectTool E/W resize (future):**
```ts
// Set fixed width — one operation, no mode check:
yObj.set('width', newWidth);
// Reset to auto:
yObj.set('width', 'auto');
```

**No migration needed.** Existing text objects have no numeric `width` key → `y.get('width')` returns `undefined` → treated as auto.

---

## 2. Type System Overhaul

Replace the plan's type definitions (lines 190–307) with the following. Key changes:
- `StyledText` base → `MeasuredSegment` → `MeasuredRun` extends chain
- `TokenBase<S>` generic encodes segment enrichment
- `ParsedRun`, `ParsedParagraph`, `ParsedContent`, `TokenSegment` eliminated (fused parse+tokenize, §4)
- `structuralHash` and `charCount` removed from all types (dead code — never read)
- `isEmpty` removed from paragraph types (inline `tokens.length === 0`)
- `MeasuredLine.isEmpty` → `hasInk` (semantic correction — matches LineBuilder, no double negation)
- `WrapConfig` and `WidthMode` types eliminated (`TextWidth` replaces both)
- `TextLayout.structuralHash` removed

```ts
// ── Base types ─────────────────────────────────────────

interface StyledText {
  text: string;
  bold: boolean;
  italic: boolean;
}

type TokenKind = 'word' | 'space';

interface TokenBase<S extends StyledText> {
  kind: TokenKind;
  segments: S[];
}

// ── Segment enrichment chain ──────────────────────────

interface MeasuredSegment extends StyledText {
  font: string;
  advanceWidth: number;
  ink: BBoxTuple;
  isWhitespace: boolean;
}

export interface MeasuredRun extends MeasuredSegment {
  advanceX: number;
}

// ── Token types ───────────────────────────────────────

type Token = TokenBase<StyledText>;

interface MeasuredToken extends TokenBase<MeasuredSegment> {
  advanceWidth: number;
}

// ── Paragraph types ───────────────────────────────────

interface TokenizedParagraph {
  tokens: Token[];
}

interface MeasuredParagraph {
  tokens: MeasuredToken[];
}

// ── Content types ─────────────────────────────────────

interface TokenizedContent {
  paragraphs: TokenizedParagraph[];
}

interface MeasuredContent {
  paragraphs: MeasuredParagraph[];
  fontSize: number;
  lineHeight: number;
}

// ── Layout output ─────────────────────────────────────

export interface MeasuredLine {
  runs: MeasuredRun[];
  index: number;
  advanceWidth: number;
  visualWidth: number;
  ink: BBoxTuple;
  baselineY: number;
  lineHeight: number;
  hasInk: boolean;         // was: isEmpty (inverted). true = has non-whitespace runs
}

export interface TextLayout {
  lines: MeasuredLine[];
  fontSize: number;
  lineHeight: number;
  widthMode: 'auto' | 'fixed';  // derived from input TextWidth, for renderer/bbox
  boxWidth: number;
  inkBBox: FrameTuple;
  logicalBBox: FrameTuple;
  // structuralHash: REMOVED (never read by any consumer)
}

// ── Config (exported) ─────────────────────────────────

export type TextAlign = 'left' | 'center' | 'right';
export type TextWidth = 'auto' | number;
```

**`hasInk` impact on existing plan code:**

| Location | Old | New |
|----------|-----|-----|
| `pushLine` (line 627) | `isEmpty: !b.hasInk` | `hasInk: b.hasInk` |
| `computeTextBBox` loop | `if (line.isEmpty) continue` | `if (!line.hasInk) continue` |
| Renderer (line 1051) | `if (line.runs.length === 0) continue` | unchanged |

**`TextWidth` impact — replace all `WrapConfig` usage:**

| Old | New |
|-----|-----|
| `wrap: WrapConfig = DEFAULT_WRAP` | `width: TextWidth = 'auto'` |
| `wrap.mode === 'fixed'` | `typeof width === 'number'` |
| `wrap.width ?? 0.01` | `width` (narrowed to `number` by typeof check) |
| `widthMode: wrap.mode` in TextLayout return | `widthMode: isFixed ? 'fixed' : 'auto'` |

Remove the `DEFAULT_WRAP` constant, `WrapConfig` type, and `WidthMode` type entirely.

**`TextAlign` and `TextWidth` location:** Define both in `@avlo/shared` (object-accessors.ts). Re-export from `text-system.ts` for existing consumers.

---

## 3. Object Accessor: `getTextLayoutProps`

Add to `packages/shared/src/accessors/object-accessors.ts`. This eliminates the 6-key manual read that appears twice in room-doc-manager and once in objects.ts.

```ts
import type * as Y from 'yjs';

export type TextAlign = 'left' | 'center' | 'right';
export type TextWidth = 'auto' | number;

export interface TextLayoutProps {
  content: Y.XmlFragment;
  origin: [number, number];
  fontSize: number;
  align: TextAlign;
  width: TextWidth;
}

export function getTextLayoutProps(y: Y.Map<unknown>): TextLayoutProps | null {
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

/** Standalone width accessor (typeof discriminates auto vs fixed) */
export function getTextWidth(y: Y.Map<unknown>): TextWidth {
  const w = y.get('width');
  return typeof w === 'number' ? w : 'auto';
}
```

**Remove:** `getWidthMode()` accessor (no longer relevant — `widthMode` key is gone).

**Keep:** Individual accessors `getFontSize`, `getOrigin`, `getAlign`, `getContent` for one-off reads (e.g., SelectTool's `getOrigin`).

---

## 4. Fused Parse+Tokenize & Allocation Optimization

Replace the plan's `parseYXmlFragment` (lines 321–368) and `tokenizeParsedContent` (lines 404–425) with a single fused function. This eliminates `ParsedContent`, `ParsedParagraph`, and `ParsedRun` types, the intermediate allocation pass, and the `splitWsNonWs` intermediate array.

**Replace `pushSegment` (lines 389–402) — take primitives, not objects:**

```ts
/**
 * Merge segment into token stream. Takes primitives to avoid allocating
 * StyledText objects that are immediately discarded during coalescing.
 * Objects are only created when actually stored.
 */
function pushSegment(
  tokens: Token[],
  kind: TokenKind,
  text: string,
  bold: boolean,
  italic: boolean,
): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind) {
    const lastSeg = last.segments[last.segments.length - 1];
    if (lastSeg && lastSeg.bold === bold && lastSeg.italic === italic) {
      lastSeg.text += text;
      return; // No object allocated — just string concat
    }
    last.segments.push({ text, bold, italic });
    return;
  }
  tokens.push({ kind, segments: [{ text, bold, italic }] });
}
```

**Replace `parseYXmlFragment` + `tokenizeParsedContent` + `splitWsNonWs` with fused function:**

```ts
export function parseAndTokenize(fragment: Y.XmlFragment): TokenizedContent {
  const paragraphs: TokenizedParagraph[] = [];
  const children = fragment.toArray();

  if (children.length === 0) {
    paragraphs.push({ tokens: [] });
  } else {
    for (const child of children) {
      if (!(child instanceof Y.XmlElement) || child.nodeName !== 'paragraph') continue;
      const tokens: Token[] = [];

      for (const textNode of child.toArray()) {
        if (!(textNode instanceof Y.XmlText)) continue;
        for (const op of textNode.toDelta()) {
          if (typeof op.insert !== 'string') continue;
          const attrs = op.attributes || {};
          const bold = !!attrs.bold;
          const italic = !!attrs.italic;

          // Inline tokenization — no intermediate array or objects
          const re = /(\s+|\S+)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(op.insert)) !== null) {
            pushSegment(tokens, /^\s+$/.test(m[0]) ? 'space' : 'word', m[0], bold, italic);
          }
        }
      }
      paragraphs.push({ tokens });
    }
  }

  if (paragraphs.length === 0) {
    paragraphs.push({ tokens: [] });
  }
  return { paragraphs };
}
```

**Paragraph isEmpty check — inline `tokens.length === 0` everywhere:**

| Plan line | Old | New |
|-----------|-----|-----|
| `measureTokenizedContent` (line 448) | `if (p.isEmpty)` | `if (p.tokens.length === 0)` |
| `layoutMeasuredContent` (line 756) | `if (p.isEmpty \|\| p.tokens.length === 0)` | `if (p.tokens.length === 0)` |

---

## 5. Cache Entry Reuse & Null Sentinels

The plan's `invalidate(id)` deletes the cache entry on content changes, creating a new entry on the very next `getLayout` call (every keystroke). Instead, reuse the entry object by marking `tokenized` as null — consistent with how `invalidateLayout` and `invalidateFlow` use null sentinels.

**Replace the plan's CacheEntry (lines 914–925):**

```ts
interface CacheEntry {
  tokenized: TokenizedContent | null;  // null = content stale, full re-pipeline
  measured: MeasuredContent;
  measuredFontSize: number | null;     // null = fontSize stale, re-measure + re-flow
  layout: TextLayout;
  layoutWidth: TextWidth | null;       // null = width stale, re-flow only
  frame: FrameTuple | null;
}
```

**Replace the plan's TextLayoutCache (lines 927–1019):**

```ts
class TextLayoutCache {
  private cache = new Map<string, CacheEntry>();

  getLayout(
    objectId: string,
    fragment: Y.XmlFragment,
    fontSize: number,
    width: TextWidth = 'auto',
  ): TextLayout {
    const entry = this.cache.get(objectId);

    // Cold miss OR content stale → full pipeline
    if (!entry || entry.tokenized === null) {
      const tokenized = parseAndTokenize(fragment);
      const measured = measureTokenizedContent(tokenized, fontSize);
      const layout = layoutMeasuredContent(measured, width);

      if (entry) {
        // Content stale — reuse entry object (no Map operations)
        entry.tokenized = tokenized;
        entry.measured = measured;
        entry.measuredFontSize = fontSize;
        entry.layout = layout;
        entry.layoutWidth = width;
        entry.frame = null;
      } else {
        // True cold miss
        this.cache.set(objectId, {
          tokenized, measured, measuredFontSize: fontSize,
          layout, layoutWidth: width, frame: null,
        });
      }
      return layout;
    }

    // FontSize changed → re-measure + re-flow
    if (entry.measuredFontSize !== fontSize) {
      entry.measured = measureTokenizedContent(entry.tokenized, fontSize);
      entry.measuredFontSize = fontSize;
      entry.layout = layoutMeasuredContent(entry.measured, width);
      entry.layoutWidth = width;
      entry.frame = null;
      return entry.layout;
    }

    // Width changed → re-flow only
    if (entry.layoutWidth !== width) {
      entry.layout = layoutMeasuredContent(entry.measured, width);
      entry.layoutWidth = width;
      entry.frame = null;
      return entry.layout;
    }

    return entry.layout;
  }

  /** Content changed: mark tokenized stale, reuse entry */
  invalidateContent(objectId: string): void {
    const e = this.cache.get(objectId);
    if (e) { e.tokenized = null; e.frame = null; }
  }

  /** FontSize changed: mark measured stale */
  invalidateLayout(objectId: string): void {
    const e = this.cache.get(objectId);
    if (e) { e.measuredFontSize = null; e.frame = null; }
  }

  /** Width changed: mark layout stale */
  invalidateFlow(objectId: string): void {
    const e = this.cache.get(objectId);
    if (e) { e.layoutWidth = null; e.frame = null; }
  }

  /** Object deleted from canvas: remove entry from Map */
  remove(objectId: string): void {
    this.cache.delete(objectId);
  }

  setFrame(objectId: string, frame: FrameTuple): void {
    const e = this.cache.get(objectId);
    if (e) e.frame = frame;
  }

  getFrame(objectId: string): FrameTuple | null {
    return this.cache.get(objectId)?.frame ?? null;
  }

  clear(): void { this.cache.clear(); }
  has(objectId: string): boolean { return this.cache.has(objectId); }
}
```

**Key differences from the plan:**

| Plan | This follow-up |
|------|---------------|
| `invalidate(id)` → `cache.delete(id)` | `invalidateContent(id)` → sets `tokenized = null`, reuses entry |
| `invalidateContent(id)` alias for delete | Removed (replaced by above) |
| `measuredFontSize = -1` sentinel | `measuredFontSize = null` sentinel (type-safe) |
| `layoutWidth = NaN` sentinel | `layoutWidth = null` sentinel (type-safe) |
| `layoutWidth: number` + `layoutWidthMode: WidthMode` | `layoutWidth: TextWidth \| null` (one field) |
| No `remove()` method | `remove(id)` for object deletion from canvas |

**Null sentinel correctness:** `null !== 'auto'` → true. `null !== 200` → true. Any null sentinel triggers recomputation. `'auto' === 'auto'` → false (no re-flow). `200 === 200` → false (no re-flow). All cases correct.

---

## 6. Observer Cleanup

The plan's observer field checks for `fontSize` and `width`/`widthMode` (lines 1276–1278) are dead code — direct Y.Map property changes produce events with `path.length === 1`, but the `path.length >= 2` guard prevents field classification. **Remove them.** The `getLayout` comparison-based approach handles these changes (see §5).

The `field === 'content'` check (line 935) DOES fire correctly because XmlFragment edits produce paths with `length >= 3`.

**Replace the observer's text cache invalidation (room-doc-manager lines 931–943):**

```ts
// Classify text-related events for cache invalidation
if (path.length >= 2) {
  const field = String(path[1] ?? '');
  if (field === 'content') {
    textLayoutCache.invalidateContent(id);  // was: invalidate(id)
    textContentChangedIds.add(id);
  }
  // fontSize/width changes: handled by getLayout comparison in applyObjectChanges.
  // Observer field checks for these are dead code (path.length === 1 for
  // direct Y.Map property changes) — intentionally omitted.
}
```

**Object deletion handler (room-doc-manager line 993):**

```ts
// Old:
textLayoutCache.invalidate(id);
// New:
textLayoutCache.remove(id);
```

**Do NOT add** `field === 'width'` checks to the observer. `getLayout` comparison is the primary mechanism for fontSize/width staleness detection.

---

## 7. Critical Fix: Font Metric Safety

The plan's `getMeasuredAscentRatio()` (lines 59–68) drops the `areFontsLoaded()` guard, `FALLBACK_ASCENT_RATIO`, line-gap handling, and `resetFontMetrics()` export. `main.tsx` imports `resetFontMetrics` — build will break without it.

**Replace lines 57–68 with the current system's implementation:**

```ts
let _measuredAscentRatio: number | null = null;

const FALLBACK_ASCENT_RATIO = 0.73;

export function getMeasuredAscentRatio(): number {
  if (_measuredAscentRatio !== null) {
    return _measuredAscentRatio;
  }

  if (!areFontsLoaded()) {
    console.warn('[text-system] getMeasuredAscentRatio called before fonts loaded! Using fallback.');
    return FALLBACK_ASCENT_RATIO;
  }

  const ctx = getMeasureContext();
  const testSize = 100;
  ctx.font = buildFontString(false, false, testSize);
  const metrics = ctx.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');

  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  const totalHeight = ascent + descent;

  const tolerance = testSize * 0.01;
  if (Math.abs(totalHeight - testSize) < tolerance) {
    _measuredAscentRatio = ascent / testSize;
  } else {
    _measuredAscentRatio = ascent / totalHeight;
  }

  return _measuredAscentRatio;
}

export function resetFontMetrics(): void {
  _measuredAscentRatio = null;
}
```

---

## 8. Critical Fix: BBox + `computeTextBBox` Replacement

Two issues in the plan's `computeTextBBox` (lines 1075–1116):

1. **BBox seeded with container edges** (`minX = boxLeft`, `maxX = boxRight`) — makes bbox at least as wide as container even when ink is narrower. Use ink-tight bounds.
2. **Signature takes 6 params** — replace with `TextLayoutProps` (§3).

**Replace lines 1075–1116 with:**

```ts
export function computeTextBBox(objectId: string, props: TextLayoutProps): BBoxTuple {
  const { content, origin, fontSize, align, width } = props;
  const layout = textLayoutCache.getLayout(objectId, content, fontSize, width);
  const [ox, oy] = origin;
  const padding = 2;

  // Derive and cache frame
  const fx = getBoxLeftX(ox, layout.boxWidth, align);
  const fy = oy - fontSize * getBaselineToTopRatio();
  textLayoutCache.setFrame(objectId, [fx, fy, layout.boxWidth, layout.logicalBBox[3]]);

  // Ink-tight horizontal bounds (NOT container-seeded)
  let minX = Infinity;
  let maxX = -Infinity;

  for (const line of layout.lines) {
    if (!line.hasInk) continue;
    const lineW = layout.widthMode === 'auto' ? line.advanceWidth : line.visualWidth;
    const lx = getLineStartX(ox, layout.boxWidth, lineW, align);
    minX = Math.min(minX, lx + line.ink[0]);
    maxX = Math.max(maxX, lx + line.ink[2]);
  }

  // Fallback for all-empty content
  if (!isFinite(minX)) { minX = fx; maxX = fx; }

  return [
    minX - padding,
    oy + layout.inkBBox[1] - padding,
    maxX + padding,
    oy + layout.inkBBox[1] + layout.inkBBox[3] + padding,
  ];
}
```

**Note:** `layout.boxWidth` is correct for frame width in both modes. In auto mode, `boxWidth = maxAdvanceWidth = logicalBBox[2]`. In fixed mode, `boxWidth = explicit width`. The conditional `wrap.mode === 'fixed' ? layout.boxWidth : layout.logicalBBox[2]` from the original follow-up simplified because they're always equal.

---

## 9. Critical Fix: Width Normalization

The plan uses `Math.max(0.01, ...)` for `maxWidth` but `Math.max(0, ...)` for `boxWidth`. Use the same `0.01` floor for both.

With `TextWidth`, both are computed from the same expression:

```ts
const isFixed = typeof width === 'number';
const maxWidth = isFixed ? Math.max(0.01, width) : Infinity;
// ...
const boxWidth = isFixed ? Math.max(0.01, width) : maxAdvanceWidth;
```

No `?? 0.01` fallbacks needed — when `isFixed` is true, `width` is narrowed to `number` by TypeScript.

---

## 10. `layoutMeasuredContent` Signature Change

**Replace `wrap: WrapConfig` parameter with `width: TextWidth`:**

```ts
function layoutMeasuredContent(content: MeasuredContent, width: TextWidth): TextLayout {
  const { fontSize, lineHeight } = content;
  const isFixed = typeof width === 'number';
  const maxWidth = isFixed ? Math.max(0.01, width) : Infinity;

  // ... (flow engine body unchanged) ...

  const boxWidth = isFixed ? Math.max(0.01, width) : maxAdvanceWidth;

  // ... (ink clamping unchanged) ...

  return {
    lines,
    fontSize,
    lineHeight,
    widthMode: isFixed ? 'fixed' : 'auto',
    boxWidth,
    inkBBox,
    logicalBBox,
    // structuralHash: REMOVED
  };
}
```

**Also in `pushLine`:** change `isEmpty: !b.hasInk` → `hasInk: b.hasInk`.

**Also:** remove `maxVisualWidth` (declared line 600, accumulated line 630, never read — dead code).

---

## 11. Call-Site Changes

### `objects.ts` — `drawText()`

```ts
// Imports:
import { getTextLayoutProps, type TextLayoutProps, getColor } from '@avlo/shared';
import { textLayoutCache, renderTextLayout } from '@/lib/text/text-system';

function drawText(ctx: CanvasRenderingContext2D, handle: ObjectHandle): void {
  const { id, y } = handle;
  if (useSelectionStore.getState().textEditingId === id) return;

  const props = getTextLayoutProps(y);
  if (!props) return;

  const color = getColor(y);
  const layout = textLayoutCache.getLayout(id, props.content, props.fontSize, props.width);
  renderTextLayout(ctx, layout, props.origin[0], props.origin[1], color, props.align);
}
```

### `room-doc-manager.ts` — `applyObjectChanges` text branch

```ts
// Replace lines 1008–1017:
if (kind === 'text') {
  const props = getTextLayoutProps(yObj);
  if (props) {
    newBBox = computeTextBBox(id, props);
  } else {
    const origin = (yObj.get('origin') as [number, number]) ?? [0, 0];
    const fontSize = (yObj.get('fontSize') as number) ?? 20;
    newBBox = [origin[0], origin[1] - fontSize, origin[0] + 1, origin[1] + 1];
  }
}
```

### `room-doc-manager.ts` — `hydrateObjectsFromY` text branch

Same pattern as above — replace lines 1105–1119 identically.

### `room-doc-manager.ts` — observer

See §6. Change `invalidate(id)` → `invalidateContent(id)`, change deletion handler to `remove(id)`.

### `TextTool.ts` — `createTextObject`

```ts
// Old:
yObj.set('widthMode', 'auto');
// New:
yObj.set('width', 'auto');
```

### `main.tsx` — `resetFontMetrics`

No change needed — `resetFontMetrics` is exported per §7.

---

## 12. Verified Correct — No Changes Needed

### `visualWidth` in `appendRun` merge branch (line 558)

```ts
b.visualWidth = prev.advanceX + prev.advanceWidth;
```

**Verified.** Traced: Run A (width 50): advanceX=0, advanceWidth=50, b.advanceX=50. Run B merge (width 50): prev.advanceWidth=100, `b.visualWidth = 0 + 100 = 100` ✓.

### Auto mode rendering (lines 1050–1063)

`getLineStartX(originX, boxWidth, lineW, align)` with `lineW = line.advanceWidth` for auto produces identical results to the current `lineStartX(originX, lineWidth, align)`. Algebraically verified for all three alignments.

### Pending whitespace flow (lines 644–669, 763–848)

Correctly implements CSS `pre-wrap`. Leading whitespace committed immediately. Inter-word whitespace buffered as pending. Trailing whitespace at paragraph end hangs. Spaces never split across lines.

### Break-word path (lines 711–746)

Forces ≥1 grapheme via `sliceTextToFit`. Binary search correct.

### Frame derivation

`fx = getBoxLeftX(ox, boxWidth, align) = ox - anchorFactor(align) * boxWidth`. Matches current system.

---

## 13. Observations (Non-Blocking)

### 1. `lineStartX` export removed — safe
No external consumer imports it (only used within text-system.ts).

### 2. `layoutContent` export removed — safe
Replaced by internal pipeline. No external imports.

### 3. Tokenizer `\s` matches NBSP
The regex `/(\\s+|\\S+)/g` treats NBSP as whitespace. Known limitation — NBSP is uncommon in Tiptap content. Acceptable for now.

### 4. `\n` handling via `\s`
`\n` classified as space token, but `\n` doesn't appear in paragraph content — Tiptap uses separate `<paragraph>` elements. Non-issue.

### 5. Observer `field === 'fontSize'` (existing line 939) is dead code
Same path.length issue as the planned width checks. Harmless but should be removed for clarity — `getLayout` comparison handles it.
