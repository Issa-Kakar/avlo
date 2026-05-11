# Code Block System

> **Maintenance:** Architectural overview, not a changelog. Match surrounding detail level when updating — don't inflate coverage of one change at the expense of the big picture.

Canvas-rendered code blocks with CodeMirror DOM overlay editing, two-tier syntax highlighting, and Yjs collaborative binding. Fully integrated with SelectTool (translate, scale, reflow, double-click-to-edit).

---

## Files

| File | Role |
|------|------|
| `code-tokens.ts` | Style enum (`S` — 16 values incl. `WHITESPACE` sentinel), `THEME` struct (palette + chrome — single source of truth for colors), spans-buffer cap helpers (`ensureSpansDataCap` / `ensureSpansLineCap` — kept here, not in `code-system.ts`, so the worker bundle stays free of `RenderLoop` → `image-manager`), packed-triple writers (`countPackedTriples` / `writePackedTriples` / `packRunSpansInto`), length-bucketed keyword tables (with `definesNext` flag) + `classifyIdent`, sizing ratios (`CHROME_FONT_RATIO`, `LINE_HEIGHT_MULT`, etc.), escape/string scanners (`scanEscape`, `scanQuotedString`, `scanTripleStringBody`, `scanTemplateLiteral`), char-code sync tokenizer (`syncTokenizeInto`) — imported by main thread, worker, and theme |
| `code-syntax-rules.ts` | Single source of truth for Lezer-tag → S enum mapping. Exports `SYNTAX_RULES` (consumed by `code-theme.ts` to derive `HighlightStyle.define` rules) and `STYLE_HIGHLIGHTER` (custom Lezer Highlighter that returns the stringified S int directly; worker callback recovers via `+classes \| 0`). One declaration, no `tagHighlighter` / `TAG_STYLE_INDEX` indirection |
| `code-system.ts` | SOA pipeline types (`CodeSource`, `CodeSpans`, `CodeLayout`, `CodeOutput`), pooled-buffer `CodeSystemCache`, `buildCodeSourceInto` / `layoutCodeSourceInto` / `ensureOutputCache`, zero-allocation canvas renderer (`renderCodeLayout` with header/output chrome), chrome height helpers (`chromeFontSize`, `headerBarHeight`, `outputPanelHeight`, `blockHeight`), worker pool (2 warm workers, hash-routed), delta→ChangedRange conversion, font metrics (derived from text-system) |
| `code-theme.ts` | CodeMirror theme extensions — lazy-loaded dark theme + syntax highlighting (`getCodeMirrorExtensions`). Reads `THEME.chrome.*` for chrome and derives `HighlightStyle.define` rules from `SYNTAX_RULES` + `THEME.palette`. No bold or italic — Sweet Dracula's emphasis is color-only. No dependency on code-system |
| `lezer-worker.ts` | Web Worker — per-object Lezer `Tree` + `TreeFragment` state, cached configured parsers, incremental parsing, `highlightTree(tree, STYLE_HIGHLIGHTER, …)` → flat `{spanData, spanLineStart}` via `+classes \| 0` + `writePackedTriples`, zero-copy transfer of both ArrayBuffers |
| `CodeTool.ts` (in `tools/`) | PointerTool — click-to-place + hit-test existing blocks + CodeMirror DOM overlay lifecycle (screen-space rendering via CSS custom properties incl. chrome color vars) + header/output DOM chrome (title input, play button, output panel). `justClosedCodeId` prevents close→remount cycle; `startEditing(id)` public API for SelectTool double-click entry |

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
  title: string | undefined,     // Header text — undefined=fallback, ''=deliberately empty
  headerVisible: boolean,        // Header bar visibility (default true)
  outputVisible: boolean,        // Output panel visibility (default false)
  output: string | undefined,    // Execution output text (not yet populated)
  ownerId: string,
  createdAt: number,
}
```

**Differences from text objects:**
- `Y.Text` not `Y.XmlFragment` — code is plain text; delta events map to Lezer `ChangedRange`
- `origin` = top-left (not baseline). Code blocks are rectangular, no alignment modes
- `width` always stored number — no 'auto' mode
- Height derived: `blockHeight(layout, fs, headerVisible, outputVisible, output)`
- No `color`/`fillColor` — dark theme is fixed chrome
- Empty blocks are NOT deleted on close (unlike text) — visible dark bg + line numbers

**Title semantics:** `undefined` → show literal `"Untitled"` fallback (legacy/back-compat — newly created blocks always commit `title: 'Untitled'` directly). `''` → user deliberately cleared, show nothing. `'Foo'` → show "Foo". Stored via `saveTitle()` on blur; `??` (not `||`) used everywhere for fallback to preserve empty string. The fallback no longer references the language extension — title and language are independent.

**Typed accessor:** `getCodeProps(y)` → `CodeProps | null` (in `core/accessors.ts`). Returns `{ content: Y.Text, origin, fontSize, width, language, lineNumbers, title, headerVisible, outputVisible, output }`. Also: `getLineNumbers(y, fallback = true)`, `getHeaderVisible(y, fallback = true)`, `getOutputVisible(y, fallback = false)`, `getCodeOutput(y)`.

---

## Architecture

### SOA Pipeline — Pooled Buffers

Four pooled buffers per id (`CacheEntry`), allocation-free hot paths:

| Tier | Type | Slots | Owner |
|------|------|-------|-------|
| Source | `CodeSource` | `fullText: string` + `lineStart: Uint32Array` (sentinel `text.length+1`) | `buildCodeSourceInto` |
| Spans  | `CodeSpans`  | flat `spanData: Uint16Array` of triples + `spanLineStart: Uint32Array` half-open ranges | `syncTokenizeInto` (main) / worker (transfer-swap) |
| Layout | `CodeLayout` | parallel `vlSrcIdx` / `vlFrom` / `vlLen` `Uint32Array`s + cached `normalFont`/`chromeFont` strings | `layoutCodeSourceInto` |
| Output | `CodeOutput` | `text: string \| null` + `lineStart: Uint32Array` | `ensureOutputCache` (identity-checked rebuild) |

**Whitespace sentinel.** Pure space/tab gap runs are emitted with `style = S.WHITESPACE` directly into the triple's style slot (writer scans the gap once during tokenization, just as before). The renderer's per-span branch is a single `style === S.WHITESPACE` compare on a value already in a register — no `(si/3)|0` divide, no parallel buffer, no second cache line. `THEME.palette[S.WHITESPACE] = THEME.palette[S.DEFAULT]` so any blind palette read returns a defined value.

**Cached font strings.** `CodeLayout` caches `${weight} ${px}px ${family}` template strings — recomputed only when `fontSize` changes (gated inside `layoutCodeSourceInto`). The renderer reads from the layout instead of allocating three template strings per call.

All buffers grow but never shrink (capacity-doubling). `out?` parameters mirror text-system's `parseAndTokenize` / `measureTokenizedContent` / `layoutMeasuredContent` — reused across content edits, font/width changes, and reflow gestures. Per-pointermove allocations during E/W reflow: zero.

**Style enum (`S`):** 16 values (DEFAULT=0 through WHITESPACE=15), fits in a byte. Colors looked up via `THEME.palette[style]`. No bold or italic — Sweet Dracula is color-only.

**`packRunSpansInto(out, lineLen, buf, count, runOffset, lineText, lineFromAbs)`:** Pre-counts gap-filled triples (`countPackedTriples`), grows `out.spanData` if needed, and writes via `writePackedTriples`. Token triples carry their explicit style; gap-fill triples are scanned for whitespace once and stamped `S.WHITESPACE` (pure space/tab) or `S.DEFAULT` (has ink). Returns the new write offset. The worker uses `writePackedTriples` directly against its own growing `_workerSpanData` to bypass the CodeSpans struct.

**Memory:** Per visual line is 12 bytes (3 × Uint32) vs ~40+ bytes for the prior `VisualLine` object (V8 header + 3 slots + retained substring). Spans dropped a `Uint16Array[]` outer container and N per-line ArrayBuffers in favor of a single flat `Uint16Array` + `Uint32Array` index.

### Coordinate System & Positioning

Code blocks use **origin-based top-left positioning**. The `origin` field stores `[x, y]` in world coordinates representing the top-left corner of the block (including background/padding).

**Frame derivation:** No stored frame in Y.Doc. Frame is computed from layout and cached:
```
frame = [origin[0], origin[1], layout.totalWidth, blockHeight(layout, fs, headerVisible, outputVisible, output)]
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

