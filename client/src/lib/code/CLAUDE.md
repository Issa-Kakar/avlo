# Code Block System

> **Maintenance:** Architectural overview, not a changelog. Match surrounding detail level when updating — don't inflate coverage of one change at the expense of the big picture.

Canvas-rendered code blocks with CodeMirror DOM overlay editing, two-tier syntax highlighting, and Yjs collaborative binding. Fully integrated with SelectTool (translate, scale, reflow, double-click-to-edit).

---

## Files

| File | Role |
|------|------|
| `code-tokens.ts` | Style enum (`S`), `PALETTE`, `RunSpans` type, `packRunSpans` gap-fill, `TAG_STYLES`/`TAG_STYLE_INDEX` maps, CoolGlow color constants, keyword sets + classification, sync regex tokenizer (`syncTokenize`) — imported by main thread, worker, and theme |
| `code-system.ts` | Singleton `CodeSystemCache`, zero-allocation canvas renderer (`renderCodeLayout`), worker pool (2 warm workers, hash-routed), delta→ChangedRange conversion, font metrics (derived from text-system), layout computation with word-aware wrapping |
| `code-theme.ts` | CodeMirror theme extensions — lazy-loaded CoolGlow dark theme + syntax highlighting (`getCodeMirrorExtensions`). No dependency on code-system |
| `lezer-worker.ts` | Web Worker — per-object Lezer `Tree` + `TreeFragment` state, cached configured parsers, incremental parsing, `highlightTree` → `RunSpans[]` via `TAG_STYLE_INDEX` + `packRunSpans`, zero-copy transfer |
| `CodeTool.ts` (in `lib/tools/`) | PointerTool — click-to-place + hit-test existing blocks + CodeMirror DOM overlay lifecycle (screen-space rendering via CSS custom properties). `justClosedCodeId` prevents close→remount cycle; `startEditing(id)` public API for SelectTool double-click entry |

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
  lineNumbers: boolean,          // Gutter visibility (default true, collaborative)
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

**Typed accessor:** `getCodeProps(y)` → `CodeProps | null` (in `@avlo/shared`). Returns `{ content: Y.Text, origin, fontSize, width, language, lineNumbers }`. Also: `getLineNumbers(y, fallback = true): boolean`.

---

## Architecture

### RunSpans — Flat Packed Style Model

The core data model for rendering. A `RunSpans` is a `Uint16Array` of `[offset, length, styleIndex]` triples covering an entire source line with no gaps. Both the sync tokenizer and Lezer worker produce `RunSpans[]` (one per source line).

**Style enum (`S`):** 13 values (DEFAULT=0 through INVALID=12), `const enum` for zero-cost inlining. Colors looked up via `PALETTE[style]`, bold via `isBold(style)` (true for indices 1-3: KEYWORD, DEF_KW, MODIFIER).

**`packRunSpans(lineLen, buf, count)`:** Converts sparse `(from, to, style)` triples in a reusable buffer into a gap-filled `Uint16Array`. Both tokenizers push triples into a shared buffer, then call `packRunSpans` once per line. No intermediate object allocation.

**Memory:** ~20x reduction vs old TextRun objects. 100-line file with ~8 runs/line: ~4.8KB (Uint16Arrays) vs ~96KB (TextRun objects + string slices).

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
padLeft(fs)   = fs * 1.0          padRight(fs)  = fs * 0.85
gutterPad(fs) = fs * 2.2

totalWidth  = stored width field (set at creation from getDefaultWidth)
totalHeight = padTop(fs) + visualLines.length * lineHeight(fs) + padBottom(fs)

