# Text Tool System Documentation

**Status:** Work in progress - WYSIWYG phase complete
**Last Updated:** SLIGHTLY STALE: MISSING SOME DOCUMENTATION

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
| `lib/tools/TextTool.ts` | PointerTool implementation, editor mounting, Y.Map creation, live editing methods |
| `lib/text/text-system.ts` | Parsing, layout engine, cache (with derived frame), renderer, BBox computation |
| `lib/text/font-config.ts` | `FONT_CONFIG` constants (extracted to avoid circular deps) |
| `lib/text/font-loader.ts` | Grandstander font loading, `areFontsLoaded()` guard |
| `lib/text/TextContextMenu.ts` | Floating toolbar: bold/italic/alignment/color/size controls |
| `lib/text/text-menu-icons.ts` | SVG icon builders for context menu |
| `renderer/layers/objects.ts` | `drawText()` function, editing skip logic |
| `stores/selection-store.ts` | `textEditingId`, `textEditingIsNew` state |
| `stores/device-ui-store.ts` | `textSize`, `textAlign`, `textColor`, `isTextEditing` state |
| `lib/room-doc-manager.ts` | Cache invalidation, BBox computation, derived frame lifecycle |
| `canvas/SurfaceManager.ts` | `getEditorHost()` - DOM container access |
| `canvas/Canvas.tsx` | `editorHostRef` div mounting |

---

## Y.Doc Object Schema

Text objects use **origin-based positioning** with **Y.XmlFragment content**:

```typescript
{
  id: string,                    // ULID
  kind: 'text',
  origin: [number, number],      // World position: [alignmentAnchorX, firstLineBaseline]
  fontSize: number,              // Font size in world units
  color: string,                 // Hex color
  align: 'left' | 'center' | 'right',  // Text alignment (default: 'left')
  widthMode: 'auto',             // Reserved for future wrapping
  content: Y.XmlFragment,        // Rich text content (Tiptap structure)
  ownerId: string,
  createdAt: number
}
```

### Origin Semantics (CRITICAL)

**`origin[1]` (Y coordinate):** Always the **baseline** of the first line (unchanged).

**`origin[0]` (X coordinate):** The **alignment anchor point**, whose meaning depends on `align`:

| `align` | `origin[0]` meaning |
|---------|---------------------|
| `'left'` | Left edge of text (traditional behavior) |
| `'center'` | Horizontal center of text block |
| `'right'` | Right edge of text |

**Why this design?**
- Changing alignment preserves the text's visual position (left edge stays put)
- The `updateTextAlign()` method adjusts `origin[0]` atomically with `align` to maintain invariant
- Canvas rendering computes per-line X via: `lineStartX = originX - anchorFactor(align) * lineWidth`
- DOM overlay uses CSS `transform: translateX(0%/-50%/-100%)` for equivalent anchoring

**Alignment change formula:**
```
W = current text width (measured from DOM)
leftX = originX - anchorFactor(oldAlign) * W    // Compute current left edge
newOriginX = leftX + anchorFactor(newAlign) * W // New anchor preserving left edge
```

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
  setFrame(objectId, frame)   // Set derived frame (called by computeTextBBox)
  getFrame(objectId): FrameTuple | null  // Read derived frame
}

// Singleton export
export const textLayoutCache = new TextLayoutCache();

