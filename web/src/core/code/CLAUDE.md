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
| `code-tokens.ts` | Shared codec/theme/plumbing: `S` enum (16 styles incl. `WHITESPACE` sentinel), `THEME` (palette + chrome — single source of truth for color), spans-SAB layout constants (`SAB_H_VERSION` / `SAB_H_LINE_COUNT` / `SAB_H_LINE_CAP` / `SAB_HDR_BYTES`), spans-buffer cap helpers (`ensureSpansDataCap` / `ensureSpansLineCap`), packed-triple writers (`countPackedTriples` / `writePackedTriples` / `packRunSpansInto`, `isAllWs`), sizing ratios, play-button geometry (`playButtonGeom`). **Imports `code-system.ts` as `type` only** — see bundle hygiene below |
| `code-tokenizer.ts` | The sync-floor highlighter: length-bucketed keyword tables + `classifyIdent` (+ case-insensitive `classifyIdentCI` via `\|32` fold for SQL), stateless char-code scan atoms (`scanNumber` / `scanQuotedString` / `scanTripleStringBody` / `scanTemplateLiteral` / `scanEscape`), and `syncTokenizeInto` — a thin **driver** dispatching by language: `tokenizeCLike` (JS/TS/Python), `tokenizeJson`, `tokenizeSql`, `tokenizeCss`, `tokenizeHtml`. CSS's core is `scanCssSegment` over a module scratch, and HTML drives it (plus `scanJsSegment`) for real embedded `<style>`/`<script>` floor highlighting. Parity vs the worker is machine-checked — see `web/scripts/token-parity.mjs`. Imported **only by `code-system.ts`**; keeps `code-system` a `type`-only import (bundle hygiene) |
| `code-system.ts` | SOA pipeline types (`CodeSource` / `CodeSpans` / `CodeLayout` / `CodeOutput`), pooled `CodeSystemCache` (incl. the per-block in-flight parse gate), `buildCodeSourceInto` / `layoutCodeSourceInto` / `ensureOutputCache`, canvas renderer (`renderCodeLayout` with header/output chrome), chrome height helpers, worker pool (2 warm workers, least-loaded seed pins) with per-id diff transport (`requestParse` full seed / `requestParseEdits` Yjs delta batches; pooled message wrappers) and the spans-SAB doorbell consumer, font metrics (derived from text-system) |
| `code-theme.ts` | CodeMirror theme + `HighlightStyle.define` rule list. All `@codemirror/*` AND `@lezer/highlight` imports are **dynamic** (inside `getCodeMirrorExtensions()`) — main bundle stays free of the editor stack |
| `lezer-worker.ts` | Web Worker. Per-object `Tree` + `TreeFragment` + text-mirror state + spans SAB, **lazily-loaded** per-language parsers (dynamic `import()` via `REGISTRY`, each entry's `load()` returns the fully-configured `Parser`; buffer-during-load preserves per-id order), incremental parsing from Yjs-delta batches (`applyEdits` splices the mirror + derives `ChangedRange[]` in one pass; `TreeFragment.applyChanges` chains across batches, one parse per message), custom `STYLE_HIGHLIGHTER` over its own `WORKER_RULES`, fused `extractSpans` walk, per-block SAB publish + postMessage doorbell |
| `vendor/sql/` | Vendored standard-SQL Lezer grammar (@codemirror/lang-sql@6.10.0, MIT — no `@lezer/sql` exists and lang-sql's dist would drag `@codemirror/language` into the worker). `sql.grammar` (verbatim) + generated `sql.grammar{,.terms}.js` (checked in; regen: `pnpm gen:sql-grammar`) + hand `.d.ts`s + `tokens.ts` (external tokenizer **constant-folded to the standard dialect**, 128-entry char-class table) + `keywords.ts` (pure strings, shared with the sync floor) + `index.ts` (styleTags-configured parser — **worker-safe**, `@lezer/lr` + `@lezer/highlight` only) + `support.ts` (editor `LanguageSupport`; main-thread only, dynamic-import-only). One grammar drives BOTH the worker and the CM editor — parity by construction, zero dialect machinery |
| `../../tools/CodeTool.ts` | PointerTool — click-to-place + hit-test + CodeMirror DOM overlay lifecycle + header/output chrome DOM. `loadLangExt(language)` loads only the needed CM lang pack per mount/switch |

## Y.Doc Schema

```typescript
{
  id, kind: 'code', ownerId, createdAt,
  origin: [number, number],   // Top-left world coords (NOT baseline, unlike text)
  content: Y.Text,            // Plain text (NOT Y.XmlFragment); deltas diffed to the worker
  language: 'javascript' | 'typescript' | 'python' | 'html' | 'css' | 'json' | 'sql',
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
`code-system.ts`. Height = `blockHeight(layout, headerVisible, outputVisible,
output)` (reads cached px metrics off `layout` — no `fontSize` param). Title
fallback uses `??` (not `||`) to preserve `''`.
Typed accessor: `getCodeProps(y)`.

## Architecture — SOA Pipeline

Four pooled buffers per id (`CacheEntry`); hot paths allocate zero.

```
Y.Text.toString()
    ↓ buildCodeSourceInto
CodeSource     fullText + Uint32Array lineStart (sentinel: text.length+1)
    ↓ syncTokenizeInto (sync floor) / lezer-worker (Lezer ceiling, SAB → copy-in on doorbell)
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

### Cached font strings + pixel metrics

`CodeLayout.normalFont` / `chromeFont` are recomputed only when `fontSize`
changes (gated in `layoutCodeSourceInto`) — saves three template-string
allocations per render call.

`layoutCodeSourceInto` also caches every `fs * ratio` product + the measured-ratio
Map lookups onto the layout (`charWidthPx` / `baselineOffsetPx` / `contentLeftPx`
/ `lineHeightPx` / `pad{Top,Bottom,Left,Right}Px` / `chromeFontSizePx` /
`headerBarHeightPx` / `borderRadiusPx` / `gutterDigits`) — computed **every**
layout call (not `fontSize`-gated, so it self-heals across the font-load
boundary), read by `renderCodeLayout` / `blockHeight` / `computeCodeBBoxInto`
instead of recomputed per frame. Both `renderCodeLayout` and `blockHeight`
therefore take **no `fontSize` param** (`fontSize === layout.fontSize` at every
call site). `digitCount(n)` replaces `String(n).length` for the gutter width.

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
        → version = ++_nextVersion (global monotonic), layoutValid=false, frame=null
        → !seeded  → requestParse(fullText) + seeded=true + inFlight=true
          !inFlight → requestParseEdits([ev.delta]) + inFlight=true
          in flight → pending.push(ev.delta)          (pendingSeed subsumes deltas)
    → same frame: getLayout() reflows in place + canvas paint
    → worker: mirror splices per batch → ONE incremental parse → fused extract
      → SAB write → Atomics.store(version) → doorbell postMessage {id, sab}
    → main doorbell: applyWorkerSpans — acquire version, gate, COPY into e.spans,
      viewport-cull invalidate, THEN flush pending (order is load-bearing)
```

### Diff transport + in-flight gate (no full text, ≤1 parse in flight per block)

Only the **first** parse of a block (cold miss or language switch) ships the full
text; every subsequent edit ships just the Yjs delta, so N peers typing cost N
tiny delta copies across the thread boundary, not N full-text copies. The worker
keeps a per-id `mirror: string`, splices it per delta op, and derives the
incremental `ChangedRange[]` in the *same* pass (`applyEdits`). `CacheEntry.seeded`
(false on `newEntry`) is the guard: an `edits` message can never reach the worker
before its full seed, whatever the observer/Yjs ordering.

**Gate.** At most one parse is in flight per block (`CacheEntry.inFlight`). The
first edit posts immediately (zero added latency); edits during a flight batch
into `pending: DeltaOp[][]` and flush as ONE message when the doorbell arrives —
an N-keystroke burst costs N cheap mirror splices + 1 parse instead of N parses
(previously each burst keystroke ran a full parse whose result the version gate
then discarded). Batches apply **sequentially** on the worker (each batch's
retains are relative to the post-previous-batch text — never concatenate);
`TreeFragment.applyChanges` chains across batches without an intervening parse.
A language change mid-flight sets `pendingSeed` (and clears `pending` — the
flush-time full text subsumes the deltas). A worker crash posts
`{type:'parse-failed', id}` → gate released, `seeded=false` so the next edit
re-seeds (also healing a desynced mirror). Versions come from a module-level
**global monotonic counter** so a stale doorbell can never falsely match a
re-created entry (evict + undo-recreate, clearAll + rehydrate).

Main-thread `yText.toString()` stays (the renderer needs a materialized string
for cheap `substring` slices, and it only fires on content change). Message
objects are pooled module-level wrappers — postMessage structured-clones
synchronously, so reuse is safe.

### Spans SAB (worker → main, zero steady-state allocation)

Each block owns one **SharedArrayBuffer**, allocated by its worker at first
publish, exact-sized with pow2 headroom + a 4 KB floor, doubled on overflow
(never shrinks; GC'd when both sides drop refs on evict/clearAll). Layout
(constants in `code-tokens.ts`): `[8×Int32 header][spanLineStart (lineCap+1)
u32][spanData u16…]`. `SAB_H_VERSION` is the **only** Atomics-accessed lane —
the worker's release store covers the plain body writes; the doorbell
`postMessage({type:'spans', id, sab})` carries the SAB **in every message** (a
handle, not a copy — kills stale-view ordering across re-pins/incarnations).

Main (`applyWorkerSpans`): acquire-load version → strict-equality gate against
`e.version` (stale publishes are never read — the gate doubles as a seqlock) →
copy into the pooled `e.spans` buffers via `ensureSpans*Cap` + `.set` (renderer
and `CodeSpans` shape untouched; buffer identity stable) → viewport-cull →
`invalidateWorldBBox` (module scratch tuple) → **then** flush `pending`. The
copy-before-flush order is load-bearing: the worker starts overwriting the
single-buffer SAB the moment the flushed parse message lands. Single buffer is
safe because the gate serializes worker-write vs main-copy (strict alternation).

**Sync tokenizer** (`code-tokenizer.ts`): char-code, allocation-free.
`syncTokenizeInto(source, language, out)` is a thin **driver** — it writes the
shared spans prologue (`ensureSpansLineCap` + line-0 offset) then dispatches by
language. JS/TS/Python route to `tokenizeCLike` (they differ only by keyword
table + `isPython`); JSON/SQL/CSS/HTML each have their own whole-source
tokenizer (see the per-language notes below). `tokenizeCLike` iterates
`source.fullText` with absolute offsets, pushes line-relative triples to a
pooled `_syncBuf`, then `flushLine` (`packRunSpansInto` + the per-line
span-start write) packs each line. All per-pass state is function-local — no
shared struct, monomorphic, zero-alloc. Two carry pieces:
- `lastDefIsFunc` — set by definer kw (`function`/`class`/`def`/`type`/
  `interface`/`enum`, via the kw table's `definesNext` flag; `classifyIdent`
  returns the matched `KwEntry` or `null`, no side-channel global). Next ident
  consumes it and renders as `S.FUNCTION_DEF`. Persists across whitespace/comments.
- `lastSignificantChar` — last non-ws non-comment char code, drives `obj.foo`
  → `S.TYPE` classification.

The stateless scan atoms (`scanNumber` / `scanQuotedString` / `scanTripleStringBody`
/ `scanTemplateLiteral` / `scanEscape`) **return their end index** (no scanner
globals), so a future language can reuse them directly. The identifier emit +
its `lastDefIsFunc`/`lastSignificantChar` write-back stays inline (a 6-way
read-and-write decision — hoisting it would risk a silent lost write-back with
no type error).

Alignment invariants (a silent break has no type error): comment/whitespace
branches must NOT update `lastSignificantChar` (so `obj /* */ .foo` still
resolves `foo` → TYPE); `lastDefIsFunc` persists across ws/comments, resets on
other emits; the number branch keeps its deliberate `lastSignificantChar = 0`.

Out of scope (needs AST): JSX HTML/Component split, regex-delimiter split,
parameter vs variable, destructured aliases, TS type-position names
(`: string`), template/f-string interpolation bodies.

**Per-language tokenizers** (each mirrors its grammar's styleTags ∘
`WORKER_RULES`; parity machine-checked by `web/scripts/token-parity.mjs` —
js/json/sql/css/html hold PERFECT per-char parity on the harness corpus):
- `tokenizeJson` — key-vs-value by `"…"`+lookahead-`:`; strict JSON number
  syntax (a `0x1` stays unstyled like Lezer's error node); **unterminated
  strings emit nothing** (the grammar requires the close quote). No cross-line
  state.
- `tokenizeSql` — mirrors `vendor/sql/tokens.ts` branch-for-branch:
  case-insensitive kw tables (`classifyIdentCI`, both sides `|32`-folded so
  `_`/digits stay consistent), dot-adjacency rule (`order.date` → plain
  Identifier), `'`/`"` literals **span lines** (carry: `strQuote`+`strEscapes`),
  **nested** block comments (carry: `commentDepth`), `E'…'`/bits/hex forms.
- `tokenizeCss` — context machine (SELECTOR/BLOCK/VALUE/@-PRELUDE + brace
  depth) in `scanCssSegment` over the `_cssScan` module scratch; BLOCK ident
  disambiguation = bounded lookahead ('{' before ';'/'}' ⇒ nested selector);
  CallTag literals (`url`/`url-prefix`/`domain`/`regexp`) → purple, other
  callees pink; number+Unit split; `#hex` vs `#id` by context.
- `tokenizeHtml` — markup modes (TEXT/TAG/ATTRVAL/COMMENT/META/RAWTEXT) with
  **real embedded highlighting**: `<script>` bodies run `scanJsSegment`
  (simplified C-like over the shared atoms + JS kw table), `<style>` bodies run
  the SAME `scanCssSegment` css blocks use — typing inside them doesn't
  shimmer. Case-insensitive tag matching (`|32`), entity refs, doctype/PI →
  purple. Floor does NOT emulate `type=`-attr dialect switches or style/on*
  attribute nesting (worker corrects, ~1 frame).

**Lezer worker pool**: 2 warm workers. An id **pins** to a worker at seed time
— chosen by lowest outstanding-parse count (so hydrate bursts / multi-block
pastes split across the pool) — and stays pinned (preserves incremental parse
trees, the per-id text mirror, **and** the per-id SAB). `ensureWorkers` asserts
cross-origin isolation (spans travel via SAB). Per-object `{ tree, fragments,
mirror }`; non-empty `changes` enable incremental parsing via
`TreeFragment.applyChanges` (chained per batch).

**Span extraction (fused)**: ONE `highlightTree(tree, STYLE_HIGHLIGHTER,
_onHighlight)` walk packs gap-filled line-relative triples **directly** into the
persistent scratches with a monotonic line cursor — no quad buffer, no binary
search, no second pass, no per-parse allocation. Relies on `highlightTree`'s
ascending non-overlapping emission order (DEV-asserted; the old two-pass cursor
scan depended on the same order). `STYLE_HIGHLIGHTER.style()` returns the
stringified `S` int; the callback decodes the **trailing** int (inherited scopes
join classes as `"inherited own"` — last is most specific). Publish copies the
scratch prefixes into the block's SAB and release-stores the version — see
"Spans SAB" above.

**Language → parser (lazy)**: a module-level `REGISTRY` maps each language to a
`{ load: () => Promise<Parser> }` entry — each `load()` does the dynamic
import(s) AND configuration, returning the ready parser. `python` →
`@lezer/python`; `typescript` / `javascript` → `@lezer/javascript` configured
`dialect: 'ts jsx'` / `'jsx'` (same chunk, cached after the first `import()`);
`json` / `css` → `@lezer/json` / `@lezer/css` (highlight props baked into the
packages); `sql` → `./vendor/sql/index` (vendored standard dialect, styleTags
pre-applied); `html` → `@lezer/html` wrapped with `configureNesting` over raw
`@lezer/css` + `@lezer/javascript` parsers, **mirroring
@codemirror/lang-html@6.4.11's `defaultNesting`/`defaultAttrs` verbatim**
(script `type=` dialect predicates, style tag/attr, `on*` event attributes) —
the editor runs lang-html's `html()`, so the two sides MUST stay in lockstep.
Parsers load **on first use**, not at worker boot, so a new language pays
nothing until its first block appears. `getParser` is async: steady state
(parser resident) processes inline; a not-yet-loaded language buffers that
language's messages in arrival order and drains them once loaded (per-id order
preserved — an id's language is fixed per edit).

> **Offline note.** Dynamic `import()` in the module worker emits separate Rollup
> chunks fetched at runtime under `/assets/*`, which `sw.ts` serves **cache-first
> (lazy)** — cached after the first *online* fetch, not precached. Grammar chunks
> (js/ts, python, json, css, html — which also pulls the css+js chunks — and the
> vendored sql) fetch as soon as the first block of that language renders, so
> they're warm well before a typical offline session. A first-ever offline load
> of a never-fetched grammar can't load (worker posts `parse-failed`, block stays
> on the sync floor) — accepted pre-production; revisit with precache if it
> matters.

### Sync ↔ Lezer alignment

The sync tokenizer's classifications match the worker's tag output so there is
no color flip when the parse arrives — machine-checked per character by
`web/scripts/token-parity.mjs` (run from `web/`: `pnpm dlx tsx
scripts/token-parity.mjs`; it carries a copy of `WORKER_RULES` — keep in sync).
Keyword tables bake reclassifications at build time:
- `true` / `false` / `null` / `True` / `False` / `None` → `S.NUMBER`
  (SQL adds `unknown`; SQL tables are case-insensitive)
- `this` / `super` → `S.LANG_VAR` (Python `self` is deliberately ABSENT —
  @lezer/python tags it as a plain VariableName, fg)
- `function` / `class` / `def` / `type` / `interface` / `enum` →
  `S.STORAGE` with `definesNext: true`; `extends` → `S.STORAGE` (Lezer
  definitionKeyword), no promote
- property-access `.` → `S.OPERATOR` (derefOperator, pink); template `${` /
  `}` delimiters → `S.STRING` (InterpolationStart/End → special(brace))

Acceptable flickers (sync emits one color → Lezer corrects ~1 frame later):
`{ method() {} }` shorthand (sync green → Lezer white), `const foo =
function() {}` (sync white → Lezer green), TS type-position names (`: string`
white → cyan), template/f-string interpolation bodies (white → real tokens),
JS statement labels (white → green via the labelName row), HTML `type=`-attr
script dialects + style/on* attribute nesting (floor scans plain JS / plain
attr string). Over-painting alternatives would be worse.

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
`STYLE_HIGHLIGHTER`) — plus a third test-only copy in
`web/scripts/token-parity.mjs`. **Reason:** keeps `@lezer/highlight` (and its
`Modifier`/`Tag` machinery, ~30–40 kB) out of the main bundle. A shared file
would force a static import somewhere it'd bleed in. **Invariant:** the rule
tables MUST stay in sync — same row order, same tag groupings, so a diff
is trivial. Modifier-set walk semantics (`definition` < `function` Modifier.id)
must be preserved: that's how `definition(propertyName)` → `S.DEFAULT` wins
over `function(propertyName)` → `S.FUNCTION_CALL` for one row covering
obj-literal keys, class fields, method shorthand, and class methods.

