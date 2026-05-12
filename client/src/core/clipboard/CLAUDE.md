# Clipboard Subsystem

Copy, paste, cut, duplicate, and select-all for whiteboard objects. Nonce-based internal/external paste detection. Supports full-fidelity internal paste (Y.Map duplication with ID remapping), rich text from external HTML, image paste, and URL→bookmark conversion.

## File Map

| File | Purpose |
|------|---------|
| `core/clipboard/clipboard-actions.ts` | All operations: copy, paste (internal/external/image/URL), cut, duplicate, selectAll |
| `core/clipboard/clipboard-serializer.ts` | Serialize/deserialize Y.Map objects + Y.XmlFragment content to JSON |

---

## Nonce System (Internal vs External Paste)

Every `copySelected()` generates a UUID nonce. The nonce is stored in module-level state alongside the serialized payload, and also written into the system clipboard as an HTML comment:

```
<!-- avlo:<uuid> --> <escaped plain text>
```

On paste, the HTML is read first. If it contains a matching nonce → **internal paste** (full fidelity from in-memory payload). If the nonce doesn't match or is absent → **external paste** (HTML parsing or plain text). On nonce mismatch, the stored payload is cleared.

This two-channel approach means:
- Internal paste preserves all object properties, rich text formatting, connector anchors, and positioning
- External paste from browsers/editors preserves bold/italic/highlight formatting via HTML parsing
- External paste from terminals (no HTML) falls back to plain text

---

## Serialization Format

```typescript
interface ClipboardPayload {
  version: 1;
  objects: SerializedObject[];
  bounds: BBoxTuple;               // [minX, minY, maxX, maxY] of all serialized objects
}

interface SerializedObject {
  kind: ObjectKind;
  props: SerializedProps;          // All Y.Map entries except content; id/kind/ownerId/createdAt typed
  content?: SerializedContent;     // Y.XmlFragment (text, shapes with labels, notes)
  textContent?: string;            // Y.Text (code blocks)
  cachedStart?: Point;             // Connectors only — start endpoint from route at copy time (paste fallback)
  cachedEnd?: Point;               // Connectors only — end endpoint from route at copy time (paste fallback)
}

type SerializedProps = { id: string; kind: ObjectKind; ownerId: string; createdAt: number } & Record<string, unknown>;

interface SerializedContent {
  paragraphs: SerializedParagraph[];
}

type MarkAttrs = { bold?: true; italic?: true; highlight?: string };

interface SerializedParagraph {
  delta: { insert: string; attributes?: MarkAttrs }[];
}
```

**Serialize flow:** `serializeObjects(ids)` iterates ObjectHandles from snapshot, serializes each Y.Map. Y.XmlFragment content → paragraph deltas (preserving bold/italic/highlight attributes). Y.Text content → plain string. BBox tracked from handle.bbox for bounds computation. For connectors, the current route's first/last points are cloned into `cachedStart`/`cachedEnd` (router buffer is pooled, so clone is required) — used as paste-fallback when an anchored target shape isn't present (cross-room paste, or copy → delete → paste in same room).

**Deserialize flow:** `deserializeFragment(content)` rebuilds Y.XmlFragment → Y.XmlElement('paragraph') → Y.XmlText with delta attributes. `extractPlainText(objects)` joins text content across objects for clipboard plain text.

**Pending Y-type construction gotcha.** Fragment builders (`deserializeFragment`, `prosemirrorJsonToFragment`, `pasteExternalText`, `pasteUrlAsText`) never read `.length` on the in-flight Y.XmlFragment / Y.XmlText — Yjs warns on reads from unattached types ("Invalid access: Add Yjs type to a document before reading data"). Instead, collect children in a plain JS array and `fragment.insert(0, children)` once at the end; track text-delta positions with a local counter. Writes on pending types queue fine and are integrated atomically when the root is attached via `yObj.set('content', fragment)`.

---

## Copy

`copySelected()`:
1. Reads `selectedIds` from selection store
2. Calls `serializeObjects(selectedIds)` → `ClipboardPayload`
3. Generates UUID nonce, stores nonce + payload in module-level state
4. Writes to system clipboard via `navigator.clipboard.write()`:
   - `text/html`: nonce comment + escaped plain text
   - `text/plain`: extracted text from all objects
5. Fallback: `writeText()` if `ClipboardItem` fails

No character limit on copy. Plain text is space-padded if empty (clipboard API rejects empty strings).

---

## Paste Dispatch

`pasteFromClipboard()` reads from `navigator.clipboard.read()` and dispatches by priority:

1. **Image type** (`item.types.find(t => t.startsWith('image/'))`) → `pasteImage(blob)`
2. **HTML** (`text/html`) → check nonce:
   - Matching nonce + stored payload → `pasteInternal(payload)`
   - Mismatch → clear stored state → `pasteExternalHtml(html)`
