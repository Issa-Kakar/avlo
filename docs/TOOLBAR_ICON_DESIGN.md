# Toolbar & Icon Design System

Reference implementation based on Mural's toolbar approach. This document explains the visual design principles, how Mural constructs their icons, and how we replicate the same aesthetic with simpler SVG techniques.

---

## Mural's Design Approach

### Toolbar Structure

- **Button size:** 32×32px
- **Icon SVG size:** 20×20px for select/hand (navigation tools), 24×24px for all other tools
- **viewBox:** Always `0 0 24 24` regardless of rendered size
- **Layout:** Vertical toolbar on the left edge, single divider separating navigation (select, hand) from content tools
- **Active state:** Blue rounded-rect background highlight on the active tool button
- **Spacing:** Minimal gap between buttons — icons appear shoulder-to-shoulder, giving a "filled, compact" appearance

### How Mural Draws Icons

Mural uses **Lottie SVG animations** for hover effects, but the resting-state icons are standard filled SVG paths. The key insight is how they achieve the **chunky, filled appearance** with fine detail:

#### 1. Compound Fill Paths (not stroked outlines)

Every icon is drawn with `fill` — never `stroke`. Where traditional wireframe icons use thin stroked lines (1-2px), Mural fills the entire shape as a solid region. This gives each icon **visual weight** — it reads as a bold, confident shape rather than a skeletal outline.

#### 2. Cutout Details via Masks and Compound Paths

To add detail within a filled shape (grooves, gaps, internal patterns), Mural uses two techniques:

**SVG Masks with Alpha Inversion:**

```xml
<filter>
  <feComponentTransfer in="SourceGraphic">
    <feFuncA type="table" tableValues="1.0 0.0"/>  <!-- inverts alpha -->
  </feComponentTransfer>
</filter>
<mask mask-type="alpha">
  <g filter="url(#invert)">
    <rect opacity="0"/>        <!-- after inversion → fully opaque background -->
    <path fill="#fff" d="..."/> <!-- detail shapes → after inversion → transparent holes -->
  </g>
</mask>
```

The mask makes detail shapes (sun, mountain, letterforms) **transparent**, so they appear as dark cutouts against the filled white icon. This is used for the **Image** and **Text** icons.

**Multi-shape fills with gaps:**
The **Pen** icon uses 3 separate `<path>` fills (nib, body, tip) that don't quite touch, creating visible 0.5-1px gaps between segments. This "segmented fill" approach creates mechanical joint details without any strokes.

#### 3. Lottie Transform Matrices

Mural's SVGs contain Lottie animation data with transform matrices on each shape:

```
matrix(scale, 0, 0, scale, translateX, translateY)
```

Each shape is defined in a local coordinate space (centered at some point), then transformed into the final viewBox space. To extract the resting-state paths, you must multiply each point through the transform chain:

```
viewBoxX = scale × (localX + centerX) + globalOffsetX
viewBoxY = scale × (localY + centerY) + globalOffsetY
```

#### 4. Path Size Relative to ViewBox

The single most important principle: **icon paths consume 80-90% of the viewBox**. In a `0 0 24 24` viewBox, the paths extend from roughly (2,2) to (22,22). This means:

- At 20px rendered size, the drawn content fills ~16-18px
- There's only 1-2px of visual padding around the icon within its button
- This tight fill creates the "chunky, bold" appearance

Compare: a typical Material Design icon might only fill 60-70% of its viewBox, with 3-4px padding on each side. That reads as thin and airy.

---

## Our Implementation

### Simplification Strategy

Instead of Mural's complex mask+filter+Lottie approach, we use simpler SVG techniques that achieve the same visual result:

| Mural Technique         | Our Equivalent                     | When Used                          |
| ----------------------- | ---------------------------------- | ---------------------------------- |
| Alpha-inversion mask    | `fillRule="evenodd"` compound path | Image icon, Text icon, Eraser      |
| Separate `<path>` fills | Multiple `<path>` elements         | Pen icon (3 segments), Highlighter |
| Lottie transforms       | Pre-computed viewBox-space paths   | Pen icon (resolved transforms)     |
| `fill` (never `stroke`) | `fill="currentColor"`              | All icons                          |

### The evenodd Technique

The `fillRule="evenodd"` SVG attribute determines fill based on winding number: a point is filled if it's inside an **odd** number of path contours, unfilled if inside an **even** number.

This lets us create cutouts with a single `<path>` element containing multiple subpaths:

```
M... (outer shape)    → winding count 1 → filled (white)
M... (inner cutout 1) → winding count 2 → unfilled (shows dark toolbar bg)
M... (inner cutout 2) → winding count 2 → unfilled (shows dark toolbar bg)
```

**Example — Image icon:**

```
Subpath 1: Rounded rect from (2,2) to (22,22)  → filled white (the background)
Subpath 2: Circle at (8,8) radius 2             → cutout (dark sun)
Subpath 3: Mountain landscape y=10→20            → cutout (dark mountains)
```

