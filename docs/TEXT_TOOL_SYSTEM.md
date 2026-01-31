# Text Tool System Documentation

**Status:** Work in progress - WYSIWYG phase complete
**Last Updated:** January 2025

## Overview

The text tool implements a **WYSIWYG rich text system** with:
- **DOM overlay during editing:** Tiptap editor mounted as an absolute-positioned div
- **Canvas rendering on exit:** Y.XmlFragment content rendered via canvas
- **Precise positioning:** Measured font metrics ensure DOM ↔ canvas baseline alignment
- **CRDT synchronization:** Y.XmlFragment enables real-time collaboration via Tiptap's Collaboration extension

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           USER INTERACTION                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TextTool.ts                                     │
│  PointerTool implementation: begin/end creates object, mounts editor        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
┌──────────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│    Y.Doc         │    │   Tiptap Editor      │    │  Selection Store │
│  Y.XmlFragment   │◄───┤   (DOM overlay)      │    │  textEditingId   │
│  (content CRDT)  │    │   Collaboration ext  │    │  textEditingIsNew│
└────────┬─────────┘    └──────────────────────┘    └──────────────────┘
         │                         │
         │                         │ On blur/ESC
         │                         ▼
         │              ┌──────────────────────┐
         │              │   commitAndClose()   │
         │              │   - Destroy editor   │
         │              │   - Remove DOM       │
         │              │   - Update stores    │
         │              └──────────────────────┘
         │
         ▼ Observer fires on Y.XmlFragment changes
┌─────────────────────────────────────────────────────────────────────────────┐
│                          room-doc-manager.ts                                 │
│  - textLayoutCache.invalidate() on content changes                          │
│  - textLayoutCache.invalidateLayout() on fontSize changes                   │
│  - computeTextBBox() for spatial index                                      │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            text-system.ts                                    │
│  parseYXmlFragment() → layoutContent() → renderTextLayout()                 │
│  TextLayoutCache: caches parsed content + measured layout                   │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       renderer/layers/objects.ts                             │
│  drawText(): skips if textEditingId matches, else renders from cache        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File Responsibilities

| File | Purpose |
|------|---------|
| `lib/tools/TextTool.ts` | PointerTool implementation, editor mounting, Y.Map creation |
| `lib/text/text-system.ts` | Font config, parsing, layout engine, cache, renderer |
| `renderer/layers/objects.ts` | `drawText()` function, editing skip logic |
| `stores/selection-store.ts` | `textEditingId`, `textEditingIsNew` state |
| `stores/device-ui-store.ts` | `textSize`, `isTextEditing` state |
| `lib/room-doc-manager.ts` | Cache invalidation, BBox computation |
| `canvas/SurfaceManager.ts` | `getEditorHost()` - DOM container access |
| `canvas/Canvas.tsx` | `editorHostRef` div mounting |

---

## Y.Doc Object Schema

Text objects use **origin-based positioning** with **Y.XmlFragment content**:

```typescript
{
  id: string,                    // ULID
  kind: 'text',
  origin: [number, number],      // World position of first line BASELINE
  fontSize: number,              // Font size in world units
  color: string,                 // Hex color
  widthMode: 'auto',             // Reserved for future wrapping
  content: Y.XmlFragment,        // Rich text content (Tiptap structure)
  ownerId: string,
  createdAt: number
}
```

### Why `origin` Instead of `frame`?

Text uses **baseline positioning** unlike shapes which use **bounding box positioning**:
- `origin[0]` = X position of left edge of first character
- `origin[1]` = Y position of first line's **baseline** (not top!)

This allows precise cursor-to-baseline alignment when clicking to create text.

---

## Y.XmlFragment Structure

Tiptap/ProseMirror stores documents as:

```
Y.XmlFragment
├── Y.XmlElement('paragraph')
│   └── Y.XmlText (with delta for bold/italic attributes)
├── Y.XmlElement('paragraph')
│   └── Y.XmlText
└── ...
```

Each `Y.XmlText` node has a `toDelta()` method returning rich text operations:

```typescript
[
  { insert: 'Hello ', attributes: { bold: true } },
  { insert: 'world', attributes: {} }
]
```

---

## Text System Pipeline (`text-system.ts`)

### 1. Font Configuration

```typescript
FONT_CONFIG = {
  family: 'Grandstander',
  fallback: '"Grandstander", cursive, sans-serif',
  weightNormal: 550,
  weightBold: 800,
  lineHeightMultiplier: 1.3,  // CSS line-height = fontSize * 1.3
}
```