3. **Plain text** → `pasteExternalText(text)`
4. **Fallback**: `readText()` if `clipboard.read()` fails

The paste handler (`handlePaste` in keyboard-manager) also checks `clipboardData.files` for OS file paste (Finder drag-to-clipboard) before calling `pasteFromClipboard()`.

---

## Internal Paste

`pasteInternal(payload, offset?)` — full-fidelity object duplication.

### ID Remapping
Every object gets a new ULID. An `idMap` (old→new) is built upfront and used for object IDs. Connector endpoints (`start`/`end`) go through a richer dispatch — see Property Remapping below.

### Position Offset
- **Explicit offset** (duplicate): uses provided `[dx, dy]`
- **No offset** (paste): computes target position → `getPasteTarget()`:
  - Cursor world position if available (`getLastCursorWorld()`)
  - Otherwise viewport center (`bboxCenter(getVisibleBoundsTuple())`)
  - Offset = target - payload bounds center

### Property Remapping
Each property is handled per-key in a switch:
- `id` → new ULID from idMap
- `ownerId` → current user ID
- `createdAt` → current timestamp
- `frame` → `[x+dx, y+dy, w, h]`
- `origin` → `[x+dx, y+dy]`
- `points` → each point offset by `[dx, dy]`
- `start`/`end` (connector endpoint union, discriminated by `Array.isArray`):
  - Free `Point` → offset by `[dx, dy]`
  - `StoredAnchor` → 4-step fallback:
    1. Target in paste set → write remapped anchor (id → idMap)
    2. Else target still exists in canvas → keep anchor unchanged (rebinds correctly)
    3. Else `cachedStart`/`cachedEnd` present → translate cached point and write as free Point (no dangling `anchor.id` leaks)
    4. Else last-ditch → translated payload bbox center as free Point
- Everything else → copied as-is

### Content Deserialization
- `content` (SerializedContent) → `deserializeFragment()` → new Y.XmlFragment
- `textContent` (string) → new Y.Text with content inserted

### Post-Paste
- Image assets enqueued for upload (viewport management handles decode)
- Internal-pasted bookmarks have all data present — no re-unfurl needed
- **Gesture-aware**: if a tool is active (mid-gesture), objects are created silently. Tool switch + selection only happens when idle.
- `ensureVisible(placedBounds)` — camera animation if placed content is off-screen

---

## External HTML Paste

`pasteExternalHtml(html)`:
1. Strip any stale avlo nonce comment
2. Extract plain text (strip HTML tags) for char limit check
3. **URL detection**: if plain text starts with a URL → `createBookmarkFromUrl()` + paste remainder as text
4. **Character limit**: > 50,000 chars → fall back to truncated plain text
5. Parse HTML via `generateJSON()` from `@tiptap/core` with paste extensions:
   - Document, Paragraph, Text, Bold, Italic, Highlight (multicolor)
6. Convert ProseMirror JSON → Y.XmlFragment via `prosemirrorJsonToFragment()`
7. Fallback: plain text paste if parsing fails or produces empty content

### ProseMirror JSON → Y.XmlFragment

Walks the doc content array, processes only `paragraph` nodes:
- For each paragraph: creates Y.XmlElement('paragraph') + Y.XmlText
- For each inline text node: reads marks array for bold/italic/highlight
  - `bold` mark → `{ bold: true }`
  - `italic` mark → `{ italic: true }`
  - `highlight` mark → `{ highlight: mark.attrs.color || DEFAULT_HIGHLIGHT }` (exported constant)
- Inserts text with attributes into Y.XmlText
- Returns null if no content found (triggers plain text fallback)

---

## External Text Paste

`pasteExternalText(text)`:
1. Empty check (trim)
2. **URL detection**: if text starts with a URL → bookmark + paste remainder recursively
3. **Character limit**: truncate at 50,000 chars
4. Split by newlines → one Y.XmlElement('paragraph') per line
5. Create text object via `createPastedTextObject()`

---

## Shared Text Object Creation

`createPastedTextObject(fragment, charCount, position?, existingId?)`:

Reads device-ui-store text preferences (fontSize, fontFamily, color, align, fillColor).

### Paste Width Logic
- **Short text** (< 65 chars): `width: 'auto'` — natural sizing, no wrapping box
- **Longer text** (>= 65 chars): `width = max(300, fontSize * 34)` — ~65 chars per line at any font size

### Horizontal Centering (Fixed-Width Pastes)
For fixed-width pastes, origin is shifted so the text bbox is symmetric around the paste target's worldX:
- `originX = worldX + pasteWidth * (anchorFactor(align) - 0.5)` — deterministic because `pasteWidth` is known up front.
- Auto-width pastes leave origin at worldX (left/right alignment would need a post-layout measurement; center-align collapses to worldX via the same formula).
- `ensureVisible()` uses the same symmetric box: `[worldX - pasteWidth/2, worldY, worldX + pasteWidth/2, worldY]`.

