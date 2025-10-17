awesome—totally with you on the brand palette. below is a **complete, production-ready CSS** set for the toolbar + inspector that bakes in:

* background: **#2D2D2D** (warm charcoal)
* selected state (button background): **#74A12E** (matcha)
* unselected icon color: **#F5F5F5** (off-white)
* selected icon color: **#000000** (deep grey/black)
* consistent hover/active/focus/disabled states
* clean dividers, compact sizing, and accessible contrast
* optional “chrome” styles for your tiny top-left cluster to keep everything coherent

I’ve organized it into sections and added comments so you can drop it straight in.

---

# 1) design tokens (custom properties)

```css
:root {
  /* Brand + surface */
  --dock-bg: #2D2D2D;               /* toolbar/inspector background */
  --dock-border: #3A3A3A;           /* subtle outline against canvas */
  --dock-hover: #383838;            /* hover background on dark */
  --dock-shadow: 0 2px 10px rgba(0,0,0,0.35);

  --accent: #74A12E;                /* selected tool background */
  --accent-hover: #6A952B;          /* hover for selected state */
  --accent-border: #5C8426;         /* focus/active border for accent */

  /* Icon/text colors on dark surfaces */
  --icon-muted: #F5F5F5;            /* default icon */
  --icon-selected: #000000;         /* selected icon for contrast on accent */
  --text-muted: #E9E9E9;
  --text-weak: #BFBFBF;

  /* Dividers, rings, misc */
  --divider: #3A3A3A;
  --ring: #9DD65A;                  /* focus ring (brand-tinted, AA on dark) */
  --ring-offset: 2px;

  /* Component metrics */
  --dock-height: 30px;              /* slim dock */
  --btn-size: 26px;                 /* hit target ≥ 26 */
  --btn-radius: 8px;
  --dock-radius: 10px;

  /* Inspector specifics */
  --swatch-size: 16px;
  --swatch-ring: 2px;
  --pill-h: 20px;
  --pill-radius: 999px;
}
```

> If you want perfectly symmetric toolbar padding, use the “Option A” we discussed: equal left/right padding. All CSS below assumes **symmetric** padding (cleanest look).

---

# 2) toolbar wrapper + dock

```css
/* centers the dock and its right-side inspector as one assembly */
.tool-dock-wrap {
  position: fixed;
  top: 8px; left: 50%;
  transform: translateX(-50%);
  z-index: 380;

  display: inline-flex;
  align-items: center;
  gap: 8px;                        /* space between dock and inspector */
}

/* the dock bar */
.tool-dock {
  display: inline-flex;
  align-items: center;
  gap: 4px;

  height: var(--dock-height);
  padding: 0 10px;                 /* symmetric, neutral */
  border-radius: var(--dock-radius);

  background: var(--dock-bg);
  border: 1px solid var(--dock-border);
  box-shadow: var(--dock-shadow);
  backdrop-filter: blur(6px);      /* subtle frosted glass */
}
```

---

# 3) tool buttons (icons inherit color)

```css
/* base button */
.tool-dock .tool-btn {
  width: var(--btn-size);
  height: var(--btn-size);

  display: grid;
  place-items: center;

  border-radius: var(--btn-radius);
  border: 1px solid transparent;
  background: transparent;
  color: var(--icon-muted);            /* icon color via currentColor */
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}

/* icons: make your SVGs use currentColor */
.tool-dock .tool-btn .icon {
  width: 14px; height: 14px;
  color: inherit;
  /* In your SVGs, prefer: stroke="currentColor" fill="none".
     If a particular icon needs fill, set fill="currentColor". */
}

/* hover (unselected) */
.tool-dock .tool-btn:hover {
  background: var(--dock-hover);
}

/* active/selected state */
.tool-dock .tool-btn.active {
  background: var(--accent);
  border-color: var(--accent-border);
  color: var(--icon-selected);         /* black icon on matcha background */
}

/* hover for the selected button */
.tool-dock .tool-btn.active:hover {
  background: var(--accent-hover);
}

/* pressed feedback (optional, subtle) */
.tool-dock .tool-btn:active {
  transform: translateY(0.5px);
}

/* focus ring (keyboard users) */
.tool-dock .tool-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: var(--ring-offset);
}

/* disabled (if you ever disable undo/redo, etc.) */
.tool-dock .tool-btn:disabled {
  opacity: 0.45;
  pointer-events: none;
  filter: saturate(0.7);
}

/* dividers between logical clusters */
.tool-dock .tool-divider {
  width: 1px;
  height: 16px;
  background: var(--divider);
  margin: 0 2px;
}
```