### 2. Font Metrics (Measured)

The system **measures** actual font metrics rather than approximating:

```typescript
getMeasuredAscentRatio(): number
// Uses canvas fontBoundingBoxAscent to get exact ascent ratio
// Cached after first measurement

getBaselineToTopRatio(): number
// = halfLeading + measuredAscentRatio
// = (1.3 - 1) / 2 + ascentRatio
// = 0.15 + ~0.88 ≈ 1.03
```

**Why this matters:** CSS line-height adds "leading" space above and below text. To align DOM text baseline with canvas text baseline, we need the exact offset from container top to baseline.

### 3. Parser: `parseYXmlFragment()`

Converts Y.XmlFragment to structured content:

```typescript
interface ParsedContent {
  paragraphs: ParsedParagraph[];
  structuralHash: number;      // For change detection
  charCount: number;
}

interface ParsedParagraph {
  runs: ParsedRun[];           // Coalesced runs with same formatting
  isEmpty: boolean;
}

interface ParsedRun {
  text: string;
  bold: boolean;
  italic: boolean;
}
```

**Key details:**
- Walks `Y.XmlElement('paragraph')` children
- Extracts delta via `Y.XmlText.toDelta()`
- **Coalesces** consecutive runs with same bold/italic (reduces layout work)
- Computes structural hash from concatenated text (for cache invalidation)

### 4. Layout Engine: `layoutContent()`

Measures text and computes positions:

```typescript
interface TextLayout {
  lines: MeasuredLine[];
  fontSize: number;
  lineHeight: number;
  inkBBox: { x, y, width, height };     // Actual drawn bounds
  logicalBBox: { x, y, width, height }; // Advance-based bounds
  structuralHash: number;
}

interface MeasuredLine {
  runs: MeasuredRun[];
  index: number;
  advanceWidth: number;
  inkBounds: { left, right, top, bottom };
  baselineY: number;                     // Relative to origin (0 for first line)
  lineHeight: number;
  isEmpty: boolean;
}

interface MeasuredRun {
  text: string;
  bold: boolean;
  italic: boolean;
  font: string;                          // Pre-computed ctx.font string
  advanceWidth: number;                  // Total advance width
  advanceX: number;                      // X offset from line start
  inkBounds: { left, right, top, bottom };
}
```

**Measurement uses canvas API:**
```typescript
ctx.measureText(run.text)
// Returns: width, actualBoundingBoxLeft/Right/Ascent/Descent
```

**Ink vs Logical Bounds:**
- **Ink bounds:** Actual pixels drawn (for accurate dirty rects)
- **Logical bounds:** Advance-based (for selection/cursor hit testing)

### 5. Cache: `TextLayoutCache`

Singleton cache for parsed content and layouts:

```typescript
class TextLayoutCache {
  getLayout(objectId, fragment, fontSize): TextLayout
  invalidate(objectId)        // Full invalidation (content changed)
  invalidateLayout(objectId)  // Layout only (fontSize changed)
  clear()                     // Full cache clear
  has(objectId): boolean
}

// Singleton export
export const textLayoutCache = new TextLayoutCache();
```

**Cache entry structure:**
```typescript
interface CacheEntry {
  parsed: ParsedContent;     // Reused if only fontSize changes
  layout: TextLayout;
  layoutFontSize: number;    // For staleness detection
}
```

**Smart invalidation:**
- Content change → delete entire entry
- FontSize change → mark `layoutFontSize = -1`, reuse parsed content

### 6. Renderer: `renderTextLayout()`

```typescript
renderTextLayout(ctx, layout, originX, originY, color)
```

- Sets `textBaseline = 'alphabetic'` for proper baseline alignment
- Origin is **baseline position** of first line
- Text extends **above** origin (ascent) and **below** (descent)
- Iterates lines → runs → `ctx.fillText()` at computed positions

### 7. BBox Computation: `computeTextBBox()`

```typescript
computeTextBBox(objectId, fragment, fontSize, origin): BBoxTuple
```

- Gets layout from cache
- Offsets ink bounds by origin
- Adds 2px padding for safety
- Used by room-doc-manager for spatial index

---

## TextTool Implementation (`TextTool.ts`)

### State Structures

