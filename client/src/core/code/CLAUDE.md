# Code Block System

> **Maintenance:** Architectural overview, not a changelog. Source is canonical
> — keep this lean. Don't restate exhaustive tables (palette, CSS, sync↔Lezer
> rows) that live in `code-tokens.ts` / `code-theme.ts` / `index.css`.

Canvas-rendered code blocks with a CodeMirror DOM overlay for editing, two-tier
syntax highlighting (sync floor + Lezer worker ceiling), and Yjs collaborative
binding. Fully integrated with SelectTool (translate, scale, reflow,
double-click-to-edit).

## Files

| File | Role |
|------|------|
| `code-tokens.ts` | `S` enum (16 styles incl. `WHITESPACE` sentinel), `THEME` (palette + chrome — single source of truth for color), spans-buffer cap helpers (`ensureSpansDataCap` / `ensureSpansLineCap`), packed-triple writers (`countPackedTriples` / `writePackedTriples` / `packRunSpansInto`), length-bucketed keyword tables + `classifyIdent`, sizing ratios, char-code sync tokenizer (`syncTokenizeInto`), play-button geometry (`playButtonGeom`). **Imports `code-system.ts` as `type` only** — see bundle hygiene below |
| `code-system.ts` | SOA pipeline types (`CodeSource` / `CodeSpans` / `CodeLayout` / `CodeOutput`), pooled `CodeSystemCache`, `buildCodeSourceInto` / `layoutCodeSourceInto` / `ensureOutputCache`, canvas renderer (`renderCodeLayout` with header/output chrome), chrome height helpers, worker pool (2 warm workers, hash-routed), delta→ChangedRange, font metrics (derived from text-system) |
| `code-theme.ts` | CodeMirror theme + `HighlightStyle.define` rule list. All `@codemirror/*` AND `@lezer/highlight` imports are **dynamic** (inside `getCodeMirrorExtensions()`) — main bundle stays free of the editor stack |
| `lezer-worker.ts` | Web Worker. Per-object `Tree` + `TreeFragment` state, cached configured parsers, incremental parsing, custom `STYLE_HIGHLIGHTER` over its own `WORKER_RULES`, zero-copy ArrayBuffer transfer |
| `../../tools/CodeTool.ts` | PointerTool — click-to-place + hit-test + CodeMirror DOM overlay lifecycle + header/output chrome DOM |

## Y.Doc Schema

```typescript
{
  id, kind: 'code', ownerId, createdAt,
  origin: [number, number],   // Top-left world coords (NOT baseline, unlike text)
  content: Y.Text,            // Plain text (NOT Y.XmlFragment); deltas → Lezer ChangedRange
  language: 'javascript' | 'typescript' | 'python',
  fontSize: number,           // World units (default 14)
  width: number,              // World units, always stored (no 'auto')
  lineNumbers: boolean,       // Gutter visibility, collaborative (default true)
  title: string | undefined,  // undefined → "Untitled" fallback; '' → deliberate clear; 'Foo' → "Foo"
  headerVisible: boolean,     // Default true
  outputVisible: boolean,     // Default false
  output: string | undefined, // Execution output (no runtime yet)
}
```

No stored frame — derived via `getCodeFrame(id)` from
`code-system.ts`. Height = `blockHeight(layout, fs, headerVisible,
outputVisible, output)`. Title fallback uses `??` (not `||`) to preserve `''`.
Typed accessor: `getCodeProps(y)`.

## Architecture — SOA Pipeline

Four pooled buffers per id (`CacheEntry`); hot paths allocate zero.

```
Y.Text.toString()
    ↓ buildCodeSourceInto
CodeSource     fullText + Uint32Array lineStart (sentinel: text.length+1)
    ↓ syncTokenizeInto (sync floor) / lezer-worker (Lezer ceiling, transfer-swaps refs)
CodeSpans      flat Uint16Array spanData (triples [off, len, style]) + Uint32Array spanLineStart
    ↓ layoutCodeSourceInto
CodeLayout     parallel Uint32Arrays vlSrcIdx / vlFrom / vlLen + cached normalFont/chromeFont
    ↓
renderCodeLayout()    canvas
computeCodeBBox()     spatial index
```