charWidth(fs)  = fs * getMinCharWidthRatio('JetBrains Mono')  (from text-system cache)
lineHeight(fs) = fs * 1.5
```

Gutter width = `maxDigits * charWidth(fs)`, where `maxDigits = max(2, String(sourceLineCount).length)`.
Content left offset = `contentLeft(digits, fs, lineNumbers)`:
- `lineNumbers=true`: `padLeft(fs) + gutterWidth + gutterPad(fs)`
- `lineNumbers=false`: `padLeft(fs)` — gutter space becomes content space, block width unchanged

`borderRadius(fs)` = `fs * 0.85` — fontSize-proportional.

### Font Metrics — Derived from text-system

No separate measurement canvas. Metrics derived from `text-system.ts`'s per-font measurement cache (`getMeasuredAscentRatio`, `getMeasuredDescentRatio`, `getMinCharWidthRatio`). JetBrains Mono is true monospace — advance width identical across all weights, so `getMinCharWidthRatio` (bold 'W') equals any-weight any-glyph advance.

- `charWidth(fs)` = `fs * getMinCharWidthRatio('JetBrains Mono')`
- `baselineOffset(fs)` = `fs * (LINE_HEIGHT_MULT + ascentR - descentR) / 2` — CSS half-leading formula with code's 1.5 line height (text system uses 1.3 for rich text JetBrains Mono)

Both canvas renderer and CM theme use the same derived metrics.

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
  lineNumbers: boolean;    // Gutter visibility — controls contentLeft + renderer gutter skip
}
```

Layout stores only geometry-independent data plus `lineNumbers` (which affects `contentLeft` and gutter rendering). All dimensional values (height, gutter width, content offset) are derived from `fontSize` via getter functions.

### Line Wrapping — WYSIWYG Match

The canvas wrapping algorithm matches CodeMirror's `lineWrapping` extension behavior. CM uses `overflow-wrap: anywhere` + `word-break: break-word` + the CSS forces `white-space: break-spaces` via the scroller. The canvas `computeLayout()` mirrors this:

1. Compute `maxChars = floor((width - contentLeft - padRight) / charWidth)`
2. For lines exceeding `maxChars`, scan backward from the break point for a space/tab boundary
3. If a word boundary is found, break there (whole-word wrap)
4. If no boundary found within the window, break at `maxChars` (character-level fallback)

Continuation lines have `from > 0` (no gutter number). The renderer clips `RunSpans` inline using `[vFrom, vTo)` range — no intermediate allocation.

---

## Theme — CoolGlow Palette

Single fixed dark theme (no user-selectable themes). All constants in `code-tokens.ts`, consumed by sync tokenizer, Lezer worker, CM theme, and canvas renderer.

### Chrome
| Constant | Hex | Purpose |
|----------|-----|---------|
| `CODE_BG` | `#060521` | Background fill |
| `CODE_DEFAULT` | `#E0E0E0` | Gap-fill text (punctuation, brackets, whitespace) |
| `CODE_GUTTER` | `#E0E0E090` | Line numbers |
| `CODE_SELECTION` | `#122BBB` | CM selection background |
| `CODE_LINE_HL` | `#FFFFFF0F` | CM active line highlight |
| `CODE_CARET` | `#FFFFFFA6` | CM cursor |

### Token Colors — Two-Tier Keywords
| S Enum | Hex | Semantic | Examples |
|--------|-----|----------|----------|
| `S.KEYWORD` | `#2BF1DC` | Control flow | `if`, `else`, `return`, `for`, `while`, `switch` |
| `S.DEF_KW` | `#F8FBB1` | Definitions | `const`, `let`, `var`, `function`, `class`, `type`, `interface` |
| `S.MODIFIER` | `#2BF1DC` | Modifiers + module (same cyan) | `export`, `import`, `async`, `static`, `private`, `readonly` |
| `S.OPERATOR` | `#2BF1DC` | Operators (same cyan) | `=`, `+`, `===`, `=>`, `&&` |
| `S.STRING` | `#8DFF8E` | Strings, regex, escape | `"hello"`, `` `template` ``, `/regex/` |
| `S.NUMBER` | `#62E9BD` | Numbers, bool, null, atom | `42`, `true`, `null` |
| `S.COMMENT` | `#AEAEAE` | Comments | `//`, `/* */`, `#` |
| `S.FUNCTION` | `#A3EBFF` | Function names, class names | `foo()`, `class Bar` |
| `S.VARIABLE` | `#B683CA` | Variables, identifiers | `x`, `self`, `myVar` |
| `S.TYPE` | `#60A4F1` | Types, properties, tags | `string`, `HTMLElement`, `<div>` |
| `S.ATTRIBUTE` | `#7BACCA` | JSX/HTML attributes | `className`, `onClick` |

