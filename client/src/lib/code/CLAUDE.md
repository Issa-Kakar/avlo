# Code Block System

Canvas-rendered code blocks with CodeMirror DOM overlay editing, two-tier syntax highlighting, and Yjs collaborative binding. **Work in progress** — not yet fully integrated with the codebase (no selection transforms, no language dropdown, no mixed selection filter).

---

## Files

| File | Role |
|------|------|
| `code-shared.ts` | Types (`TextRun`, `SparseHighlight`) + color constants (One Dark palette) + `TAG_STYLES` map + gap-fill (`highlightsToRuns`) + run slicing (`sliceRuns`) — imported by both main thread and worker |
| `code-system.ts` | Singleton `CodeSystemCache`, sync regex tokenizer, canvas renderer (`renderCodeLayout`), worker pool (2 warm workers), delta→ChangedRange conversion, CM theme extensions, font metrics measurement, layout computation with word-aware wrapping |
| `lezer-worker.ts` | Web Worker — per-object Lezer `Tree` + `TreeFragment` state, incremental parsing, `highlightTree` → `SparseHighlight[][]` via expanded `tagHighlighter`, gap-fill to `TextRun[][]` |
| `CodeTool.ts` (in `lib/tools/`) | PointerTool — click-to-place + hit-test existing blocks + CodeMirror DOM overlay lifecycle (screen-space rendering via CSS custom properties) |

---

## Y.Doc Schema

```typescript
{
  id: string,                    // ULID
  kind: 'code',
  origin: [number, number],      // Top-left corner [x, y] in world coords
  content: Y.Text,               // Plain text (NOT Y.XmlFragment)
  language: 'javascript' | 'typescript' | 'python',
  fontSize: number,              // World units, default 14
  width: number,                 // World units, stored (never 'auto')
  ownerId: string,
  createdAt: number,
}
```

**Differences from text objects:**
- `Y.Text` not `Y.XmlFragment` — code is plain text; delta events map to Lezer `ChangedRange`
- `origin` = top-left (not baseline). Code blocks are rectangular, no alignment modes
- `width` always stored number — no 'auto' mode
- Height derived: `padTop(fs) + visualLines.length * lineHeight(fs) + padBottom(fs)`
- No `color`/`fillColor` — dark theme is fixed chrome
- Empty blocks are NOT deleted on close (unlike text) — visible dark bg + line numbers

**Typed accessor:** `getCodeProps(y)` → `CodeProps | null` (in `@avlo/shared`). Returns `{ content: Y.Text, origin, fontSize, width, language }`.

---

## Architecture

### TextRun Gap-Fill Model

The core data model for rendering. Both the sync tokenizer and Lezer worker produce `SparseHighlight[][]` (sparse tokens with `{ from, to, color, bold }`). The `highlightsToRuns()` function converts these into a complete `TextRun[]` partition per line, filling gaps between highlights with `CODE_DEFAULT`. Invariant: `runs.map(r => r.text).join('') === lineText`. The renderer iterates runs sequentially, advancing an x cursor by `run.text.length * charWidth` — every character appears in exactly one run.

### Coordinate System & Positioning

Code blocks use **origin-based top-left positioning**. The `origin` field stores `[x, y]` in world coordinates representing the top-left corner of the block (including background/padding).

**Frame derivation:** No stored frame in Y.Doc. Frame is computed from layout and cached:
```
frame = [origin[0], origin[1], layout.totalWidth, totalHeight(layout, fontSize)]
```
Read via `getCodeFrame(id)`. `computeCodeBBox(id, yObj)` computes layout, derives frame, caches it, and returns bbox.

### Block Sizing — fontSize-Proportional

All padding is a ratio of `fontSize`:
```
padTop(fs)    = fs * 1.5          padBottom(fs) = fs * 1.5
padLeft(fs)   = fs * 0.85         padRight(fs)  = fs * 0.85
gutterPad(fs) = fs * 0.7

totalWidth  = stored width field (set at creation from getDefaultWidth)
totalHeight = padTop(fs) + visualLines.length * lineHeight(fs) + padBottom(fs)

charWidth(fs)  = fs * measuredCharWidthRatio  (measured via canvas, fallback 0.6)
lineHeight(fs) = fs * 1.5
```

