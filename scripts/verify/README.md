# Verification harness (`scripts/verify/`)

Headless **verification**, not a test suite. The goal is to check a change against the
*running app* quickly and deterministically — screenshots + state assertions — so canvas
work can be confirmed without hand-driving the UI. There is no `@playwright/test` runner and
no CI wiring yet (persistent tests are deferred until nearer prod); this stays a thin,
scriptable layer.

## Why it exists

The canvas is imperative — synthesizing pointer drags to build state is slow and brittle for
an agent. So instead we expose a **dev-only bridge** (`window.__avlo`, from
`web/src/dev/test-bridge.ts`, tree-shaken out of prod) and create objects programmatically:

```js
window.__avlo.createShape({ x: 200, y: 200, w: 240, h: 150 })
window.__avlo.count()      // → assert state
window.__avlo.fit()        // → frame content for a screenshot
```

Objects created this way flow through the normal Yjs deep-observer pipeline (handle, spatial
index, caches, dirty rects) exactly as a user gesture would.

## Two tiers

- **Tier 1 — client only (`pnpm dev:web`, port 3000).** The harness seeds a synthetic dev
  identity into `localStorage` (`avlo.auth.v1`), which makes `ensureIdentity()` take the
  synchronous returning-visitor path — so `/room/:id` loads with **no auth or sync worker
  running**. Enough to verify rendering, tools, geometry, layout, z-order, hit-testing.
- **Tier 2 — full stack (`pnpm dev`, requires `workers/auth/.dev.vars`).** Needed only when
  the change touches real sync/collab, auth, image upload, or unfurl.

Point the harness elsewhere with `BASE_URL` (e.g. `BASE_URL=http://localhost:5180` for the
`avlo-parallel` worktree's `pnpm dev:p`).

## Run it

```bash
pnpm dev:web                              # in one terminal (client only)
node scripts/verify/demo.mjs              # reference loop: create → fit → snap → assert
node scripts/verify/snap.mjs /home home   # screenshot any route → .verify/home.png
pnpm verify:snap /room/0123456789AB room  # same, via the root script
HEADED=1 node scripts/verify/demo.mjs     # watch it in a real window
```

Screenshots land in `.verify/` (gitignored). `browser.mjs` collects console messages and page
errors (`h.errors`) so a script can assert "no console errors."

## `window.__avlo` surface

`createShape` · `createText` · `createNote` · `remove` · `clearAll` · `count` · `ids` · `get`
· `bbox` · `kind` · `handle` · `select` · `clearSelection` · `selectedIds` · `setTool` ·
`camera` · `setCamera` · `fit` · `screenToWorld` · `worldToClient` · `undo` · `redo` ·
`transact` · `waitForIdle` · `settle`. Escape hatches: `Y`, `stores`. Extend the bridge as
verification needs grow.

## When to use what

- **This harness (Playwright CLI/scripts)** — the default. Deterministic flows, screenshots,
  state assertions, console/network capture. Cheap on tokens, headless, scriptable.
- **Claude-in-Chrome (computer use)** — exploratory/visual judgement where seeing and
  reasoning about pixels matters. Higher token cost; reach for it when a screenshot needs
  interpreting, not just capturing.
- **No Playwright MCP** — the CLI + `page.evaluate` covers console/dev-tool scripting; an MCP
  would add surface without buying anything here.
- **No Puppeteer** — Playwright (chromium) covers every verification need; a second driver is
  redundant.

## Deferred / documented (intentionally not wired)

- **Vitest / `@playwright/test`** — deferred until nearer prod (rapid change makes persistent
  tests noisy bookkeeping now). This layer is structured so adding `@playwright/test` +
  `playwright.config.ts` later is additive, not a rewrite.
- **Bundled dev mode** (Vite 8.1 `experimental.bundledDev` / `vite --experimental-bundle`) —
  experimental and known to break with third-party plugins (we run TanStack Router, Tailwind,
  SAB module workers, custom `worker.format`); it also doesn't itself emit a classic dev
  `sw.js`. Try it ad hoc if curious; don't make it the default. Service-worker-in-dev is
  deferred with it.
- **React Compiler** — skipped (plugin-react v6 runs pure Oxc). To enable later:
  `pnpm add -D @rolldown/plugin-babel @babel/core babel-plugin-react-compiler`, then in
  `vite.config.ts` add `babel({ babelConfig: { plugins: [reactCompilerPreset()] } })` from
  `@rolldown/plugin-babel` / `@vitejs/plugin-react` **before** `react()`. Revisit once the
  Oxc-native compiler transform stabilizes (no Babel pass).
