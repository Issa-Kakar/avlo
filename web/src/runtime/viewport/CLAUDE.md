# Viewport / Camera Motion Subsystem

Animated camera motion — zoom, edge auto-pan, arrow-key pan. No React; module-level RAF loops and pure transform math. Driven by the input layer (`../input/keyboard-manager.ts` triggers zoom + arrow pan; `CanvasRuntime` drives edge scroll) but the mechanics live here.

## File Map

| File | Purpose |
|------|---------|
| `zoom.ts` | Animated zoom: step, fit-to-bounds, reset, center-preserving transforms |
| `edge-scroll.ts` | Auto-pan near viewport edges during qualifying tool drags |
| `arrow-key-pan.ts` | Continuous arrow-key panning with easeInQuad acceleration |
| `trackpad-pan.ts` | Two-finger wheel-scroll panning, direct 1:1 (trackpad input mode); momentum is the OS's, we synthesize none |

External consumers beyond runtime: `ZoomControls.tsx` and `clipboard-actions.ts` import from `zoom.ts` (`zoomIn`/`zoomOut`/`zoomTo`/`animateToFit`).

---

## Zoom System (`zoom.ts`)

Animated zoom with easeOutCubic easing over 180ms. Module-level RAF animation state with seamless mid-animation retargeting.

### Zoom Steps
Predefined log-spaced percentages: `[0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5]`

Step tolerance (STEP_EPS): 0.005 for "at this step" comparisons.

### Rapid Click Accumulation
`pendingStep` stores the target from the last step request. Rapid `zoomIn()`/`zoomOut()` calls use `pendingStep` as the base (if ahead/behind current scale), allowing fast clicks to jump multiple steps without waiting for animation completion.

### Center Preservation
`calculateZoomTransform(currentScale, currentPan, zoomFactor, zoomCenter)` computes new scale + pan such that world coordinates under the zoom center remain fixed. Used by both step zoom (viewport center) and pinch zoom (pinch midpoint).

### Public API

| Function | Behavior |
|----------|----------|
| `zoomIn()` | Next step from current/pending scale, centered on viewport |
| `zoomOut()` | Previous step, centered on viewport |
| `zoomTo(targetScale)` | Animate to specific scale, centered on viewport |
| `animateZoomReset()` | Animate to scale=1, pan={0,0} |
| `animateToFit(bounds, padding, maxScale, minScale)` | Fit world bounds in viewport. Floor applied first, then cap — "never zoom in" always wins. |
| `animateZoom(toScale, toPan)` | Low-level: animate to target. Retargets seamlessly mid-animation. |
| `cancelZoom()` | Cancel in-progress animation |
| `clampScale(scale)` | Clamp to MIN_ZOOM/MAX_ZOOM from camera store |

### Fit-to-Bounds

`animateToFit(bounds, padding=80, maxScale=Infinity, minScale=0)`:
- Computes fitting scale: `min((width - 2*padding) / boundsW, (height - 2*padding) / boundsH)`
- Applies: `clampScale(min(max(fitScale, minScale), maxScale))`
- Centers camera on bounds midpoint
- Used by clipboard paste (`ensureVisible`) with maxScale=currentScale (only zoom out), minScale=0.25

---

## Edge Scrolling (`edge-scroll.ts`)

Auto-pan when pointer nears viewport edge during qualifying tool drags.

### Eligibility
Only active during `select`, `connector`, or `shape` tool drags (tool must be active). Pen, highlighter, eraser, text, pan, code, note are excluded.

### Proximity Model

40px edge zone from each viewport edge. `computeProximity(pos, size)` returns a signed normalized value:
- `0` — pointer in interior (no scroll)
- `-1` to `0` — pointer approaching min edge (left/top)
- `0` to `1` — pointer approaching max edge (right/bottom)
- Beyond viewport bounds: clamped at ±1

Proximity is **squared** before applying to speed — fine-grained control at low proximity (entering zone at 0.25 → 0.0625 factor), steeper at edge (1.0 → 1.0 factor).

### Timing

| Phase | Duration | Behavior |
|-------|----------|----------|
| **Delay** | 50ms | No scrolling — prevents accidental trigger |
| **Ramp** | 100ms | easeInQuad acceleration (t² curve) |
| **Full speed** | After 150ms | Proximity² × BASE_SPEED at full easing |

### Speed

`BASE_SPEED = 9.5` CSS px per 16ms tick (~570 CSS px/s max at proximity=1, full easing).

All speeds are screen-space (÷ scale for world delta) — consistent visual speed regardless of zoom level.

**Small screen factor**: 0.65× per axis when viewport dimension < 1000px.

### Tool Re-dispatch

After each pan, the module:
1. Calls `screenToWorld(lastClientX, lastClientY)` to get updated world coordinates
2. Updates cursor tracking via `setLastCursorWorld(world)` (`../input/cursor-tracking.ts`)
3. Calls `getCurrentTool()?.move(world[0], world[1])` to update the active tool