Gutter width = `maxDigits * charWidth(fs)`, where `maxDigits = max(2, String(sourceLineCount).length)`.
Content left offset = `padLeft(fs) + gutterWidth + gutterPad(fs)`.

`BORDER_RADIUS` is currently a fixed constant (12). Will become fontSize-proportional.

### Measured Font Metrics

Singleton lazy measurement via canvas `measureText()` at 100px:
- `charWidthRatio` — `measureText('M').width / 100`
- `baselineRatio` — `(halfLeading + fontBoundingBoxAscent) / lineHeight` using CSS half-leading formula

Both canvas renderer and CM theme use the same measured ratios.

### Content Layout

```typescript
interface VisualLine {
  srcIdx: number;   // source line index
  from: number;     // char offset in source line (0 = first segment → show gutter)
  text: string;     // visual line text
}
interface CodeLayout {
  lines: VisualLine[];
  sourceLineCount: number;
  totalWidth: number;
}
```

Layout stores only geometry-independent data. All dimensional values (height, gutter width, content offset) are derived from `fontSize` via getter functions.

### Line Wrapping — WYSIWYG Match

The canvas wrapping algorithm matches CodeMirror's `lineWrapping` extension behavior. CM uses `overflow-wrap: anywhere` + `word-break: break-word` + the CSS forces `white-space: break-spaces` via the scroller. The canvas `computeLayout()` mirrors this:

1. Compute `maxChars = floor((width - contentLeft - padRight) / charWidth)`
2. For lines exceeding `maxChars`, scan backward from the break point for a space/tab boundary
3. If a word boundary is found, break there (whole-word wrap)
4. If no boundary found within the window, break at `maxChars` (character-level fallback)

Continuation lines have `from > 0` (no gutter number). `sliceRuns()` slices `TextRun[]` to the visual line's character range.

---

## Two-Tier Tokenization

### Flow
```
Y.Text change (typing or remote sync)
  → deep observer fires synchronously
  → codeSystem.handleContentChange(id, ev, lang)
    → syncTokenize(text, lang) → SparseHighlight[][] (fast regex)
    → highlightsToRuns() per line → TextRun[][] (gap-filled)
    → cache.runs updated, layout/frame nulled, version incremented
    → deltaToChangedRanges(ev.delta) → ChangedRange[]
    → dispatch to worker pool: { type:'parse', id, text, language, version, changes }

Same rAF frame:
  → renderer calls getLayout() → gets sync-tokenized runs → draws all chars

Worker responds (typically next frame):
  → applyWorkerRuns(id, runs, forVersion)
  → version-gated: discarded if stale
  → swaps runs (only colors change), invalidateWorld() for redraw
  → renderer draws Lezer-accurate colors
```

Runs are **always populated** after entry creation. Cold miss in `getLayout()` creates a full entry with sync-tokenized runs and dispatches a worker parse. No blank-until-first-edit.

### Sync Tokenizer (`syncTokenize`)

Regex-based highlight emitter — returns `SparseHighlight[][]`. Provides instant coloring on the same frame as a content change.

Handles: keywords (JS/TS/Python sets, sorted longest-first), strings (including template literals with `${}` nesting, Python f/r/b-prefix strings, triple quotes), numbers (hex/binary/octal/scientific/separators/BigInt), comments (line `//`, block `/* */`, Python `#`, hashbang `#!`), operators (including `=>`, `?.`, `??`, `...`), decorators (`@name`), identifiers (keywords bolded, function calls colored by `FUNCTION`, PascalCase by `TYPE`, others by `VARIABLE`).

Does NOT emit tokens for punctuation, brackets, or whitespace — these become `CODE_DEFAULT`-colored gaps via gap-fill.

Multi-line state tracked via `inBlockComment` and `inTemplateString` flags across lines.

### Lezer Worker Pool

2 warm workers. Round-robin dispatch. Lazy initialization (first `dispatch()` call creates them).

