# Background Dot Grid (`renderer/grid/`)

> A **third canvas** rendered BELOW all objects: an analytic infinite dot grid with LOD density bands. Preferred path is a WebGPU shader (one draw call, cross-band crossfade); a full Canvas2D `createPattern` fallback covers drivers without WebGPU. Toggled by bare **`G`** (persisted `device-ui` `gridEnabled`). Off by default, near-zero memory when off.

Not part of the base/overlay render loops — a **standalone loop** (`gridLoop`) that owns its own canvas, sizing, and on-demand rAF, and reads the shared camera directly.

---

## Where it plugs in

```
Canvas.tsx           <canvas z:0 grid> < <canvas z:1 base> < <canvas z:2 overlay> < <div z:3 editor> < <div z:4 cursor>
  gridCanvasRef        pointerEvents:none, 100%×100% CSS; backing store 0×0 until first enable
CanvasRuntime.start    gridLoop.start(gridCanvas)   // .stop() on teardown — peer of renderLoop/overlayLoop
keyboard-manager       bare 'g' → toggleGridEnabled()   // handleBareKey — suppressed while editing text
device-ui-store        gridEnabled (persisted) + selectGridEnabled selector + toggleGridEnabled action
camera-store           subscribeCamera(schedule) + useCameraStore.getState() read each frame
```

**Base canvas is transparent** (its opaque fill was removed for the grid). The container `<div>` supplies the `#fafafa` page fill; the grid composites in the gaps between objects. This is load-bearing — re-opaquing the base canvas hides the grid.

Repaint triggers are exactly: camera change (pan/zoom/resize/DPR) and the on/off toggle. Both just `schedule()` a frame; `frame()` decides enable-render vs disable-and-shrink. A static camera does zero work (on-demand rAF, no steady-state loop).

---

## Files

| File | Responsibility |
|------|----------------|
| `GridRenderLoop.ts` | `GridRenderLoop` + `gridLoop` singleton. Owns canvas sizing (incl. 0×0-when-off), on-demand rAF (timer fallback in hidden tabs), lazy backend init + commit guard, device-loss rebuild, backing-store clamp → effective dpr. |
| `grid-backend.ts` | `GridBackend` interface + `createGridBackend(canvas, webgpuOnly?)` pick-best factory (WebGPU → Canvas2D). |
| `grid-webgpu-backend.ts` | WebGPU backend + one module-level shared `GPUDevice` (`getGridDevice`, loss handling). Claims the canvas context LAST so a build failure leaves it free for 2D. |
| `grid-2d-backend.ts` | Canvas2D fallback — single-dot tile via `createPattern`, `setTransform` phasing. O(1)/frame regardless of density. Hard band switch (no crossfade). |
| `grid.wgsl` | Full-screen-triangle vertex + analytic dot fragment. 32-byte uniform, `draw(3)`, premultiplied output. Tuning via `override` constants mirroring `grid-params.ts`. |
| `grid-params.ts` | **Single source of truth** for lattice math — `GRID` tuning, `finestBandLevel`/`finestBandSpacing`, `reducePanPhase` (zero-alloc), `snapWorldToGrid`. Consumed by both backends + future snap-to-grid. |

---

## Lifecycle & memory

- **Nothing allocated until first enable** — no `getContext`, adapter, or device while off. `start()` runs one frame that, if disabled, just drops the HTML-canvas default (300×150) to 0×0.
- **Off-frame** (`gridEnabled` false): `backend.unconfigure()` (release the WebGPU swapchain / drop the 2D tile+pattern) + backing store → 0×0. The **backend instance is kept** for an instant re-toggle (reconfigures on the next enabled frame).
- **`stop()`** (room unmount): full `backend.destroy()` + canvas → 0×0. The shared `GPUDevice` deliberately survives for a fast re-init on the next room/enable.
- **Lazy backend init is async** (`createRenderPipelineAsync`). A `backendPending` flag prevents double-init; on resolve, the backend is committed **only if `started && this.canvas === canvas`** (still the live loop on the same canvas) — otherwise the loop was stopped/remounted mid-await and the backend is discarded/destroyed. `backendPending` is intentionally NOT reset in `stop()`; the in-flight init self-discards against the guard.
- **Hidden tabs:** rAF is paused, so a scheduled frame falls back to a `setTimeout` (`HIDDEN_FRAME_MS`). `visibilitychange` re-picks rAF vs timer and always repaints on tab return (a backgrounded tab may have had its canvas backing store evicted → otherwise blank until the next camera move).

---

## Backend contract (`GridBackend`)

The **loop owns sizing**; a backend only draws the current camera into whatever backing-store size the loop already set. Never resize from inside a backend.

- `kind` (`'webgpu'|'2d'`) — a canvas is permanently locked to its first `getContext()` type, so a device-loss rebuild must recreate the SAME kind.
- `maxDim` — max backing-store dimension (WebGPU device limit / 2D 16384). The loop clamps `round(css×dpr)` to it, scaling both axes by the same factor into an **effective dpr** so the CSS-stretched grid stays world-aligned with the base canvas.
- `render(panX, panY, scale, dpr)` — `panX/panY` are **phase-reduced** world coords (see below); `dpr` is the effective (post-clamp) dpr.
- `unconfigure()` — release swapchain / cached tiles (toggle off; cheap re-enable).
- `destroy()` — full teardown; WebGPU keeps the module-level device.
- `isLost()` — WebGPU: shared device gone/replaced → loop rebuilds. Always false for 2D.