```typescript
interface TextToolState {
  isActive: boolean;           // Gesture in progress
  pointerId: number | null;
  downWorld: [number, number] | null;  // Click position
}

interface EditorState {
  container: HTMLDivElement | null;    // Mounted DOM element
  editor: Editor | null;               // Tiptap Editor instance
  objectId: string | null;             // Y.Map object ID
  originWorld: [number, number] | null; // World position
  fontSize: number;
  color: string;
  isNew: boolean;                      // For empty deletion on blur
}
```

### PointerTool Lifecycle

```
canBegin() → true if not active and not currently editing text
     │
begin(pointerId, worldX, worldY)
     │ Store click position
     │
move() → no-op for text tool
     │
end()
     │
     ├─ createTextObject(x, y, fontSize, color)
     │      └─ Y.Map with empty Y.XmlFragment
     │
     ├─ beginTextEditing(objectId, isNew=true)
     │      └─ selection-store
     │
     └─ mountEditor(objectId, x, y, fontSize, color, isNew)
```

### Object Creation

```typescript
createTextObject(worldX, worldY, fontSize, color): string {
  roomDoc.mutate((ydoc) => {
    const yObj = new Y.Map();
    yObj.set('id', objectId);
    yObj.set('kind', 'text');
    yObj.set('origin', [worldX, worldY]);
    yObj.set('fontSize', fontSize);
    yObj.set('color', color);
    yObj.set('widthMode', 'auto');
    yObj.set('content', new Y.XmlFragment());  // Empty - Tiptap populates
    yObj.set('ownerId', userId);
    yObj.set('createdAt', Date.now());
    objects.set(objectId, yObj);
  });
  return objectId;
}
```

### Editor Mounting (DOM Overlay)

```typescript
mountEditor(objectId, worldX, worldY, fontSize, color, isNew) {
  // 1. Get editor host from SurfaceManager
  const host = getEditorHost();

  // 2. Get Y.XmlFragment from object
  const fragment = handle.y.get('content') as Y.XmlFragment;

  // 3. Create container div
  const container = document.createElement('div');
  container.className = 'text-editor-container';

  // 4. Calculate screen position (CRITICAL for alignment)
  const [screenX, screenY] = worldToClient(worldX, worldY);
  const scale = useCameraStore.getState().scale;
  const scaledFontSize = fontSize * scale;

  // Position: baseline aligns with origin
  const containerTop = screenY - scaledFontSize * getBaselineToTopRatio();
  const containerLeft = screenX;

  // 5. Apply positioning (inline) + dynamic values (CSS custom properties)
  container.style.position = 'absolute';
  container.style.left = `${containerLeft}px`;
  container.style.top = `${containerTop}px`;
  container.style.fontSize = `${scaledFontSize}px`;
  container.style.lineHeight = `${scaledFontSize * FONT_CONFIG.lineHeightMultiplier}px`;
  container.style.setProperty('--text-color', color);
  // Static styles handled by .text-editor-container CSS class

  // 6. Append to host
  host.appendChild(container);

  // 7. Create Tiptap Editor with CSS class-based styling
  const editor = new Editor({
    element: container,
    extensions: [
      Document,
      Paragraph.configure({ HTMLAttributes: { class: 'tiptap-paragraph' } }),
      Text,
      Bold.configure({ HTMLAttributes: { class: 'tiptap-bold' } }),
      Italic.configure({ HTMLAttributes: { class: 'tiptap-italic' } }),
      Collaboration.configure({ fragment }),  // CRDT sync!
    ],
    autofocus: 'end',
    editorProps: { attributes: { class: 'tiptap' } },
  });

  // 8. Setup handlers + update stores
  this.setupEditorHandlers();
  useDeviceUIStore.getState().setIsTextEditing(true);
}
```

### DOM Positioning Math

The key insight is aligning the **text baseline** in DOM with the **click position** in world coordinates:

```
World Y (click) = baseline position
Screen Y = worldToClient(worldX, worldY)[1]

CSS container top = Screen Y - (scaledFontSize * baselineToTopRatio)

Where baselineToTopRatio accounts for:
  - Half leading: (lineHeightMultiplier - 1) / 2 = 0.15
  - Font ascent ratio: ~0.88 (measured)
  - Total: ~1.03 (container top is ABOVE baseline by ~103% of fontSize)
```

**Visual:**
```
Container top  ───────────────────────
               │  half leading (0.15 * fontSize)
               ├─────────────────────
               │  ascent (~0.88 * fontSize)
Baseline       ═══════════════════════  ← Click position (worldY)
               │  descent
               ├─────────────────────
               │  half leading
Container bottom ─────────────────────
```

### Event Handlers

