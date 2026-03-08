# Code Block System — Implementation Log

**Date:** 2026-03-08
**Branch:** `feature/code-blocks`
**Status:** Phases 1–3 complete (foundation + editing + syntax highlighting). Phase 4 pending.
**Typecheck:** Passing clean across all workspaces.

---

## What Was Built

Phases 1–3 of the code block system:

- **Phase 1:** Canvas-rendered code blocks with dark background, line numbers, click-to-place creation, selection/hit-testing, spatial indexing, dirty rects, undo, and a minimal context menu (font size stepper).
- **Phase 2:** CodeMirror 6 DOM overlay editing with y-codemirror.next for collaborative Yjs binding. Center-placement, escape/click-outside handlers, zoom/pan repositioning, per-session undo, tab normalization.
- **Phase 3:** Two-tier syntax highlighting — sync regex tokenizer (floor, ~30-50us, instant) + Lezer incremental parser in a 2-worker pool (ceiling, ~1ms, full accuracy). WYSIWYG: canvas and CodeMirror editor share the same One Dark color palette.

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

**Key decisions:**

- `Y.Text` not `Y.XmlFragment` — code is plain text. Y.Text delta events map to Lezer's `ChangedRange` for incremental parsing.
- `origin` = top-left (not baseline like text objects). Code blocks are rectangular, no alignment modes.
- `width` always stored — no 'auto' mode. Code blocks have a fixed visual container.
- Height derived from `lineCount * lineHeight + padding`, cached in code system.
- No `color`/`fillColor` fields — dark theme is fixed chrome.
- `fontSize` is the scale key — all dimensions scale proportionally.
- Empty code blocks are NOT deleted on close (unlike text) — they are decorated objects with visible dark bg + line numbers.

---

## Two-Tier Tokenization (Floor + Ceiling)

```
Frame N:   Y.Text change (local typing or remote sync)
           -> observer fires SYNCHRONOUSLY
           -> syncTokenize runs (~30-50us) — regex-based per-language
           -> cache tokens updated with correct regex spans
           -> worker.postMessage dispatched (async)

Frame N:   rAF fires, renderer calls getLayout()
           -> gets regex tokens -> draws correct colors
           (worker hasn't responded yet — doesn't matter)

Frame N+1: worker responds with Lezer tokens
           -> cache tokens upgraded, layout nulled
           -> NO invalidateWorld (observer dirty rect already covers it)

Frame N+1: rAF fires, renderer calls getLayout()
           -> gets Lezer tokens -> draws correct colors
           (if regex and Lezer agree — ~95% of cases — no visible change)
```

**Sync regex tokenizer** handles: keywords (language-specific sorted sets), strings (single/double/backtick/triple-quote), numbers (int/float/hex), comments (line `//` and block `/* */` for JS/TS, `#` for Python), operators, punctuation. Heuristic classification: identifier followed by `(` = function (blue), uppercase first char = type (yellow), keyword set member = keyword (purple bold), else = variable (red).

**Lezer worker pool:** 2 workers created at first `requestParse()`, persist for app lifetime. Round-robin dispatch. Each worker owns per-object parse state (Tree + TreeFragments) for incremental parsing. Token extraction via `highlightTree` with a tag highlighter mapping Lezer tags to `TAG_STYLES` colors.

---

## Code Files (2)

### `client/src/lib/code/code-system.ts`

