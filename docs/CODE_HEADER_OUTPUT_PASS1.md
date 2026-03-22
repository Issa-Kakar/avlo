# Code Block Header & Output Panel — First Pass

> **Status:** Typechecks clean. Canvas rendering works. Multiple issues remain (see Known Issues).

## What Was Added

Header bar (title + play button) and output panel visual chrome for code blocks. No execution runtime — this is the visual/data infrastructure only.

- **Header bar**: Title text (editable in DOM overlay), decorative play button, separator line
- **Output panel**: "Output" label, text area, separator line
- **Y.Doc fields**: `title`, `headerVisible`, `outputVisible`, `output`
- **Canvas rendering**: Header and output draw as part of the code block background
- **DOM overlay**: Header div with title input + output div created during CodeMirror editing
- **Context menu**: Header/output toggle buttons in the `codeOnly` toolbar
- **Selection actions**: `toggleCodeHeader()`, `toggleCodeOutput()` free functions
- **BBox/frame**: `blockHeight()` replaces `totalHeight()` in bbox computation so selection handles, hit testing, and dirty rects account for header/output

## Height Model

```
blockHeight =
  [headerBarHeight(fs)]     ← only if headerVisible (fs * 2.5)
+ padTop(fs)                ← code area top padding (fs * 1.5)
+ visualLines * lineHeight  ← code content (lines * fs * 1.5)
+ padBottom(fs)             ← code area bottom padding (fs * 1.5)
+ [outputPanelHeight(fs)]   ← only if outputVisible

headerBarHeight(fs) = fs * HEADER_HEIGHT_RATIO (2.5)

outputPanelHeight(fs, output) =
  fs * OUTPUT_LABEL_H_RATIO (2.0)
  + min(outputLines, MAX_OUTPUT_CANVAS_LINES) * chromeFontSize(fs) * OUTPUT_LINE_H_MULT (1.4)
  + fs * OUTPUT_PAD_BOTTOM_RATIO (0.8)

chromeFontSize(fs) = fs * CHROME_FONT_RATIO (0.82)
```

Origin stays at the block's top-left (including header when visible). Canvas code content rendering shifts down by `headerBarHeight` when header is visible.

## New Y.Doc Fields

```
title: string | undefined     — undefined = "Untitled.{ext}" based on language
headerVisible: boolean         — default true (new blocks), fallback true in accessor
outputVisible: boolean         — default false
output: string | undefined     — execution output text (not yet populated by anything)
```

New blocks created by CodeTool set `headerVisible: true`, `outputVisible: false`. `title` and `output` are NOT set (undefined = defaults). Existing blocks without these fields get headers via the `?? true` fallback in `getHeaderVisible()`.

---

## All Files Changed (12 files, +625 / -32 lines)

### 1. `packages/shared/src/accessors/object-accessors.ts`

**Extended `CodeProps` interface** with 4 new fields:
```typescript
title: string | undefined;
headerVisible: boolean;
outputVisible: boolean;
output: string | undefined;
```

**Updated `getCodeProps()`** to read 4 new fields with defaults: `headerVisible ?? true`, `outputVisible ?? false`.

**New accessors:**
- `getCodeTitle(y, language?)` — resolved display title with `"Untitled.{ext}"` fallback via `CODE_EXTENSIONS` map
- `getRawCodeTitle(y)` — raw stored value (undefined = default)
- `getHeaderVisible(y, fallback = true)`
- `getOutputVisible(y, fallback = false)`
- `getCodeOutput(y)` — returns `string | undefined`

**Added `CODE_EXTENSIONS`** map: `{ javascript: 'js', typescript: 'ts', python: 'py' }`.

All new exports flow through the existing `export * from './accessors/object-accessors'` in `packages/shared/src/index.ts`.

### 2. `client/src/lib/code/code-tokens.ts`