// Module-level getter (convenience)
export function getTextFrame(objectId: string): FrameTuple | null
```

**Cache entry structure:**
```typescript
interface CacheEntry {
  parsed: ParsedContent;     // Reused if only fontSize changes
  layout: TextLayout;
  layoutFontSize: number;    // For staleness detection
  frame: FrameTuple | null;  // Derived world-coords frame, set by computeTextBBox
}
```

**Smart invalidation:**
- Content change → delete entire entry (frame gone)
- FontSize change → mark `layoutFontSize = -1`, null `frame` → next `computeTextBBox` recomputes both
- Origin/align change → no cache invalidation needed (layout is position-agnostic; `computeTextBBox` reads fresh values from Y.Map and recomputes frame)

### 6. Renderer: `renderTextLayout()`

```typescript
renderTextLayout(ctx, layout, originX, originY, color, align: TextAlign = 'left')
```

- Sets `textBaseline = 'alphabetic'` for proper baseline alignment
- Origin is **baseline position** of first line (Y) and **alignment anchor** (X)
- Text extends **above** origin (ascent) and **below** (descent)
- **Per-line X computation:** `lineStartX = originX - anchorFactor(align) * line.advanceWidth`
- Iterates lines → runs → `ctx.fillText()` at computed positions

### 7. BBox Computation + Derived Frame: `computeTextBBox()`

```typescript
computeTextBBox(objectId, fragment, fontSize, origin, align, fixedWidth?): BBoxTuple
```

- Gets layout from cache
- **Computes per-line ink bounds** accounting for alignment-based positioning
- Adds 2px padding for safety
- **Derives and caches the text frame** on every call: `[fx, fy, fw, fh]` where:
  - `fx = originX - anchorFactor(align) * width` (left edge)
  - `fy = originY - fontSize * getBaselineToTopRatio()` (top edge)
  - `fw = fixedWidth ?? layout.logicalBBox.width`
  - `fh = layout.logicalBBox.height`
- Frame is stored via `textLayoutCache.setFrame()`, readable via `getTextFrame(objectId)`
- Called from `room-doc-manager.applyObjectChanges()` (steady-state) and `hydrateObjectsFromY()` (rebuild), both synchronous before any render/hit-test — guarantees freshness
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
  originWorld: [number, number] | null; // World position (alignment anchor)
  fontSize: number;
  color: string;
  align: TextAlign;                    // Current alignment
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
  const align = useDeviceUIStore.getState().textAlign;
  roomDoc.mutate((ydoc) => {
    const yObj = new Y.Map();
    yObj.set('id', objectId);
    yObj.set('kind', 'text');
    yObj.set('origin', [worldX, worldY]);
    yObj.set('fontSize', fontSize);
    yObj.set('color', color);
    yObj.set('align', align);
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

  // 6. Set alignment CSS custom properties
  container.style.setProperty('--text-align', align);
  container.style.setProperty('--text-anchor-tx', ...); // 0% / -50% / -100%

  // 7. Append to host
  host.appendChild(container);

  // 8. Create Tiptap Editor with CSS class-based styling
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

  // 9. Setup handlers, mount context menu, update stores
  this.setupEditorHandlers();
  textContextMenu.mount(host, container, editor, objectId);
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
  if (container.contains(e.target)) return;
  // Also check context menu element
  const menu = document.querySelector('.text-context-menu');
  if (menu && menu.contains(e.target)) return;
  this.commitAndClose();
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

  // Context menu handles its own positioning via camera subscription
  textContextMenu.onViewChange();
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

  // Cleanup (order matters: context menu → handlers → editor → DOM → stores)
  textContextMenu.destroy();
  this.removeEditorHandlers();
  editor.destroy();
  container.parentNode.removeChild(container);

  // Clear editor state BEFORE updating stores
  this.editorState = { /* reset to defaults */ };

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

### Live Editing Methods (called by TextContextMenu)

```typescript
updateColor(newColor)      // Y.Map + CSS --text-color + UI store
updateFontSize(newSize)    // Y.Map (triggers invalidateLayout) + CSS + reposition
updateTextAlign(newAlign)  // Adjusts origin.x to preserve left edge, Y.Map atomic update
```

**Alignment change formula:** `newOriginX = leftX + anchorFactor(newAlign) * W` where `leftX = originX - anchorFactor(oldAlign) * W` and `W` is measured from DOM via `getBoundingClientRect().width / scale`.

### Module-Level Exports

```typescript
setTextToolInstance(tool)        // Called by tool-registry
getTextToolInstance(): TextTool  // Used by context menu for updateColor/updateFontSize
getActiveEditorContainer()       // DOM element access
getActiveTiptapEditor()          // Tiptap Editor access
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
  const align = y.get('align') ?? 'left';  // Alignment for origin semantics

  if (!content || !origin) return;

  // Get cached layout
  const layout = textLayoutCache.getLayout(id, content, fontSize);

  // Render (no opacity - always fully opaque)
  renderTextLayout(ctx, layout, origin[0], origin[1], color, align);
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
  textEditingIsNew: boolean;       
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
  textAlign: TextAlign;            // 'left' | 'center' | 'right' (default for new text)
  textColor: string;               // Text-specific color
  isTextEditing: boolean;          // DOM editor active
}

// Actions
setTextSize(size: TextSizePreset)
setTextAlign(align: TextAlign)
setTextColor(color: string)
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
  const align = yObj.get('align') ?? 'left';  // Alignment affects bbox!

  if (origin && content) {
    newBBox = computeTextBBox(id, content, fontSize, origin, align);
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

  /* Alignment support via CSS transform for anchor positioning */
  width: max-content;
  transform: translateX(var(--text-anchor-tx, 0%));
  text-align: var(--text-align, left);
}

/* Tiptap extensions add classes to HTML tags */
.text-editor-container strong,
.text-editor-container .tiptap-bold { font-weight: 800; }

.text-editor-container em,
.text-editor-container .tiptap-italic { font-style: italic; }
```

**Alignment CSS custom properties:**
| `align` | `--text-anchor-tx` | `--text-align` | Effect |
|---------|-------------------|----------------|--------|
| `left` | `0%` | `left` | Left edge at position |
| `center` | `-50%` | `center` | Center at position |
| `right` | `-100%` | `right` | Right edge at position |

**JS handles only:**
- Positioning (`position`, `left`, `top`)
- Zoom-dependent values (`fontSize`, `lineHeight`) - inline for performance
- Per-object color (`--text-color` CSS custom property)
- Per-object alignment (`--text-anchor-tx`, `--text-align` CSS custom properties)

---


### 2. ~~No Contextual Toolbar~~ ✅ RESOLVED

**Status:** Implemented via `TextContextMenu.ts` - floating toolbar with bold/italic/alignment/color/size controls.

---

## Next Steps: Integrate Derived Frame into Hit Testing & Selection

The derived text frame (`getTextFrame(objectId)`) is now cached and always fresh, but **consumers still call `getFrame(handle.y)` which returns `null` for text** (text has no stored `frame` key in Y.Map). The following files need to be updated to use `getTextFrame()` for text objects:

- **`geometry/hit-testing.ts`** — `hitTestPoint()` / `hitTestMarquee()` use `getFrame()` for shape bounds; text objects fall through. Wire in `getTextFrame()` so text becomes selectable/erasable.
- **`connectors/snap.ts`** — connector snapping reads `getFrame()` to find shape edges; text objects are invisible to snapping. Wire in `getTextFrame()`.
- **`tools/SelectTool.ts`** — translate/scale reads frame for shapes; text currently skips transforms. Wire in `getTextFrame()` for translate support.
- **`renderer/layers/objects.ts`** — transform rendering reads frame; text renders at original position during transforms. Wire in `getTextFrame()` for visual feedback.

Once these consumers use `getTextFrame()`, text objects will participate fully in selection, erasing, connector snapping, and transforms.

---

## Future Work

### Medium-term

2. **Font family selector**
3. **Selection transforms** (scale/translate text objects)

### Long-term

4. **Text wrapping** (widthMode: 'fixed')
5. **Shape labels** (text inside shapes)

---