**Chrome sizing** (header bar + output panel):
```
chromeFontSize(fs)    = fs * 0.72          — smaller, minimal chrome text
headerBarHeight(fs)   = fs * 2.5           — title + play button area
outputPanelHeight(fs, output) =
    fs * 2.0                               — "Output" label height
  + min(outputLines, 12) * cfs * 1.4       — output text (capped at 12 lines)
  + fs * 0.8                               — bottom padding

blockHeight(layout, fs, headerVisible, outputVisible, output) =
    [headerBarHeight(fs)]                  — only if headerVisible
  + padTop(fs) + lines * lineHeight(fs) + padBottom(fs)   — code area
  + [outputPanelHeight(fs, output)]        — only if outputVisible
```

`totalHeight()` is still exported for internal use but `blockHeight()` is used for bbox/frame computation.

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
interface CodeLayout {
  fontSize: number; width: number; lineNumbers: boolean;
  totalWidth: number; sourceLineCount: number;
  // Visual lines — SOA, no string slot per line.
  visualLineCount: number; visualLineCap: number;
  vlSrcIdx: Uint32Array;   // source line index
  vlFrom:   Uint32Array;   // char offset within source line (0 = first segment → show gutter)
  vlLen:    Uint32Array;   // char length of visual line
}
```

Visual line text is derived at render time from `(source.fullText, source.lineStart[srcIdx])` — no `string` slot per line. `layoutCodeSourceInto(source, fontSize, width, lineNumbers, out)` mutates `out` in place; capacity grows but never shrinks.

### Line Wrapping — WYSIWYG Match

The canvas wrapping algorithm matches CodeMirror's `lineWrapping` extension behavior. CM uses `overflow-wrap: anywhere` + `word-break: break-word` + the CSS forces `white-space: break-spaces` via the scroller. `layoutCodeSourceInto()` mirrors this:

1. Compute `maxChars = floor((width - contentLeft - padRight) / charWidth)`
2. For lines exceeding `maxChars`, scan backward from the break point for a space/tab boundary (`fullText.charCodeAt(lineFrom + j)`)
3. If a word boundary is found, break there (whole-word wrap)
4. If no boundary found within the window, break at `maxChars` (character-level fallback)

Continuation lines have `vlFrom > 0` (no gutter number). The renderer clips flat span triples inline using `[vFrom, vTo)` range — no intermediate allocation; per-span fillText takes a single substring of `fullText`.

---

## Theme — CoolGlow Chrome + Sweet Dracula Palette

Single source of truth for colors. `code-tokens.ts` exports `THEME: ThemeSpec` (currently `CODE_THEME` — a hybrid: deep-blue/purple **CoolGlow chrome** wrapping Sweet Dracula's vibrant **token palette**). A swap is one export line plus invalidate. Two slots:

- **`THEME.palette: readonly string[]`** — index = `S` enum value (length 16, including `WHITESPACE` at index 15 mirrored from `DEFAULT`).
- **`THEME.chrome: { bg, gutter, selection, lineHl, caret, nonmatchBracket, searchMatch, sep, title, playGreen, playBg, outputLabel, outputText, placeholder }`** — chrome colors (background, gutter, selection, separator, play button, output panel, title input placeholder). Anything that isn't a token color but used to be a hard-coded hex now lives here.

Consumers:
- Canvas renderer (`renderCodeLayout`) reads `THEME.palette[style]` for token color and `THEME.chrome.{bg,sep,title,playGreen,playBg,outputLabel,outputText,gutter}`.
- CM theme (`code-theme.ts`) reads `THEME.chrome.*` directly. `.cm-matchingBracket` is editor-only UI — independent of THEME and Lezer — a transparent fill + subtle `1px solid #ffffff4d` (30%-alpha white) outline. **Selector must be `&.cm-focused .cm-matchingBracket`** to beat `@codemirror/language`'s baseTheme, which paints a teal `#328c8252` film via that exact higher-specificity selector during focus. Plain `.cm-matchingBracket` loses CSS specificity and the film stays. Same constraint applies to `.cm-nonmatchingBracket` (rose via `THEME.chrome.nonmatchBracket`).
- `CodeTool.setCSSVars` writes `--c-bg`, `--c-sep`, `--c-title`, `--c-caret`, `--c-placeholder`, `--c-output-label`, `--c-output-text` from `THEME.chrome.*`. `index.css` rules read `var(--c-*, <hex fallback>)` so partially-themed elements degrade gracefully.

### Run Button — Geometry Helper

`playButtonGeom(fontSize) → { btnR, triW, triH, triXOffset }` in `code-tokens.ts` is the single source of truth for the play-button triangle. The canvas renderer reads `triXOffset = triW / 3` to draw the triangle centroid-balanced on `btnCx`. The DOM editor consumes the same numbers through CSS vars set by `CodeTool.setCSSVars` (`--c-btn-size = fs * scale`, `--c-tri-w = triW * scale`, `--c-tri-h = triH * scale`) so `positionEditor()` updates flow automatically on every zoom. `.code-run-btn > svg` is `position: absolute` with `left: calc(50% - var(--c-tri-w) / 3); top: calc(50% - var(--c-tri-h) / 2);` — a direct CSS translation of the canvas `triX = btnCx - triW/3, triY_top = btnCy - triH/2`, so the SVG triangle's centroid lands on the button center (NOT the SVG's visual center — those differ by `triW/6` because the triangle's centroid sits at `triW/3`, not `triW/2`). SVG path `M0 0L17 10L0 20Z` (viewBox `0 0 17 20`, aspect 17:20 = 0.85) matches the canvas triangle's `triW:triH = 0.85:1`. SVG fill is `THEME.chrome.playGreen`; circle background is `THEME.chrome.playBg` (both set inline at creation).

