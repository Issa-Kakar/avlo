# Phase 7 — **AGENT TASKFILE** (Minimal PWA & Update Flow — client-only)

---

## A. Objective → What you are building

Ship an **installable PWA** with:

* **App-shell caching** for HTML navigations (`/`, `/rooms/:id`) using a **cache-first** strategy
* A reliable **“Update available”** prompt that calls `skipWaiting()` on confirm and reloads
* **Pre-cache** of **Monaco (core + workers)** and a small, versioned **Practice Problem** JSON pack
* **No caching** of `/api/**`, `/yjs/**`, or any `wss:` traffic
* Optional **desktop-only** silent warm-cache for the **Pyodide pack** after `activate`

Keep this phase **client-only** and additive. Do **not** change routing, providers, or any server code. &#x20;

---

## B. Stop conditions (when to stop coding)

Stop when **all checks in Section Q** pass locally. Do **not** alter client routing (Phase 2 scope), whiteboard schema/renderer (Phases 3–5), or code-execution internals (Phase 6).&#x20;

---

## C. Tooling & prerequisites (no guessing)

* **Client**: existing React + TypeScript + Vite setup.
* **Versioning**: use `APP_VERSION` (string) embedded at build (e.g., `import.meta.env.VITE_APP_VERSION`) for cache keys.
* **No server changes**; reuse current server headers/origin gates from earlier phases.&#x20;

---

## D. Git hygiene (run)

```bash
git checkout -b feat/phase-7-pwa
```

---

## E. File layout (exactly)

```
client/
  public/
    manifest.webmanifest
    icons/
      icon-192.png
      icon-512.png
      icon-512-maskable.png   # maskable
  src/
    pwa/
      register-sw.ts          # registration + update prompt bridge
      update-prompt.tsx       # tiny UI to confirm update
      warm-pyodide.ts         # desktop-only silent warm-up (seed fetches)
    sw.ts                     # service worker (built with Vite's SW plugin or rollup)
```

> If you already have a SW file, replace its content per Section F but keep the same entry path.

---

## F. Implementation details (normative)

### F.1 Web App Manifest (installability)

**`public/manifest.webmanifest`**

* `name`, `short_name`
* `start_url: "/?source=pwa"`, `display: "standalone"`
* `theme_color`, `background_color`
* `icons`: **192×192**, **512×512**, and **maskable 512×512**
  Link via `<link rel="manifest" href="/manifest.webmanifest" />`.&#x20;

### F.2 Cache naming & versioning

Use **two** versioned caches:

* `app-shell-v{APP_VERSION}` — HTML + core immutable assets
* `offline-pack-v{APP_VERSION}` — Monaco + workers + Practice Problem JSON

Purge caches from **older versions** at `activate`. Additionally, **delete legacy `pyodide-pack-*` caches** when the version changes.&#x20;

### F.3 Precache lists (install event)

**Must include**:

* HTML shell (Vite build output root, e.g., `/index.html` or hashed equivalent via `self.__WB_MANIFEST`/plugin)
* App CSS/JS entry(s)
* **Monaco core + workers** (deterministically enumerated or via a `manifest` generated list)
* **Practice Problem pack** (small versioned JSON shipped with the app)
  **Must NOT include** any `/pyodide/**` assets (warmed post-activate, desktop-only).&#x20;

### F.4 Fetch handling (rules)

* **HTML navigations** (requests where `mode === 'navigate'`):

  * **Cache-first**: respond from `app-shell-v{APP_VERSION}` (the shell), falling back to `fetch()` if shell missing (dev).
  * This covers both `/` and **virtual** `/rooms/:id` paths in SPA routing.&#x20;
* **API / collaboration**:

  * **Bypass cache** for \*\*`/api/**`, **`/yjs/**`**, and **all `wss:`**. Never store or serve from SW. (If matched, call `fetch(event.request)` without caching.)&#x20;
* **Static assets** (Monaco + problem JSON):

  * Serve **cache-first** from `offline-pack-v{APP_VERSION}`, update opportunistically in background.

### F.5 Update flow (prompt + skipWaiting)

* **Registration**: in `register-sw.ts`, call `navigator.serviceWorker.register('/sw.js')`. Listen for:

  * `registration.updatefound` → watch `installing.state`.
  * When a new worker reaches `installed` **and** `navigator.serviceWorker.controller` exists, emit `updateAvailable`.
* **Prompt UI**: implement `UpdatePrompt` (`update-prompt.tsx`) that appears on `updateAvailable`. On confirm:

  1. call `registration.waiting.postMessage({ type: 'SKIP_WAITING' })`
  2. listen once for `navigator.serviceWorker.oncontrollerchange` → `window.location.reload()`
* **Worker side**: handle `message` `{ type:'SKIP_WAITING' }` → `self.skipWaiting()`.&#x20;

### F.6 Desktop-only Pyodide warm-cache (optional, invisible)

* After `activate`, call `warmPyodide()` **only on desktop** heuristics (e.g., `(pointer: fine)` + width threshold).
* `warmPyodide()` seeds fetches under `/pyodide/<version>/**`; SW intercepts with **CacheFirst** into a **separate** `pyodide-pack-<version>` cache.
* **No status text**; **no pre-cache at install**; **purge old `pyodide-pack-*`** at next `activate`.&#x20;

---

## G. Non-negotiable rules (must follow)

1. **Client-only diff.** Do **not** modify server headers, WS gateway, or origin allowlist logic in this phase.&#x20;
2. **Never cache** `/api/**`, `/yjs/**`, or `wss:`; these must always bypass.&#x20;
3. **Cache-first HTML navigations** for `/` and `/rooms/:id` only; do not alter router or providers (Phase 2).&#x20;
4. **Pre-cache Monaco**; **do not** pre-cache Pyodide; warm **after** `activate` (desktop-only).&#x20;
5. **Update prompt required**: visible “**Update available**” → confirm → `skipWaiting()` → reload.&#x20;

