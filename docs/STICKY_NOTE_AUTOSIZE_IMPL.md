# Sticky Note Auto Font Size — Implementation Deep Dive

**Status:** DOM prototype validated. Algorithm correct. Font shrinks on keystroke, grows on delete. Two-phase search with educated jumps produces smooth, visually correct stepping behavior matching Miro's observable patterns.

**Scope:** DOM overlay editing only. Canvas rendering still uses the stored Y.Map `fontSize` and will look wrong — that's expected until the layout cache and canvas path are updated.

---

## Table of Contents

1. [The Problem](#1-the-problem)
2. [The Core Insight: Fixed Container, Variable Font](#2-the-core-insight-fixed-container-variable-font)
3. [Container Geometry](#3-container-geometry)
4. [The 100px Ratio Strategy](#4-the-100px-ratio-strategy)
5. [Font Size Steps](#5-font-size-steps)
6. [The Two-Phase Algorithm](#6-the-two-phase-algorithm)
7. [flowCheck — The Line-Counting Engine](#7-flowcheck--the-line-counting-engine)
8. [computeNoteAutoSize — The Orchestrator](#8-computenoteautosize--the-orchestrator)
9. [TextTool Integration](#9-texttool-integration)
10. [CSS Changes](#10-css-changes)
11. [Data Flow: Keystroke to Render](#11-data-flow-keystroke-to-render)
12. [Walkthrough: Typing a Long Unbroken String](#12-walkthrough-typing-a-long-unbroken-string)
13. [Walkthrough: Paragraph Behavior](#13-walkthrough-paragraph-behavior)
14. [Edge Cases](#14-edge-cases)
15. [Relationship to layoutMeasuredContent](#15-relationship-to-layoutmeasuredcontent)
16. [Files Changed](#16-files-changed)
17. [Future Direction](#17-future-direction)

---

## 1. The Problem

Before auto-size, sticky notes had explicit font sizes (chosen by the user or defaulted). When content grew, the note's height grew — turning the square note into a rectangle. This fundamentally breaks the visual metaphor of a sticky note: a fixed-size card where the handwriting gets smaller as you write more.

Every professional whiteboard app (Miro, FigJam, etc.) implements auto-sizing: the note stays fixed, the font shrinks. But the behavior is deceptively complex. It's not just "shrink until it fits." There are two distinct behavioral regimes separated by a phase transition, and getting the stepping granularity right is critical to the feel.

---

## 2. The Core Insight: Fixed Container, Variable Font

The mental model is simple: the note is a 280×280 world-unit square. The content area (after padding) is 256×256. The algorithm's job is: **given the current text content, find the largest font size from a predefined step list where the text fits within the 256×256 content box.**

"Fits" means:
- Every word (in Phase 1) is narrower than the content width at that font size
- The total line count (after word-wrapping) does not exceed the available vertical space
- Words wrap at word boundaries following CSS `pre-wrap` + `break-word` rules

The note's stored `fontSize` in the Y.Map is ignored during editing. The auto-computed size is used for the DOM overlay. The Y.Map value remains at its default — it will be used (or replaced) when the canvas rendering path is updated.

---

## 3. Container Geometry

```
NOTE_WIDTH = 280 world units (the full note, including padding)
padding = getNotePadding(280) = 280 * (12/280) = 12
contentWidth = getNoteContentWidth(280) = 280 - 2*12 = 256
contentHeight = contentWidth = 256  (square content box)
```

**Why square?** The existing convention (`maxContentH = contentWidth`) makes notes square when content is small. Auto-size preserves this: the content area is always 256×256, and the font shrinks to fit within it.

**Why 12px padding?** The `NOTE_PADDING_RATIO` (12/280) was established with the original sticky note implementation. It provides enough visual breathing room without wasting content area.

The auto-size function operates entirely within this 256×256 content area. It never touches the note's outer dimensions, padding, corner radius, or shadow.

---

## 4. The 100px Ratio Strategy

This is the central performance insight that makes per-keystroke computation feasible.

### The Physics of Font Scaling

Font glyph advance widths scale **linearly** with font size. If the word "hello" measures 260px at 100px font size, it measures exactly 104px at 40px (260 × 0.4). This is a fundamental property of digital typography — glyphs are vector outlines scaled by the font size.

### The Strategy

Instead of re-measuring every token at every candidate font size (which would be O(tokens × steps × measureText)), we:

1. **Measure once at 100px.** Call `measureTokenizedContent(tokenized, 100, 'Grandstander')`. Every `MeasuredToken.advanceWidth` and `MeasuredSegment.advanceWidth` is now a 100px-space width. The 100px lineHeight = `100 × 1.3 = 130`.

2. **Scale the container up instead of scaling tokens down.** For a candidate font size `step`, instead of multiplying every token width by `step/100`, we divide the container width by `step/100`:

```
maxW100 = contentWidth / (step / 100) = contentWidth × 100 / step
```

At this scaled-up width, the 100px token widths produce **identical line-break positions** to what you'd get measuring at `step` with the real `contentWidth`. Everything stays in 100px space — zero per-token multiplication.

### Why This Works — Proof

At candidate size `step`, a word fits on a line when:
```
wordWidth_at_step ≤ contentWidth
```

Since `wordWidth_at_step = wordW100 × (step / 100)`:
```
wordW100 × (step / 100) ≤ contentWidth
wordW100 ≤ contentWidth / (step / 100)
wordW100 ≤ maxW100
```

The comparison `wordW100 ≤ maxW100` uses only 100px-space quantities. No per-token scaling needed.

### Why This Works for Char-Breaking Too

`sliceTextToFit(seg.font, text, lineRemaining)` uses the segment's 100px font string. `measureTextCached` returns 100px widths. `lineRemaining` is in 100px space (`maxW100 - curW`). The binary search for grapheme break positions is correct because all quantities are in the same coordinate system.

### Height Check

The one place we must use the real font size is the height constraint. The number of lines that fit in the content area depends on the actual line height:

```
maxLines = floor(contentHeight / (step × lineHeightMultiplier))
```

Which we compute as:
```
maxLines = floor(contentHeight / (lineH100 × scale))
```

where `lineH100 = 100 × 1.3 = 130` and `scale = step / 100`. This is `floor(256 / (130 × step/100))` = `floor(256 / (step × 1.3))`. At step 72: `floor(256/93.6) = 2`. At step 20: `floor(256/26) = 9`. At step 8: `floor(256/10.4) = 24`.

### Cache Efficiency

The `MEASURE_LRU` (75,000 entries) caches `measureTextCached(font, text)` results keyed by `font + '\0' + text`. Since we always measure at 100px with the same font family, the cache key set is small — just the text content × style variants (bold/italic combinations). After the first `computeNoteAutoSize` call, subsequent calls for the same content are almost entirely cache hits. Only new characters typed generate new cache entries.

---

## 5. Font Size Steps

```typescript
export const NOTE_FONT_STEPS: number[] = [
  72, 64, 56, 48, 44, 40, 36, 34, 32, 30, 28, 26, 24, 22, 20,
  18, 16, 15, 14, 13, 12, 11, 10, 9, 8,
];
```

**Why 72px max?** At 72px in Grandstander, approximately 3 characters fill the 256px content width. This is the "empty note" state — one or two characters displayed huge and centered, exactly like Miro.

**Why 8px min?** Below 8px, text becomes unreadable on standard displays. This is the absolute floor — if content can't fit at 8px, it gets clipped (which is the user's signal that their note has too much content).

**Why these specific steps?** The steps are designed for perceptual smoothness:

- **72–48 (large range):** 8px jumps. At large sizes, even 8px differences are visually significant but acceptable — users are typically typing just a few characters here.
- **48–20 (working range):** 4→2px jumps, getting finer. This is where most editing happens — short sentences, a few paragraphs. Finer steps mean each keystroke causes a smaller visual jump.
- **20–8 (small range):** 1px jumps. At small sizes, even 1px matters for fitting that one extra line. Maximum granularity here because this is where "one more character" transitions happen.

**The Phase 1 floor (18px):** This is where the behavioral transition happens. Above 18px, words are atomic and never break. Below 18px, the algorithm switches to character-breaking mode. 18px was chosen because it's the point where most reasonable single words still fit the 256px content width — below that, unbroken words start exceeding the container, and character breaking becomes the correct behavior.

---

## 6. The Two-Phase Algorithm

The two-phase model was reverse-engineered from Miro's observable behavior. It explains a phenomenon that would otherwise be inexplicable: when typing a very long unbroken word, the font steadily shrinks (Phase 1 keeping the word on one line), but at some point the font **jumps up** and the word wraps onto multiple lines (Phase 2 activating character breaking).

### Phase 1 — Words Are Atomic

Search font sizes top-down (largest first). Text is split into paragraphs and words via the tokenizer. Words are **never broken mid-character**. If any single word is wider than the content area at a given font size, that font size fails.

Phase 1 has a floor: 18px. Below this, Phase 1 gives up entirely.

**What the user sees during Phase 1:**
- Typing a long unbroken string → font shrinks steadily, text stays on one line
- Typing words with spaces → words flow across lines (normal word-wrap), font adjusts for line count
- Adding paragraphs (Enter) → each paragraph gets its own line, font adjusts vertically

**Why words are atomic in Phase 1:** This matches the user's expectation for normal text. When you type "hello world", you expect "hello" and "world" to stay intact. Character breaking should only happen for genuinely oversized content — hence the two-phase design.

### Phase 2 — Character Breaking Activated

When Phase 1 hits the floor without finding a fit (the widest word can't fit even at 18px without breaking), Phase 2 activates. It **restarts from the largest font size (72)**, but now oversized words get broken at character/grapheme boundaries via `sliceTextToFit`.

**Why Phase 2 restarts from the top:** This is the key insight from the Miro reverse-engineering. If Phase 2 continued downward from the floor, the font could never grow above 18px after the transition. But in practice, the font jumps **up** — e.g., from 18px to 48px — because with character breaking enabled, the text wraps to multiple lines and a much larger font size fits. The upward jump proves the search restarts from the top.

**After the transition:** Normal behavior resumes. Adding characters fills lines, eventually overflows height, font steps down. Removing characters frees space, font steps up. The transition is seamless — the user just sees the font adapt.

### The Constraining Element

At any given moment, the font size is determined by the **hardest-to-fit element**. This might be:
- The widest word (width constraint in Phase 1)
- The total line count after word-wrap (height constraint)
- The char-broken line count of an oversized word (height constraint in Phase 2)

Shortening the bottleneck (e.g., deleting characters from the longest word) causes the font to grow. Shortening text that was already fitting doesn't change anything — the bottleneck hasn't moved.

---

## 7. flowCheck — The Line-Counting Engine

**Location:** `text-system.ts`, §5b. Internal function (not exported).

### Purpose

`flowCheck` is a stripped-down mirror of `layoutMeasuredContent`. Instead of building `MeasuredRun[]` and `MeasuredLine[]` arrays for rendering, it **only counts lines** and **bails early** when the count exceeds `maxLines`. This makes it lightweight enough to run multiple times per keystroke across different font size candidates.

### Signature

```typescript
type FlowResult = 'fits' | 'heightOverflow' | { wordTooWide: number };

function flowCheck(
  measured: MeasuredContent,  // at 100px
  maxW: number,               // scaled-up content width (100px space)
  maxLines: number,           // max lines at this candidate font size
  phase: 1 | 2,
): FlowResult
```

### Return Values

- **`'fits'`:** All text placed within `maxLines`. This candidate font size works.
- **`'heightOverflow'`:** Text requires more than `maxLines`. Try a smaller font.
- **`{ wordTooWide: number }`:** Phase 1 only. A word's 100px advance width exceeds `maxW`. The word can't fit on a single line at this size. The returned `wordTooWide` value enables an educated jump (see §8).

### The Whitespace State Machine

The flow engine must match CSS `white-space: pre-wrap` + `overflow-wrap: break-word` behavior. This requires a pending whitespace model:

**Leading whitespace** (no ink on the line yet): Committed immediately. Can cause line overflow — this matches CSS `pre-wrap` behavior where leading whitespace is meaningful.

**Inter-word whitespace** (ink already on the line): Buffered as `pendingW`. When the next word arrives:
- If `curW + pendingW + wordW ≤ maxW`: commit pending, place word on current line.
- If it doesn't fit: the pending whitespace stays on the current line (it "hangs" past the edge for highlight rendering purposes in the real layout engine — in flowCheck we just ignore it since we're only counting lines), push the line, and place the word on a fresh line.

**Why buffer whitespace instead of committing immediately?** Because CSS `pre-wrap` does not break lines at whitespace — it only breaks when the _next word_ doesn't fit. The whitespace between words "hangs" past the container edge (it's there for highlight rendering) but doesn't cause a line break. This buffering model replicates that exactly.

### Token Processing — Three Paths

For each word token, flowCheck takes one of three paths:

#### Path 1: Oversized Word (`wordW > maxW`)

The word is wider than the entire content area at this font size. In Phase 1, this is immediately rejected — return `{ wordTooWide: wordW }`. The outer algorithm uses this to make an educated jump.

In Phase 2, the word is character-broken:
1. Finalize the current line if it has any content (`hasInk || curW > 0` → `lineCount++`).
2. Walk each segment of the word token. For each segment, consume text via `sliceTextToFit`:
   - `sliceTextToFit(seg.font, text, remaining)` does a binary search over grapheme boundaries to find the largest prefix that fits within `remaining` pixels.
   - If the head fits: advance `curW`, continue with `tail`.
   - If the head doesn't fit AND there's existing content on the line (`curW > 0`): push the line, retry on a fresh line. This is the forward-progress guarantee — a single grapheme is always placed on a fresh line, even if it overflows.
   - If `tail` is non-empty: push the line (the head filled it), start fresh for the tail.
3. After all segments consumed: set `hasInk = true`, clear `pendingW`.

#### Path 2: Normal Word, Line Has Ink (`hasInk === true`)

Test `curW + pendingW + wordW ≤ maxW`:
- **Fits:** Update `curW = testW`. Clear `pendingW`.
- **Doesn't fit:** Push the current line (`lineCount++`). Start fresh with `curW = wordW`.

This is the standard word-wrap decision: does the next word fit on this line (including the inter-word space), or do we wrap?

#### Path 3: First Word on Line (`hasInk === false`)

There may be accumulated leading whitespace in `curW`. Test `curW + wordW > maxW`:
- **Doesn't fit:** The leading whitespace pushed the word off the edge. Push the whitespace-only line (`lineCount++`). Place word on fresh line: `curW = wordW`.
- **Fits:** `curW += wordW`.

Set `hasInk = true`, clear `pendingW`.

### Paragraph Boundaries

- **Empty paragraph** (no tokens): `lineCount++`. One line consumed.
- **End of non-empty paragraph:** `lineCount++`. The current line (whatever's on it) is finalized.

The per-paragraph variables (`curW`, `hasInk`, `pendingW`) are declared inside the paragraph loop and reset automatically for each new paragraph.

### Early Termination

Every `lineCount++` is followed by `if (lineCount > maxLines) return 'heightOverflow'`. This means flowCheck exits as soon as overflow is detected — it doesn't waste time flowing the remaining paragraphs. For content that doesn't fit, this is a significant speedup, especially in the outer loop that may test many font sizes.

---

## 8. computeNoteAutoSize — The Orchestrator

**Location:** `text-system.ts`, §5b. Exported.

### Signature

```typescript
export function computeNoteAutoSize(fragment: Y.XmlFragment): number
```

Takes a Y.XmlFragment (the note's content), returns the optimal font size (one of `NOTE_FONT_STEPS`).

### Step-by-Step Algorithm

#### Step 1: Tokenize and Measure

```typescript
const tokenized = parseAndTokenize(fragment);
const measured = measureTokenizedContent(tokenized, 100, 'Grandstander');
```

- `parseAndTokenize` walks the Y.XmlFragment → paragraph elements → delta ops → word/space tokens. This is the same tokenizer used by the main layout engine.
- `measureTokenizedContent` at 100px: each segment gets a font string at 100px (e.g., `"normal 450 100px \"Grandstander\", cursive, sans-serif"`), and `measureTextCached` returns the advance width. After first run, most lookups are `MEASURE_LRU` cache hits.

**Why Grandstander is hardcoded:** This prototype only supports Grandstander for sticky notes. The measurement must use the same font as the rendering. If different fonts were supported, each would need its own measurement pass (since glyph widths differ per family).

#### Step 2: Extract Constants

```typescript
const contentWidth = getNoteContentWidth(NOTE_WIDTH);  // 256
const contentHeight = contentWidth;                     // 256 (square)
const lhMult = FONT_FAMILIES['Grandstander'].lineHeightMultiplier;  // 1.3
const lineH100 = 100 * lhMult;                         // 130
const paraCount = Math.max(1, measured.paragraphs.length);
```

`paraCount` is at least 1 because `parseAndTokenize` always ensures at least one paragraph.

#### Step 3: Compute Max Word Width

```typescript
let maxWordW100 = 0;
for (const p of measured.paragraphs) {
  for (const tok of p.tokens) {
    if (tok.kind === 'word' && tok.advanceWidth > maxWordW100)
      maxWordW100 = tok.advanceWidth;
  }
}
```

The widest word (at 100px) determines the width constraint. If `maxWordW100 = 0`, the note has no word tokens (empty or all whitespace) — any font size works.

#### Step 4: Educated Starting Index

Instead of always starting from step 0 (72px), we compute where the search should begin:

```typescript
const widthMax = (contentWidth * 100) / maxWordW100;
const heightMax = contentHeight / (paraCount * lhMult);
const maxSize = Math.min(widthMax, heightMax);
```

- **`widthMax`:** The largest font size where the widest word fits on one line. Derived from `wordW100 × (step/100) ≤ contentWidth` → `step ≤ contentWidth × 100 / wordW100`.
- **`heightMax`:** The largest font size where `paraCount` lines fit vertically. Derived from `paraCount × step × lhMult ≤ contentHeight` → `step ≤ contentHeight / (paraCount × lhMult)`. This is a lower bound since word-wrapping may produce more lines than paragraphs.
- **`maxSize`:** The tighter of the two constraints. No font size above this can possibly work.

We find the first step at or below `maxSize` and back up one index for a safety margin. The backup accounts for the fact that `heightMax` is optimistic (doesn't account for word-wrapping creating extra lines) and rounding.

**Why this matters:** Without the educated start, a note with a single very long word would start at 72px and step all the way down, triggering `wordTooWide` at every step. With the educated start, it jumps directly to the vicinity of the correct answer.

#### Step 5: Phase 1 — No Character Breaking

```typescript
for (let i = startIdx; i < NOTE_FONT_STEPS.length; i++) {
  const step = NOTE_FONT_STEPS[i];
  if (step < NOTE_PHASE1_FLOOR) { phase2 = true; break; }

  const scale = step / 100;
  const maxLines = Math.floor(contentHeight / (lineH100 * scale));
  if (maxLines < 1 || paraCount > maxLines) continue;

  const maxW100 = contentWidth / scale;
  const result = flowCheck(measured, maxW100, maxLines, 1);

  if (result === 'fits') return step;
  if (result === 'heightOverflow') continue;

  // wordTooWide — educated jump
  ...
}
```

For each step from the educated start downward:

1. **Floor check:** If `step < 18`, Phase 1 gives up. Set `phase2 = true` and break.

2. **Quick rejects:**
   - `maxLines < 1`: The font is too large for even one line to fit in the content height. Skip.
   - `paraCount > maxLines`: The paragraph count alone exceeds available lines (each paragraph needs at least one line). Skip.

3. **Full flow check:** `flowCheck(measured, maxW100, maxLines, 1)` simulates the layout.
   - `'fits'` → **return this step.** Largest font size that works.
   - `'heightOverflow'` → **continue** to next smaller step.
   - `{ wordTooWide: w100 }` → **educated jump** (below).

#### The Educated Jump

When `flowCheck` reports a word too wide, we know the exact width `w100` (at 100px). We can compute exactly which font size accommodates it:

```
needed = contentWidth × 100 / w100
```

This is the largest font size where `w100 × (step/100) ≤ contentWidth`, i.e., the word fits on one line. We find the first step at or below `needed`:
- If that step is below the Phase 1 floor → switch to Phase 2.
- Otherwise, set the loop index to jump directly there.

**Why the jump matters:** Without it, if a word is too wide at 72px, we'd try 64, 56, 48, etc., getting `wordTooWide` at each one until the word finally fits. The educated jump skips all those failed attempts. For a word that needs step 30, we jump from 72 directly to 30 — saving 6 unnecessary `flowCheck` calls.

The jump sets `i = j - 1` because the for loop will `i++` before the next iteration, landing on index `j`.

#### Step 6: Phase 2 — Character Breaking from the Top

```typescript
if (phase2) {
  for (const step of NOTE_FONT_STEPS) {
    const scale = step / 100;
    const maxLines = Math.floor(contentHeight / (lineH100 * scale));
    if (maxLines < 1 || paraCount > maxLines) continue;
    const maxW100 = contentWidth / scale;
    if (flowCheck(measured, maxW100, maxLines, 2) === 'fits') return step;
  }
}
```

Phase 2 starts from step 0 (72px) — **not** from where Phase 1 left off. This is critical: with character breaking enabled, a word that needed 18px when kept on one line might fit at 48px when wrapped to 3 lines. The font jumps up.

Phase 2 uses `flowCheck` with `phase = 2`, which char-breaks oversized words via `sliceTextToFit` instead of rejecting them. It never returns `wordTooWide`. The only failure mode is `heightOverflow`.

No educated jump in Phase 2 — oversized words are handled by char-breaking, and the search is top-down until a fit is found.

#### Step 7: Fallback

```typescript
return NOTE_FONT_STEPS[NOTE_FONT_STEPS.length - 1]; // 8
```

If even 8px with character breaking doesn't fit, return the smallest step. The CSS `overflow: hidden` will clip the excess. This is the user's signal to delete content.

---

## 9. TextTool Integration

### New Fields

```typescript
private isAutoSizeNote = false;
private autoFontSize = 0;
```

- `isAutoSizeNote`: Set to `true` when the active editor is a sticky note. Guards all auto-size code paths.
- `autoFontSize`: The computed font size in world units. Replaces the stored Y.Map `fontSize` for CSS calculations.

### mountEditor — Note Branch

When mounting a note editor, after the existing positioning setup:

```typescript
this.isAutoSizeNote = true;
this.autoFontSize = computeNoteAutoSize(fragment!);
const sf = this.autoFontSize * scale;
container.style.fontSize = `${sf}px`;
container.style.lineHeight = `${sf * FONT_FAMILIES['Grandstander'].lineHeightMultiplier}px`;
container.style.maxHeight = `${maxContentH * scale}px`;
```

**What's happening here:**

1. **`computeNoteAutoSize(fragment!)`** runs the full algorithm on the current content. For a new empty note, this returns 72 (huge font for the first character).

2. **Override fontSize/lineHeight.** The container's `fontSize` and `lineHeight` were already set generically (from the stored Y.Map value). These lines override them with the auto-computed size × camera scale.

3. **`maxHeight`** constrains the container to the square content area. This is the key CSS constraint: the container can never grow taller than 256 × scale pixels. Combined with `overflow: hidden`, content that exceeds this is clipped until the next auto-size recalculation shrinks the font. Without this, the browser would expand the container to fit all content, defeating the auto-size purpose.

**Why override instead of computing earlier?** The generic `fontSize` read (from `getTextProps`) and the note-specific positioning (from `getNoteProps`) are separate concerns. The auto-size override is a post-hoc adjustment — clean separation, minimal code change.

### onTransaction — Triggering Recomputation

```typescript
onTransaction: ({ editor: ed, transaction }) => {
  syncInlineStylesToStore(ed);
  if (this.isAutoSizeNote && transaction.docChanged) {
    this.updateAutoSize();
  }
},
```

**Why `transaction.docChanged`?** Tiptap fires `onTransaction` for every ProseMirror transaction — including cursor movements, selection changes, and mark toggles. Only content changes (typing, deleting, pasting) affect the font size computation. Checking `docChanged` ensures we only run the expensive-ish `computeNoteAutoSize` when the content actually changed. Selection changes trigger `syncInlineStylesToStore` but skip the auto-size path.

**Timing:** By the time `onTransaction` fires, the Tiptap↔Yjs collaboration extension has already synced the change to the Y.XmlFragment. So `getContent(handle.y)` in `updateAutoSize()` returns the current content including the just-typed character.

### updateAutoSize — The Per-Keystroke Path

```typescript
private updateAutoSize(): void {
  if (!this.container || !this.objectId) return;
  const handle = getCurrentSnapshot().objectsById.get(this.objectId);
  if (!handle) return;
  const fragment = getContent(handle.y);
  if (!fragment) return;

  const newSize = computeNoteAutoSize(fragment);
  if (newSize === this.autoFontSize) return;
  this.autoFontSize = newSize;

  const scale = useCameraStore.getState().scale;
  const sf = newSize * scale;
  this.container.style.fontSize = `${sf}px`;
  this.container.style.lineHeight = `${sf * FONT_FAMILIES['Grandstander'].lineHeightMultiplier}px`;
}
```

**Early exit on same size:** Most keystrokes don't change the font size. A note at 30px stays at 30px when the user types one more character that still fits. The `if (newSize === this.autoFontSize) return` check avoids two unnecessary CSS property writes and the browser reflow they'd trigger.

**What it writes:** Only `fontSize` and `lineHeight`. The position (left/top), maxWidth, maxHeight, and alignment are unchanged by content changes — they only change on pan/zoom (via `positionEditor`).

**Performance:** `computeNoteAutoSize` runs in well under 1ms for typical note content:
- `parseAndTokenize`: regex walk of Y.XmlFragment, ~0.1ms.
- `measureTokenizedContent` at 100px: mostly `MEASURE_LRU` cache hits after first run, ~0.1ms.
- `flowCheck` loop: pure arithmetic (width comparisons). Phase 2 (rare) adds `sliceTextToFit` calls. Typical: <0.2ms.
- CSS assignment: 2 property writes. The browser handles reflow.

### positionEditor — Pan/Zoom Updates

```typescript
const sf = (this.isAutoSizeNote ? this.autoFontSize : fontSize) * scale;
```

When the user pans or zooms, `positionEditor` is called via `onViewChange`. The font size in world units doesn't change (content unchanged), but the CSS pixel size must be recalculated: `autoFontSize × newScale`. The `maxHeight` is also recalculated: `maxContentH × newScale`.

**Why this.autoFontSize and not recomputing?** Pan/zoom doesn't change content. The auto-size result is deterministic for given content. Recomputing would be wasted work.

### commitAndClose — Cleanup

```typescript
this.isAutoSizeNote = false;
this.autoFontSize = 0;
```

Reset the auto-size state when the editor is closed. The next `mountEditor` call will set them fresh.

### syncProps — No Changes Needed

The `syncProps` method handles Y.Map property changes from undo/redo. For auto-size notes, the Y.Map `fontSize` is ignored — the auto-computed size takes precedence. If the user undoes a content change, `onTransaction` fires with `docChanged = true`, which calls `updateAutoSize()`, which recomputes the font from the (now reverted) content. Undo/redo works through the existing content-change path with zero special handling.

---

## 10. CSS Changes

### The One-Line Change

```css
/* Before */
.tiptap[data-width-mode='note'] {
  overflow: visible;
  text-align: var(--text-align, center);
}

/* After */
.tiptap[data-width-mode='note'] {
  overflow: hidden;
  text-align: var(--text-align, center);
}
```

**Why `overflow: hidden`?** When the user types a character, there's a brief moment between the DOM updating (character appears at current font size) and the auto-size recalculating (font shrinks to fit). During this moment, the content may overflow the container. `overflow: hidden` clips this momentary overflow, preventing a visual flash.

In practice, the `onTransaction` callback fires synchronously after the ProseMirror transaction processes the keystroke, and `updateAutoSize` writes the new CSS font size immediately. The browser batches the DOM change + CSS change into a single repaint. So the "momentary overflow" is typically sub-frame. But `overflow: hidden` is the safety net.

### What CSS Stays the Same

- **Base `.tiptap` rules:** `width: max-content`, `overflow-wrap: break-word`, `white-space: pre-wrap` — all essential. `break-word` enables the browser to char-break words that exceed `maxWidth` (matching Phase 2 behavior). `pre-wrap` preserves whitespace semantics that the flow engine mirrors.
- **Transform positioning:** `transform: translateX(var(--text-anchor-tx)) translateY(var(--text-anchor-ty))` — the vertical centering via CSS clamp is untouched.
- **`.tiptap[data-width-mode='note'] p { margin: 0 }`** — paragraph margins must be zero for the line-height-based vertical calculations to work.

### Inline Styles (Set by TextTool, Not the CSS File)

- **`maxHeight: ${maxContentH × scale}px`** — the key constraint. The container can never grow taller than the square content area. This is the CSS-side enforcement of the fixed-container model.
- **`maxWidth: ${contentWidth × scale}px`** — already existed. Constrains horizontal content.
- **`fontSize` and `lineHeight`** — overridden to use the auto-computed size.

---

## 11. Data Flow: Keystroke to Render

### Content Change (Typing)

```
User types a character
  → Tiptap processes keystroke
  → prosemirror-yjs syncs change to Y.XmlFragment (synchronous)
  → ProseMirror transaction fires
  → onTransaction({ editor, transaction })
    → syncInlineStylesToStore(editor)     // update toolbar bold/italic state
    → transaction.docChanged === true
    → updateAutoSize()
      → getCurrentSnapshot().objectsById.get(objectId)  // get live Y.Map handle
      → getContent(handle.y)                             // get Y.XmlFragment
      → computeNoteAutoSize(fragment)
        → parseAndTokenize(fragment)       // Y.XmlFragment → Token[]
        → measureTokenizedContent(tok, 100, 'Grandstander')
        │   // each segment → measureTextCached (MEASURE_LRU hits)
        │   // → MeasuredContent with 100px widths
        → compute maxWordW100, startIdx    // educated starting point
        → Phase 1: flowCheck at each step
        │   step 72: fits? → too many lines? → word too wide? → educated jump
        │   ...
        │   floor reached? → Phase 2
        → Phase 2: flowCheck with char-breaking
        │   step 72 → 64 → ... → first fitting step → return
        → return optimal font size
      → if newSize === this.autoFontSize: return (no change)
      → this.autoFontSize = newSize
      → container.style.fontSize = newSize × scale + 'px'
      → container.style.lineHeight = newSize × scale × 1.3 + 'px'
  → Browser batches DOM update + CSS changes into single repaint
  → CSS overflow-wrap: break-word handles actual line breaking
  → CSS overflow: hidden clips any sub-frame overflow
  → CSS translateY clamp handles vertical centering
```

### Pan/Zoom

```
User pans or zooms
  → CanvasRuntime calls tool.onViewChange()
  → TextTool.positionEditor()
    → Reads handle from snapshot (content unchanged)
    → Recalculates screen position from world origin
    → Updates fontSize CSS: autoFontSize × newScale
    → Updates lineHeight CSS: autoFontSize × newScale × 1.3
    → Updates maxHeight: contentWidth × newScale
    → No auto-size recomputation (content unchanged, autoFontSize is deterministic)
```

---

## 12. Walkthrough: Typing a Long Unbroken String

Content area: 256 × 256 world units. Grandstander lineHeightMultiplier = 1.3. Hypothetical: "d" at 100px measures ~58px advance width.

### Char 1: "d"

- `maxWordW100 = 58`. `widthMax = 256 × 100 / 58 ≈ 441`. `heightMax = 256 / 1.3 ≈ 197`. Start at step 0 (72).
- Phase 1, step 72: `maxW100 = 256 / 0.72 = 355.6`. Word 58 < 355.6 → fits width. `maxLines = floor(256 / (130 × 0.72)) = floor(2.73) = 2`. 1 line ≤ 2. **Fits → return 72.**
- Display: single huge character centered.

### Chars 1–6: "dddddd"

- Word at 100px: 6 × 58 = 348. Step 72: `maxW100 = 355.6`. 348 < 355.6. 1 line ≤ 2. **→ 72.**
- Still one line of large text.

### Char 7: "ddddddd"

- Word at 100px: 7 × 58 = 406. Step 72: `maxW100 = 355.6`. 406 > 355.6. **Word too wide.**
- Educated jump: `needed = 256 × 100 / 406 ≈ 63`. First step ≤ 63 → step 56 (index 2).
- Step 56: `maxW100 = 256 / 0.56 = 457`. 406 < 457. `maxLines = floor(256 / 72.8) = 3`. 1 ≤ 3. **Fits → return 56.**
- Font drops from 72 to 56. One line of text, just barely fitting.

### Chars 7–16: Steady Phase 1 Shrinking

Each additional "d" adds ~58 to the 100px word width. The word exceeds the current step's `maxW100`, triggering educated jumps to smaller steps: 56 → 48 → 44 → 40 → 36 → ... The font shrinks steadily while text stays on one line.

### Around Char 25: Phase 1 Floor Reached

- Word at 100px: ~1450. Step 18: `maxW100 = 256 / 0.18 = 1422`. 1450 > 1422. **Word too wide at floor.**
- Phase 1 can't go below 18 → `phase2 = true`.

### Phase 2 Activation

- Phase 2, step 72: `maxW100 = 355.6`. Word 1450 > 355.6 → char-break. ~`ceil(1450/355) ≈ 5` lines. `maxLines = 2`. 5 > 2. Overflow.
- Step 64: ~`ceil(1450/400) ≈ 4` lines. `maxLines = floor(256/83.2) = 3`. 4 > 3. Overflow.
- Step 56: ~`ceil(1450/457) ≈ 4` lines. `maxLines = 3`. 4 > 3. Overflow.
- Step 48: ~`ceil(1450/533) ≈ 3` lines. `maxLines = floor(256/62.4) = 4`. 3 ≤ 4. **Fits → return 48.**

**Font jumps from 18 to 48.** The text wraps to 3 lines at 48px. The user sees the word break across lines and the font grow. This is the Phase 1→2 transition.

### After Transition: Phase 2 Normal Behavior

Adding more d's increases the char-broken line count. When 3 lines at 48px overflow (line count exceeds `maxLines`), steps down to 44, then 40, etc. Steady Phase 2 shrinking.

---

## 13. Walkthrough: Paragraph Behavior

### Starting State: 14 d's at 30px

"dddddddddddddd" — word at 100px ≈ 812. Step 30: `maxW100 = 853`. 812 < 853. 1 line. `maxLines = 6`. **Fits at 30.**

### User Presses Enter

Two paragraphs: ["dddddddddddddd", ""]. `paraCount = 2`. `maxWordW100 = 812` (unchanged).
- Step 30: 812 < 853. 2 lines (one per paragraph). 2 ≤ 6. **Still fits at 30.**
- An empty paragraph adds 1 line but doesn't change the width constraint. Font stays the same.

### User Types "hello" in Second Paragraph

Two paragraphs with words: "dddddddddddddd" and "hello". `maxWordW100 = 812` (the d's are still widest).
- Step 30: "hello" at 100px ≈ 260. 260 < 853 → fits on line 2. 2 lines total. `maxLines = 6`. **Still 30.**

### User Deletes a "d" (13 d's)

"ddddddddddddd" + "hello". `maxWordW100 ≈ 754`.
- Step 32: `maxW100 = 800`. 754 < 800. 2 lines. `maxLines = 6`. **Fits at 32. Font grows.**

Removing a character from the constraining word freed up width, allowing a larger font. The font immediately grows by one step.

### User Removes a Character from "hello"

"ddddddddddddd" + "hell". `maxWordW100 = 754` (unchanged — "ddddddddddddd" is still the widest word).
- Same result: **32.** Modifying non-constraining content has no effect.

---

## 14. Edge Cases

### Empty Note

`parseAndTokenize` returns `[{ tokens: [] }]` → 1 empty paragraph. `maxWordW100 = 0`. Phase 1 step 72: no words to fail, 1 line ≤ `maxLines` (2). **→ 72.** The note starts with a huge invisible placeholder.

### Single Character

1 word token, 1 paragraph. Small width at 100px. Fits at 72. **→ 72.** Huge character centered.

### All Whitespace

Spaces are `'space'` tokens. No word tokens. `maxWordW100 = 0`. A paragraph of only spaces has no ink — paragraph pushes 1 line. **→ 72.**

### Mixed Bold/Italic in a Word

"he**llo**" has 2 segments: "he" (normal) + "llo" (bold). The token's `advanceWidth` = sum of both segment widths. For Phase 2 char-breaking, `sliceTextToFit` is called per-segment — the existing segment walk handles cross-segment words correctly.

### Word Exactly Equal to maxW100

`wordW === maxW100` → not oversized (the `> maxW` check fails). The word fills exactly one line. Correct.

### Content at 8px Floor

If content can't fit even at 8px with character breaking, `computeNoteAutoSize` returns 8 (the smallest step). CSS `overflow: hidden` clips the excess. The note is at maximum density — user should trim content.

---

## 15. Relationship to layoutMeasuredContent

`flowCheck` is a stripped-down derivative of `layoutMeasuredContent`. Here's an exhaustive comparison:

| Aspect | `layoutMeasuredContent` | `flowCheck` |
|--------|------------------------|-------------|
| **Purpose** | Build full `TextLayout` for rendering | Count lines to check if content fits |
| **Output** | `MeasuredLine[]` with runs, widths, baselines | `'fits'` or `'heightOverflow'` or `{ wordTooWide }` |
| **Allocation** | `MeasuredRun[]`, `MeasuredLine[]` per line | Zero heap allocation (only stack variables) |
| **Completion** | Always runs to completion | Bails when `lineCount > maxLines` |
| **Break-word** | Always char-breaks oversized words | Phase 1: rejects. Phase 2: char-breaks. |
| **Whitespace model** | `pendingSegs[]` + `pendingW` (buffers actual segments) | `pendingW` only (tracks total width) |
| **Line tracking** | `LineBuilder` with `runs[]`, `advanceX`, `visualWidth`, `hasInk` | `curW`, `hasInk`, `pendingW` (3 numbers + 1 bool) |
| **Alignment** | Computes `alignmentWidth`, `baselineY` per line | Irrelevant (not rendering) |
| **fixupParagraphEnd** | Adjusts last line's `alignmentWidth` for CSS two-behavior model | Not needed (alignment is irrelevant) |

The token placement logic — pending whitespace buffering, word fit check (curW + pendingW + wordW ≤ maxW), oversized detection (wordW > maxW), leading whitespace handling, paragraph boundaries — is identical between the two. `flowCheck` is `layoutMeasuredContent` with all the rendering bookkeeping stripped and early termination added.

### One Subtle Difference

In `layoutMeasuredContent`, when an oversized word arrives and the current line has content, the code checks if there's room for pending whitespace before deciding whether to push the line. In `flowCheck`, the oversized path always pushes the current line (`if hasInk || curW > 0: lineCount++`). This is slightly more conservative — it may overcount by 1 line in rare edge cases (oversized word + existing content sharing a line). For auto-sizing, this means the font might be one step smaller than strictly necessary in that scenario. The difference is negligible and the simplification is worthwhile.

---

## 16. Files Changed

### `client/src/lib/text/text-system.ts`

**Added (§5b, between §5 and §6):**
- `NOTE_FONT_STEPS` constant (exported) — 25 font sizes from 72 to 8
- `NOTE_PHASE1_FLOOR` constant (internal) — 18
- `FlowResult` type — `'fits' | 'heightOverflow' | { wordTooWide: number }`
- `flowCheck()` function (internal) — lightweight line-counting layout simulation
- `computeNoteAutoSize()` function (exported) — two-phase font size search

**Added (sticky note constants section):**
- No changes to existing code. New constants and functions are additive.

### `client/src/lib/tools/TextTool.ts`

**Added:**
- Import: `computeNoteAutoSize` from text-system
- Fields: `isAutoSizeNote: boolean`, `autoFontSize: number`
- Method: `updateAutoSize()` — reads fragment, recomputes, updates CSS

**Modified:**
- `mountEditor` note branch: computes initial auto font size, overrides container CSS, adds `maxHeight`
- `onTransaction` callback: added `transaction` parameter, checks `docChanged` → calls `updateAutoSize()`
- `positionEditor` note branch: uses `this.autoFontSize` instead of stored `fontSize` for CSS, adds `maxHeight` update
- `commitAndClose`: resets `isAutoSizeNote` and `autoFontSize`

### `client/src/index.css`

**Modified:**
- `.tiptap[data-width-mode='note']`: `overflow: visible` → `overflow: hidden`

---

## 17. Future Direction

This implementation validates the algorithm in the DOM overlay. The next stages involve:

- **Cache integration:** Building a dedicated note layout cache path. The auto-size computation needs to feed into the canvas rendering pipeline so the canvas renders at the correct font size (currently it uses the Y.Map stored value, which is wrong).

- **Y.Map fontSize as derived:** Since auto-size makes fontSize a function of content, the stored value becomes redundant for notes. The system may evolve to derive fontSize deterministically from content + note geometry, eliminating the stored field.

- **Uniform scale model:** Since notes only uniform-scale (no E/W reflow), the geometry can be simplified. Possibly storing a scale factor instead of width, and deriving all dimensions from `NOTE_WIDTH × scale`.

- **Function consolidation:** `flowCheck` and `computeNoteAutoSize` may merge into a single function with inline tracking, eliminating the function call overhead and enabling the educated jump logic to share state more efficiently.

- **Step refinement:** The current steps will be tuned — finer granularity in the 30–40px range, adjusted padding, possibly narrower content width. The algorithm is step-list-agnostic; changing the list changes the behavior without touching the search logic.

- **Performance:** The current implementation tokenizes and measures from scratch on every call. A future version could cache the `MeasuredContent` (at 100px) and only re-tokenize on content changes, re-using the measured data across font size searches. This would reduce per-keystroke cost further.