**Two-tier keyword split:** Cyan (`#2BF1DC`) for all keywords, modifiers, and operators. Yellow (`#F8FBB1`) exclusively for definition keywords — "this line declares something." `MODIFIER` and `OPERATOR` are separate enum values sharing the cyan palette entry for future flexibility.

**Theme-ready:** Future theme toggle = swap `PALETTE` contents + invalidate. No re-tokenization needed.

### TAG_STYLES / TAG_STYLE_INDEX

`TAG_STYLES`: Maps Lezer tag class names → `{ color, bold? }`. Derived from `PALETTE`. Used by CM `HighlightStyle`.

`TAG_STYLE_INDEX`: Maps Lezer tag class names → `S` enum values. Used by worker's `highlightTree()` callback. 14 entries.

### Sync Tokenizer Keyword Classification

The sync tokenizer uses string-based sets to classify keywords into two tiers via `keywordStyle(word, lang)`:
- **Definition sets** (`jsDefKwSet`, `tsDefExtras`, `pyDefKwSet`) → `S.DEF_KW`
- **Modifier sets** (`jsModifierSet`, `tsModifierExtras`, `pyModifierSet`) → `S.MODIFIER`
- **Everything else in keyword set** → `S.KEYWORD`

Decorators (`@name`) use `S.MODIFIER`. The Lezer pass uses semantic tags (`definitionKeyword` → `S.DEF_KW`, `moduleKeyword`/`modifier` → `S.MODIFIER`).

---

## Two-Tier Tokenization

### Flow
```
Y.Text change (typing or remote sync)
  → deep observer fires synchronously
  → codeSystem.handleContentChange(id, ev, lang)
    → syncTokenize(sourceLines, lang) → RunSpans[] (flat packed triples)
    → cache.spans updated, layout/frame nulled, version incremented
    → deltaToChangedRanges(ev.delta) → ChangedRange[] (adjacent ranges merged)
    → dispatch to worker (hash-routed): { type:'parse', id, text, language, version, changes }

Same rAF frame:
  → renderer calls getLayout() → gets sync-tokenized spans → draws all chars

Worker responds (typically next frame):
  → applyWorkerSpans(id, spans, forVersion)
  → version-gated: discarded if stale
  → swaps spans (only colors change), invalidateWorld() for redraw
  → renderer draws Lezer-accurate colors
```

Spans are **always populated** after entry creation. Cold miss in `getLayout()` creates a full entry with sync-tokenized spans and dispatches a worker parse. No blank-until-first-edit.

### Sync Tokenizer (`syncTokenize`)

Regex-based tokenizer — signature `syncTokenize(lines: string[], lang)`, returns `RunSpans[]`. Callers pass pre-split `sourceLines[]` (no internal `text.split('\n')`). Pushes `(from, to, styleIndex)` triples into a reusable module-level buffer, then calls `packRunSpans()` per line. No per-highlight object allocation.

Handles: keywords (JS/TS/Python sets, three-tier classification via `keywordStyle()`), strings (including template literals with `${}` nesting, Python f/r/b-prefix strings, triple quotes), numbers (hex/binary/octal/scientific/separators/BigInt), comments (line `//`, block `/* */`, Python `#`, hashbang `#!`), operators (including `=>`, `?.`, `??`, `...`), decorators (`@name` → S.MODIFIER), identifiers (function calls → S.FUNCTION, PascalCase → S.TYPE, others → S.VARIABLE).

Does NOT emit tokens for punctuation, brackets, or whitespace — these become `S.DEFAULT` gaps via `packRunSpans`.

Multi-line state tracked via `inBlockComment` and `inTemplateString` flags across lines. `scanTemplateLiteral` pushes directly into the shared buffer instead of allocating/returning objects.

### Lezer Worker Pool

2 warm workers. **Hash-based routing** (`id.charCodeAt(id.length - 1) % POOL_SIZE`) — deterministic, preserves incremental parse trees. Lazy initialization (first `dispatch()` call creates them).

**Cached configured parsers:** `tsParser` and `jsxParser` are configured once at worker startup, not per-parse.