```typescript
// Escape key → commit and close
boundHandleKeyDown = (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    this.commitAndClose();
  }
};

// Click outside → commit and close
// Delayed 100ms to avoid catching initial click
boundHandleClickOutside = (e) => {
  if (!container.contains(e.target)) {
    this.commitAndClose();
  }
};
```

### View Change Handling

When camera pans/zooms, reposition the editor:

```typescript
onViewChange() {
  this.repositionEditor();
}

repositionEditor() {
  const [worldX, worldY] = this.editorState.originWorld;
  const [screenX, screenY] = worldToClient(worldX, worldY);
  const scale = useCameraStore.getState().scale;
  const scaledFontSize = this.editorState.fontSize * scale;

  // Update position
  container.style.left = `${screenX}px`;
  container.style.top = `${screenY - scaledFontSize * getBaselineToTopRatio()}px`;

  // Update font size for crisp rendering at new zoom
  container.style.fontSize = `${scaledFontSize}px`;
  container.style.lineHeight = `${scaledFontSize * FONT_CONFIG.lineHeightMultiplier}px`;
}
```

### Commit and Close

```typescript
commitAndClose() {
  const { editor, container, objectId, isNew } = this.editorState;

  // Delete empty new text objects
  if (editor.isEmpty && isNew) {
    roomDoc.mutate((ydoc) => {
      objects.delete(objectId);
    });
  }

  // Cleanup
  this.removeEditorHandlers();
  editor.destroy();
  container.parentNode.removeChild(container);

  // Update stores
  useSelectionStore.getState().endTextEditing();
  useDeviceUIStore.getState().setIsTextEditing(false);

  // Force re-render (editor unmount doesn't trigger Y.Doc mutation)
  invalidateWorld(getVisibleWorldBounds());
  invalidateOverlay();
}
```

### Edit Existing Text

Called by SelectTool when clicking on text:

```typescript
editExistingText(objectId: string) {
  const handle = snapshot.objectsById.get(objectId);
  const origin = handle.y.get('origin');
  const fontSize = handle.y.get('fontSize') ?? 20;
  const color = handle.y.get('color') ?? '#000000';

  useSelectionStore.getState().beginTextEditing(objectId, false);  // isNew=false
  this.mountEditor(objectId, origin[0], origin[1], fontSize, color, false);
}
```

---

## Canvas Rendering Integration

### objects.ts: `drawText()`

```typescript
function drawText(ctx: CanvasRenderingContext2D, handle: ObjectHandle) {
  const { id, y } = handle;

  // CRITICAL: Skip if being edited (DOM overlay is visible)
  const textEditingId = useSelectionStore.getState().textEditingId;
  if (textEditingId === id) {
    return;  // DOM editor handles display
  }

  // Get data
  const content = y.get('content') as Y.XmlFragment;
  const origin = y.get('origin') as [number, number];
  const fontSize = y.get('fontSize') ?? 20;
  const color = y.get('color') ?? '#000000';

  if (!content || !origin) return;

  // Get cached layout
  const layout = textLayoutCache.getLayout(id, content, fontSize);

  // Render (no opacity - always fully opaque)
  renderTextLayout(ctx, layout, origin[0], origin[1], color);
}
```

### Transform Handling

During selection transforms (scale/translate), text renders at original position:

```typescript
// In renderSelectedObjectWithScaleTransform():
if (handle.kind === 'text') {
  drawText(ctx, handle);  // Original position
  return;
}
```

This is Phase 1 behavior - text transforms deferred to future phases.

---

## Store Integration

### Selection Store (`selection-store.ts`)

```typescript
interface SelectionState {
  textEditingId: string | null;     // Object being edited
  textEditingIsNew: boolean;        // For empty deletion
}

// Actions
beginTextEditing(objectId: string, isNew: boolean)
endTextEditing()

// Selectors
selectTextEditingId(state) => state.textEditingId
selectIsTextEditing(state) => state.textEditingId !== null
selectTextEditingIsNew(state) => state.textEditingIsNew
```

### Device UI Store (`device-ui-store.ts`)

```typescript
interface DeviceUIState {
  textSize: TextSizePreset;        // 20 | 30 | 40 | 50
  isTextEditing: boolean;          // DOM editor active
}

// Actions
setTextSize(size: TextSizePreset)
setIsTextEditing(editing: boolean)
```

---

## Room Doc Manager Integration

### Cache Invalidation