---

# 4) inspector (colors + size pills)

The inspector sits to the **right** of the dock (persistent whenever the active tool supports color and/or size). It shares the same material as the dock for a cohesive “one piece” feel.

```css
.inspector {
  display: inline-flex;
  align-items: center;
  gap: 8px;

  height: var(--dock-height);
  padding: 0 8px;
  border-radius: var(--dock-radius);

  background: var(--dock-bg);
  border: 1px solid var(--dock-border);
  box-shadow: var(--dock-shadow);
}

/* rows inside the inspector */
.inspector .row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* --- color swatches --- */
.swatch {
  width: var(--swatch-size);
  height: var(--swatch-size);
  border-radius: 50%;

  /* on a dark surface, a faint border prevents dark colors disappearing */
  border: 1px solid rgba(255,255,255,0.25);
  box-shadow: inset 0 0 0 0 rgba(0,0,0,0);  /* will be used for active ring */
  transition: transform 100ms ease, box-shadow 120ms ease;
}

.swatch:hover {
  transform: translateY(-0.5px);
}

/* active color ring (brand) */
.swatch.active {
  box-shadow: 0 0 0 var(--swatch-ring) var(--accent);
  border-color: var(--accent-border);
}

/* keyboard focus on swatches */
.swatch:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: var(--ring-offset);
}

/* --- size pills --- */
.size-pill {
  height: var(--pill-h);
  padding: 0 8px;
  border-radius: var(--pill-radius);

  background: transparent;
  border: 1px solid var(--dock-border);

  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--text-muted);

  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}

.size-pill:hover {
  background: var(--dock-hover);
}

/* active size uses brand background + black text */
.size-pill.active {
  background: var(--accent);
  border-color: var(--accent-border);
  color: var(--icon-selected);
}

/* keyboard focus */
.size-pill:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: var(--ring-offset);
}
```

### suggested palette (8 swatches, no white)

Use these in your Inspector component:

```css
/* purely optional helpers if you prefer CSS classes for swatches */
.swatch.ink      { background:#111827; }
.swatch.red      { background:#EF4444; }
.swatch.orange   { background:#F97316; }
.swatch.amber    { background:#F59E0B; }
.swatch.green    { background:#10B981; }
.swatch.blue     { background:#3B82F6; }
.swatch.violet   { background:#8B5CF6; }
.swatch.pink     { background:#EC4899; }
```

(Or keep them inline via style props—either way is fine.)

---

# 5) “micro” top-left chrome (optional, to keep everything coherent)

Since you moved **kebab · trash · users · invite** to the top-left and wanted it **really tiny**, here’s a dark-surface version that matches the toolbar:

```css
/* container */
.overlay { position: fixed; z-index: 400; display: flex; align-items: center; }
.overlay-left { top: 8px; left: 8px; }
.micro-top-left { gap: 6px; }

/* shared micro-button style */
.micro {
  height: 20px; min-width: 20px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0 6px;

  background: var(--dock-bg);
  border: 1px solid var(--dock-border);
  border-radius: 6px;
  color: var(--text-muted);
  box-shadow: var(--dock-shadow);

  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.micro:hover { background: var(--dock-hover); }
.micro:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: var(--ring-offset);
}

/* kebab */
.kebab { width: 16px; padding: 0 1px; }
.kebab .dot { width: 2px; height: 2px; border-radius: 50%; background: #D1D5DB; display: block; margin: 1px 0; }

/* tiny trash */
.btn-trash.tiny { width: 20px; }
.btn-trash.tiny .icon-14 { width: 14px; height: 14px; color: var(--icon-muted); }
.btn-trash.tiny:hover .icon-14 { color: #FCA5A5; }       /* optional red hint on hover */

/* presence */
.presence-chip.tiny { gap: 6px; }
.presence-dot { width: 6px; height: 6px; border-radius: 999px; background: #10B981; }
.avatar-mini.tiny {
  width: 20px; height: 20px; border-radius: 999px;
  display: grid; place-items: center; font-size: 10px; font-weight: 700;
  color: #000; background: #74A12E; border: 1px solid var(--accent-border);
}

/* invite */
.btn-invite.tiny { font-weight: 700; }
```

