# Code Block System

Canvas-rendered code blocks with CodeMirror DOM overlay editing, two-tier syntax highlighting, and Yjs collaborative binding.

---

## Files

| File | Role |
|------|------|
| `code-system.ts` | Constants, types, sync tokenizer, layout cache, canvas renderer, worker pool, delta conversion, CM theme |
| `lezer-worker.ts` | Web Worker — incremental Lezer parsing + token extraction (2-worker pool) |
| `CodeTool.ts` (in `lib/tools/`) | PointerTool — click-to-place + CodeMirror DOM overlay lifecycle |

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

**Key differences from text objects:**
- `Y.Text` not `Y.XmlFragment` — code is plain text, delta events map to Lezer `ChangedRange`
- `origin` = top-left (not baseline). Code blocks are rectangular, no alignment modes
- `width` always stored number — no 'auto' mode
- Height derived: `PADDING_TOP + visualLineCount * lineHeight + PADDING_BOTTOM`, cached in code system
- No `color`/`fillColor` — dark theme is fixed chrome
- Empty blocks are NOT deleted on close (unlike text) — visible dark bg + line numbers

---

## Architecture

### Coordinate System & Positioning

Code blocks use **origin-based top-left positioning**. The `origin` field stores `[x, y]` in world coordinates representing the top-left corner of the block (including background/padding).

**Frame derivation:** No stored frame in Y.Doc. Frame is computed from layout and cached:
```
frame = [origin[0], origin[1], layout.totalWidth, layout.totalHeight]
```
Read via `getCodeFrame(id)`. Mirrors `getTextFrame()` pattern.

**BBox derivation:** Frame-to-bbox conversion:
```
bbox = [origin[0], origin[1], origin[0] + totalWidth, origin[1] + totalHeight]
```
`computeCodeBBox()` in `code-system.ts` handles this — it computes layout, caches frame, returns proper `[minX, minY, maxX, maxY]` BBoxTuple.

### Block Sizing

All sizing constants in `code-system.ts §1`:

```
totalWidth  = stored width field (set at creation from getDefaultWidth)
totalHeight = PADDING_TOP + visualLineCount * lineHeight(fontSize) + PADDING_BOTTOM

getDefaultWidth(fontSize) = DEFAULT_CHARS * charWidth + PADDING_LEFT + PADDING_RIGHT + gutterWidth(2) + GUTTER_PAD_RIGHT
getMinWidth(fontSize)     = MIN_CHARS * charWidth + same padding
charWidth(fontSize)       = fontSize * CHAR_WIDTH_RATIO (0.6)
lineHeight(fontSize)      = fontSize * LINE_HEIGHT_MULT (1.5)
```

Current constants: `DEFAULT_CHARS=48`, `MIN_CHARS=24`, `PADDING_TOP/BOTTOM=24`, `PADDING_LEFT=12`, `PADDING_RIGHT=12`, `GUTTER_PAD_RIGHT=10`, `BORDER_RADIUS=8`.

### Content Layout

The `contentLeft` offset positions code text after the gutter:
```
contentLeft = PADDING_LEFT + gutterWidth(digits, fontSize) + GUTTER_PAD_RIGHT
```
Where `gutterWidth = maxDigits * charWidth` and `digits = max(2, String(sourceLineCount).length)`.

### Line Wrapping

Canvas wraps at character boundary for monospace: `maxChars = floor((width - contentLeft - PADDING_RIGHT) / charWidth)`. Source lines exceeding `maxChars` are split into visual lines. The layout's `lines` array contains visual lines; `sourceLineCount` tracks original count. Continuation lines have `index: -1` (no gutter number).

CodeMirror uses `EditorView.lineWrapping` + `overflow-x: hidden` on `.cm-scroller`.

---

## Two-Tier Tokenization