Merged module (replaces Phase 1's code-constants, code-layout-cache, code-renderer). Organized in 8 sections:

| Section             | Contents                                                                      |
| ------------------- | ----------------------------------------------------------------------------- |
| §1 Constants        | Font, sizing, dark theme palette, token colors (One Dark), derived helpers    |
| §2 Types            | `CodeToken`, `CodeLayoutLine`, `CodeLayout`, `TAG_STYLES` map                 |
| §3 Sync Tokenizer   | `syncTokenize(text, language)` — main-thread regex tokenizer                  |
| §4 Cache            | `CodeSystemCache` singleton — text, lines, tokens, layout, frame              |
| §5 Worker Pool      | 2 warm workers, round-robin, `requestParse`/`requestRemove`/`requestClearAll` |
| §6 Delta Conversion | `deltaToChangedRanges(delta)` — Y.Text delta to Lezer ChangedRange[]          |
| §7 Canvas Renderer  | `renderCodeLayout(ctx, layout, originX, originY)`                             |
| §8 CodeMirror Theme | `getCodeMirrorExtensions()` — lazy-loaded theme + highlight style             |

**Cache entry:**

```typescript
interface CacheEntry {
  text: string; // Always current after handleContentChange
  lines: string[]; // Always split
  tokens: CodeToken[][] | null; // null only before first content; stale kept
  layout: CodeLayout | null; // null = needs recompute
  layoutFontSize: number;
  layoutWidth: number;
  frame: FrameTuple | null;
}
```

**Critical change from Phase 1:** `handleContentChange()` runs `syncTokenize()` immediately — tokens are NEVER null after first content. The worker's Lezer tokens replace regex tokens when ready (upgrade, not fill-from-null).

**Public API:**
| Method | Called by | Does |
|--------|-----------|------|
| `getLayout(id, yText, fontSize, width, lang)` | `computeCodeBBox`, `drawCode` | Rebuild if stale, return cached |
| `handleContentChange(id, text, lines, lang)` | Deep observer | Update text+lines, run syncTokenize, null layout/frame |
| `applyTokens(id, tokens)` | Worker response | Set Lezer tokens, null layout (not frame) |
| `getCodeFrame(id)` | Hit testing, selection | Read cached frame |
| `setFrame(id, frame)` | `computeCodeBBox` | Store derived frame |
| `remove(id)` / `clear()` | Deletion / room change | Cleanup + worker notification |
| `requestParse(id, text, lang, changes?)` | Deep observer | Dispatch to worker pool |

---

### `client/src/lib/code/lezer-worker.ts`

Web Worker (one of 2 in pool). Owns per-object parse state.

**Protocol:**

```
Main -> Worker: { type:'parse', id, text, language, changes? }
Main -> Worker: { type:'remove', id }
Main -> Worker: { type:'clearAll' }
Worker -> Main: { type:'tokens', id, tokens: CodeToken[][] }
```

Incremental parsing: `TreeFragment.applyChanges()` + `parser.parse(text, fragments)`. Token extraction via `highlightTree` + `tagHighlighter` mapping Lezer tags to `TAG_STYLES`. Multi-line tokens split at line boundaries for per-line `CodeToken[][]`.

---

## CodeTool.ts

Full tool: click-to-place + CodeMirror DOM overlay editing.

**State:**

```typescript
private gestureActive, pointerId, downWorld, hitCodeId;  // gesture
objectId: string | null;                                  // current editing target
private container, editorView, sessionUM;                 // editor
private boundHandleKeyDown, boundHandleClickOutside;      // handler refs
```

**Lifecycle:**

- `begin()` -> hit test for existing code blocks
- `end()` -> if hit: `mountEditor(hitCodeId)`. Else: `createCodeObject(x,y)` -> rAF -> `mountEditor(id)`
- `onViewChange()` -> `positionEditor()` (scale-aware repositioning)
- `destroy()` -> `commitAndClose()`

**`createCodeObject()`:** Center placement — origin = click minus half block size. Empty `Y.Text()` content, editor mounts immediately after rAF.

**`mountEditor(objectId)`:**

1. Close existing editor if open
2. Create container div (`.code-editor`, absolute positioned at worldToClient origin)
3. Lazy-load CodeMirror modules (parallel `Promise.all` of 7 imports + theme extensions)
4. Create per-session `Y.UndoManager(yText)`, tab normalizer extension
5. `EditorState.create()` with: lineNumbers, language, indentUnit, yCollab, theme, tab filter
6. `EditorView({ state, parent: container }).focus()`
7. `beginCodeEditing(objectId)` on selection store
8. Widen main UM captureTimeout to 600s, setup escape + click-outside handlers

**`commitAndClose()`:** Does NOT delete empty blocks (unlike TextTool). Destroys EditorView, restores main UM captureTimeout to 500ms, clears session UM, removes container, calls `endCodeEditing()`, invalidates world + overlay.

**Public API for SelectTool:**

- `startEditing(objectId)` — double-click-to-edit
- `isEditorMounted()` — guard

---

## Deep Observer Changes (room-doc-manager.ts)

```
Y.Text content change on code object:
  -> ev instanceof Y.YTextEvent
  -> yText.toString() -> text, lines
  -> codeSystem.handleContentChange(id, text, lines, lang)  // sync tokenize
  -> requestParse(id, text, lang, changes)                    // async worker
```

Delta forwarding: `deltaToChangedRanges(ev.delta)` converts Y.Text delta to Lezer `ChangedRange[]` for incremental parsing.

**Deletion bridge:** If `codeEditingId` matches a deleted object, calls `endCodeEditing()`.

---

## Selection Store Additions

```typescript
// State
codeEditingId: string | null;

// Actions
beginCodeEditing: (objectId) => set({ codeEditingId: objectId, menuOpen: true }) + refreshStyles();
endCodeEditing: () => set({ codeEditingId: null, menuOpen: selectedIds.length > 0 });
```

---

## CSS (index.css)

```css
.code-editor {
  pointer-events: auto;
  z-index: 1000;
  border-radius: 8px;
  overflow: hidden;
}
.code-editor .cm-editor {
  height: auto;
  border-radius: 8px;
  outline: none;
}
.code-editor .cm-editor.cm-focused {
  outline: none;
}
.code-editor .cm-scroller {
  font-family: 'JetBrains Mono', monospace;
  overflow: auto;
}
```

Most styling via `codeEditorTheme` (JS, not CSS) for WYSIWYG parity.

---

## Dependencies Added (client/package.json)

```
@codemirror/state  @codemirror/view  @codemirror/commands  @codemirror/language
@codemirror/lang-javascript  @codemirror/lang-python
@lezer/highlight  @lezer/common
y-codemirror.next
```

---

## File Map (Phases 1-3)

| File                                       | Status                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `client/src/lib/code/code-system.ts`       | **NEW** (merged from 3 Phase 1 files + tokenizer + worker comm + theme) |
| `client/src/lib/code/lezer-worker.ts`      | **NEW**                                                                 |
| `client/src/lib/tools/CodeTool.ts`         | **REWRITTEN** (Phase 1 stub -> full editor)                             |
| `client/src/lib/room-doc-manager.ts`       | modified (delta forwarding, code editing deletion bridge)               |
| `client/src/stores/selection-store.ts`     | modified (beginCodeEditing/endCodeEditing)                              |
| `client/src/renderer/layers/objects.ts`    | modified (import update)                                                |
| `client/src/lib/geometry/hit-testing.ts`   | modified (import update)                                                |
| `client/src/lib/utils/selection-utils.ts`  | modified (import update)                                                |
| `client/src/index.css`                     | modified (CodeMirror overlay CSS)                                       |
| `client/package.json`                      | modified (+9 dependencies)                                              |
| `client/src/lib/code/code-constants.ts`    | **DELETED** (merged into code-system.ts)                                |
| `client/src/lib/code/code-layout-cache.ts` | **DELETED** (merged into code-system.ts)                                |
| `client/src/lib/code/code-renderer.ts`     | **DELETED** (merged into code-system.ts)                                |

---

## What's NOT Done (Phase 4)

### Phase 4 — Selection & Transforms

- Transform previews: uniform scale (corner), width resize (E/W), translate
- Scale commit: write fontSize + origin + width to Y.Map
- Context menu: language dropdown (JS/TS/Python)
- `FilterObjectsDropdown` update for code blocks in mixed selections
- Cursor change for code tool (crosshair or code-specific)