### Chrome Colors (CoolGlow)
| Slot | Hex | Use |
|------|-----|-----|
| `bg` | `#060521` | Deep blue/purple block background |
| `gutter` | `#E0E0E090` | Line numbers (light grey, ~56% alpha) |
| `selection` | `#122BBB` | Selection background (bright blue) |
| `lineHl` | `#FFFFFF0F` | Active line wash (subtle white) |
| `caret` | `#FFFFFFA6` | Caret (bright white) |
| `nonmatchBracket` | `#FF5370` | Rose unmatched-bracket outline |
| `searchMatch` | `#FFD43B40` | Translucent yellow search highlight |
| `sep` | `#FFFFFF20` | Hairline separator (header / output) |
| `title` | `#AEAEAE` | Header title text |
| `playGreen` / `playBg` | `#4ADE80` / `#4ADE8035` | Run button triangle + circle |
| `outputLabel` / `outputText` | `#E0E0E090` / `#AEAEAE` | Output panel label + body |
| `placeholder` | `#E0E0E060` | Title input placeholder |

### Token Colors (Sweet Dracula palette)
| S Enum | Hex | Semantic | Examples |
|--------|-----|----------|----------|
| `S.DEFAULT` | `#F8F8F2` | Foreground / plain identifiers / separators / brackets | bare text, `{` / `[` / `(`, `,`, `;` |
| `S.KEYWORD` | `#FF79C6` | Control flow / general kws / JSX punctuation | `if`, `else`, `return`, `new`, `<`, `>`, JSX `<div`, `</span>` |
| `S.STORAGE` | `#8BE9FD` | Definer keywords | `function`, `class`, `const`, `let`, `var`, `type`, `interface`, `enum`, `def`, `lambda` |
| `S.MODIFIER` | `#FF79C6` | Modifier keywords | `export`, `import`, `from`, `async`, `static`, `public`, `readonly`, `namespace` |
| `S.STRING` | `#F1FA8C` | Strings, regex bodies, character literals | `"hello"`, `` `template` ``, `/re/` body |
| `S.NUMBER` | `#BD93F9` | Numbers + bool/null/atom | `42`, `0xFF`, `true`, `false`, `null` |
| `S.COMMENT` | `#AEAEAE` | Comments (light grey — contrast on deep-purple bg) | `//`, `/* */`, `#` |
| `S.FUNCTION_DEF` | `#50FA7B` | Function defs, class/type names | `function foo`, `class Bar`, `def baz`, `type Id` |
| `S.VARIABLE` | `#F8F8F2` | Plain identifiers (same hex as DEFAULT, semantic split kept) | `x`, `myVar`, object-literal property keys (`{ key: v }`), class fields |
| `S.TYPE` | `#8BE9FD` | PascalCase types, primitives, property accesses | `string`, `HTMLElement`, `obj.foo` |
| `S.OPERATOR` | `#FF79C6` | Operators, derefs, escape sequences | `=`, `+`, `===`, `=>`, `.`, `\n` inside `"..."` |
| `S.ATTRIBUTE` | `#50FA7B` | JSX/HTML attribute names | `className`, `onClick` |
| `S.INVALID` | `#FF5555` | Invalid / errors | parse errors |
| `S.FUNCTION_CALL` | `#50FA7B` | Function invocations (green — matches FUNCTION_DEF) | `foo()`, `obj.bar()` |
| `S.LANG_VAR` | `#BD93F9` | Language variables + decorators | `this`, `super`, `self`, `@decorator` |
| `S.WHITESPACE` | (mirrors DEFAULT) | Gap-fill sentinel (renderer skips) | spaces/tabs between tokens |

Emphasis is **color-only** — no bold, no italic. The summary:
- **Pink** for keywords, modifiers, operators, derefs (`.`), JSX angle brackets / tag names, and escape sequences inside strings.
- **Cyan** for storage types (definer kws) and property accesses (`obj.foo` reads).
- **Green** for function/class/type definitions, function calls, and JSX attribute names.
- **Purple** for numbers, `this`/`super`/`self`, and decorators.
- **Yellow** for string bodies; **red** for invalid; **light grey** for comments.
- **White** (DEFAULT) for plain identifiers, object-literal keys, class fields, brackets, `,` and `;`.

### `SYNTAX_RULES` + `STYLE_HIGHLIGHTER` (Lezer-tag → S)

`code-syntax-rules.ts` exports the single Lezer-tag → S mapping in two consumable forms, both derived from one declaration:

- **`SYNTAX_RULES: readonly { tags: Tag[]; style: S }[]`** — declarative table (~16 rows). `code-theme.ts` derives `HighlightStyle.define([...])` from it: `{ tag: r.tags, color: THEME.palette[r.style] }` per row. No `fontWeight` / `fontStyle` — color is the only visual axis.
- **`STYLE_HIGHLIGHTER: Highlighter`** — custom `{ style(tags) }` impl that returns the stringified S int directly (e.g. `'5'` for `S.NUMBER`). Worker callback recovers via `+classes | 0`. No `tagHighlighter` indirection, no `TAG_STYLE_INDEX` lookup.

This collapses the previous three sources of truth (`code-theme.ts`'s hand-written rule list + worker's `tagHighlighter` block + `TAG_STYLE_INDEX` map) into one.

**Deliberately routed to DEFAULT** (white):
- `tags.separator` — `,` and `;` deliberately unmapped → modifier-set walk falls through to `DEFAULT`.
- `tags.definition(tags.propertyName)` — **explicitly** mapped to `S.DEFAULT`. Without this entry the modifier-set walk would resolve via the base `tags.propertyName` → `S.TYPE` (cyan); the explicit mapping wins because @lezer/highlight orders each tag's `set` from most-specific to least-specific. Modifier ids matter: `definition` is defined before `function` (id 0 vs 2), so for tag `function(definition(propertyName))` the set is `[function(definition(propertyName)), definition(propertyName), function(propertyName), propertyName]` — the walk hits `definition(propertyName)` (→ DEFAULT) BEFORE `function(propertyName)` (→ FUNCTION_CALL). One rule covers obj-literal keys, class fields, method shorthand, AND class methods. Only `function(definition(variableName))`, `className`, and `definition(typeName)` get green FUNCTION_DEF.

### Sync Tokenizer Keyword Classification

Keywords classify via length-bucketed `KwEntry[][]` tables built once at module load (`JS_KW_BY_LEN`, `TS_KW_BY_LEN`, `PY_KW_BY_LEN`). Each entry stores a `Uint8Array` of char codes, the final `S` to emit, and a `definesNext` boolean. `classifyIdent(text, start, end, table)` looks up the length bucket and char-code-compares — no `string.slice`, no `Set.has`, zero allocation per identifier — and sets module-level `_classifyDefines` for the caller.

Reclassifications baked at table-build time so the sync output matches the Lezer worker's tag output (no color flip on first parse arrival):
- `true` / `false` / `null` (JS/TS) → `S.NUMBER`
- `True` / `False` / `None` (Python) → `S.NUMBER`
- `this` / `super` (JS/TS) → `S.LANG_VAR` (purple)
- `self` (Python) → `S.LANG_VAR`
- `function` / `class` (JS/TS); `type` / `interface` / `enum` (TS); `def` / `class` (Python) → `S.STORAGE` (cyan) with `definesNext: true`

**`lastDefIsFunc` tracking.** `syncTokenizeInto` keeps a function-local `lastDefIsFunc` boolean across the entire pass (not reset per line). Set to `_classifyDefines` after each keyword emit. The next identifier emit consumes it and renders as `S.FUNCTION_DEF` (green) regardless of `(` lookahead — `function foo`, `class Foo`, `type Bar`, `def baz`, `interface I` all turn green on the name. State persists across whitespace and comments (`function /* */ foo` resolves correctly); reset to `false` by any other emit (operator, string, number, decorator, brackets, plain identifier).