Cross-language row notes (the table is GLOBAL — one highlighter for all
languages): `tags.atom` must stay in the NUMBER row (JS `super` emits it, so
CSS value keywords like `block` are purple by consequence); `tags.labelName`
sits in the ATTRIBUTE row (CSS `#id` + `@keyframes` names green; rare JS
labels ride along); `tags.attributeValue` in the STRING row (HTML attr values
+ JSX attr values); `tags.unit` → KEYWORD (CSS `px`/`%` pink); `tags.color` in
the NUMBER row; `tags.function(tags.punctuation)` in the deref row (JS `=>`
pink — also what the sync floor paints); `tags.separator` deliberately
unmapped (JS/PY/JSON/CSS separators all fg).

## Canvas Renderer (`renderCodeLayout`)

Signature: `renderCodeLayout(ctx, layout, originX, originY, spans, source,
title?, output?, outputCache?)` — all size/color metrics read off `layout`'s
cached px fields, so no `fontSize` param. `title`/`output` undefined hides the
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
buffers, plus version + language + frame + `seeded` (worker-mirror seed guard) +
layout cache keys.

### Invalidation rules

| Trigger | Source/Spans | Layout | Frame | Version |
|---------|--------------|--------|-------|---------|
| `handleContentChange` | rebuilt in place | invalidated | nulled | `++_nextVersion` |
| `applyWorkerSpans` (version match) | SAB copied into pooled buffers (colors only) | unchanged | unchanged | unchanged |
| fontSize/width/lineNumbers change (in `getLayout`) | — | reflowed in place | nulled | unchanged |
| Language change (in `getLayout`) | re-tokenized in place | **preserved** if dims unchanged | preserved | `++_nextVersion` |