**Per-object state:** Each worker maintains a `Map<string, { tree: Tree, fragments: TreeFragment[] }>`. When `changes` are provided, `TreeFragment.applyChanges()` enables incremental parsing. Without changes (cold parse or language change), a full parse is performed.

**Span extraction (`extractSpans`):** `highlightTree()` walks the Lezer `Tree` with the `styleHighlighter`. Callback stores `[lineIdx, from, to, style]` quads into a reusable flat `number[]` buffer (zero object allocation). Second pass uses a sequential cursor scan — O(highlights) total vs previous O(highlights × lines). Line offsets are binary-searched for fast token-to-line mapping.

**Zero-copy transfer:** Worker transfers `RunSpans` ArrayBuffers to main thread (no structured clone overhead). Worker arrays become detached after postMessage.

**Protocol:**
```
Main → Worker: { type:'parse', id, text, language, version, changes? }
Main → Worker: { type:'remove', id }
Main → Worker: { type:'clearAll' }                    (broadcast to ALL workers)
Worker → Main: { type:'spans', id, version, spans: RunSpans[] }
```

**Language → Parser mapping:**
- `'python'` → `@lezer/python`
- `'typescript'` → `@lezer/javascript` configured with `dialect: 'ts jsx'` (cached)
- `'javascript'` (default) → `@lezer/javascript` configured with `dialect: 'jsx'` (cached)

---

## Cache (`CodeSystemCache`)

Singleton `codeSystem`. Per-object `CacheEntry`:

```typescript
interface CacheEntry {
  sourceLines: string[];
  version: number;              // Monotonic, incremented on content or language change
  spans: RunSpans[];            // Always populated — packed per source line
  layout: CodeLayout | null;    // null = needs recompute
  layoutFontSize: number;       // Cache key
  layoutWidth: number;          // Cache key
  layoutLineNumbers: boolean;   // Cache key
  language: CodeLanguage;       // Cache key
  frame: FrameTuple | null;     // Derived, set by computeCodeBBox
}
```

### Invalidation Rules

| Trigger | What changes | Layout | Frame | Version |
|---------|-------------|--------|-------|---------|
| `handleContentChange` | New text, new sync-tokenized spans | nulled | nulled | incremented |
| `applyWorkerSpans` | Spans swapped (colors only) | unchanged | unchanged | checked (must match) |
| fontSize/width/lineNumbers change (detected in `getLayout`) | — | recomputed | nulled | unchanged |
| Language change (detected in `getLayout`) | Re-tokenized spans | **preserved** if dims unchanged | preserved | incremented |

`applyWorkerSpans` does NOT null the layout — only colors change, not geometry. It calls `invalidateWorld(frameBounds)` if a cached frame exists.

**Language change optimization:** Language affects only colors, not geometry. Re-tokenize spans + dispatch worker parse, but do NOT null layout/frame unless fontSize/width also changed.

### Public API

| Method | Called by | Purpose |
|--------|-----------|---------|
| `computeLayout(sourceLines, fontSize, width, lineNumbers?)` | SelectTool width reflow preview | Pure layout computation (exported) |
| `getLayout(id, yText, fontSize, width, lang, lineNumbers?)` | `computeCodeBBox`, `drawCode` | Build or return cached layout; handles cold miss, language change, relayout |
| `handleContentChange(id, ev, lang)` | Deep observer | Sync tokenize + dispatch worker parse with delta changes |
| `applyWorkerSpans(id, spans, forVersion)` | Worker response handler | Version-gated span upgrade |
| `getSpans(id)` | `drawCode` in objects.ts | Get RunSpans[] for renderer |
| `getSourceLines(id)` | `drawCode` in objects.ts | Get source lines for fillText |
| `getFrame(id)` / `setFrame(id, frame)` | Hit testing, selection, bbox | Read/write cached frame |
| `remove(id)` / `clear()` | Deletion / room change | Cleanup entries + notify workers |

---

## Canvas Renderer (`renderCodeLayout`)

Signature: `renderCodeLayout(ctx, layout, originX, originY, fontSize, spans, sourceLines)`

Zero-allocation span iteration — no `sliceRuns`, no intermediate objects. Steps:

1. **Background:** `roundRect` fill with `CODE_BG`, `borderRadius(fontSize)`
2. **Per visual line:** Compute `baseY = originY + padTop + i * lineHeight + baselineOffset`
3. **Gutter:** When `layout.lineNumbers` is true and `vline.from === 0`, right-align line number within gutter area. Skipped entirely when lineNumbers is false.
4. **Code text:** Iterate `RunSpans` triples with inline `[vFrom, vTo)` clipping. `PALETTE[style]` for color, `isBold(style)` for font. `lineText.substring(drawFrom, drawTo)` for fillText (V8 SlicedString optimization). Whitespace checked via `charCodeAt` (no regex)
5. **Batching:** Font and fillStyle only set on change (`prevFont` tracking)
6. **Placeholder:** After the loop, if `sourceLines.length === 1 && sourceLines[0] === ''`, draw grey "Type something..." at first line position (same font, color as CM6 placeholder)

---

## Screen-Space DOM Editor — CSS Custom Properties

CodeMirror needs to render crisply at all zoom levels. CSS `transform: scale()` would cause blurriness. Leaving dimensions unscaled would produce incorrect world-to-screen-space alignment. The solution: all dimensions computed as `world * scale` in exact px values.

### Dimensional Properties (set at mount + every zoom/pan change)

```
screenFS = fontSize * scale      → container.style.fontSize
screenW  = width * scale         → container.style.width
screenLH = lineHeight(fs) * scale → container.style.lineHeight
borderRadius = borderRadius(fs) * scale → container.style.borderRadius
```

Position via `worldToClient(origin)` → `left/top` in CSS px.

### CSS Custom Properties (`--c-*`)

The CM theme references CSS custom properties instead of `em` units. `setCSSVars()` writes them as exact px on the container at mount and on every `positionEditor()` call. Values depend on `lineNumbers`:

**lineNumbers ON (default):**
| CSS var | Value | Used by |
|---------|-------|---------|
| `--c-pt` | `padTop(fs) * scale` px | `.cm-scroller` paddingTop |
| `--c-pb` | `padBottom(fs) * scale` px | `.cm-scroller` paddingBottom |
| `--c-gl` | `padLeft(fs) * scale` px | `.cm-gutters` paddingLeft |
| `--c-gr` | `gutterPad(fs) * scale` px | `.cm-line` padding-left (gutter-to-content gap) |
| `--c-pr` | `padRight(fs) * scale` px | `.cm-line` padding-right |
| `--c-gw` | `2 * charWidth(fs) * scale` px | `.cm-gutterElement` minWidth |

**lineNumbers OFF:** `--c-gl` = `0px`, `--c-gw` = `0px`, `--c-gr` = `padLeft(fs) * scale` px (provides block left indent via `.cm-line` padding since CM removes `.cm-gutters` entirely when the `lineNumbers` extension is absent).

This avoids browser `em→px` conversion which introduces sub-pixel rounding mismatches versus the canvas renderer.

### Padding Placement: Scroller, Not Content

Vertical padding (`--c-pt`, `--c-pb`) is on `.cm-scroller`, not `.cm-content`. CM's `viewState.measure()` reads `contentDOM` padding with `parseInt()`, which truncates fractional px values, causing gutter-content vertical misalignment. Placing padding on the scroller avoids this.

### Gutter-Content Gap: Line, Not Gutters

The gutter-to-content gap (`--c-gr`, `gutterPad`) is applied as `padding-left` on `.cm-line`, not as `padding-right` on `.cm-gutters` or `.cm-gutterElement`. CM6's base theme sets `box-sizing: border-box` on `.cm-gutterElement`, which absorbs padding into the element's box without propagating it to push `.cm-content` rightward. Placing the gap on `.cm-line` ensures correct alignment AND makes `.cm-activeLine` background cover the gap area seamlessly (no highlight discontinuity between gutter and content).

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

1. **Theme** (`EditorView.theme`, dark mode): CoolGlow chrome — background, gutter, cursor (`CODE_CARET`), selection (`CODE_SELECTION`), active line (`CODE_LINE_HL`), bracket matching (cyan/red outlines), search match, tooltip, fold placeholder, placeholder hint. All padding/sizing via `var(--c-*)`. Line-height set as the `LINE_HEIGHT_MULT` ratio on `.cm-scroller`. Gutter elements use `fontFeatureSettings: '"tnum"'` for tabular numbers.