Result: white picture frame with dark sun and dark mountain landscape inside.

**Example — Text icon:**

```
Subpath 1: Rounded rect from (2,2) to (22,22)  → filled white (the background)
Subpath 2: T-shape (crossbar + stem)            → cutout (dark T letterform)
```

Result: white rounded square with the letter T punched through it.

### Pre-computing Mural's Pen Transforms

The Pen icon required resolving Lottie animation transforms. Mural defines 3 shapes in local coordinate spaces:

```
Global transform: matrix(0.9938, 0, 0, 0.9938, 1.6946, 1.5694)
Shape 1 (nib):  centered at (16.705, 4.170)  → viewBox ~(14.4, 2.6) to (21.4, 9.6)
Shape 2 (body): centered at (9.921, 11.015)  → viewBox ~(5.2, 6.0) to (18.0, 17.9)
Shape 3 (tip):  centered at (3.405, 17.395)  → viewBox ~(1.9, 16.4) to (8.1, 22.1)
```

Transform formula per point:

```
vx = 0.9938 × (localX + centerX) + 1.6946
vy = 0.9938 × (localY + centerY) + 1.5694
```

We ran this computation on every coordinate in each shape's path to produce 3 pre-computed `<path>` elements in viewBox space. The 3 shapes have deliberate gaps between them (they don't share edges), creating visible joints.

### Select & Hand Icons

These two icons were copied directly from Mural's HTML — they're simple `fill="currentColor"` paths without Lottie transforms, found in the `data-mrl-svg-name="cursor"` and `data-mrl-svg-name="moveCanvas"` SVG elements. The hand icon is particularly detailed with precise finger geometry (5 fingers, proper knuckle curvature, palm).

---

## CSS Design Decisions

### Variables (RoomPage.css)

```css
--dock-h: 40px; /* Toolbar height — tight around 32px buttons + 3px padding each side */
--btn: 32px; /* Button size */
--btn-radius: 8px; /* Button corner radius */
--icon: 20px; /* Icon render size within button */
--dock-gap: 1px; /* Gap between buttons — nearly touching */
--dock-pad: 3px; /* Toolbar internal padding */
--dock-radius: 12px; /* Toolbar corner radius */
```

### Why 1px Gap

At 2px+ gap, with 12+ buttons, the accumulated whitespace creates visible rivers of empty space running through the toolbar. At 1px, buttons read as a continuous band with barely perceptible separation.

### Single Divider

One divider after the navigation tools (Select, Hand) separates "how you navigate" from "what you create." This matches Mural's pattern. All creation tools (pen, eraser, text, shapes, code, image) flow together without dividers.

### Active State

Blue (`#1D4ED8`) background fill on the 32px button with 8px border radius. The icon stays white. The blue fill covers the full button area, creating a strong visual indicator that contrasts with the dark toolbar.

---

## Icon Design Principles

### Do

- **Fill shapes, never stroke** — gives weight and reads at small sizes
- **Fill 80-90% of the 24×24 viewBox** — paths from ~(2,2) to ~(22,22)
- **Use evenodd cutouts for detail** — dark holes in filled shapes create fine features
- **Use multiple separate fills with gaps** — segmented shapes (pen, highlighter) use deliberate spacing between pieces for joint/seam detail
- **Copy from reference when possible** — Mural's select cursor and hand are directly extractable from their HTML

### Don't

- Don't use `stroke` — it creates wireframe/outline aesthetics that read as thin
- Don't leave 3-4px padding around icon content — that's the "sparse" look we're avoiding
- Don't use uniform line width for all features — vary thickness for hierarchy (thick body, thin detail grooves)
- Don't make cutout bands too wide — they should be ~1-2px visual width, like grooves, not gaping holes

### Key Visual Test

At the toolbar's rendered size, each icon should have almost no visible gap between its filled content and the button edge. When the active blue highlight is shown, the icon's silhouette should feel like it's "pressing against" the blue box, not floating with empty space around it.

---

## Reference Files

- `cssmural.md` — Mural's raw HTML for Image, Pen, Text, Select, and Hand icons (with Lottie SVG data)
- `muraltoolbar.png` — Mural's vertical toolbar screenshot (design target)
- `muralRoomPage.png` — Mural's full room page showing toolbar in context
- `Screenshot 2026-03-15 110054.png` — Previous toolbar state before this redesign

---

## Future Work

- Increase toolbar height and scale icons further for better visual presence
- Move toolbar to left-side vertical layout (matching Mural's positioning)
- Redesign the inspector panel separately from the toolbar
- Add lock icon for tool-lock mode
- Make connector arrow diagonal (top-right pointing)
- Redesign eraser with more recognizable appearance (current dual-groove approach is improved but still evolving)
- Redesign code icon as `</>` with proper slash and wider bracket spacing
- Thicken the T cutout in the text icon once icon size increases
- Move undo/redo to a different location