**New constants block** after `LINE_HEIGHT_MULT`:
```
CHROME_FONT_RATIO    = 0.82
HEADER_HEIGHT_RATIO  = 2.5
OUTPUT_LABEL_H_RATIO = 2.0
OUTPUT_LINE_H_MULT   = 1.4
OUTPUT_PAD_BOTTOM_RATIO = 0.8
MAX_OUTPUT_CANVAS_LINES = 12
MAX_OUTPUT_CHARS     = 4096
MAX_TITLE_LENGTH     = 48

CODE_SEPARATOR       = '#FFFFFF12'
CODE_TITLE_COLOR     = '#AEAEAE'
CODE_PLAY_GREEN      = '#4ADE80'
CODE_PLAY_GLOW       = '#4ADE8060'
CODE_OUTPUT_LABEL    = '#E0E0E090'
```

### 3. `client/src/lib/code/code-system.ts`

**New imports** from code-tokens: `CODE_DEFAULT`, `CHROME_FONT_RATIO`, `HEADER_HEIGHT_RATIO`, `OUTPUT_LABEL_H_RATIO`, `OUTPUT_LINE_H_MULT`, `OUTPUT_PAD_BOTTOM_RATIO`, `MAX_OUTPUT_CANVAS_LINES`, `CODE_SEPARATOR`, `CODE_TITLE_COLOR`, `CODE_PLAY_GREEN`, `CODE_PLAY_GLOW`, `CODE_OUTPUT_LABEL`.

**New §4b section — chrome height helpers:**
- `chromeFontSize(fs)` — `fs * 0.82`
- `headerBarHeight(fs)` — `fs * 2.5`
- `outputPanelHeight(fs, output)` — label + capped output lines + bottom padding
- `blockHeight(layout, fontSize, headerVisible, outputVisible, output)` — full block including chrome
- `CodeChrome` interface — `{ headerVisible, title, language, outputVisible, output }`

**`computeCodeBBox` update (line ~578):**
- Now reads chrome fields from `getCodeProps(yObj)` (which already returns them)
- Uses `blockHeight(layout, props.fontSize, props.headerVisible, props.outputVisible, props.output)` instead of `totalHeight(layout, props.fontSize)`
- Frame and bbox both use the new height

**`renderCodeLayout` update (line ~607):**
- New optional `chrome?: CodeChrome` parameter (backward compat — omit for old callers)
- Background roundRect height uses `blockHeight(...)` when chrome provided, else `totalHeight(...)`
- **Header rendering** (when `chrome.headerVisible`):
  - Separator line at `originY + headerBarHeight(fs)` — 1px rect in `CODE_SEPARATOR`
  - Title text: `chromeFontSize(fs)`, left-aligned at `originX + padLeft(fs)`, vertically centered. Color: `CODE_TITLE_COLOR`
  - Play button: green circle (`CODE_PLAY_GREEN`) with glow (`CODE_PLAY_GLOW`, shadowBlur=4). Radius `fs * 0.5`. White play triangle inside.
- **Code content y-offset**: `codeTop = originY + hh` — all per-line rendering uses `codeTop` instead of `originY`
- **Output rendering** (when `chrome.outputVisible`):
  - Separator line at code bottom
  - "Output" label: `chromeFontSize(fs)`, color `CODE_OUTPUT_LABEL`
  - Output text lines: `chromeFontSize(fs)`, color `CODE_DEFAULT`, up to `MAX_OUTPUT_CANVAS_LINES`
  - Empty → "No output" placeholder in gutter color

`totalHeight()` is **unchanged** — still exported, still useful internally, but no longer used for bbox computation.

### 4. `client/src/renderer/layers/objects.ts`

**New imports:** `CodeChrome` from code-system, `getCodeTitle` from @avlo/shared.

**`drawCode` (line ~359):** Builds `CodeChrome` from props and passes to `renderCodeLayout`:
```typescript
const chrome: CodeChrome = {
  headerVisible: props.headerVisible,
  title: getCodeTitle(y, props.language),
  language: props.language,
  outputVisible: props.outputVisible,
  output: props.output ?? '',
};
renderCodeLayout(ctx, layout, ..., chrome);
```