2. **Syntax highlighting** (`HighlightStyle.define`): Comprehensive Lezer tag mapping using the three-tier keyword system. Tags grouped by semantic role: control keywords → `KEYWORD`, definition keywords → `DEF_KEYWORD`, module/modifier → `MODIFIER`, plus full coverage of strings (including special(brace), character), numbers (integer, float), comments (doc), functions (className, definition types), variables (self, labelName), types (angleBracket, namespace), all operator subtypes, attributes, deref, punctuation, and invalid.

### Editor State Extensions (set at mount)

- `lineNumbers()` in `Compartment` — `formatNumber` callback pads with spaces to match canvas digit reservation. When `lineNumbers=false`, compartment holds empty `[]` (CM removes `.cm-gutters` entirely). Dynamically reconfigurable via `switchLineNumbers()`
- `highlightActiveLine()` + `highlightActiveLineGutter()` — continuous active line highlight. `.cm-activeLineGutter` uses negative `marginLeft` + `paddingLeft` (both `var(--c-gl)`) to extend the highlight background to the block's left edge
- `EditorView.lineWrapping` — enables CM's native word-wrapping
- `bracketMatching()` — highlights matching bracket pairs (cyan outline) and mismatches (red outline)
- `closeBrackets()` — auto-closes brackets, quotes, template literals; `closeBracketsKeymap` for Backspace pair-deletion
- Language extension in `Compartment` — `python()` or `javascript({ typescript: true, jsx: true })`, dynamically reconfigurable via `switchLanguage()`. Same lazy-import pattern used by `switchLineNumbers()`
- `indentUnit.of('    ')` — 4-space indentation
- `keymap.of([backspaceIndent, ...closeBracketsKeymap, indentWithTab, ...yUndoManagerKeymap])` — indent-unit Backspace first (deletes 4 spaces at col % 4 boundaries), then closeBrackets, Tab, explicit undo/redo
- `yCollab(yText, null, { undoManager: sessionUM })` — Yjs collaborative binding with per-session UndoManager scoped to `[yText, yMap]`
- `placeholder('Type something...')` — grey hint text in empty editors (matches canvas placeholder)
- Tab normalizer transaction filter — replaces `\t` with 4 spaces in all insertions

---

## CodeTool — PointerTool Implementation

Registered in `tool-registry.ts` as singleton `codeTool`, mapped to `'code'` tool ID.

### Gesture Flow

1. `begin()`: Hit-test existing code blocks via `hitTestVisibleCode()` (occlusion-aware, Z-order by ULID descending)
2. `end()`: If hit → `mountEditor(hitId)`. If no hit → `createCodeObject(x, y)` at center-placed position, then `mountEditor(createdId)`.

### Object Creation

Center-placed: `originX = clickX - width/2`, `originY = clickY - blockHeight/2`. Default language: `typescript`. Width from `getDefaultWidth(fontSize)`. fontSize from `useDeviceUIStore.textSize`. `lineNumbers` from `useDeviceUIStore.codeLineNumbers` (persisted preference).

### Editor Lifecycle

**Mount:** Close existing editor if open → create container div → set screen-space dimensions + CSS vars → append to `editorHost` → lazy-load CM modules (parallel `Promise.all`) → create session UM scoped to `[yText, yMap]` with `trackedOrigins: new Set([userId])` → build `EditorState` with extensions → create `EditorView` → focus → extract `syncConf` via `ySyncFacet` → seal main UM (add syncConf origin, captureTimeout → 600s) → register Y.Map observer → `beginCodeEditing(objectId)` on selection store → invalidate world.

**Close (`commitAndClose`):** Remove event handlers → unseal main UM (remove syncConf origin, captureTimeout → 500ms) → unobserve Y.Map → destroy EditorView → clear session UM → remove container from DOM → null all refs → `endCodeEditing()` on selection store → invalidate world + overlay.

### Event Handlers

- **Escape key** (capture phase): Close editor
- **Click outside** (capture phase, 100ms delayed attach): Close editor. Clicks on `.ctx-menu` are excluded. Canvas clicks are consumed (`stopPropagation`) when code tool is active.