Decorators (`@name`) emit `S.LANG_VAR` (purple) directly. The Lezer pass uses semantic tags (`definitionKeyword` → `S.STORAGE`, `moduleKeyword`/`modifier` → `S.MODIFIER`, `meta` → `S.LANG_VAR`, `self` → `S.LANG_VAR`).

### Escape Sequences Inside Strings

`scanQuotedString`, `scanTripleStringBody`, and `scanTemplateLiteral` all split escape sequences out of their parent string runs. When a backslash is encountered the run is flushed up to the backslash as `S.STRING`, the escape itself emits as `S.OPERATOR` (pink — matches Sweet Dracula's `constant.character.escape`), then the STRING run resumes. Recognized escape forms: `\X` (single char), `\xHH` (hex byte), `\uHHHH` (unicode), `\u{...}` (extended unicode), `\NNN` (octal — lang-dependent but tokenized uniformly).

### WYSIWYG Sync ↔ Worker Alignment

The sync tokenizer's identifier classification matches the worker's tag-based output — no color flip when the Lezer parse arrives:

| Construct | Sync output | Lezer output | Match |
|-----------|-------------|--------------|-------|
| `function foo` | `STORAGE` + `FUNCTION_DEF` (definesNext) | `STORAGE` + `FUNCTION_DEF` (`tags.function(definition(variableName))`) | ✓ |
| `class Foo` | `STORAGE` + `FUNCTION_DEF` (definesNext) | `STORAGE` + `FUNCTION_DEF` (`tags.className`) | ✓ |
| `type Foo` / `interface I` / `enum E` (TS) | `STORAGE` + `FUNCTION_DEF` (definesNext) | `STORAGE` + `FUNCTION_DEF` (`tags.definition(typeName)`) | ✓ |
| `def foo` (Python) | `STORAGE` + `FUNCTION_DEF` (definesNext) | `STORAGE` + `FUNCTION_DEF` | ✓ |
| `foo()` | `FUNCTION_CALL` green (`(` lookahead) | `FUNCTION_CALL` green (`tags.function(variableName)`) | ✓ |
| `obj.foo()` | `FUNCTION_CALL` green (`(` wins over after-`.`) | `FUNCTION_CALL` green (`tags.function(propertyName)`) | ✓ |
| `obj.foo` (no call) | `TYPE` (after-`.`) | `TYPE` (`tags.propertyName`) | ✓ |
| `{ bold: x }` / `{ bold }` obj key | `VARIABLE` white | `DEFAULT` white (explicit `definition(propertyName)` → DEFAULT) | ✓ |
| `class Foo { field = 1 }` `field` | `VARIABLE` white (no `(` lookahead) | `DEFAULT` white (explicit `definition(propertyName)` → DEFAULT) | ✓ |
| `,` and `;` | gap-fill `DEFAULT` white | `DEFAULT` white (`tags.separator` unmapped, falls through) | ✓ |
| `{` / `}` / `[` / `]` / `(` / `)` | gap-fill `DEFAULT` white | `DEFAULT` white (`tags.bracket` → DEFAULT) | ✓ |
| `.` accessor | `OPERATOR` pink | `OPERATOR` pink (`tags.derefOperator`) | ✓ |
| `true` / `false` / `null` / `True` / `False` / `None` | `NUMBER` (table) | `NUMBER` (`tags.bool` / `tags.null`) | ✓ |
| `this` / `super` / `self` | `LANG_VAR` (table) | `LANG_VAR` (`tags.self`) | ✓ |
| `@decorator` | `LANG_VAR` | `LANG_VAR` (`tags.meta`) | ✓ |
| `\n` inside `"..."` | `OPERATOR` (split via `scanEscape`) | `OPERATOR` (`tags.escape`) | ✓ |

**Acceptable flicker** (sync emits one color, Lezer corrects on next frame; over-painting alternatives would be worse):
- `{ method() {} }` object-literal method shorthand: sync `FUNCTION_CALL` green (`(` lookahead) → Lezer `DEFAULT` white (`function(definition(propertyName))` set walk hits `definition(propertyName)` → DEFAULT before `function(propertyName)` → FUNCTION_CALL, because `definition` has lower Modifier.id than `function`). ~1 frame.
- `class Foo { bar() {} }` method body: same mechanism → sync green → Lezer white. ~1 frame.
- `const foo = function() {}`: sync `VARIABLE` (fg) → Lezer `FUNCTION_DEF` (green).

Property-access tracking uses a function-local `lastSignificantChar` (char code of the last non-ws / non-comment emitted char; persists across the entire pass, NOT per line — so `obj\n  .foo` works). Number branch resets it to 0; comments and whitespace deliberately leave it unchanged so `obj /* */ . foo` still resolves `foo` as `S.TYPE`.

**Out of scope** (needs AST awareness — no plan to address in the sync tokenizer):
JSX HTML-tag vs Component split (all `tags.tagName` → pink uniformly today), regex-delimiter split (bodies + delimiters all yellow), parameter vs variable distinction (Sweet Dracula's italic-orange treatment requires scope analysis), destructured aliases (`const { foo } = obj`).

---

## Two-Tier Tokenization

### Flow
```
Y.Text change (typing or remote sync)
  → deep observer fires synchronously
  → codeSystem.handleContentChange(id, ev, lang)
    → buildCodeSourceInto(text, entry.source)        // mutate lineStart, no string[]
    → syncTokenizeInto(entry.source, lang, entry.spans)  // flat triples into spanData
    → version incremented, layout marked invalid, frame nulled
    → deltaToChangedRanges(ev.delta) → ChangedRange[] (adjacent ranges merged)
    → dispatch to worker (hash-routed): { type:'parse', id, text, language, version, changes }

Same rAF frame:
  → renderer calls getLayout() → reflows entry.layout in place → draws all chars

Worker responds (typically next frame):
  → applyWorkerSpans(id, spanData, spanLineStart, forVersion)
  → version-gated: discarded if stale
  → swap entry.spans.spanData / spanLineStart refs to worker's transferred buffers
  → invalidateWorld() for redraw; renderer draws Lezer-accurate colors
```

Source + spans are **always populated** after entry creation. Cold miss in `getLayout()` builds source, sync-tokenizes spans, runs layout, and dispatches a worker parse. No blank-until-first-edit.

### Sync Tokenizer (`syncTokenizeInto`)

Char-code tokenizer — signature `syncTokenizeInto(source: CodeSource, lang, out: CodeSpans): void`. Iterates `source.fullText` with absolute offsets (no per-line `substring`), pushes line-relative `(from, to, style)` triples into a reusable `_syncBuf`, then `packRunSpansInto` per line writes flat triples into `out.spanData` and updates `out.spanLineStart[lineIdx + 1]`. Helpers (`isHexDigit`, `isIdentStart`, `isIdentPart`, `isDigit`, `isOperator`) take char codes — V8 jump-tables / branchless compares the predicates. No `slice`, no `substring`, no `Set.has`, no `string[]`.

Handles: keywords (length-bucketed table lookup via `classifyIdent`, with `definesNext` flag setting `lastDefIsFunc` so the next ident emits as `S.FUNCTION_DEF`), strings (`scanQuotedString` / `scanTripleStringBody` / `scanTemplateLiteral` — all emit `S.OPERATOR` for embedded escape sequences), numbers (hex/binary/octal/scientific/separators/BigInt), comments (line `//`, block `/* */`, Python `#`, hashbang `#!`), operators (including `=>`, `?.`, `??`, `...`), decorators (`@name` → `S.LANG_VAR`), identifiers (definer-promoted → `S.FUNCTION_DEF`, function calls via `(` lookahead → `S.FUNCTION_CALL`, PascalCase → `S.TYPE`, post-`.` lowercase → `S.TYPE`, others → `S.VARIABLE`).

Does NOT emit tokens for punctuation, brackets, or pure whitespace — these become gap-fill triples in `packRunSpansInto`. Pure space/tab gaps stamp `S.WHITESPACE` so the renderer skips ink work; mixed gaps stamp `S.DEFAULT`.

Multi-line state tracked via `inBlockComment`, `inTemplateString`, and `inTripleString` flags across lines. `inTripleString` stores the quote char code (`34` for `"""`, `39` for `'''`) so Python multi-line docstrings color correctly. `scanTemplateLiteral` pushes directly into the shared buffer.

### Lezer Worker Pool

2 warm workers. **Hash-based routing** (`id.charCodeAt(id.length - 1) % POOL_SIZE`) — deterministic, preserves incremental parse trees. Lazy initialization (first `dispatch()` call creates them).

**Cached configured parsers:** `tsParser` and `jsxParser` are configured once at worker startup, not per-parse.

**Per-object state:** Each worker maintains a `Map<string, { tree: Tree, fragments: TreeFragment[] }>`. When `changes` are provided, `TreeFragment.applyChanges()` enables incremental parsing. Without changes (cold parse or language change), a full parse is performed.

**Span extraction (`extractAndSendSpans`):** Builds the line-offset table via a single `charCodeAt(i) === 10` scan into the reusable `_workerLineOffsets: Uint32Array` (sentinel `text.length + 1`). `highlightTree(tree, STYLE_HIGHLIGHTER, callback)` walks the Lezer `Tree`; the callback recovers the S int with `+classes | 0` (no `TAG_STYLE_INDEX` lookup) and stores `[lineIdx, from, to, style]` quads into a flat `_hlBuf` (zero object allocation). Sequential cursor scan packs each line's triples into `_workerSpanData` (reusable growing `Uint16Array`) via `writePackedTriples`. The used prefix is sliced into a fresh `Uint16Array` for transfer — `_workerSpanData` itself stays warm.

**Zero-copy transfer:** Worker transfers two ArrayBuffers in one `postMessage(..., [spanData.buffer, spanLineStart.buffer])`. Main thread `applyWorkerSpans` swaps `entry.spans.spanData` / `spanLineStart` refs directly.

**Protocol:**
```
Main → Worker: { type:'parse', id, text, language, version, changes? }
Main → Worker: { type:'remove', id }
Main → Worker: { type:'clearAll' }                    (broadcast to ALL workers)
Worker → Main: { type:'spans', id, version, spanData: Uint16Array, spanLineStart: Uint32Array }
```

**Language → Parser mapping:**
- `'python'` → `@lezer/python`
- `'typescript'` → `@lezer/javascript` configured with `dialect: 'ts jsx'` (cached)
- `'javascript'` (default) → `@lezer/javascript` configured with `dialect: 'jsx'` (cached)

**Worker bundle hygiene.** `code-tokens.ts` and `code-syntax-rules.ts` both import `code-system.ts` only as `import type { CodeSpans }` (or not at all) — value imports are forbidden. A static value import would chain `code-tokens → code-system → @/renderer/RenderLoop → @/core/image/image-manager`, dragging the main-thread bundle into the worker; `image-manager.ts` has top-level `new Worker(...)` (would spawn 2 nested image workers per lezer worker on module load) and `window.addEventListener(...)` (throws in worker context), aborting the worker's module-load before `onmessage` is installed and silently dropping every parse request. `@lezer/highlight` (used by `code-syntax-rules.ts` for `STYLE_HIGHLIGHTER`) is already in the worker bundle — no new pull. The cap helpers (`ensureSpansDataCap` / `ensureSpansLineCap`) live in `code-tokens.ts` to keep this chain broken. `w.onerror` / `w.onmessageerror` handlers in `ensureWorkers` surface any future module-load regression instead of failing silently.

---

## Cache (`CodeSystemCache`)

Singleton `codeSystem`. Per-object `CacheEntry` — four pooled SOA buffers:

```typescript
interface CacheEntry {
  source: CodeSource;           // pooled — slots overwritten per content change
  spans: CodeSpans;             // pooled — flat buffer, grows only (worker upgrade swaps refs)
  layout: CodeLayout;           // pooled — in-place reflow
  output: CodeOutput;           // pooled — rebuilt on output change

  version: number;              // Monotonic, incremented on content or language change
  language: CodeLanguage;
  frame: FrameTuple | null;     // Derived, set by computeCodeBBox

  layoutFontSize: number;       // Cache key
  layoutWidth: number;          // Cache key
  layoutLineNumbers: boolean;   // Cache key
  layoutValid: boolean;         // false = needs recompute (set on content change)
}
```

### Invalidation Rules

| Trigger | What changes | Layout | Frame | Version |
|---------|-------------|--------|-------|---------|
| `handleContentChange` | Source rebuilt, spans re-tokenized in place | invalidated (`layoutValid=false`) | nulled | incremented |
| `applyWorkerSpans` | `spans.spanData` / `spanLineStart` refs swapped (colors only); viewport-culls before invalidation | unchanged | unchanged | checked (must match) |
| fontSize/width/lineNumbers change (detected in `getLayout`) | — | reflowed in place | nulled | unchanged |
| Language change (detected in `getLayout`) | Spans re-tokenized in place | **preserved** if dims unchanged | preserved | incremented |

`applyWorkerSpans` does NOT touch the layout — only span colors change. It viewport-culls before invalidating: the cached frame is intersected with `getVisibleBoundsTuple()` (shared scratch tuple from camera-store, no allocation) and only emits `invalidateWorldBBox([fx, fy, fx+fw, fy+fh])` if the block overlaps the visible viewport. Off-screen blocks (remote edits while panned far away, or freshly-mounted blocks deep in a long doc) skip the invalidation entirely — saves dirty-rect bookkeeping plus a redundant repaint of an empty rect. Floors `e.spans.spanCap = Math.max(spanData.length, 48)` so an empty-content response (`spanData.length === 0`) doesn't trip `ensureSpansDataCap`'s `cap *= 2` doubling loop on the next sync-tokenize grow; `ensureSpansDataCap` separately floors `cap = Math.max(s.spanCap, 16)` for defense-in-depth.

**Language change optimization:** Language affects only colors, not geometry. Re-tokenize spans + dispatch worker parse, but do NOT recompute layout unless fontSize/width also changed.

### Public API

| Method | Called by | Purpose |
|--------|-----------|---------|
| `layoutCodeSourceInto(source, fontSize, width, lineNumbers, out)` | SelectTool reflow (`reflowCode`) | In-place layout into a pooled `CodeLayout` buffer |
| `getLayout(id, yText, fontSize, width, lang, lineNumbers?)` | `computeCodeBBox`, `drawCode` | Build or return cached layout; handles cold miss, language change, relayout |
| `handleContentChange(id, ev, lang)` | Deep observer | Rebuild source + sync-tokenize + dispatch worker parse with delta changes |
| `applyWorkerSpans(id, spanData, spanLineStart, forVersion)` | Worker response handler | Version-gated span ref-swap; viewport-culls before invalidate |
| `getSpans(id)` | `drawCode` in objects.ts | Get `CodeSpans` for renderer (flat triples) |
| `getSource(id)` / `getCodeSource(id)` | `drawCode`, transform freeze | Get `CodeSource` for renderer / E/W reflow |
| `getOutputCache(id, output)` | `drawCode`, `computeCodeBBox` | Identity-checked rebuild of `CodeOutput` line offsets |
| `getFrame(id)` / `setFrame(id, frame)` | Hit testing, selection, bbox | Read/write cached frame |
| `evict(id)` / `clear()` | Deletion / room change | Cleanup entries + notify workers |

---

## Canvas Renderer (`renderCodeLayout`)

Signature: `renderCodeLayout(ctx, layout, originX, originY, fontSize, spans, source, title?, output?, outputCache?)`

`title` and `output` are optional: `undefined` = section hidden, present string = section visible. Callers in `objects.ts` build these from `headerVisible`/`outputVisible` props and forward `entry.output` as `outputCache`.

Zero-allocation span iteration — no intermediate objects. Steps:

1. **Background:** `roundRect` fill with `THEME.chrome.bg`, `borderRadius(fontSize)`. Height = `blockHeight(...)` (includes chrome when present, uses `outputCache` for line count when provided)
2. **Separator helper (`drawSep`):** Pixel-snapped hairline — reads `ctx.getTransform()`, converts Y to device coords via `Math.round()`, draws exactly `dpr` device pixels (= 1 CSS pixel) with `resetTransform()` and `THEME.chrome.sep` fill. Prevents sub-pixel anti-aliasing from halving apparent separator opacity
3. **Header bar** (when `title !== undefined`): Separator at `originY + headerBarHeight(fs)`. Title text (`THEME.chrome.title`) at chrome font size, vertically centered. Play button: `THEME.chrome.playBg` circle + `THEME.chrome.playGreen` triangle (geometry from `playButtonGeom(fs)`, centroid-balanced via `triXOffset = triW/3`), right-aligned
4. **Code content:** All lines offset down by `headerBarHeight(fs)` when header present (`codeTop = originY + hh`)
5. **Per visual line:** Compute `baseY = codeTop + padTop + i * lineHeight + baselineOffset`. Read `srcIdx = vlSrcIdx[i]`, `vFrom = vlFrom[i]`, `vTo = vFrom + vlLen[i]` from the SOA layout
6. **Gutter:** When `layout.lineNumbers` is true and `vlFrom[i] === 0`, right-align line number within gutter area (`THEME.chrome.gutter`). Skipped entirely when lineNumbers is false
7. **Code text:** Iterate flat span triples in `[spanLineStart[srcIdx], spanLineStart[srcIdx+1])` with inline `[vFrom, vTo)` clipping. `ctx.font = normalFont` is hoisted once before the visual-line loop (Sweet Dracula has no bold tokens, so the prior per-span bold/normal branch is gone — chrome blocks set `chromeFont` explicitly above/below the loop). **Whitespace skip:** if `style === S.WHITESPACE`, advance `x` by `drawLen * cw` and continue — single compare-and-branch on a value already in a register, no fillStyle set, no fillText. Otherwise, `THEME.palette[style]` for color, `fullText.substring(lineStartChar + drawFrom, lineStartChar + drawTo)` for fillText (V8 SlicedString — single allocation per painted span)
8. **Batching:** Font and fillStyle only set on change (`prevFont` tracking)
9. **Placeholder:** After the loop, if `source.lineCount === 1 && source.fullText.length === 0`, draw grey "Type something..." at first line position
10. **Output panel** (when `output !== undefined`): Separator at code bottom. "Output" label at chrome font size, vertically centered. Output text lines (max `MAX_OUTPUT_CANVAS_LINES`) iterated via `outputCache.lineStart`. Callers (`drawCode` + scale paths in `objects.ts`, `computeCodeBBox`) always pass an eagerly-built `outputCache` when output is shown, so the renderer has no fallback branch.

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

`setCSSVars()` writes layout AND chrome color vars as exact px / hex on the container. Layout vars are set at mount and on every `positionEditor()` call (depend on zoom + `lineNumbers`); chrome color vars come from `THEME.chrome.*` and are written alongside them so a future theme swap picks up the CSS side automatically. The CM theme references the layout vars instead of `em` units (avoiding browser em→px rounding); `index.css` rules read the chrome vars with hex fallbacks identical to today's literals.

**Layout — lineNumbers ON (default):**
| CSS var | Value | Used by |
|---------|-------|---------|
| `--c-pt` | `padTop(fs) * scale` px | `.cm-scroller` paddingTop |
| `--c-pb` | `padBottom(fs) * scale` px | `.cm-scroller` paddingBottom |
| `--c-gl` | `padLeft(fs) * scale` px | `.cm-gutters` paddingLeft |
| `--c-gr` | `gutterPad(fs) * scale` px | `.cm-line` padding-left (gutter-to-content gap) |
| `--c-pr` | `padRight(fs) * scale` px | `.cm-line` padding-right |
| `--c-gw` | `2 * charWidth(fs) * scale` px | `.cm-gutterElement` minWidth |
| `--c-btn-size` | `fs * scale` px | `.code-run-btn` width + height (circle diameter = `fs`) |
| `--c-tri-w` | `playButtonGeom(fs).triW * scale` px | `.code-run-btn > svg` width + centroid horizontal offset |
| `--c-tri-h` | `playButtonGeom(fs).triH * scale` px | `.code-run-btn > svg` height + centroid vertical offset |

**Layout — lineNumbers OFF:** `--c-gl` = `0px`, `--c-gw` = `0px`, `--c-gr` = `padLeft(fs) * scale` px (provides block left indent via `.cm-line` padding since CM removes `.cm-gutters` entirely when the `lineNumbers` extension is absent).

**Chrome colors (from `THEME.chrome.*`):**
| CSS var | Source | Used by |
|---------|--------|---------|
| `--c-bg` | `THEME.chrome.bg` | `.code-editor` background |
| `--c-sep` | `THEME.chrome.sep` | `.code-header` border-bottom |
| `--c-title` | `THEME.chrome.title` | `.code-title` color |
| `--c-caret` | `THEME.chrome.caret` | `.code-title` caret-color |
| `--c-placeholder` | `THEME.chrome.placeholder` | `.code-title::placeholder` |
| `--c-output-label` | `THEME.chrome.outputLabel` | `.code-output-label` color |
| `--c-output-text` | `THEME.chrome.outputText` | `.code-output-text` color |

### Padding Placement: Scroller, Not Content

Vertical padding (`--c-pt`, `--c-pb`) is on `.cm-scroller`, not `.cm-content`. CM's `viewState.measure()` reads `contentDOM` padding with `parseInt()`, which truncates fractional px values, causing gutter-content vertical misalignment. Placing padding on the scroller avoids this.

### Gutter-Content Gap: Line, Not Gutters

The gutter-to-content gap (`--c-gr`, `gutterPad`) is applied as `padding-left` on `.cm-line`, not as `padding-right` on `.cm-gutters` or `.cm-gutterElement`. CM6's base theme sets `box-sizing: border-box` on `.cm-gutterElement`, which absorbs padding into the element's box without propagating it to push `.cm-content` rightward. Placing the gap on `.cm-line` ensures correct alignment AND makes `.cm-activeLine` background cover the gap area seamlessly (no highlight discontinuity between gutter and content).

### `positionEditor()`

Called on every zoom/pan change (`onViewChange()`). Updates ALL dimensional properties (position, width, fontSize, lineHeight, borderRadius, CSS vars) + header div (height, padding, title font size) + output div (font size, padding, separator margins, label height, text maxHeight/lineHeight) + calls `editorView.requestMeasure()` to trigger CM relayout.

### CSS (index.css)

```css
.code-editor {
  pointer-events: auto; z-index: 1000; overflow: hidden;
  background: var(--c-bg, #060521);
}
.code-editor .cm-editor { height: auto; border-radius: inherit; outline: none; }
.code-editor .cm-scroller {
  font-family: 'JetBrains Mono', monospace;
  overflow-y: auto; overflow-x: hidden;
  line-height: inherit !important;  /* Override CM base theme's 1.4 */
}

/* Header/output chrome — colors via --c-* with hex fallbacks. */
.code-header {
  display: flex; align-items: center; box-sizing: border-box;
  border-bottom: 1px solid var(--c-sep, rgba(255,255,255,0.125));
}
.code-title {
  background: transparent; border: none; outline: none;
  color: var(--c-title, #aeaeae);
  caret-color: var(--c-caret, #ffffffa6);
  font-family: 'JetBrains Mono', monospace; flex: 1; min-width: 0; padding: 0;
}
.code-title::placeholder { color: var(--c-placeholder, #e0e0e060); }
.code-run-btn {
  flex-shrink: 0; border: none; padding: 0; position: relative;
  border-radius: 50%; pointer-events: none;
  width: var(--c-btn-size); height: var(--c-btn-size);
}
.code-run-btn > svg {
  /* SVG is absolute-positioned (NOT flex-centered) so the triangle's centroid
     — which sits at triW/3, not triW/2 — lands on the button center. */
  position: absolute;
  left: calc(50% - var(--c-tri-w) / 3);
  top:  calc(50% - var(--c-tri-h) / 2);
  width: var(--c-tri-w); height: var(--c-tri-h);
}
.code-output { font-family: 'JetBrains Mono', monospace; overflow: hidden; box-sizing: border-box; }
.code-output-label { color: var(--c-output-label, #e0e0e090); font-weight: 450; }
.code-output-text { color: var(--c-output-text, #aeaeae); white-space: pre-wrap; word-break: break-all; overflow-y: auto; }
```

The `line-height: inherit !important` forces the scroller to use the container's explicit px line-height instead of CM's base theme value of `1.4`, which fights the code system's `1.5` multiplier at identical specificity.

All dynamic chrome sizing (fontSize, padding, height, lineHeight) is set via inline styles in CodeTool, not CSS — matches the screen-space rendering model where everything is `world * scale` in exact px.

---

## CodeMirror Extensions

Lazy-loaded via `getCodeMirrorExtensions()` (cached after first call). Two extensions:

1. **Theme** (`EditorView.theme`, dark mode): chrome reads `THEME.chrome.*` (background, gutter, selection, active line, caret, nonmatching bracket, search match, tooltip, fold placeholder, placeholder hint). Matching brackets are editor-only UI (independent of THEME / Lezer): transparent fill + subtle `1px solid #ffffff4d` outline via `&.cm-focused .cm-matchingBracket` (must match CM baseTheme's selector specificity to override its teal film). All padding/sizing via `var(--c-*)`. Line-height set as the `LINE_HEIGHT_MULT` ratio on `.cm-scroller`. Gutter elements use `fontFeatureSettings: '"tnum"'` for tabular numbers.

2. **Syntax highlighting** (`HighlightStyle.define`): derived from `SYNTAX_RULES` (`code-syntax-rules.ts`) + `THEME.palette` — one declarative table feeds both this CM rule list AND the worker's `STYLE_HIGHLIGHTER`. Tags grouped by semantic role: control keywords → `S.KEYWORD`, definer kws → `S.STORAGE`, module/modifier → `S.MODIFIER`, decorators / self → `S.LANG_VAR`, strings (string, special, regexp, character) → `S.STRING`, escapes → `S.OPERATOR`, numbers (integer, float, bool, null, atom), comments (line, block, doc), function defs (`function(definition(variableName))`, `className`, `definition(typeName)`) → `S.FUNCTION_DEF`, property-key definitions (`definition(propertyName)`) → `S.DEFAULT` (white — overrides base `propertyName` → TYPE for obj keys, class fields, methods), function calls (`function(variableName)`, `function(propertyName)`) → `S.FUNCTION_CALL`, types/properties → `S.TYPE`, JSX tagName + angleBracket → `S.KEYWORD`, operator subtypes + derefs → `S.OPERATOR` (separators unmapped → DEFAULT), brackets → default, attributes, invalid.

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

Center-placed: `originX = clickX - width/2`, `originY = clickY - blockHeight/2` (includes `headerBarHeight` in centering when the header is visible). Default language: `typescript`. Width from `getDefaultWidth(fontSize)`. fontSize from `useDeviceUIStore.textSize`. `lineNumbers` from `useDeviceUIStore.codeLineNumbers`. `headerVisible` from `useDeviceUIStore.codeHeaderVisible` (persisted: toggling header in the context menu writes through to the store via the `HEADER_VISIBLE` field descriptor's `persist` hook, so the next new block honors the user's preference). `title: 'Untitled'` is committed at creation; `outputVisible: false`; `output` is NOT set (undefined).

### Editor Lifecycle — Atomic Mount

The async CM import window (~500ms cold) used to fall between `appendChild(container)` and the EditorView construction. Result: a visible flash of an empty container after the canvas had already suppressed its rendering. The atomic mount eliminates this:

**Mount (six phases):**
1. **Off-DOM build.** Create container, set screen-space dimensions + CSS vars, build header div (if `headerVisible`). Container is detached — code stays painted on the canvas, no flicker.
2. **Mark intent.** Set `pendingMountId = objectId`.
3. **Lazy CM imports.** `Promise.all` over CM modules (the only async window).
4. **Post-await abort check.** If `pendingMountId !== objectId` (re-entrancy: a newer `startEditing` overwrote it), or `getHandle(objectId)` is null/wrong-kind (deleted during the wait), drop the half-built container (still off-DOM, GC handles it) and return without mutating shared state.
5. **Build CM state + view.** Session UM, language compartment, line-numbers compartment, EditorState, `new EditorView({ state, parent: container })`. CM renders into the off-DOM container. Build output div if `outputVisible`.
6. **ATOMIC SWAP.** Single tick: `host.appendChild(container)` → `beginCodeEditing(objectId)` (canvas suppresses code, overlay clears handles) → assign `this.editorView` / `this.container` / `this.objectId`, clear `this.pendingMountId` → `invalidateOverlay()` + `invalidateWorldAll()`. From the user's perspective, in one frame: code disappears from canvas + handles disappear + DOM appears with fully rendered CM.
7. **Post-swap wiring.** Focus routing, syncConf extraction, main UM sealing, Y.Map observer, document-level handlers.

**Re-entrancy guard.** A second `startEditing` while one is pending overwrites `pendingMountId`. The earlier mount's post-await check then sees a stale id and bails. `commitAndClose` also clears `pendingMountId` so a programmatic close during the await window aborts the mount cleanly.

**Focus routing on mount:** If `pendingEntryWorld` Y < `origin[1] + headerBarHeight(fontSize)` AND header visible → focus title input. Else if entry world exists → focus CM, place cursor at click position via `posAtCoords()` in rAF. Else (new block) → focus CM.

**Close (`commitAndClose`):** `saveTitle()` → null `titleInput` (prevents blur re-entry during DOM removal) → remove event handlers → unseal main UM (captureTimeout → 500ms) → unobserve Y.Map → destroy EditorView → clear session UM → remove container from DOM → null all refs (including `pendingMountId`) → `endCodeEditing()` → invalidate world + overlay.

### Header DOM Lifecycle

`createHeaderDiv(container, y, fs, scale)`: Creates flex div with title input + play button. Title input reads `y.get('title') ?? "Untitled"` (uses `??` to preserve empty string). Play button: circle bg `#4ADE8035`, green triangle SVG `#4ADE80`, `pointer-events: none` (decorative). The button width/height and SVG geometry are driven entirely by `--c-btn-size` / `--c-tri-w` / `--c-tri-h` on the container — `createHeaderDiv` sets no inline sizes, so `setCSSVars` (called on every `positionEditor`) keeps the DOM SVG pixel-aligned with the canvas triangle at every zoom.

**Title input events:**
- **Blur:** Calls `saveTitle()` to persist
- **Enter:** `preventDefault()` + `blur()` — confirms title, editor stays mounted unfocused (no CM jump)
- **Escape:** `stopPropagation()` + `blur()` — prevents document-level close handler from firing

`saveTitle()`: Trims input. Empty string → stores `''` (deliberate clear, distinct from undefined). Non-empty and different from stored → sets title. No-op if unchanged.

**Visibility toggle:** `updateHeaderVisibility(y)` — creates/removes header div. On show, inserts before first child. On hide, removes div and nulls refs.

### Output DOM Lifecycle

`createOutputDiv(container, y, fs, scale)`: Creates div with separator (1px div, negative margins for full-width), label ("Output", explicit height = `fs * OUTPUT_LABEL_H_RATIO * scale`), text div (max height capped at `MAX_OUTPUT_CANVAS_LINES` lines). No CSS `border-top` — separator is a child div to match canvas `drawSep` exactly.

**Visibility toggle:** `updateOutputVisibility(y)` — creates/removes output div.

### Event Handlers

- **Escape key** (capture phase): Close editor
- **Click outside** (capture phase, 100ms delayed attach): Close editor. Clicks on `.ctx-menu` are excluded. Canvas clicks are consumed (`stopPropagation`) when code tool is active.

### UndoManager Integration

Two-level undo: per-session UM for in-editor Ctrl+Z/Y, main UM for post-close atomic undo. Same pattern as TextTool's `TextCollaboration` extension.

**Session UM:** `Y.UndoManager([yText, yMap], { trackedOrigins: new Set([userId]) })`. Scoped to both Y.Text (content) and Y.Map (properties). `yCollab()` auto-adds `syncConf` (YSyncConfig) as a tracked origin so local CM edits are captured. `yUndoManagerKeymap` provides explicit Mod-z/Mod-y/Mod-Shift-z bindings.

**Main UM sealing:** After EditorView creation, `syncConf` extracted via `view.state.facet(ySyncFacet)` and added to main UM's tracked origins. `captureTimeout` set to 600s so entire session merges into one undo item. On close, `syncConf` removed and `captureTimeout` restored to 500ms.

### Y.Map Observer — Live Property Sync

Registered after EditorView creation on `handle.y`. Listens for `keysChanged`:
- `fontSize`, `width`, `origin` → `positionEditor()`
- `language` → `switchLanguage()` (title is independent of language — no fallback rewrite)
- `lineNumbers` → `switchLineNumbers()` + `positionEditor()`
- `headerVisible` → `updateHeaderVisibility()` + `positionEditor()`
- `outputVisible` → `updateOutputVisibility()` + `positionEditor()`
- `title` → update input value if not focused (uses `??` for fallback — preserves empty string)
- `output` → `updateOutputContent()` (sets textDiv content)

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

The render-side scalar derivation is inlined at each call site (no wrapper). Keeps the hot path allocation-free:

```typescript
function drawCode(ctx, handle) {
  if (_codeEditingId === handle.id) return; // DOM overlay active
  const props = getCodeProps(handle.y);
  const layout = codeSystem.getLayout(id, props.content, props.fontSize, props.width, props.language, props.lineNumbers);
  const spans = codeSystem.getSpans(id);
  const source = codeSystem.getSource(id);
  if (!spans || !source) return;
  const title = props.headerVisible ? (props.title ?? 'Untitled') : undefined;
  const output = props.outputVisible ? (props.output ?? '') : undefined;
  const outputCache = output !== undefined ? (codeSystem.getOutputCache(id, output) ?? undefined) : undefined;
  renderCodeLayout(ctx, layout, props.origin[0], props.origin[1], props.fontSize, spans, source, title, output, outputCache);
}
```

Title/output args: `headerVisible` → `title` (undefined hides header, string shows it — the literal `'Untitled'` fallback covers legacy objects with `title: undefined`). `outputVisible` → `output` (undefined hides panel, string shows it). The scale-time render branches (`reflow` / `uniform`) inline the same six lines — no shared wrapper, zero per-frame object allocation. Output cache is always built when output is shown so the renderer's output branch has no fallback path.

Scale transform rendering: uniform (`drawScaledCodePreview`), reflow (`drawReflowedCodePreview`), edge-pin translate. Full transform behavior matrix in `tools/selection/CLAUDE.md`.

### selection-store.ts

`codeEditingId` gates DOM overlay vs canvas rendering. `CodeReflowState` stores per-object layouts + origins during E/W scale transforms. `SelectedStyles` includes `codeHeaderVisible`/`codeOutputVisible` for context menu toggles.

### SelectTool.ts — Code Block Integration

- **Translate:** via `origin` (same as text), not `frame`
- **Scale:** Uniform (corner/codeOnly N/S), reflow (E/W), edge-pin (mixed N/S) — see `tools/selection/CLAUDE.md`
- **Editing entry:** Double-click calls `codeTool.startEditing(id)` with `justClosedCodeId` guard
- **Guards:** `codeEditingId` blocks handle hit testing, hover cursors, hides resize handles

### hit-testing.ts

Code blocks are included in `ObjectKind` (`'code'`) and participate in spatial index queries. `hitTestVisibleCode()` in `hit-testing.ts` handles code block hit testing with Z-order occlusion (same pattern as `hitTestVisibleText`): spatial query → `testObjectHit` → Z-sort → occlusion scan. Code blocks always occlude (opaque bg); unfilled shape interiors are transparent.

---

### Context Menu — Header/Output Toggles

`CodeStyleGroup` in `ContextMenu.tsx` renders toggle buttons for line numbers, header, and output. `toggleCodeHeader()` and `toggleCodeOutput()` in `selection-actions.ts` read current state from first selected code object and toggle all selected code objects atomically.

---

## Known Issues / Not Yet Implemented

- **Long code blocks:** CM's internal viewport optimization causes WYSIWYG mismatch on very tall blocks (content outside CM's visible window is virtualized)
- **Play button:** Decorative only (`pointer-events: none`). No execution runtime