**`drawScaledCodePreview` (line ~767):** Same — builds chrome, passes to `renderCodeLayout`.

**`drawReflowedCodePreview` (line ~821):** Same — builds chrome, passes to `renderCodeLayout`.

### 5. `client/src/lib/tools/SelectTool.ts`

**Import change:** Replaced `totalHeight as codeTotalHeight` with `blockHeight as codeBlockHeight`.

**Line ~1140 (`invalidateTransformPreview`, E/W reflow):**
```typescript
// Before:
const newHeight = codeTotalHeight(layout, props.fontSize);
// After:
const newHeight = codeBlockHeight(layout, props.fontSize, props.headerVisible, props.outputVisible, props.output);
```

This ensures E/W reflow dirty rects account for header/output height.

### 6. `client/src/lib/tools/CodeTool.ts`

**New imports:** `getCodeTitle`, `getLanguage`, `getHeaderVisible`, `getOutputVisible`, `getCodeOutput` from @avlo/shared. `chromeFontSize`, `headerBarHeight` from code-system. `MAX_TITLE_LENGTH`, `MAX_OUTPUT_CANVAS_LINES`, `OUTPUT_LINE_H_MULT` from code-tokens.

**New instance fields:**
```typescript
private headerDiv: HTMLDivElement | null = null;
private titleInput: HTMLInputElement | null = null;
private outputDiv: HTMLDivElement | null = null;
private outputTextDiv: HTMLDivElement | null = null;
```

**`createCodeObject` (line ~152):**
- Added `yObj.set('headerVisible', true)` and `yObj.set('outputVisible', false)`
- Center-placement height now includes `headerBarHeight(fontSize)`:
  ```typescript
  const singleLineH = headerBarHeight(fontSize) + padTop(fontSize) + lh + padBottom(fontSize);
  ```

**`mountEditor` (line ~223):**
- Header div created before `host.appendChild(container)` (if `props.headerVisible`)
- Output div created after `new EditorView({ state, parent: container })` (if `props.outputVisible`)
- Mod+Enter keybind added to CM keymap: `{ key: 'Mod-Enter', run: () => { this.toggleHeader(); return true; } }`