`applyWorkerSpans` is version-gated (discard stale; global monotonic counter).
It **viewport-culls** before invalidating: intersects `e.frame` with
`getVisibleBoundsTuple()` (shared scratch tuple) — off-screen blocks (remote
edits while panned away) skip the dirty rect entirely; the next pan/zoom into
view repaints from scratch. It always runs the pending flush, even on a stale
gate — that's what advances the in-flight state machine.

### Public API

| Method | Purpose |
|--------|---------|
| `getLayout(id, yText, fontSize, width, lang, lineNumbers?)` | Cold-miss builds full entry + full-seeds worker (`seeded=true`); language change re-seeds; otherwise returns cached layout (handles dims change) |
| `handleContentChange(id, ev, lang)` | Deep-observer Y.Text hook — sync floor + gated dispatch: full seed if `!seeded`, post `[ev.delta]` if idle, else batch into `pending` |
| `applyWorkerSpans(id, sab)` | Spans doorbell — acquire+gate, copy-in, viewport-cull invalidate, flush pending |
| `onParseFailed(id)` | Gate release on worker crash — clears pending, `seeded=false` (next edit re-seeds) |
| `getSpans(id)` / `getSource(id)` / `getOutputCache(id, output)` | Renderer accessors |
| `getFrame(id)` / `setFrame(id, frame)` | Hit testing / selection / bbox |
| `evict(id)` / `clear()` | Deletion / room change |