### UndoManager Integration

Two-level undo: per-session UM for in-editor Ctrl+Z/Y, main UM for post-close atomic undo. Same pattern as TextTool's `TextCollaboration` extension.

**Session UM:** `Y.UndoManager([yText, yMap], { trackedOrigins: new Set([userId]) })`. Scoped to both Y.Text (content) and Y.Map (properties). `yCollab()` auto-adds `syncConf` (YSyncConfig) as a tracked origin so local CM edits are captured. `yUndoManagerKeymap` provides explicit Mod-z/Mod-y/Mod-Shift-z bindings.

**Main UM sealing:** After EditorView creation, `syncConf` extracted via `view.state.facet(ySyncFacet)` and added to main UM's tracked origins. `captureTimeout` set to 600s so entire session merges into one undo item. On close, `syncConf` removed and `captureTimeout` restored to 500ms.

### Y.Map Observer — Live Property Sync

Registered after EditorView creation on `handle.y`. Listens for `keysChanged`:
- `fontSize`, `width`, `origin` → `positionEditor()` (re-reads fresh props, updates all screen-space dimensions + CSS vars)
- `language` → `switchLanguage()` (lazy-loads parser, reconfigures language `Compartment`)
- `lineNumbers` → `switchLineNumbers()` (reconfigures lineNumbers `Compartment`) + `positionEditor()` (updates CSS vars for gutter/no-gutter mode)

Cleanup: `yMap.unobserve()` in `commitAndClose` before view destroy.

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
  const layout = codeSystem.getLayout(id, props.content, props.fontSize, props.width, props.language, props.lineNumbers);
  const spans = codeSystem.getSpans(id);
  const lines = codeSystem.getSourceLines(id);
  renderCodeLayout(ctx, layout, props.origin[0], props.origin[1], props.fontSize, spans, lines);
}
```

During scale transforms, code blocks get full context-aware rendering:
- **Corner / codeOnly N/S:** `drawScaledCodePreview()` — ctx.scale on cached layout with rounded fontSize
- **E/W:** `drawReflowedCodePreview()` — renders from pre-computed `CodeReflowState` layout/origin
- **Mixed N/S:** Edge-pin translate via `computeEdgePinTranslation()`

### selection-store.ts

```typescript
codeEditingId: string | null;
codeReflow: CodeReflowState | null;  // E/W reflow state during scale transforms
beginCodeEditing: (objectId) => set({ codeEditingId: objectId, menuOpen: true });
endCodeEditing: () => set({ codeEditingId: null, menuOpen: selectedIds.length > 0 });
```

`CodeReflowState` (same shape as `TextReflowState`): `{ layouts: Map<string, CodeLayout>, origins: Map<string, [number, number]> }`. Initialized in `beginScale` for E/W handles when `kindCounts.code > 0`, cleared in `endTransform`/`cancelTransform`.

### SelectTool.ts — Code Block Integration

- **Translate:** Code blocks translate via `origin` (same as text), not `frame`
- **Scale:** Full dispatch in `invalidateTransformPreview` and `commitScale` — uniform scale (corner/codeOnly N/S), reflow (E/W), edge-pin (mixed N/S)
- **Double-click to edit:** `objectInSelection` click on code block calls `codeTool.startEditing(id)` with `justClosedCodeId` guard
- **Guards:** `codeEditingId` blocks handle hit testing, hover cursors, and hides resize handles during editing
- **onViewChange:** Forwards to `codeTool.onViewChange()` when editor is mounted

### hit-testing.ts

Code blocks are included in `ObjectKind` (`'code'`) and participate in spatial index queries. `hitTestVisibleCode()` in `hit-testing.ts` handles code block hit testing with Z-order occlusion (same pattern as `hitTestVisibleText`): spatial query → `testObjectHit` → Z-sort → occlusion scan. Code blocks always occlude (opaque bg); unfilled shape interiors are transparent.

---

## Known Issues / Not Yet Implemented

- **Long code blocks:** CM's internal viewport optimization causes WYSIWYG mismatch on very tall blocks (content outside CM's visible window is virtualized)