### Flow
```
Y.Text change (typing or remote sync)
  → deep observer fires synchronously
  → codeSystem.handleContentChange(id, ev, lang)
    → syncTokenize() runs (~30-50us) — regex tokenizer, main thread
    → cache updated with regex tokens (layout/frame nulled)
    → requestParse() dispatched to worker pool (async)

Same rAF frame:
  → renderer calls getLayout() → gets regex tokens → draws correct colors

Next frame (worker responds):
  → applyTokens() upgrades cache to Lezer tokens, nulls layout
  → NO invalidateWorld (observer dirty rect already covers it)
  → renderer calls getLayout() → draws Lezer tokens
```

Tokens are **never null** after first content change. Worker upgrade is invisible ~95% of the time (regex and Lezer agree on most tokens).

### Sync Regex Tokenizer (`syncTokenize`)

Single-pass state machine per line. Cross-line state for block comments and template strings. Handles:
- Keywords (language-specific `Set` for O(1) lookup)
- Strings (single/double/backtick/triple-quote)
- Numbers (int, float, hex, scientific notation)
- Comments (line `//`, block `/* */`, Python `#`)
- Operators, punctuation

Heuristic classification: `ident(` → function, `Uppercase` → type, keyword set → keyword, else → variable.

### Lezer Worker Pool

2 warm workers created at first `requestParse()`, persist for app lifetime. Round-robin dispatch.

Each worker owns per-object parse state (`Tree` + `TreeFragments`) for incremental parsing. `deltaToChangedRanges()` converts Y.Text delta to Lezer `ChangedRange[]`. Token extraction via `highlightTree` + `tagHighlighter` mapping Lezer tags to `TAG_STYLES`.

**Protocol:**
```
Main → Worker: { type:'parse', id, text, language, changes? }
Main → Worker: { type:'remove', id }
Main → Worker: { type:'clearAll' }
Worker → Main: { type:'tokens', id, tokens: CodeToken[][] }
```

### TAG_STYLES

Shared between sync tokenizer, Lezer worker, and CM `HighlightStyle`. One Dark inspired palette:
- keyword → `#c678dd` (purple, bold)
- string → `#98c379` (green)
- number → `#d19a66` (orange)
- comment → `#5c6370` (dim gray)
- function → `#61afef` (blue)
- variable → `#e06c75` (red)
- type → `#e5c07b` (yellow)
- operator → `#56b6c2` (cyan)
- punctuation → `#abb2bf` (default)

---

## Cache (`CodeSystemCache`)

Singleton `codeSystem`. Per-object `CacheEntry`:

```typescript
interface CacheEntry {
  text: string;           // Current full text
  lines: string[];        // text.split('\n')
  tokens: CodeToken[][];  // null only before first content; regex floor → Lezer upgrade
  layout: CodeLayout | null;   // null = needs recompute
  layoutFontSize: number;      // Cache key — layout invalidated if fontSize changes
  layoutWidth: number;         // Cache key — layout invalidated if width changes
  frame: FrameTuple | null;    // Derived, set by computeCodeBBox
}
```

**Invalidation rules:**
- `handleContentChange` → nulls `layout` + `frame` (text/tokens changed, dimensions may change)
- `applyTokens` → nulls `layout` only (dimensions unchanged, just colors)
- fontSize/width mismatch in `getLayout` → nulls `layout` + `frame`

**Public API:**
| Method | Called by | Purpose |
|--------|-----------|---------|
| `getLayout(id, yText, fontSize, width, lang)` | `computeCodeBBox`, `drawCode` | Build or return cached layout |
| `handleContentChange(id, ev, lang)` | Deep observer | Sync tokenize + dispatch worker parse |
| `applyTokens(id, tokens)` | Worker response handler | Upgrade to Lezer tokens |
| `getFrame(id)` / `setFrame(id, frame)` | Hit testing, selection, bbox | Read/write cached frame |
| `remove(id)` / `clear()` | Deletion / room change | Cleanup + worker notification |

**External getters:**
- `getCodeFrame(id)` — reads cached frame (mirrors `getTextFrame` pattern)
- `computeCodeBBox(id, yObj)` — computes layout, caches frame, returns `[minX, minY, maxX, maxY]`