> If you want the avatar to stay your old blue, just swap `background: #74A12E; color: #000` for `background: #3B82F6; color: #fff`.

---

# 6) behavior notes (so the CSS does the right thing)

1. **SVG icons should inherit color.**
   In each icon SVG: prefer `stroke="currentColor" fill="none"` (or `fill="currentColor"` if filled). That way:

   * default (unselected) icons = `var(--icon-muted)` on charcoal
   * selected icons = `var(--icon-selected)` on matcha

2. **Selected state is background-driven.**
   A selected tool gets the **matcha** background (`--accent`). The icon flips to **black**. The border tightens to `--accent-border`. Hovering a selected tool darkens matcha slightly (`--accent-hover`).

3. **Inspector consistency.**

   * Color swatches always render the **same** (order + sizes) for any tool that supports color.
   * Size pills always render **S / M / L / XL** for any tool that supports size.
   * When a tool supports only one of the two, hide the other row — the box remains the same height so nothing “jumps.”

4. **Focus rings** are brand-tinted and visible on dark.
   `--ring` (9DD65A) is chosen to be bright enough to pass AA against #2D2D2D while still harmonizing with the accent.

5. **Dividers** (`--divider`) keep clusters readable without noise.
   They’re subtle (1px, #3A3A3A) so the dock doesn’t feel busy.

6. **Motion** is minimal and snappy.
   100–120ms transitions keep things feeling responsive without lag.

---

# 7) quick “what goes where” recap

* **`.tool-dock-wrap`**: fixed at top center, holds **dock** + **inspector**.
* **`.tool-dock`**: the toolbar bar itself (icons/buttons + dividers).
* **`.tool-btn`**: individual tool buttons; **`.active`** uses matcha background + black icon.
* **`.inspector`**: persistent extension with **color swatches** and **size pills**.
* **`.swatch` / `.size-pill`**: selected states mirror dock (matcha background, black text for pills).
* **“micro” top-left**: all tiny controls share the same dark surface treatment for coherence.

---

oh yeah—this is the fun part. let’s swap in **chunky-but-clean SVGs** that still read crisply at your tiny 14–16px icon size, move **undo/redo** into a “microscopic” add-on, and make sure every icon uses `currentColor` so it inherits your brand states (unselected = `#F5F5F5`, selected = `#000000` on the matcha background).

below you’ll find:

1. drop-in **React icon components** (pen w/ baseline, thick pan hand, universal image, EXACT lasso you pasted, line with circular ends) sized and centered for your toolbar.
2. how to wire them into your `ToolPanel` buttons.
3. the **micro** undo/redo extension (positioned top-right by default, with two alternate placements you can swap to).
4. tiny notes on sizing/centering and stroke weights so they look “chunky” but still minimal.

---

# 1) icons (tsx)

make a small `icons.tsx` (or tuck these where you keep shared UI). every SVG uses `viewBox="0 0 24 24"` and **`currentColor`** for both fill or stroke so your toolbar CSS drives the colors.

```tsx
// icons.tsx
import React from "react";

/* PEN — chunky nib + baseline. Filled for crispness at 14px. */
export const IconPen: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    {/* nib (filled) */}
    <path
      d="M14.7 3.3l6 6-3.2 3.2-6-6 3.2-3.2zM10.3 7.7l6 6-6.6 6.6c-.24.24-.54.41-.87.47l-4.39.73a.9.9 0 0 1-1.05-1.05l.73-4.39c.06-.33.23-.63.47-.87l6.61-6.45z"
      fill="currentColor"
    />
    {/* baseline under pen */}
    <rect x="3.5" y="19.25" width="17" height="1.5" rx="0.75" fill="currentColor" />
  </svg>
);

/* PAN — thick hand silhouette (filled) for strong readability at tiny size. */
export const IconPanHand: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M9 12.5V9.8a1.8 1.8 0 1 1 3.6 0v1.2h.8V7.9a1.8 1.8 0 1 1 3.6 0v3.1h.8V9.5a1.8 1.8 0 1 1 3.6 0v6c0 3.1-2.6 5.6-5.7 5.6H10c-2.5 0-4.6-2-4.6-4.6v-3a1.7 1.7 0 1 1 3.6 0z"
      fill="currentColor"
    />
  </svg>
);

/* IMAGE — universal: frame + mountain + sun. */
export const IconImage: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <rect x="3" y="5" width="18" height="14" rx="2" ry="2" fill="currentColor" />
    {/* cutouts to keep it minimal on tiny size (use strokes so it stays legible) */}
    <path d="M7 16l3.2-3.2 3.8 4.8 2.7-3.3L21 18H7z" fill="#2D2D2D" />
    <circle cx="10" cy="9" r="1.6" fill="#2D2D2D" />
  </svg>
);

/* LASSO / SELECT — EXACT path you provided, normalized to 24x24 and currentColor. */
export const IconLassoSelect: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <path
      d="M4.495 11.05a8.186 8.186 0 0 0 .695-3.067c.001-.027.006-.052.007-.078l.965.41a9.254 9.254 0 0 1-.648 2.888zm14.087-5.128l-.81.61a12.73 12.73 0 0 1 1.272 1.98l1-.307a13.602 13.602 0 0 0-1.462-2.283zm-4.224-2.13a8.128 8.128 0 0 1 2.02 1.285l.825-.62a9.226 9.226 0 0 0-2.6-1.648zm-4.541-.355a6.581 6.581 0 0 1 1.748-.237 6.919 6.919 0 0 1 .864.063l.245-.985a7.967 7.967 0 0 0-1.109-.078 7.501 7.501 0 0 0-2.023.276zM5.873 18.574a3.676 3.676 0 0 1-2.13-1.012L2.66 17.8a4.49 4.49 0 0 0 3.103 1.776zm-2.861-2.9c-.003-.058-.012-.11-.012-.17 0-.594.314-1.01.917-1.756.168-.208.349-.438.53-.682l-1.13-.169A4.135 4.135 0 0 0 2 15.504c0 .136.012.261.022.389zM6.534 6.3a4.422 4.422 0 0 1 1.458-1.97l-.29-1.016a5.53 5.53 0 0 0-2.078 2.599zm15.084 7.022a16.977 16.977 0 0 0-.788-3.266l-.974.299a16.1 16.1 0 0 1 .587 2.11zM18.757 17l2.189 4.515-2.894 1.456-2.266-4.621L13 22.17V9.51L23.266 17zm-1.597-1h3.038L14 11.478v7.624l1.954-2.68 2.552 5.201 1.11-.559zM11 18.854a8.011 8.011 0 0 0-2.454-.391c-.229 0-.444.011-.651.026l-.111 1.013c.243-.022.493-.039.763-.039a7.2 7.2 0 0 1 2.453.453z"
      fill="currentColor"
    />
  </svg>
);

/* LINE — diagonal with circular terminals (chunky). */
export const IconLineNodes: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
    <line x1="6" y1="18" x2="18" y2="6"
      stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
    {/* bigger nodes so they pop at 14px */}
    <circle cx="6" cy="18" r="2.1" fill="currentColor" />
    <circle cx="18" cy="6"  r="2.1" fill="currentColor" />
  </svg>
);
```

> why this works at 14px: all icons are **filled** (or use **2.25 stroke** with **round caps**) so they don’t “hairline” out. they’re centered in a 24×24 box, so when your `.icon` class sets `width/height: 14px`, everything lands perfectly in the button’s visual center.

---

# 2) use the icons in your toolbar

example snippet inside your `ToolPanel` buttons (keep your existing `ToolButton` component):

```tsx
import { IconPen, IconPanHand, IconImage, IconLassoSelect, IconLineNodes } from "./icons";

// ...
<ToolButton tool="pen" isActive={activeTool === 'pen'} onClick={() => setActiveTool('pen')} tooltip="Pen (P)">
  <IconPen className="icon" />
</ToolButton>

<ToolButton tool="pan" isActive={activeTool === 'pan'} onClick={() => setActiveTool('pan')} tooltip="Pan (Space)">
  <IconPanHand className="icon" />
</ToolButton>

<ToolButton tool="image" isActive={activeTool === 'image'} onClick={() => setActiveTool('image')} tooltip="Image (I)">
  <IconImage className="icon" />
</ToolButton>

<ToolButton tool="select" isActive={activeTool === 'select'} onClick={() => setActiveTool('select')} tooltip="Select/Lasso (V)">
  <IconLassoSelect className="icon" />
</ToolButton>

<ToolButton tool="line" isActive={activeTool === 'line'} onClick={() => setActiveTool('line')} tooltip="Line (L)">
  <IconLineNodes className="icon" />
</ToolButton>
```

> reminder: your toolbar CSS already sets `.tool-btn .icon { width: 14px; height: 14px; color: inherit; }` so the icons will automatically render **off-white** by default and **black** when the button is `.active` (because of the matcha selected background and our `currentColor` approach).

---

# 3) move UNDO/REDO to a “micro” extension

we’ll give you **3 placements**. default is top-right corner (minimal collision risk). both are tiny (18×18 buttons), charcoal surface, subtle hover. take your pick by toggling a class.

### a) JSX (add once, near your canvas or in `RoomPage`)

```tsx
{/* UNDO/REDO micro — choose ONE placement class below */}
<div className="undo-redo-micro ur-top-right">
  <button className="micro-ghost" aria-label="Undo" onClick={undo}>
    <svg viewBox="0 0 24 24" className="micro-icon" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5l-5 5 5 5" />
      <path d="M20 12H5" />
    </svg>
  </button>
  <button className="micro-ghost" aria-label="Redo" onClick={redo}>
    <svg viewBox="0 0 24 24" className="micro-icon" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l5 5-5 5" />
      <path d="M4 12h15" />
    </svg>
  </button>
</div>
```

### b) CSS

```css
/* container */
.undo-redo-micro {
  position: fixed;
  z-index: 381; /* slightly above the dock */
  display: inline-flex;
  gap: 6px;
  opacity: 0.95;
}

/* placement options — pick ONE class */
.ur-top-right    { top: 8px; right: 8px; }                      /* default */
.ur-under-dock   { top: calc(8px + var(--dock-height) + 4px); right: 12px; } /* subtle under the dock */
.ur-right-float  { top: 8px; right: calc(50% - 420px); }        /* floats near right side of centered dock; tweak 420px to your dock+inspector width */

/* the tiny buttons (charcoal, ghosty) */
.micro-ghost {
  width: 18px; height: 18px;
  display: grid; place-items: center;
  border-radius: 6px;
  background: var(--dock-bg);
  border: 1px solid var(--dock-border);
  color: var(--icon-muted);
  box-shadow: var(--dock-shadow);
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease, transform 90ms ease;
}
.micro-ghost:hover { background: var(--dock-hover); }
.micro-ghost:active { transform: translateY(0.5px); }
.micro-ghost:focus-visible { outline: 2px solid var(--ring); outline-offset: var(--ring-offset); }

.micro-icon { width: 12px; height: 12px; }
```

> feel free to delete the two placement classes you don’t use; I included them so you can try which feels best with your chosen dock width.

---

# 4) tiny visual/sizing guardrails (so it all feels intentional)

* **icon size** in the toolbar stays **14×14** (your `.icon` class). the shapes are filled (or 2.2 stroke) so they read at that size. if you ever bump to 16px, everything still holds.
* **chunkiness**: for stroke icons, use **`strokeWidth: 2.2–2.4`** with **round caps/joins**. for filled icons, keep silhouettes bold with minimal interior details (what we did).
* **centering**: all icons are designed to be centered within a 24×24 viewBox. if one ever looks optically high/low, nudge with a 0.25px translate on the path, not by changing the icon `viewBox`.
* **currentColor**: every icon’s fill/stroke = `currentColor`. your button states decide the color (off-white when idle, black on matcha when active). you won’t chase colors in each SVG.

---

# 5) quick checklist to finish wiring

1. **Remove** undo/redo from the toolbar group.
2. **Insert** the `undo-redo-micro` block once (choose the best placement class).
3. **Import** and use the new icons for: **pen**, **pan**, **image**, **select/lasso**, **line**.
4. **Keep** the CSS you and I finalized earlier (charcoal dock, matcha selected, off-white idle). The new icons automatically follow those states.

want me to drop these into your exact `ToolPanel.tsx` with the right order and dividers based on your file so you can paste the whole block in one go?