Safe for all eligible tools — SelectTool translate/scale/marquee, ConnectorTool snap+routing, DrawingTool shape preview all update naturally.

### CanvasRuntime Integration

| Call Site | Action |
|-----------|--------|
| `handlePointerMove` | `updateEdgeScroll(clientX, clientY)` — updates proximity + starts/stops RAF |
| `handlePointerUp` | `stopEdgeScroll()` |
| `handlePointerCancel` | `stopEdgeScroll()` |
| `handleLostPointerCapture` | `stopEdgeScroll()` |
| `stop()` (runtime teardown) | `stopEdgeScroll()` |
| Camera subscription | `isEdgeScrolling()` guard prevents redundant `tool.onViewChange()` calls (tool already re-dispatched immediately after pan) |

### Stop Conditions
Pointer up/cancel/lost-capture, runtime stop, eligibility loss (tool change, gesture end), or pointer returning to interior (delay resets on re-entry).

---

## Arrow Key Pan (`arrow-key-pan.ts`)

Smooth continuous canvas pan while arrow keys are held. Own RAF loop, independent from edge scroll.

### Speed & Acceleration
- **Base speed**: 800 CSS px/s at full acceleration
- **Start fraction**: 25% of base speed (200 CSS px/s)
- **Ramp**: easeInQuad over 400ms from 25% → 100%
- **Scale-adjusted**: world speed = computed speed ÷ camera scale
- **Diagonal normalization**: direction vector normalized per-tick to prevent 1.41× speed

### Guards (in `../input/keyboard-manager.ts`)
- Key repeat events ignored (only initial keydown starts a direction)
- Blocked during: active gesture, text editing, spacebar pan mode
- `stopDirection(key)` on keyup, `stopAll()` on window blur (clears stale held-key state)

### Direction Tracking
Module-level `Set<string>` of held direction keys. RAF loop runs while set is non-empty. Delta time capped at 50ms to prevent large jumps after tab-away.

Pan direction matches "grab" semantics: ArrowRight → content moves right (pan.x increases).

---

## Trackpad Pan (`trackpad-pan.ts`)

Two-finger scroll panning for **trackpad** input mode (`device-ui-store.pointerInput === 'trackpad'`). A single pure function — **no state, no RAF, no momentum code**. `applyTrackpadPan(dX, dY)` pans via `setPanXY` directly and returns. Touches **no** tool/panTool/cursor/capture state (it's a viewport scroll, unlike an MMB grab: never swaps the cursor, never captures the pointer).

Driven by `CanvasRuntime.handleWheel`: in trackpad mode a plain (non-ctrl) wheel event routes here after a forward guard (`getCurrentTool()?.isActive()` → bail) + `panTool.cancelCoast()` (kills an in-flight MMB coast the top `panTool.isActive()` guard misses while coasting).

### Direction
Straight pass-through of the browser delta — **both axes `+`, no inversion** (`setPanXY(pan + delta/scale)`). This is the *opposite* sign of PanTool's `−` (cursor-derived, not delta-derived). Respects the OS natural-scroll setting exactly like a web page (macOS natural-scroll → grab-like; Windows default → page-scroll).

### Momentum is the OS's, not ours
Panning is **direct 1:1** per wheel event. Momentum comes for free on platforms that emit a post-liftoff momentum phase (macOS trackpads, Windows Precision Touchpads keep sending decaying wheel events after your fingers leave — we just keep panning on them). Platforms with no OS inertia (native Linux) stop dead on release. We **deliberately synthesize nothing** — a fabricated coast was removed because it was unfixable here:
- Stacked on OS inertia it double-counts → the canvas flies away.
- There is no "wheel-up" event, so it had to infer stream-end via a ~120ms idle timeout → a freeze that then lurched back into motion = a visible **stutter on settle** (reproduced on Windows Chrome, i.e. platform-independent).
- Telling a trackpad from a mouse needs a device signal the `wheel` event doesn't carry: integer/vertical-only deltas are ambiguous on Linux, and browser zoom / display scaling makes even a **mouse** report fractional deltas (false positives).

`PanTool` can coast cleanly only because a pointer gives it `pointerup` (a real release) + `pointerType` (a real device) for free; the wheel path has neither, so it doesn't try.

### Mutual exclusion
Trackpad pan and a pointer gesture are never active at once, enforced by (a) the top `panTool.isActive()` early-return in `handleWheel` and (b) the forward guard — with no input ever swallowed. Because trackpad pan calls only `setPanXY` (like arrow-key pan / wheel-zoom) and never re-dispatches `tool.move()`, it must **not** be added to the `isEdgeScrolling()` guard on the camera subscription — it needs `onViewChange()` to fire so hover cursor / mounted editors / context menu / peer cursors stay correct as content scrolls.