---

## H. What not to touch (to stay clear of Phases 2–6, 8–10)

* **Routing/providers/shell** (Phase 2)
* **Schema/renderer/tools, export** (Phases 3–5)
* **Code exec internals** (Phase 6)
* **Limits UI / toasts** (Phase 8)
* **Server security/observability** (Phase 10)&#x20;

---

## I. Registration snippet (app entry)

Minimal example (adapt names to your app).

> Place imports in your root layout or boot code; ensure `UpdatePrompt` can render a small confirm bar.

```ts
// src/pwa/register-sw.ts
export function registerSW(hooks: { onUpdateAvailable: (reg: ServiceWorkerRegistration) => void }) {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    const reg = await navigator.serviceWorker.register('/sw.js');
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          hooks.onUpdateAvailable(reg);
        }
      });
    });
  });
}
```

```ts
// src/pwa/update-prompt.tsx
export function showUpdatePrompt(reg: ServiceWorkerRegistration) {
  // Render a tiny confirm UI; on confirm:
  reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
}
```

*(Do not hard-code texts other than “Update available”. Keep it small and unobtrusive.)*&#x20;

---

## J. Service Worker (behavioral skeleton)

Key handlers you **must** implement:

* `install` → open `app-shell-v{APP_VERSION}` + `offline-pack-v{APP_VERSION}`; add shell + Monaco + problem JSON to caches
* `activate` → `clients.claim()`; **purge** older caches and any `pyodide-pack-*` from previous versions
* `message` → `{ type:'SKIP_WAITING' }` → `self.skipWaiting()`
* `fetch`:

  * **If** navigation → **cache-first** from `app-shell-v{APP_VERSION}`
  * **If** URL starts with `/api/` or `/yjs/` → **bypass** (just `fetch`)
  * **If** `wss:` → SW does nothing (browsers ignore SW for WS)
  * **Else if** in `offline-pack` (Monaco/JSON) → **cache-first**, update in background

Ensure the SW builds with your toolchain (Vite plugin, Rollup, or Workbox) but **do not** introduce push/background sync.&#x20;

---

## K. Desktop-only Pyodide warm-cache (optional)

* In `warm-pyodide.ts`, detect desktop and sequentially `fetch()` the small set of `/pyodide/<version>/**` URLs you care about.
* SW `fetch` rule should treat these with a **CacheFirst** policy in a **separate** cache and the `activate` step must remove older `pyodide-pack-*`. **No UI**.&#x20;

---

## L. Practice Problem pack (content contract)

Ship a **small** static JSON file (e.g., `public/problems.v1.json`) with the canonical schema below, versioned alongside Monaco, and add it to `offline-pack`. Keep it tiny.
*(Schema excerpt already agreed in implementation.)*&#x20;

---

## M. Flags & env

* Feature flag: `PWA_ENABLED` (default **on** in dev; **on** in prod once validated)
* `APP_VERSION` must change on each release to trigger update + cache rotation. (Server already exposes `APP_VERSION` for headers/observability.)&#x20;

---

## N. Error/edge cases

* **Offline first-load**: If shell is present in cache, navigations succeed even without network; otherwise rely on network.
* **Bypass confirmation loops**: After confirm, rely on `controllerchange` once; do **not** prompt again until a *newer* worker is present.
* **CORS / allowlist**: Unchanged here; server enforcement remains from Phase 1/10.&#x20;

---

## O. Strings (normative)

* “**Update available**” (prompt title/button ok)
* Keep any additional text minimal and product-consistent. (No extra banners about Pyodide warming.)

---

## P. Run (local)

1. `npm run build` (client) → ensure SW emits to `/sw.js` (or configure Vite plugin).
2. `npm run build` (root) → `bundle:assets` copies client build into `server/public/` (per overview).&#x20;
3. `npm run dev --workspace=server` and visit `/` then `/rooms/test` (dev shell).
4. Increment `APP_VERSION` and rebuild to verify update prompt behavior.

---

## Q. Acceptance checks (must all pass)

1. **Update prompt**

   * Install a new SW (bump `APP_VERSION`) → **“Update available”** appears; confirm → `skipWaiting()` → app reloads under new version.&#x20;
2. **Bypass rules**

   * Requests to **`/api/**`** and **`/yjs/**`** always **miss** the SW cache (verified via DevTools → Network → “from service worker” is **No**).&#x20;
3. **Cache-first HTML**

   * With the network throttled/offline, navigations to `/` and `/rooms/<id>` still load the shell from cache.&#x20;
4. **Pre-cache Monaco + problem JSON**

   * First visit (online) → entries are present in `offline-pack-v{APP_VERSION}` and served **cache-first** subsequently.&#x20;
5. **Pyodide not pre-cached**

   * No `/pyodide/**` entries in install precache; optional desktop warm-cache only after `activate`; old `pyodide-pack-*` purged on version change.&#x20;

---

## R. Done = merge-ready

* Manifest linked; icons present; PWA installable.&#x20;
* SW implements **cache-first navigations**, **precache (Monaco + JSON)**, **bypass rules**, **update prompt**, and optional desktop Pyodide warm-cache with legacy purge.&#x20;
* No server diffs; origin/CSP/WS hygiene remain enforced by Phases **1** and **10**. &#x20;

---

### Notes & provenance

Scope matches your Implementation/Overview for **Phase 7** (cache rules, manifest, update prompt, Monaco/pyodide handling) and keeps separation from Phases 2–6 & 8–10. For reference patterns and guardrails, see prior taskfiles (Phases **1**, **9**, **10**).  &#x20;