**Per-object state:** Each worker maintains a `Map<string, { tree: Tree, fragments: TreeFragment[] }>`. When `changes` are provided, `TreeFragment.applyChanges()` enables incremental parsing. Without changes (cold parse or language change), a full parse is performed.

**Run extraction:** `highlightTree()` walks the Lezer `Tree` with an expanded `tagHighlighter` that maps Lezer tags to class names. `TAG_STYLES` maps class names to `{ color, bold }`. The highlighter covers: keyword, string, number, comment, function, variable, type, operator, plus expanded tags (separator, bracket, angleBracket, squareBracket, paren, brace, derefOperator, meta, self, atom). Line offsets are binary-searched for fast token-to-line mapping.

**Protocol:**
```
Main → Worker: { type:'parse', id, text, language, version, changes? }
Main → Worker: { type:'remove', id }
Main → Worker: { type:'clearAll' }
Worker → Main: { type:'runs', id, version, runs: TextRun[][] }
```

**Language → Parser mapping:**
- `'python'` → `@lezer/python`
- `'typescript'` → `@lezer/javascript` configured with `dialect: 'ts jsx'`
- `'javascript'` (default) → `@lezer/javascript` configured with `dialect: 'jsx'`

---

## Cache (`CodeSystemCache`)

Singleton `codeSystem`. Per-object `CacheEntry`:

```typescript
interface CacheEntry {
  text: string;
  sourceLines: string[];
  version: number;           // Monotonic, incremented on content or language change
  runs: TextRun[][];         // Always populated — gap-filled per source line
  layout: CodeLayout | null; // null = needs recompute
  layoutFontSize: number;    // Cache key
  layoutWidth: number;       // Cache key
  language: CodeLanguage;    // Cache key — language change triggers retokenize + reparse
  frame: FrameTuple | null;  // Derived, set by computeCodeBBox
}
```

### Invalidation Rules

| Trigger | What changes | Layout | Frame | Version |
|---------|-------------|--------|-------|---------|
| `handleContentChange` | New text, new sync-tokenized runs | nulled | nulled | incremented |
| `applyWorkerRuns` | Runs swapped (colors only) | unchanged | unchanged | checked (must match) |
| fontSize/width change (detected in `getLayout`) | — | recomputed | nulled | unchanged |
| Language change (detected in `getLayout`) | Re-tokenized runs | recomputed | nulled | incremented |

`applyWorkerRuns` does NOT null the layout — only colors change, not geometry. It calls `invalidateWorld(frameBounds)` if a cached frame exists.

### Public API

| Method | Called by | Purpose |
|--------|-----------|---------|
| `getLayout(id, yText, fontSize, width, lang)` | `computeCodeBBox`, `drawCode` | Build or return cached layout; handles cold miss, language change, relayout |
| `handleContentChange(id, ev, lang)` | Deep observer | Sync tokenize + dispatch worker parse with delta changes |
| `applyWorkerRuns(id, runs, forVersion)` | Worker response handler | Version-gated run upgrade |
| `getRuns(id)` | `drawCode` in objects.ts | Get TextRun[][] for renderer |
| `getFrame(id)` / `setFrame(id, frame)` | Hit testing, selection, bbox | Read/write cached frame |
| `remove(id)` / `clear()` | Deletion / room change | Cleanup entries + notify workers |

---

## Canvas Renderer (`renderCodeLayout`)

Signature: `renderCodeLayout(ctx, layout, originX, originY, fontSize, runs)`

All metrics derived from `fontSize` inline. Steps:

1. **Background:** `roundRect` fill with `CODE_BG`, `BORDER_RADIUS`
2. **Per visual line:** Compute `baseY = originY + padTop + i * lineHeight + baselineOffset`
3. **Gutter:** On lines where `vline.from === 0`, right-align line number within gutter area: `originX + padLeft + (digits - lineNum.length) * charWidth`
4. **Code text:** `sliceRuns(runs[srcIdx], from, from + text.length)` → iterate, `fillText` per run; x cursor advances by `run.text.length * charWidth`
5. **Batching:** Font and fillStyle only set on change (`prevFont` tracking). Whitespace-only runs skip `fillText`.

---

## Screen-Space DOM Editor — CSS Custom Properties