---

## Canvas Renderer (`renderCodeLayout`)

Renders a `CodeLayout` at `(originX, originY)` in world coords:
1. Background: `roundRect` fill with `CODE_BG`
2. Per visual line: gutter number (right-aligned, only on `index >= 0` lines) + code text with per-token coloring
3. Monospace positioning: each token rendered at `codeX + token.from * charWidth`
4. Baseline offset: `lineHeight * 0.7` (alphabetic baseline)

Font: `FONT_WEIGHT fontSize CODE_FONT` (400 weight, JetBrains Mono).

**Skip rule:** `drawCode()` in `objects.ts` skips rendering when `codeEditingId === id` (DOM editor visible instead).

---

## CodeTool Lifecycle

### Gesture → Object Creation / Editor Mount

```
begin(pointerId, worldX, worldY)
  → hit test existing code blocks via spatial index + frame check

end(worldX, worldY)
  → if hit existing: beginCodeEditing() → mountEditor(hitId)
  → if no hit: createCodeObject(x, y) → mountEditor(newId)
  → resetGesture() + invalidate

onViewChange() → positionEditor() (transform-based repositioning)
destroy() → commitAndClose()
```

### `createCodeObject(worldX, worldY)`

Center placement: `origin = [click - width/2, click - (PADDING_TOP + lineHeight + PADDING_BOTTOM)/2]`.
Creates Y.Map with empty `Y.Text()`, `language: 'javascript'`, default fontSize/width.
`mutate()` is synchronous — observer fires synchronously — handle exists when mutate returns.
Calls `mountEditor(id)` directly (no RAF).

### `mountEditor(objectId)` — async

1. Close existing editor (`commitAndClose` if already editing)
2. Create container div with **world-unit** dimensions: `width`, `fontSize` in world px
3. CSS `transform: scale(${scale})` + `transformOrigin: 0 0` handles zoom
4. Position via `worldToClient(origin)` → `left/top` in screen px
5. Lazy-load CM modules (8 parallel imports via `Promise.all`)
6. Create per-session `Y.UndoManager(yText)` with 500ms capture
7. CM extensions: `lineNumbers`, `lineWrapping`, language, `indentUnit('    ')`, `indentWithTab`, `yCollab`, theme+highlight, tab normalizer
8. `EditorView.focus()`
9. `beginCodeEditing(objectId)` on selection store (if not already set)
10. Main UndoManager: widen `captureTimeout` to 600s (isolate editor edits)
11. Setup escape + click-outside handlers

### `positionEditor()` — called on zoom/pan

Only updates `left/top` (via `worldToClient`) and `transform: scale(${scale})`. Width/fontSize stay at world units — CSS transform handles zoom scaling.

### `commitAndClose()`

1. Remove keyboard/pointer handlers
2. `EditorView.destroy()`
3. Restore main UM `captureTimeout` to 500ms, clear session UM
4. Remove container from DOM
5. `endCodeEditing()` on selection store
6. `invalidateWorld` + `invalidateOverlay`

Does **not** delete empty blocks (unlike TextTool).

### Public API

- `startEditing(objectId)` — for SelectTool double-click-to-edit
- `isEditorMounted()` — guard check
- `objectId` — public field, current editing target

---

## DOM Editor Zoom Strategy

Container uses world-unit dimensions. CSS `transform: scale(${scale})` handles zoom.
No per-instance CM theme needed — font inherits from container.

**CSS (index.css):**
```css
.code-editor {
  will-change: transform;
  transform-origin: 0 0;
  overflow: hidden;
}
.cm-scroller {
  overflow-y: auto;
  overflow-x: hidden;  /* lineWrapping handles wrap */
}
```