**Y.Map observer (line ~432):** Added watchers for:
- `headerVisible` → `updateHeaderVisibility()` + `positionEditor()`
- `outputVisible` → `updateOutputVisibility()` + `positionEditor()`
- `title` → update input value if not focused (don't fight local edits)
- `output` → `updateOutputContent()`
- `language` → also calls `updateTitleForLanguageChange()` (updates default title)

**`positionEditor` (line ~498):** Now also updates:
- Header div: height, padding, title input font-size
- Output div: font-size, padding, text max-height, line-height

**`commitAndClose` (line ~614):**
- Calls `this.saveTitle()` before cleanup
- Nulls all 4 new refs after container removal

**New methods:**
- `createHeaderDiv(container, props, scale)` — creates header div with title input + play button, wires blur/keydown events
- `createOutputDiv(container, props, scale)` — creates output div with label + text area
- `saveTitle()` — reads input, compares with stored. Empty/matches-default → `y.delete('title')`. Different → `y.set('title', trimmed)`
- `toggleHeader()` — public. Reads `headerVisible`, writes `!current`
- `toggleOutput()` — public. Reads `outputVisible`, writes `!current`
- `updateHeaderVisibility(y)` — show/hide header div, create if needed (inserts before first child)
- `updateOutputVisibility(y)` — show/hide output div, create if needed
- `updateOutputContent(y)` — updates output text div content
- `updateTitleForLanguageChange(y)` — updates title input if using default

### 7. `client/src/index.css`

**New CSS rules** after `.code-editor .cm-scroller`:
```css
.code-header     — flex, align-items center, border-bottom separator, transparent bg
.code-title      — transparent bg, no border/outline, JetBrains Mono, flex:1, caret color
.code-title::placeholder — dimmed color
.code-run-btn    — flex-shrink:0, border-radius:50%, pointer-events:none (non-functional)
.code-output     — border-top separator, JetBrains Mono, overflow hidden
.code-output-label — dimmed color, font-weight 450
.code-output-text  — pre-wrap, word-break, overflow-y auto
```

All dynamic sizing (fontSize, padding, height) set via inline styles in CodeTool, not CSS vars.

### 8. `client/src/lib/utils/selection-actions.ts`

**New imports:** `getHeaderVisible`, `getOutputVisible`.

**New functions:**
- `toggleCodeHeader()` — reads `headerVisible` from first code object, toggles all selected code objects, calls `refreshStyles()`
- `toggleCodeOutput()` — same pattern for `outputVisible`

Both use the existing `getCodeIds()` helper (prefers `codeEditingId` over `selectedIds`).

### 9. `client/src/lib/utils/selection-utils.ts`

**New imports:** `getHeaderVisible`, `getOutputVisible`.

**Extended `SelectedStyles`** with:
```typescript
codeHeaderVisible: boolean | null;
codeOutputVisible: boolean | null;
```

**Updated `EMPTY_STYLES`** with `codeHeaderVisible: null, codeOutputVisible: null`.

**Updated `computeStyles`** for `codeOnly` kind to read and return `codeHeaderVisible` and `codeOutputVisible` from first code object.

**Updated `stylesEqual`** to check new fields.

**Updated non-code return** to include `codeHeaderVisible: null, codeOutputVisible: null`.

### 10. `client/src/components/context-menu/ContextMenu.tsx`

**New imports:** `toggleCodeHeader`, `toggleCodeOutput` from selection-actions. `IconCodeHeader`, `IconCodeOutput` from icons.

**`CodeStyleGroup` update:**
- Changed from single `selectCodeFontSize` selector to `selectCodeStyles` returning `{ fontSize, headerVisible, outputVisible }` via `useShallow`
- Added two `MenuButton` toggles after CodeLines button:
  - `IconCodeHeader` — active when `headerVisible === true`, calls `toggleCodeHeader`
  - `IconCodeOutput` — active when `outputVisible === true`, calls `toggleCodeOutput`

### 11. `client/src/components/context-menu/icons/CodeIcons.tsx`

**New icons:**
- `IconCodeHeader` — 16x16 viewBox, rect top bar (opaque) + stroke bottom box (header metaphor)
- `IconCodeOutput` — 16x16 viewBox, stroke top box + opaque bottom bar (output metaphor)

### 12. `client/src/components/context-menu/icons/index.ts`

**Updated export** to include `IconCodeHeader`, `IconCodeOutput` from CodeIcons.

---

## Invalidation Path

- `headerVisible`/`outputVisible` change → deep observer fires → `computeCodeBBox` reads fresh props → computes correct `blockHeight` → overwrites cached frame → dirty rect invalidation
- `title` change → no geometry change, just redraw via dirty rect from observer
- `output` change with `outputVisible=true` → height may change → frame recomputed by `computeCodeBBox`
- CacheEntry unchanged — no chrome state cached in code-system's CacheEntry

---

## Known Issues (Second Pass)

### Critical

1. **Title input does not save**

2. **Code background disappears on editor mount** 

### Design / Data Separation

4. **`createHeaderDiv` reads props unnecessarily** — The method takes `props` (the full CodeProps return) but only needs `fontSize`, `language`, and the handle's Y.Map for title resolution. The `ReturnType<typeof getCodeProps> & {}` type annotation is awkward.

5. **Title resolution in `createHeaderDiv` is convoluted** — First tries to read from `props.content.doc!` (wrong approach, accessing Y.Doc internals), then overwrites from handle. Should just read from handle.y directly.

6. **Scale-dependent inline styles everywhere** — Header, output, play button sizes are all set as inline styles computed from `fontSize * scale`. This duplicates logic between `createHeaderDiv`/`createOutputDiv` and `positionEditor`. Should consider a unified sizing pass.

7. **Play button style is inline** — Background color, box-shadow, SVG dimensions all hardcoded as inline styles in `createHeaderDiv`. Should use CSS class + CSS variables or at minimum consolidate with the canvas render constants.

### Missing from Plan

14. **`CLAUDE.md` docs** — The code system CLAUDE.md was NOT updated with header/output documentation.

15. **Clipboard serialization** — The plan didn't mention it, and nothing was done. Copy/paste of code blocks should naturally carry the new Y.Map fields since the clipboard serializer copies all Y.Map keys. Needs verification.

---

## Pass 2 Changes

### Bugs Fixed

1. **Title save (double-call deletion):** `saveTitle()` was called twice during close — once explicitly in `commitAndClose()`, then again via the blur listener when `removeChild()` detached the input from DOM. The second call saw the just-saved title as `defaultTitle` (via `(y.get('title') as string) || fallback`), matched it against `trimmed`, and deleted it. Fixed by: (a) nulling `titleInput` immediately after the first save to block blur re-entry, (b) comparing against the fallback title (`Untitled.${ext}`) only, never the stored value.

2. **Title read in `createHeaderDiv`:** Was reading from `props.content.doc!.getMap('root').get('objects')` — the wrong Y.Map entirely. Signature changed from `(container, props, scale)` to `(container, y: Y.Map, fs, scale)`. Reads title inline: `y.get('title') as string || fallback`.

3. **DOM background transparent:** `.code-editor` had no background. Added `background: #060521` (CODE_BG) to CSS. Removed `background: transparent` from `.code-header`.

4. **Output panel DOM height mismatch:** Canvas `outputPanelHeight` includes `padB = fs * OUTPUT_PAD_BOTTOM_RATIO` (0.8) at the bottom. DOM output div had zero bottom padding. Added `padding-bottom: fs * 0.8 * scale` to both `createOutputDiv` and `positionEditor`.

### API Cleanup

5. **`CodeChrome` interface removed** from `code-system.ts`. `renderCodeLayout` signature changed from `(..., chrome?: CodeChrome)` to `(..., title?: string, output?: string)`. `undefined` = section hidden, present = section visible. Callers in `objects.ts` build title/output inline from props.

6. **`getCodeTitle` / `getRawCodeTitle` deleted** from `object-accessors.ts`. `CODE_EXTENSIONS` exported instead. All call sites use inline `(y.get('title') as string) || \`Untitled.${CODE_EXTENSIONS[lang]}\``.

7. **`createOutputDiv` signature simplified** from `(container, props, scale)` to `(container, y: Y.Map, fs, scale)`. Same pattern as header.

### Removed

8. **Ctrl+Enter keymap** deleted from CM extensions (was toggling header, hijacking expected newline).

9. **"No output" placeholder** removed from both canvas renderer (deleted else branch) and DOM (`props.output ?? ''` instead of `'No output'`).

### Current State

- `object-accessors.ts`: `CODE_EXTENSIONS` exported. `getCodeTitle`/`getRawCodeTitle` gone.
- `code-system.ts`: No `CodeChrome`. `renderCodeLayout` takes `title?: string, output?: string`. Padding ratios unchanged (1.5/1.5).
- `objects.ts`: Three render functions (`drawCode`, `drawScaledCodePreview`, `drawReflowedCodePreview`) build title/output inline from `CODE_EXTENSIONS` + props.
- `CodeTool.ts`: `createHeaderDiv(container, y, fs, scale)`, `createOutputDiv(container, y, fs, scale)`. Title save uses fallback-only comparison. `titleInput` nulled before DOM removal. Output div has correct bottom padding.
- `index.css`: `.code-editor` has `background: #060521`. `.code-header` has no explicit background.

### Still Buggy

- Chevron collapse affordances not implemented (removed after failed attempt — needs redesign with canvas+DOM parity)
- Play button is non-functional (decorative only)
- Overall DOM/canvas alignment still needs visual QA pass