CodeMirror needs to render crisply at all zoom levels. CSS `transform: scale()` would cause blurriness. Leaving dimensions unscaled would produce incorrect world-to-screen-space alignment. The solution: all dimensions computed as `world * scale` in exact px values.

### Dimensional Properties (set at mount + every zoom/pan change)

```
screenFS = fontSize * scale      → container.style.fontSize
screenW  = width * scale         → container.style.width
screenLH = lineHeight(fs) * scale → container.style.lineHeight
borderRadius = BORDER_RADIUS * scale → container.style.borderRadius
```

Position via `worldToClient(origin)` → `left/top` in CSS px.

### CSS Custom Properties (`--c-*`)

The CM theme references CSS custom properties instead of `em` units. `setCSSVars()` writes them as exact px on the container at mount and on every `positionEditor()` call:

| CSS var | Value | Used by |
|---------|-------|---------|
| `--c-pt` | `padTop(fs) * scale` px | `.cm-scroller` paddingTop |
| `--c-pb` | `padBottom(fs) * scale` px | `.cm-scroller` paddingBottom |
| `--c-gl` | `padLeft(fs) * scale` px | `.cm-gutters` paddingLeft |
| `--c-gr` | `gutterPad(fs) * scale` px | `.cm-gutters` paddingRight |
| `--c-pr` | `padRight(fs) * scale` px | `.cm-line` padding-right |
| `--c-gw` | `2 * charWidth(fs) * scale` px | `.cm-gutterElement` minWidth |

This avoids browser `em→px` conversion which introduces sub-pixel rounding mismatches versus the canvas renderer.

### Padding Placement: Scroller, Not Content

Vertical padding (`--c-pt`, `--c-pb`) is on `.cm-scroller`, not `.cm-content`. CM's `viewState.measure()` reads `contentDOM` padding with `parseInt()`, which truncates fractional px values, causing gutter-content vertical misalignment. Placing padding on the scroller avoids this.

### `positionEditor()`

Called on every zoom/pan change (`onViewChange()`). Updates ALL dimensional properties (position, width, fontSize, lineHeight, borderRadius, CSS vars) + calls `editorView.requestMeasure()` to trigger CM relayout.

### CSS (index.css)

```css
.code-editor {
  pointer-events: auto;
  z-index: 1000;
  overflow: hidden;
}
.code-editor .cm-editor {
  height: auto;
  border-radius: inherit;
  outline: none;
}
.code-editor .cm-scroller {
  font-family: 'JetBrains Mono', monospace;
  overflow-y: auto;
  overflow-x: hidden;
  line-height: inherit !important;  /* Override CM base theme's 1.4 */
}
```

The `line-height: inherit !important` forces the scroller to use the container's explicit px line-height instead of CM's base theme value of `1.4`, which fights the code system's `1.5` multiplier at identical specificity.

---

## CodeMirror Extensions

Lazy-loaded via `getCodeMirrorExtensions()` (cached after first call). Two extensions:

1. **Theme** (`EditorView.theme`, dark mode): Background, gutter, cursor, selection colors. All padding/sizing via `var(--c-*)`. Line-height set as the `LINE_HEIGHT_MULT` ratio on `.cm-scroller`. Gutter elements use `fontFeatureSettings: '"tnum"'` for tabular numbers.

2. **Syntax highlighting** (`HighlightStyle.define`): Maps Lezer `tags` to the same color constants used by the sync tokenizer and canvas renderer (`KEYWORD`, `STRING`, `NUMBER`, etc.). Keywords are bold.

### Editor State Extensions (set at mount)

- `lineNumbers()` with `formatNumber` callback — pads line numbers with spaces to match canvas gutter digit reservation (`max(2, String(lines).length)`)
- `EditorView.lineWrapping` — enables CM's native word-wrapping
- Language extension: `python()` or `javascript({ typescript: true, jsx: true })`
- `indentUnit.of('    ')` — 4-space indentation
- `keymap.of([indentWithTab])` — Tab key indents
- `yCollab(yText, null, { undoManager })` — Yjs collaborative binding with per-session UndoManager
- Tab normalizer transaction filter — replaces `\t` with 4 spaces in all insertions