`out?` parameters mirror text-system. Buffers grow (capacity-doubling), never
shrink. Per-pointermove allocations during E/W reflow: zero.

### Whitespace sentinel

`packRunSpansInto` scans gap-fill triples; pure space/tab runs stamp
`S.WHITESPACE` (15) into the style slot. The renderer's per-span branch is a
single `style === S.WHITESPACE` compare on a register-held value — no parallel
buffer, no extra cache line. `THEME.palette[S.WHITESPACE]` mirrors `DEFAULT` so
defensive blind reads return a defined value.

### Cached font strings

`CodeLayout.normalFont` / `chromeFont` are recomputed only when `fontSize`
changes (gated in `layoutCodeSourceInto`) — saves three template-string
allocations per render call.

### Frame & sizing

Origin-based top-left positioning (no shifted baseline). All padding/borders
are ratios of `fontSize` exposed by `code-system.ts`:
`padTop/padBottom/padLeft/padRight/gutterGap/borderRadius/lineHeight/charWidth/baselineOffset`.
`padLeft` is the single horizontal-pad constant (chrome left inset, gutter
internal indent, content left padding). `gutterGap` is the extra half-`fs` between
gutter and code (lines-on only), painted inside the gutter element so
`.cm-activeLineGutter` covers it continuously.

`charWidth(fs) = fs * getMinCharWidthRatio('JetBrains Mono')` — JetBrains Mono
is true monospace, so the bold-'W' measurement matches any-weight any-glyph
advance. `baselineOffset` uses the CSS half-leading formula with code's 1.5
line-height.

`contentLeft(digits, fs, lineNumbers)`:
- ON  → `padLeft + gutterWidth + gutterGap + padLeft`
- OFF → `padLeft` (CM removes `.cm-gutters` entirely)

## Two-Tier Tokenization

```
Y.Text change
    → deep observer fires sync
    → codeSystem.handleContentChange(id, ev, lang)
        → buildCodeSourceInto + syncTokenizeInto (sync floor — instant color)
        → version++, layoutValid=false, frame=null
        → deltaToChangedRanges → dispatch worker (hash-routed)
    → same frame: getLayout() reflows in place + canvas paint
    → next frame (typical): worker responds → applyWorkerSpans (Lezer ceiling)
```