```typescript
// In deep observer callback:
if (field === 'content') {
  // Y.XmlFragment change: full invalidation
  textLayoutCache.invalidate(id);
  textContentChangedIds.add(id);
} else if (field === 'fontSize') {
  // fontSize change: layout-only invalidation
  textLayoutCache.invalidateLayout(id);
}

// On object deletion:
if (handle.kind === 'text') {
  textLayoutCache.invalidate(id);
}

// On full rebuild:
textLayoutCache.clear();
```

### BBox Computation

```typescript
// In steady-state updates:
if (kind === 'text') {
  const origin = yObj.get('origin');
  const content = yObj.get('content') as Y.XmlFragment;
  const fontSize = yObj.get('fontSize') ?? 20;

  if (origin && content) {
    newBBox = computeTextBBox(id, content, fontSize, origin);
  }
}
```

---

## DOM Host Architecture

### Canvas.tsx

```tsx
const editorHostRef = useRef<HTMLDivElement>(null);

// In JSX:
<div
  ref={editorHostRef}
  className="dom-overlay-root"
  style={{
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',  // Pass-through by default
    overflow: 'hidden',
  }}
/>
```

### SurfaceManager.ts

```typescript
// Module-level registry
let editorHost: HTMLDivElement | null = null;

export function getEditorHost(): HTMLDivElement | null {
  return editorHost;
}

// In start():
editorHost = this.editorHostEl;

// In stop():
editorHost = null;
```

### CanvasRuntime.ts

```typescript
interface RuntimeConfig {
  container: HTMLDivElement;
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  editorHost: HTMLDivElement;        // Text editor DOM host
}

start(config) {
  const { container, baseCanvas, overlayCanvas, editorHost } = config;
  this.surfaceManager = new SurfaceManager(container, baseCanvas, overlayCanvas, editorHost);
  // ...
}
```

---

## CSS Architecture

**Location:** `client/src/index.css`

The text editor uses CSS-based styling with separation of concerns:

```css
.text-editor-container {
  /* Static appearance (font-family, font-weight 550, etc.) */
  font-family: "Grandstander", cursive, sans-serif;
  color: var(--text-color, #000000);  /* Dynamic via JS */
}

/* Tiptap extensions add classes to HTML tags */
.text-editor-container strong,
.text-editor-container .tiptap-bold { font-weight: 800; }

.text-editor-container em,
.text-editor-container .tiptap-italic { font-style: italic; }
```

**JS handles only:**
- Positioning (`position`, `left`, `top`)
- Zoom-dependent values (`fontSize`, `lineHeight`) - inline for performance
- Per-object color (`--text-color` CSS custom property)

---

## Known Technical Debt

### 1. Hash Only Includes Text Content

**Problem:** `structuralHash` only hashes text content, not style attributes.

**Location:** `text-system.ts:226`

**Impact:** If bold/italic changes without text changes, cache may not invalidate properly.

**Future fix:** Include formatting in hash:
```typescript
hashInput += `${text}[${bold?'B':''}${italic?'I':''}]`;
```

### 2. No Contextual Toolbar

**Current:** Text settings in main toolbar

**Future:** Floating toolbar appears when editing text (like Google Docs)

### 3. Device UI Store Settings Not Used During Edit

**Problem:** `textSize` and `color` in device-ui-store are read at creation time, but changing them during edit has no effect.

**Future:** Sync store settings ↔ editor state bidirectionally.

---

## Future Work

### Near-term

1. **Fix structural hash** to include style attributes
2. **Add contextual toolbar** for text formatting

### Medium-term

3. **Text align settings** (left/center/right)
4. **Font family selector**
5. **Selection transforms** (scale/translate text objects)

### Long-term

6. **Text wrapping** (widthMode: 'fixed')
7. **Shape labels** (text inside shapes)
8. **Tables/lists** (Tiptap extensions)

---

## Debugging Tips

### Check if text is being edited
```javascript
useSelectionStore.getState().textEditingId
// null = not editing, string = objectId being edited
```

### Inspect text layout cache
```javascript
// Check if cached
textLayoutCache.has(objectId)

// Force invalidation
textLayoutCache.invalidate(objectId)
```

### Debug font metrics
```javascript
getMeasuredAscentRatio()  // Should be ~0.88 for Grandstander
getBaselineToTopRatio()   // Should be ~1.03
```

### Debug positioning
```javascript
// World → screen
worldToClient(worldX, worldY)

// Expected container top
screenY - (fontSize * scale * getBaselineToTopRatio())
```