---

## CodeTool — PointerTool Implementation

Registered in `tool-registry.ts` as singleton `codeTool`, mapped to `'code'` tool ID.

### Gesture Flow

1. `begin()`: Hit-test existing code blocks via spatial index query (8px screen-space radius, Z-order by ULID descending)
2. `end()`: If hit → `mountEditor(hitId)`. If no hit → `createCodeObject(x, y)` at center-placed position, then `mountEditor(createdId)`.

### Object Creation

Center-placed: `originX = clickX - width/2`, `originY = clickY - blockHeight/2`. Default language: `typescript`. Width from `getDefaultWidth(fontSize)`. fontSize from `useDeviceUIStore.textSize`.

### Editor Lifecycle

**Mount:** Close existing editor if open → create container div → set screen-space dimensions + CSS vars → append to `editorHost` → lazy-load CM modules (parallel `Promise.all`) → create `Y.UndoManager(yText)` → build `EditorState` with extensions → create `EditorView` → focus → `beginCodeEditing(objectId)` on selection store → invalidate world.

**Close (`commitAndClose`):** Remove event handlers → destroy EditorView → clear UndoManager → remove container from DOM → null all refs → `endCodeEditing()` on selection store → invalidate world + overlay.

### Event Handlers

- **Escape key** (capture phase): Close editor
- **Click outside** (capture phase, 100ms delayed attach): Close editor. Clicks on `.ctx-menu` are excluded. Canvas clicks are consumed (`stopPropagation`) when code tool is active.

---

## Integration Points

### room-doc-manager.ts — Deep Observer

Content change path (Y.Text on code object):
```typescript
if (kind === 'code' && ev instanceof Y.YTextEvent) {
  const lang = getCodeProps(yObj!)?.language ?? 'javascript';
  codeSystem.handleContentChange(id, ev, lang);
}
```

BBox computation: `computeCodeBBox(id, yObj)` called in both hydration and incremental update paths.

Deletion: `codeSystem.remove(id)` called when a code object is deleted. Deletion bridge: if `codeEditingId` matches a deleted object, calls `endCodeEditing()`.

Room change / full rebuild: `codeSystem.clear()`.

### objects.ts — Render Dispatch

```typescript
function drawCode(ctx, handle) {
  if (useSelectionStore.getState().codeEditingId === handle.id) return; // DOM overlay active
  const props = getCodeProps(handle.y);
  const layout = codeSystem.getLayout(id, props.content, props.fontSize, props.width, props.language);
  const runs = codeSystem.getRuns(id);
  renderCodeLayout(ctx, layout, props.origin[0], props.origin[1], props.fontSize, runs);
}
```

During scale transforms, code blocks currently fall through to `drawObject()` (no scale transform rendering yet).

### selection-store.ts

```typescript
codeEditingId: string | null;
beginCodeEditing: (objectId) => set({ codeEditingId: objectId, menuOpen: true });
endCodeEditing: () => set({ codeEditingId: null, menuOpen: selectedIds.length > 0 });
```

### hit-testing.ts

Code blocks are included in `ObjectKind` (`'code'`) and participate in spatial index queries. CodeTool does its own hit testing (frame-based point-in-rect against `getCodeFrame()`).

---

## Known Issues / Not Yet Implemented

- **Selection transforms:** Code blocks have no scale/translate preview during SelectTool transforms (renders static)
- **Language dropdown:** No UI to change language
- **Mixed selection filter:** Code blocks not filtered in context menu
- **UndoManager:** Per-session UM handles CM undo. Needs proper origin-based filtering like TextTool's pattern
- **Flash on mount:** Async CM load means brief canvas frame visible before DOM overlay appears
- **Long code blocks:** CM's internal viewport optimization causes WYSIWYG mismatch on very tall blocks (content outside CM's visible window is virtualized)
- **Language change + worker tree:** On language change, a full re-parse is dispatched (no `changes`). The worker's previous `Tree`/`TreeFragment` state for that object is overwritten by the fresh parse. This is correct — Lezer trees are parser-specific, so fragments from one language's parser cannot be reused by another.