**Factory** `createGridBackend(canvas, webgpuOnly)`: probes WebGPU without consuming the canvas context; `webgpuOnly` is set on a device-loss rebuild (canvas already locked to `'webgpu'`, so a 2D fallback is impossible) — it returns `null` and the loop retries WebGPU on the next event rather than claiming a doomed 2D context.

---

## Lattice math (`grid-params.ts` — the shared brain)

`GRID`: `baseSpacing` 10 wu (finest band + future snap unit), `bandRatio` 5 (10→50→250→1250…, coarser dots are a subset), `minPxCss` 20 (finest on-screen spacing before promoting a band), `dotRadiusCss` 1.1, cool-gray `colorRgb`, `alphaMax` 0.55.

- `finestBandLevel(scale)` — continuous band level (0 at ideal zoom, rising as you zoom out). `floor` = finest visible band; the fraction drives the **cross-band fade**. Identical to the WGSL's `lvl` so CPU and GPU agree on boundaries.
- `finestBandSpacing(scale)` — world spacing of that band (2D fallback + snap use it).
- `reducePanPhase(panX, panY, scale, out)` — **mandatory for f32 sharpness.** Phase-reduces pan into a small range while preserving every visible band's lattice, keeping the shader's `world = pan + frag/pxPerWorld` inside f32's precise range millions of world units from the origin (raw f32 world coords jitter dots there). Modulus `baseSpacing · bandRatio^(floor(level)+2)` is divisible by every drawable band plus a full band of headroom, so a log2 rounding disagreement between CPU and GPU at a boundary can never shift a dot. Zero-alloc — writes into the loop's scratch tuple.
- `snapWorldToGrid(wx, wy, spacing?)` — CPU-only snap for future snap-to-grid; no GPU readback.

---

## WGSL shader (`grid.wgsl`)

Full-screen triangle (`draw(3)`, no vertex/index buffers) + analytic fragment; one 32-byte uniform (`cam = panX,panY,scale,dpr` / `col = r,g,b,alphaMax`). Tuning arrives as pipeline-`override` constants (`BASE`/`MIN_PX`/`DOT_R`/`BASE_SP`) supplied from `GRID` at pipeline creation — **keep these mirrored with `grid-params.ts`.** Fragment reconstructs world from the device-px frag position (y-down, no flip), computes `lvl`/`l0`/fade, and unions two bands: `max(coarseCov, fineCov·(1-f))`. Coarse dots are a positional subset of fine dots, so as the fine band fades the coarse dots occupy the exact same pixels — no popping, no moiré. Output is **premultiplied** (`alphaMode: 'premultiplied'`, no blend — each pixel written once), composited over the page background by the DOM.

**WebGPU render** writes the 8-float uniform, grabs a fresh `getCurrentTexture()`, clears to transparent, `draw(3)`, submits. `ctx.configure` runs once (the drawing buffer tracks `canvas.width/height` automatically — never reconfigured on resize; only re-runs after an `unconfigure()`).

**Shared device:** one module-level `GPUDevice` for the whole app, created lazily, coalescing concurrent callers via `devicePromise`; survives `destroy()`. `device.lost` nulls it only on a non-`'destroyed'` reason (real GPU reset/driver crash), after which `isLost()` trips and the loop rebuilds.

---

## Canvas2D fallback (`grid-2d-backend.ts`)

For Firefox Linux/Android, Safari < 26, some Linux/AMD Chrome. A single-dot tile repeated via `createPattern` — **O(1) per frame regardless of dot density** (a direct dot-by-dot draw would explode to 100k+ arcs near a band promotion). Hard band switch (no crossfade — accepted for the fallback). The `pattern.setTransform` scales an integer-sized tile so its repeat period is EXACTLY the fractional device-px cell and phases it so dot centers land on world lattice points — this is what glues dots to their world positions across the whole viewport (an integer tile alone drifts). Tile + pattern rebuilt only when size/dpr change; the `DOMMatrix` is reused (zero per-frame alloc).

---

## Invariants

- **Loop sizes, backend draws.** All backing-store sizing (incl. the maxDim clamp and 0×0-when-off) lives in `GridRenderLoop`; backends assume the canvas is already sized.
- **Base canvas stays transparent + container `#fafafa`.** The grid only shows because the base clears transparent; changing either breaks it.
- **Canvas locked to first context type.** WebGPU claims the context LAST (device/shader/pipeline/buffers built first) so a build failure leaves the canvas free for 2D; a device-loss rebuild is WebGPU-only.
- **Async-init commit guard.** Commit a resolved backend only if the loop is still live on the same canvas.
- **`grid-params.ts` is the single source of truth.** Both backends and the WGSL `override` defaults mirror it — change tuning there.
- **Off ⇒ near-zero memory.** 0×0 backing store + `unconfigure()`; the shared GPU device stays resident for instant re-toggle.