**CM Theme (getCodeMirrorExtensions):** Shared singleton. Sets bg, gutter colors/padding, content padding (PADDING_TOP/BOTTOM), line padding (PADDING_RIGHT), cursor color, active line, selection. Gutter has `paddingLeft: PADDING_LEFT` for WYSIWYG match.

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
Single call — `handleContentChange` does toString, split, syncTokenize, and requestParse internally.

**Deletion bridge:** If `codeEditingId` matches a deleted object, calls `endCodeEditing()`.

**BBox computation:** `computeCodeBBox(id, yObj)` imported from `code-system.ts`.

### objects.ts — Render Dispatch

```typescript
case 'code':
  drawCode(ctx, handle);  // skips if codeEditingId === id
```
Transform preview: currently translate-only (Phase 4 will add proper scale).

### hit-testing.ts

Uses `getCodeFrame(id)` for rectangle hit testing and marquee intersection. Code blocks are always filled (dark bg = opaque interior).

### selection-store.ts

- `codeEditingId: string | null` — tracks which code block is being edited
- `beginCodeEditing(objectId)` → sets `codeEditingId`, opens context menu, refreshes styles
- `endCodeEditing()` → clears `codeEditingId`
- `selectionKind: 'codeOnly'` when all selected objects are code blocks

### selection-utils.ts

- `computeSelectionComposition` counts code objects, derives `'codeOnly'` kind
- `computeStyles` for `'codeOnly'`: only tracks `fontSize`

### Context Menu

`effectiveKind === 'codeOnly'` renders `CodeStyleGroup` — currently just a `FontSizeStepper`.

### tool-registry.ts

`codeTool` = singleton `CodeTool`, mapped to `'code'` tool ID. Exported directly for external access.

---

## Known Issues / TODO

### Critical — DOM/Canvas WYSIWYG Mismatch
- **Blurry on zoom:** CSS `transform: scale()` rasterizes at base resolution then scales. Need screen-space rendering (compute all dimensions × scale directly, no CSS transform). Requires CM theme padding to also scale — CSS custom properties or per-mount theme.
- **Padding doesn't scale with fontSize:** PADDING_TOP/BOTTOM/LEFT/RIGHT are fixed world-unit px (24/24/12/12). A fontSize=28 block has the same padding as fontSize=14. Consider making padding proportional to fontSize.
- **Height mismatch DOM vs canvas:** CM's actual line-height may differ from `fontSize * LINE_HEIGHT_MULT`. Canvas uses exact `fontSize * 1.5`, CM may compute differently.
- **Gutter-to-code spacing off:** Canvas uses `charWidth(fontSize) = fontSize * 0.6` for gutter width. CM's actual monospace character width may differ slightly, causing gutter/code alignment mismatch.

### Frame / Cache Bugs
- **Empty block frame null:** `getLayout()` re-nulls frame on every call when `text === '' && !tokens` (line 564). After hydration sets frame via `computeCodeBBox`, next render call re-enters that branch and nulls it. Fix: have `getLayout` cache the frame, or guard the re-read more carefully.
- **No tokenization on hydration:** `syncTokenize` + `requestParse` only run in `handleContentChange` (observer path). After page reload, code blocks render with no syntax highlighting until the first edit. Fix: trigger tokenization in `getLayout` when tokens are null, or in `computeCodeBBox` during hydration.

### Other
- **UndoManager:** Per-session UM handles CM undo. Main UM capture timeout hacking removed — main UM may capture individual keystrokes. Needs proper origin-based filtering like TextTool's `ySyncPluginKey` pattern.
- **Flash on mount:** `beginCodeEditing` called from `end()` hides canvas rendering before async `mountEditor` completes. Currently mitigated by also calling `beginCodeEditing` inside `mountEditor` after EditorView creation, but the early call in `end()` for the hit-existing path can still flash. The call in `end()` is commented out as a WIP fix.
- **Font weight:** `FONT_WEIGHT=400` but JetBrains Mono woff2 may only have 450-700 range
- **Phase 4 not done:** Selection transforms (scale, width resize), language dropdown, mixed selection filter