### Object Creation
Creates Y.Map with: id, kind='text', origin, fontSize, fontFamily, color, align, width, content, optional fillColor, ownerId, createdAt.

### Post-Create
- Gesture-aware tool switch + selection (same as internal paste)
- `ensureVisible()` only for fixed-width pastes (auto-width = short text, already near cursor/viewport)

---

## URL → Bookmark Paste

Both `pasteExternalText()` and `pasteExternalHtml()` check for leading URLs before proceeding.

`extractLeadingUrl(text)`:
- Trims text, takes first line
- Validates via `normalizeUrl()` (HTTP/HTTPS only)
- Returns `{ url, remainder }` or null

`createBookmarkFromUrl(url)`:
- Checks `canCreateBookmark()` — offline guard
- If offline: `pasteUrlAsText()` → creates text object with URL as content
- If online: `beginUnfurl(url, worldX, worldY)` → enters bookmark pipeline

If there's text after the URL (remainder), it's pasted separately as a text object via recursive `pasteExternalText()`.

---

## Image Paste

`pasteImage(blob)`:
- Gets paste target position
- Calls `createImageFromBlob(blob, worldX, worldY, { selectAfter })` from image subsystem
- `selectAfter` is true only when no tool gesture is active

Also exported as public API for drag-drop image handling.

---

## Cut

`cutSelected()`: async copy → synchronous `deleteSelected()`.

---

## Duplicate

`duplicateSelected()`:
1. Serialize current selection
2. Compute smart offset via `computeSmartOffset()`
3. Call `pasteInternal()` with computed offset

### Smart Duplicate Placement

`computeSmartOffset(bounds, excludeIds)` tries four directions in priority order:

1. **Right** of selection bounds (width + 20px gap)
2. **Below** (height + 20px gap)
3. **Above**
4. **Left**

For each candidate direction:
- Constructs a query bounds (candidate position ± 2px epsilon for edge-touching detection)
- Queries spatial index for collisions
- Excludes original selected objects from collision check
- First direction with zero collisions wins

**Fallback**: `[40, 40]` diagonal offset if all four directions are occupied.

---

## Select All

`selectAll()`:
- Gets all object IDs from `getObjectsById()`
- Switches to select tool, sets selection, invalidates overlay

---

## Visibility / Zoom-to-Fit

`ensureVisible(bounds)`:
- Checks if bounds are fully contained within current viewport (early return if so)
- Calls `animateToFit(bounds, padding=80, maxScale=currentScale, minScale=0.25)`
- **Only zooms out** — maxScale capped at current camera scale
- **Floor at 25%** — prevents extreme zoom-out on huge pasted content
- Skipped for auto-width pastes (short text, always near cursor/viewport)

---

## Constants

```
PASTE_CHAR_LIMIT  = 50,000     Max chars for external paste (HTML falls back to truncated text)
PASTE_EXTENSIONS               Tiptap extensions for HTML parsing: Document, Paragraph, Text, Bold, Italic, Highlight(multicolor)
```

---

## Integration Points

### Keyboard Manager (`runtime/keyboard-manager.ts`)
- `Cmd+C` → `copySelected()`
- `Cmd+X` → `cutSelected()` (blocked during active gesture)
- `Cmd+D` → `duplicateSelected()` (blocked during active gesture)
- `Cmd+A` → `selectAll()` (cancels non-select tool gesture first)
- `Cmd+V` handled via DOM paste event → `handlePaste()` → `pasteFromClipboard()`

### InputManager (`runtime/InputManager.ts`)
- Registers `document` paste listener → forwards to `handlePaste()` in keyboard-manager
- OS file paste (Finder copy) → `clipboardData.files` → `pasteImage()`

### Cursor Tracking (`runtime/cursor-tracking.ts`)
- `getLastCursorWorld()` provides paste target position
- Updated by `CanvasRuntime.handlePointerMove()`

### Selection Store
- `selectedIds` read for copy/duplicate source
- `setSelection()` called after paste/duplicate/selectAll

### Device UI Store
- Text preferences read for external text paste (fontSize, fontFamily, color, align, fillColor)
- `setActiveTool('select')` called after paste operations

### Bookmark Subsystem (`core/bookmark/`)
- `canCreateBookmark()` — offline guard for URL paste
- `beginUnfurl()` — starts bookmark pipeline for pasted URLs
- Detailed docs: `core/bookmark/CLAUDE.md`

### Image Subsystem (`core/image/`)
- `createImageFromBlob()` — creates image objects from pasted images
- `enqueue()` — enqueues image assets from internal paste for upload
- Detailed docs: `core/image/CLAUDE.md`

### Zoom (`runtime/viewport/zoom.ts`)
- `animateToFit()` — camera animation for off-screen pasted content