Helpers exported from `code-system.ts` and consumed externally: `getCodeFrame`,
`getCodeSource`, `computeCodeBBoxInto` (observer hot path — writes into a pooled
bbox + reuses `e.frame` in place via `setFrameXYWH`; `computeCodeBBox` is the
allocating cold-path wrapper), `terminateCodeWorkers` (kills the warm pool on room teardown — see Integration).

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

- **`code-tokens.ts` AND `code-tokenizer.ts` import `code-system.ts` as `type`
  only**. A value import would chain `→ code-system → RenderLoop → image-manager`,
  dragging image-manager's top-level `window.addEventListener(...)` into
  the lezer worker — module-load aborts before `onmessage` is installed and
  parse requests silently drop. The worker imports `{ S, isAllWs, SAB_* }`
  from `code-tokens.ts` **only** — it never reaches `code-tokenizer.ts`, and
  `code-tokens.ts` must never gain a *value* import of `code-tokenizer.ts` (only
  `code-system.ts` imports the tokenizer). The spans cap helpers
  (`ensureSpansDataCap` / `ensureSpansLineCap`) live in `code-tokens.ts`
  specifically to keep this chain broken. `w.onerror` / `w.onmessageerror`
  surface any regression.
- **`code-theme.ts` has NO top-level `@codemirror/*` or `@lezer/highlight`
  imports** — everything is inside the async `getCodeMirrorExtensions()`.
  Static imports here bleed `Modifier`/`TagName`/`Tag` into the main bundle
  (~30–40 kB). Verify with
  `grep -c "highlightTree\|tagHighlighter\|defineModifier" dist/assets/main-*.js`
  after each build — that must be `0`. (Don't grep bare `Modifier`/`TagName`:
  benign `getElementsByTagName` + unrelated vendor `hasAddModifier` false-match.)
- **Rule tables duplicated, deliberately** (`code-theme.ts` rule list +
  `lezer-worker.ts` `WORKER_RULES`) — see "Lezer-tag → S mapping" above.

## Integration

**`room-doc-manager.ts`** deep observer: code-kind Y.Text events route to
`codeSystem.handleContentChange(id, ev, lang)`. `computeCodeBBoxInto(id, yObj, out)`
is called for code in hydration and incremental update paths. Object deletion →
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