**Sync tokenizer** (`syncTokenizeInto`): char-code, allocation-free. Iterates
`source.fullText` with absolute offsets, pushes line-relative triples to a
pooled `_syncBuf`, then `packRunSpansInto` writes flat triples per line. Two
pieces of function-local state across the whole pass:
- `lastDefIsFunc` — set by definer kw (`function`/`class`/`def`/`type`/
  `interface`/`enum`, via the kw table's `definesNext` flag). Next ident
  consumes it and renders as `S.FUNCTION_DEF`. Persists across whitespace/comments.
- `lastSignificantChar` — last non-ws non-comment char code, drives `obj.foo`
  → `S.TYPE` classification.

Out of scope (needs AST): JSX HTML/Component split, regex-delimiter split,
parameter vs variable, destructured aliases.

**Lezer worker pool**: 2 warm workers, hash-routed by `id.charCodeAt(id.length
- 1) % 2` so the same object always lands on the same worker (preserves
incremental parse trees). Per-object `{ tree, fragments }`; if `changes` are
provided, `TreeFragment.applyChanges` enables incremental parsing.

**Span extraction**: `highlightTree(tree, STYLE_HIGHLIGHTER, callback)` walks
the tree. `STYLE_HIGHLIGHTER.style()` returns the stringified `S` int directly
(no `TAG_STYLE_INDEX` lookup); callback recovers via `+classes | 0`. Highlights
collected into a flat `_hlBuf` quad buffer, then a sequential cursor scan packs
per-line triples via `writePackedTriples` into the reusable `_workerSpanData`.
Used prefix is sliced into a fresh `Uint16Array` for transfer — main thread
swaps refs zero-copy.

**Language → parser**: `python` → `@lezer/python`; `typescript` →
`@lezer/javascript` configured with `dialect: 'ts jsx'`; `javascript` →
`@lezer/javascript` configured with `dialect: 'jsx'`. Both configured parsers
cached at worker startup.

### Sync ↔ Lezer alignment

The sync tokenizer's classifications match the worker's tag output so there is
no color flip when the parse arrives. Keyword tables bake reclassifications
at build time:
- `true` / `false` / `null` / `True` / `False` / `None` → `S.NUMBER`
- `this` / `super` / `self` → `S.LANG_VAR`
- `function` / `class` / `def` / `type` / `interface` / `enum` →
  `S.STORAGE` with `definesNext: true`

Acceptable flickers (sync emits one color → Lezer corrects ~1 frame later):
`{ method() {} }` shorthand (sync green → Lezer white), `const foo =
function() {}` (sync white → Lezer green). Over-painting alternatives would be
worse.

## Theme

Single source of truth: `THEME` in `code-tokens.ts` — `palette[S]` for token
colors and `chrome.{bg,gutter,selection,lineHl,caret,nonmatchBracket,searchMatch,
sep,title,playGreen,playBg,outputLabel,outputText,placeholder}` for chrome.
Current theme: CoolGlow chrome (deep blue/purple) + Sweet Dracula palette.
Color-only emphasis — no bold, no italic. Theme swap = change `CODE_THEME`
export + invalidate.

Three consumers read from `THEME`: the canvas renderer (`THEME.palette[style]`
+ `THEME.chrome.*`), the CM theme (`code-theme.ts` reads `THEME.chrome.*`
directly), and `CodeTool.setCSSVars` (writes the chrome subset as CSS custom
properties — see below).

### Lezer-tag → S mapping (two copies, intentional)

The mapping is duplicated between `code-theme.ts` (passed to
`HighlightStyle.define`) and `lezer-worker.ts` (`WORKER_RULES` → custom
`STYLE_HIGHLIGHTER`). **Reason:** keeps `@lezer/highlight` (and its
`Modifier`/`Tag` machinery, ~30–40 kB) out of the main bundle. A shared file
would force a static import somewhere it'd bleed in. **Invariant:** the two
rule tables MUST stay in sync — same row order, same tag groupings, so a diff
is trivial. Modifier-set walk semantics (`definition` < `function` Modifier.id)
must be preserved: that's how `definition(propertyName)` → `S.DEFAULT` wins
over `function(propertyName)` → `S.FUNCTION_CALL` for one row covering
obj-literal keys, class fields, method shorthand, and class methods.

## Canvas Renderer (`renderCodeLayout`)

Signature: `renderCodeLayout(ctx, layout, originX, originY, fontSize, spans,
source, title?, output?, outputCache?)`. `title`/`output` undefined hides the
respective chrome section; present string shows it. Callers (`drawCode` +
scale-time paths in `objects.ts`) eagerly build `outputCache` so the renderer
has no fallback branch.

Hot path: hoists `ctx.font = normalFont` once before the visual-line loop (no
per-span bold/normal switch — color-only theme), reads `THEME.palette[style]`
per span, calls `fullText.substring(absFrom, absTo)` for fillText (V8
SlicedString — only unavoidable alloc per painted span). Whitespace branch
advances `x` and `continue`s — no fillStyle set, no fillText.

`drawSep(y)` reads `ctx.getTransform()`, rounds to device pixels, and draws
exactly `dpr` device pixels with `resetTransform()` — prevents sub-pixel
antialiasing from halving apparent separator opacity.

Play button is centroid-balanced: `triX = btnCx - triXOffset` with
`triXOffset = triW/3` (NOT `triW/2`) so the triangle's geometric centroid lands
on the button center. The DOM SVG mirrors this via `left: calc(50% -
var(--c-tri-w) / 3)` — keep in sync. Single source of truth:
`playButtonGeom(fontSize)`.

## Cache (`CodeSystemCache`)

Singleton `codeSystem`. Per-object `CacheEntry` carries the four pooled SOA
buffers, plus version + language + frame + layout cache keys.

### Invalidation rules

| Trigger | Source/Spans | Layout | Frame | Version |
|---------|--------------|--------|-------|---------|
| `handleContentChange` | rebuilt in place | invalidated | nulled | ++ |
| `applyWorkerSpans` (version match) | refs swapped (colors only) | unchanged | unchanged | unchanged |
| fontSize/width/lineNumbers change (in `getLayout`) | — | reflowed in place | nulled | unchanged |
| Language change (in `getLayout`) | re-tokenized in place | **preserved** if dims unchanged | preserved | ++ |

`applyWorkerSpans` is version-gated (discard stale). It **viewport-culls**
before invalidating: intersects `e.frame` with `getVisibleBoundsTuple()` (shared
scratch tuple) — off-screen blocks (remote edits while panned away) skip the
dirty rect entirely; the next pan/zoom into view repaints from scratch. Floors
`spanCap = max(spanData.length, 48)` so an empty-content response can't trip
`ensureSpansDataCap`'s `cap *= 2` loop. Belt-and-suspenders: `ensureSpansDataCap`
itself floors `cap = max(s.spanCap, 16)`.

### Public API

| Method | Purpose |
|--------|---------|
| `getLayout(id, yText, fontSize, width, lang, lineNumbers?)` | Cold-miss builds full entry + dispatches worker; otherwise returns cached layout (handles language/dims change) |
| `handleContentChange(id, ev, lang)` | Called by deep observer on Y.Text change |
| `applyWorkerSpans(id, spanData, spanLineStart, forVersion)` | Worker response, viewport-cull invalidate |
| `getSpans(id)` / `getSource(id)` / `getOutputCache(id, output)` | Renderer accessors |
| `getFrame(id)` / `setFrame(id, frame)` | Hit testing / selection / bbox |
| `evict(id)` / `clear()` | Deletion / room change |

Helpers exported from `code-system.ts` and consumed externally: `getCodeFrame`,
`getCodeSource`, `computeCodeBBox`, `terminateCodeWorkers` (kills the warm pool on room teardown — see Integration).

## DOM Editor (CodeTool)

Screen-space rendering: all dimensions = `world * scale` in exact px. No `CSS
transform: scale()` (causes blurriness) and no `em` units in CM's theme
(browser em→px rounding mismatches canvas). Position via
`worldToClient(origin)` → `left/top`.

### CSS custom properties (`--c-*`)

`setCSSVars(container, fontSize, scale, lineNumbers)` writes layout vars and
chrome color vars on the container. `index.css` rules read each with a hex
fallback so partially-themed elements degrade gracefully.

| Var | Source | Used by |
|-----|--------|---------|
| `--c-pt` / `--c-pb` | `padTop/padBottom(fs) * scale` | `.cm-scroller` paddingTop/Bottom |
| `--c-pr` | `padRight(fs) * scale` | `.cm-line` padding-right |
| `--c-cl` | `padLeft(fs) * scale` | `.cm-line` padding-left |
| `--c-gi` | `padLeft(fs) * scale` | `.cm-gutterElement` padding-left (lines-on only) |
| `--c-gg` | `gutterGap(fs) * scale` | `.cm-gutterElement` padding-right (lines-on only) |
| `--c-gw` | `2 * charWidth(fs) * scale` | `.cm-gutterElement` min-width content area |
| `--c-btn-size` | `fs * scale` | `.code-run-btn` width/height |
| `--c-tri-w` / `--c-tri-h` | `playButtonGeom(fs) * scale` | `.code-run-btn > svg` width/height + centroid offset |
| `--c-bg` / `--c-sep` / `--c-title` / `--c-caret` / `--c-placeholder` / `--c-output-label` / `--c-output-text` | `THEME.chrome.*` | `.code-editor` + chrome elements |

`--c-gi` / `--c-gw` / `--c-gg` are removed when `lineNumbers=false` (CM strips
`.cm-gutters`). `--c-cl` stays — content padding always applies.

**Padding placement.** Vertical padding lives on `.cm-scroller`, NOT
`.cm-content` — CM's `viewState.measure()` reads contentDOM padding with
`parseInt()`, truncating fractional px and breaking gutter alignment.

**Active-line continuity.** `.cm-gutterElement` and `.cm-line` both
`box-sizing: border-box`, so their backgrounds cover their own
padding-paint regions. `.cm-activeLineGutter` and `.cm-activeLine` highlights
extend to the block edges without negative-margin tricks.

### Matching-bracket selector

`bracketMatching()` decoration must use `&.cm-focused .cm-matchingBracket`
(and `.cm-nonmatchingBracket`) — `@codemirror/language`'s baseTheme paints a
teal film via that exact higher-specificity selector during focus; plain
`.cm-matchingBracket` loses and the film stays.

### Mount lifecycle (atomic)

The async CM import window (~500ms cold) used to fall between
`appendChild(container)` and `new EditorView(...)`, flashing an empty
container. The mount is now atomic:

1. Build container off-DOM (set dimensions, CSS vars, optionally header div). These dimensions are **provisional scaffolding** — a pre-await snapshot CM builds into, never the authoritative on-screen geometry (see step 6).
2. Mark intent: `pendingMountId = objectId`.
3. `Promise.all` over `@codemirror/*` + `getCodeMirrorExtensions()` (the only async window).
4. **Abort check:** if `pendingMountId !== objectId` (re-entrant `startEditing`) or `getHandle(objectId)` is null/wrong-kind (deleted during wait), drop the half-built container and return.
5. Build CM state + view; CM renders into the still-off-DOM container.
6. **Atomic swap** (single tick, no paint between statements): `host.appendChild(container)` → set instance refs → **`positionEditor()`** → `beginCodeEditing(id)` → invalidate. The `positionEditor()` call is load-bearing: it re-derives left/top/width/fontSize/CSS-vars/header/output from the **live** camera + props, because a zoom/pan during the async window (or a remote geometry edit) would otherwise leave the step-1 snapshot stale exactly when the canvas stops painting this id — the editor would freeze at the old transform for the handoff frame while the canvas repaints neighbors at the new one. It runs post-`appendChild` so `requestMeasure()` measures an attached element.
7. Post-swap wiring: focus routing, syncConf extraction, main UM sealing, Y.Map observer, document-level event handlers. Focus routing's `posAtCoords` maps the entry click through a **live** `worldToClient` read *inside* its rAF (not a pre-await snapshot) so the caret lands correctly if the camera moved during/after the swap.

`commitAndClose` also clears `pendingMountId` so a programmatic close during
the await window aborts the mount cleanly.

**Geometry invariant:** `positionEditor()` is the *single* authority for the
editor's on-screen geometry. It runs once at the atomic swap (step 6) and again
on every `onViewChange` (camera move) and every geometry-affecting Y.Map key
change while editing. Nothing else establishes user-visible position/size —
PHASE 1 only scaffolds CM's off-DOM build.

**Focus routing on mount:** click in header region (Y < `origin[1] +
headerBarHeight`) → focus title input. Else `pendingEntryWorld` → focus CM and
place cursor at click via `posAtCoords()` in rAF. Else new block → focus CM at
end.

### Y.Map observer (live sync)

`fontSize` / `width` / `origin` → `positionEditor()`. `language` →
`switchLanguage()` (lazy lang-pack import). `lineNumbers` →
`switchLineNumbers()` + `positionEditor()`. `headerVisible` /
`outputVisible` → create/remove chrome div + reposition. `title` → update
input value if not focused (uses `??`). `output` → update text content.

### Editor State extensions

`lineNumbers()` in `Compartment` (padded with spaces to match canvas digit
reservation; `[]` when off), `highlightActiveLine` + `highlightActiveLineGutter`,
`EditorView.lineWrapping`, `bracketMatching`, `closeBrackets`,
language-extension in `Compartment` (`python()` or `javascript({ typescript:
true, jsx: true })`), `indentUnit.of('    ')`, custom Backspace-at-4-space
keymap, `closeBracketsKeymap`, `indentWithTab`, `yUndoManagerKeymap`,
`yCollab(yText, null, { undoManager: sessionUM })`, `placeholder('Type
something...')`, theme exts, and a transactionFilter that replaces `\t` with 4
spaces in all insertions.

### UndoManager (two-level)

**Session UM** — `Y.UndoManager([yText, yMap], { trackedOrigins: new
Set([userId]), captureTimeout: 500 })`. Scoped to both content and props. After
view construction, `syncConf = view.state.facet(ySyncFacet)` is added as a
tracked origin so local CM edits get captured. `yUndoManagerKeymap` provides
Mod-z/Mod-y/Mod-Shift-z.

**Main UM sealing** — `syncConf` added to main UM's tracked origins;
`captureTimeout` set to 600s so the entire editing session merges into one
atomic undo item post-close. On close, `syncConf` removed and `captureTimeout`
restored to 500ms.

`commitAndClose` does NOT manually null the EditorView's internal fields —
CM's `destroy()` schedules a final blur-notification `setTimeout` that reads
`view.observer.notifiedFocused`; pre-emptive nulling races that timeout and
throws.

## Bundle Hygiene (critical invariants)

- **`code-tokens.ts` imports `code-system.ts` as `type` only**. A value import
  would chain `code-tokens → code-system → RenderLoop → image-manager`,
  dragging image-manager's top-level `window.addEventListener(...)` into
  the lezer worker — module-load aborts before `onmessage` is installed and
  parse requests silently drop. The spans cap helpers
  (`ensureSpansDataCap` / `ensureSpansLineCap`) live in `code-tokens.ts`
  specifically to keep this chain broken. `w.onerror` / `w.onmessageerror`
  surface any regression.
- **`code-theme.ts` has NO top-level `@codemirror/*` or `@lezer/highlight`
  imports** — everything is inside the async `getCodeMirrorExtensions()`.
  Static imports here bleed `Modifier`/`TagName`/`Tag` into the main bundle
  (~30–40 kB). Verify with `grep -l "Modifier\|TagName" dist/assets/main-*.js`
  after each build.
- **Rule tables duplicated, deliberately** (`code-theme.ts` rule list +
  `lezer-worker.ts` `WORKER_RULES`) — see "Lezer-tag → S mapping" above.

## Integration

**`room-doc-manager.ts`** deep observer: code-kind Y.Text events route to
`codeSystem.handleContentChange(id, ev, lang)`. `computeCodeBBox(id, yObj)` is
called for code in hydration and incremental update paths. Object deletion →
`codeSystem.evict(id)`. Room change → `codeSystem.clear()` (broadcasts to
ALL workers). Room teardown (`RoomDocManager.destroy()`) additionally calls
`terminateCodeWorkers()` — the lazy pool is killed and re-created on demand in
the next room (kept out of `clearAllObjectCaches()`, which also runs on hydrate).

**`renderer/object-cache.ts`** dispatches `code` to `codeSystem.evict` and
`clearAllObjectCaches` to `codeSystem.clear`.

**`renderer/layers/objects.ts`** dispatches `drawCode(ctx, handle)` (skips
when `_codeEditingId === id`) and renders scale entries — `reflow` /
`uniform` / `edge-pin translate` (full matrix in `tools/selection/CLAUDE.md`).

**`selection-store.ts`**: `codeEditingId` gates DOM overlay vs canvas
rendering. `CodeReflowState` stores per-object pooled layouts + origins for
E/W scale. `SelectedStyles` includes `codeHeaderVisible` / `codeOutputVisible`
for the context menu.

**`SelectTool.ts`**: translate via `origin`. Scale: uniform (corner / codeOnly
N/S), reflow (E/W), edge-pin (mixed N/S). Double-click →
`codeTool.startEditing(id, entryWorld)` with `justClosedCodeId` guard.

**Context menu** (`CodeStyleGroup` in `ContextMenu.tsx`):
`toggleCodeLineNumbers`, `toggleCodeHeader`, `toggleCodeOutput` —
context-menu actions wired through field descriptors in
`selection-actions.ts`.

**Hit testing** (`pickTopmostOfKind`/`hitTestVisibleText` pattern in
`object-query.ts`): code blocks always occlude (opaque bg) and participate
normally in spatial-index queries.

## Known Issues

- **Long code blocks:** CM's internal viewport optimization causes WYSIWYG
  mismatch on very tall blocks (content outside CM's visible window is virtualized).
- **Play button:** Decorative only (`pointer-events: none`). No execution runtime.
