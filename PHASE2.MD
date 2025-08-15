# Phase 2 — Client Foundation (Routing, Providers, Shell) — **UI‑Backed Edition**

> **Audience:** IDE AI agent executing the task file verbatim.
>
> **Mission:** Implement the Phase 2 client foundation for Avlo by **converting the provided HTML mocks into production React views** and wiring them to routing, Yjs providers, presence, connection status, "copy link", and mobile view‑only gating. **No scope creep.** Follow constraints precisely. When repo structure or imports are unknown, **verify in‑repo before acting** and adapt paths accordingly. All checks and verifications below are **mandatory**.

> **Source UI files (now in repo root):**
>
> * `/AVLO-LANDING-v3.html` → becomes the **`/` (Landing)** route UI shell.
> * `/Avlo-Whiteboard-with-cursors_highlightericon_update.html` → becomes the **`/rooms/:id` (Room)** route UI shell.
>
> You will extract markup, CSS tokens, and component structure from these files and migrate them to React while preserving the visual design and behavior **within Phase‑2 scope only**.

---

## 0) Hard Constraints (do not alter)

* **Scope guard:** Phase 2 covers **routing**, **Yjs client providers** (`y-websocket` + `y-indexeddb`), **app shell** (split view), **presence list + cursors (lightweight)**, **connection indicator**, **copy‑link**, **mobile view‑only gating**, **accessibility for popovers/sliders**, and **teardown**. Nothing else.
* **Mobile is view‑only** in MVP. No UA sniffing — use capability checks (`pointer: coarse`, width ≤ 820 px).
* **Y.Doc identity:** Always construct with `new Y.Doc({ guid: roomId })`. **Never** mutate `doc.guid`.
* **Persistence:** Attach `y-indexeddb` per room and **do not** delete on leave.
* **Transport:** Use `/ws` for WebSocket and `/api` for REST. Build URLs from `window.location`; no host/port hard‑coding.
* **Presence cadence:** Update local presence every **75–100 ms**; throttle outbound sends to **\~30 Hz**.
* **Reconnect:** Exponential backoff **with full jitter**, ceiling **30 s**; surface **Reconnecting** state.
* **Normative UI strings:**

  * Copy link toast → **`Link copied.`** (exact text)
  * Room full → **`Room is full — create a new room.`**
  * Offline delta too large → **`Change too large. Refresh to rejoin.`**
  * Too many requests → **`Too many requests — try again shortly.`**
* **No new deps** beyond those listed. Reuse existing styling.
* **No auth, analytics payloads, or drawing engine work** in this phase (counters only if framework exists).
* **No stack traces in UI**; show friendly toasts/status only.

---

## 1) Repo Reality Check (MANDATORY before coding)

1. **Workspaces:** Confirm `client/` and `server/` exist. If not, stop and report; do not create server code in this phase.
2. **Client stack:** Verify React 18 + TypeScript + Vite (or the project’s chosen equivalent). If JS‑only, mirror file names with `.jsx` and remove types.
3. **Styling:** Confirm current styling approach. If Tailwind exists, you **do not** need to migrate these pages to Tailwind now — keep existing CSS, extract tokens. If Tailwind does not exist, still proceed with plain CSS.
4. **Installed deps (client):** `react`, `react-dom`, `yjs`, `y-websocket`, `y-indexeddb`, `react-router-dom`, and an id utility (`nanoid` or existing). If router is missing, add `react-router-dom` (follow project’s semver policy).
5. **Server endpoints:** Verify WS path `/ws` and REST base `/api` (no changes here). Confirm CORS/dev origins are already allowed.
6. **Env:** Do not alter env logic. Read existing variables via the project’s pattern.
7. **Scripts:** Ensure client `dev`, `build` scripts function; adjust only doc instructions (not scripts) if names differ.

> If any prerequisite fails, annotate the deviation and proceed with the **minimal** equivalent change. Do not introduce new architecture.

---

## 2) What to Extract From Each HTML File

### 2.1 `/AVLO-LANDING-v3.html` → Landing route (`/`)

**Keep / migrate:**

* Header (logo, theme toggle) and hero section with CTAs **Create Room** (primary) and **Join Room** (secondary).
* Any grid/background and code sample block as presentational content.
* CSS variables (design tokens) and light/dark palettes defined under `:root` and `[data-theme="dark"]`.

**Replace / remove:**

* Remove inline `<script>` behaviors for the CTAs and theme; re‑implement in React.
* Replace any placeholder navigation with router **navigate** calls.

**IDs/classes you will reuse or add:**

* Existing ID: `#themeToggle` (migrate to a React component; keep id for CSS hooks).
* Add data‑testids: `data-testid="create-room"`, `data-testid="join-room"`, `data-testid="theme-toggle"`.

### 2.2 `/Avlo-Whiteboard-with-cursors_highlightericon_update.html` → Room route (`/rooms/:id`)

**Keep / migrate:**

* Header (left: branding/title field; center: connection chip; right: avatar stack, copy‑link, export (stub), theme toggle).
* Main body split into **board** (left) and **editor** (right) with existing grid/canvas placeholder.
* Tool rail markup (presentational **only** in Phase 2).
* Users modal/popover UI.

**Replace / remove:**

* Remove or stub any inline behavior for drawing, minimap, zoom, run/console, AI chat. Keep the elements presentational or hidden.
* Replace demo copy‑link logic with the new toast text (**`Link copied.`**).

**IDs you will keep (and wire later):**

* `#board` (canvas container), `#code` (editor container), `#copyLink`, `#export`, `#usersBtn`, `#usersModal`, `#searchUsersBtn`,
  `#zoomIn`, `#zoomLabel`, `#zoomOut`, `#runBtn`, `#swapSideBtn`, `#palette`, `#paletteHelp`, `#toolRailContainer`, `#toolbarCollapseBtn`, `#toast`, `#themeToggle`, `#colorSlider`, `#sizeSlider`, `#colorIndicator`, `#colorPreview`.

**Add data‑testids:**

* `data-testid="connection-chip"`, `data-testid="users-avatar-stack"`, `data-testid="copy-link"`, `data-testid="split-resizer"`, `data-testid="export"` (disabled), `data-testid="run"` (disabled).

---

## 3) Files to Create/Touch (verify paths; adapt to repo)

> If a file exists, extend it conservatively; if not, create it. Keep names close to the project’s conventions.

```
client/
  src/
    main.tsx                      // App bootstrap (RouterProvider + ThemeProvider)
    app/
      router.tsx                  // Routes: "/" and "/rooms/:id"
      providers/
        yjsClient.ts              // createYDoc, createProviders(roomId), teardown
      hooks/
        useRoom.ts                // validate id, wire providers, awareness, teardown
        useReconnector.ts         // full-jitter backoff helpers
        useTheme.ts               // data-theme toggler around <html>
      state/
        connection.ts             // derives Online/Reconnecting/Offline/Read-only
        presence.ts               // name/color generation + awareness glue
      utils/
        device.ts                 // isCoarsePointer, isNarrow, onResize
        url.ts                    // getWsUrl(), getHttpBase()
        toast.ts                  // minimal aria-live polite toast system
      components/
        AppShell.tsx              // header + split view + resizer + slots
        AppHeader.tsx             // left/center/right header areas
        ConnectionChip.tsx        // status chip (uses data-testid)
        UsersAvatarStack.tsx      // presence list/count + modal trigger
        UsersModal.tsx            // focus-trapped modal wrapper
        CopyLinkButton.tsx        // writes to clipboard → toast "Link copied."
        ThemeToggle.tsx           // toggles data-theme
        SplitPane.tsx             // 70/30 split with draggable resizer (persisted)
      pages/
        Landing.tsx               // migrated from AVLO-LANDING-v3.html
        Room.tsx                  // migrated from Avlo-Whiteboard...html
    styles/
      tokens.css                  // merged CSS variables from both HTML files
      app.css                     // minimal layout helpers if needed
```

---

## 4) Design Tokens & Styles Extraction

1. Open both HTML files and locate the `:root { … }` CSS variables and the `[data-theme="dark"] { … }` overrides.
2. **Create `styles/tokens.css`** and paste the union of both sets, **deduplicating variables**. If the same variable is defined in both files, prefer the whiteboard page values for workspace areas and ensure landing still looks correct; adjust only **token values**, not selectors.
3. If either file declares keyframes, motion durations, radii, or spacing tokens, copy them too.
4. In `main.tsx` (or global stylesheet), import `tokens.css` **once**.
5. Do **not** import large page‑specific styles globally. Keep page or component styles local and minimal.

> Do not rename variables unless there is a conflict; when you must, change **all** references in the migrated components.

---

## 5) Router Setup

1. Install `react-router-dom` if missing.
2. Create `app/router.tsx` using `createBrowserRouter` or `BrowserRouter` + `Routes`.
3. Routes:

   * `/` → `<Landing />`
   * `/rooms/:id` → `<Room />`
4. Provide a minimal error boundary element that renders a generic message (no stack trace).
5. In `main.tsx`, render `<RouterProvider router={router} />` (or `<BrowserRouter>...</BrowserRouter>`).

---

## 6) Theme Provider

1. Implement `useTheme.ts` with:

   * `getTheme()` → reads from `localStorage` or system; returns `light | dark`.
   * `setTheme(next)` → sets `data-theme` on `<html>` and stores it.
2. Build `<ThemeToggle />` that toggles between light/dark and updates `<html data-theme>`.
3. Migrate existing `#themeToggle` button markup from both HTML files into this component (keep svg/icon and classes for visual parity). Add `data-testid="theme-toggle"`.

---

## 7) Landing Page Migration (`/`)

### 7.1 Structure

* Create `pages/Landing.tsx`.
* Copy the **header** and **hero** sections from `/AVLO-LANDING-v3.html` into semantic React markup.
* Keep the CTA buttons and any decorative code/canvas blocks as presentational only.

### 7.2 Behavior

* **Create Room** button (`data-testid="create-room"`):

  * POST to `${getHttpBase()}/api/rooms`.
  * On success, expect JSON with `shareLink` (or room id). Navigate to that link.
  * On HTTP 429, show toast **`Too many requests — try again shortly.`**
  * On other errors, show toast **`Unable to create room. Try again.`** (non‑normative fallback).
* **Join Room** button (`data-testid="join-room"`):

  * If a "Room ID" input exists in the landing markup, validate with `/^[A-Za-z0-9_\-]+$/` and navigate to `/rooms/:id`.
  * If no input, open a minimal modal prompt (accessible) to collect the id, validate, then navigate.
* **Theme toggle**: Mount `<ThemeToggle />` where `#themeToggle` was.

### 7.3 Accessibility

* Ensure any modal used for Join is focus‑trapped, closes on `Esc`, and returns focus to the trigger.

---

## 8) Room Page Migration (`/rooms/:id`)

### 8.1 Structure

* Create `pages/Room.tsx`.
* Port the header and body layout from `/Avlo-Whiteboard-with-cursors_highlightericon_update.html`:

  * **Header**: left (logo + non‑editable title), center (**ConnectionChip**), right (avatar stack, **CopyLinkButton**, `Export` (disabled), **ThemeToggle**).
  * **Body**: **SplitPane** with left = `#board` container, right = `#code` container. Default ratio **70/30**. Draggable resizer with keyboard support.
  * **Tool rail** and advanced controls remain **presentational** (do not wire behavior).

### 8.2 Behavior

* **CopyLinkButton** (`data-testid="copy-link"`):

  * `navigator.clipboard.writeText(window.location.href)`; on success show toast **`Link copied.`**
  * On failure, fall back to hidden input select/copy.
* **Export** button (`#export`, `data-testid="export"`):

  * Disabled in this phase. If clicked, show unobtrusive toast: `Export will be available in a later phase.` (non‑normative).
* **Run** button (`#runBtn`, `data-testid="run"`): disabled/no‑op.
* **Users** (`#usersBtn`, `#usersModal`):

  * Clicking opens a focus‑trapped modal listing current users (from awareness). Provide search (`#searchUsersBtn`) as a static filter by name; optional in Phase 2.
* **Theme toggle**: `<ThemeToggle />` replacing `#themeToggle`.
* **Swap side** (`#swapSideBtn`): optional; you may keep the control presentational or wire it to flip the split panes if trivial. Persist choice in `localStorage`.

### 8.3 Accessibility

* **Modal** focus trap and `Esc` close; return focus to `#usersBtn` on close.
* **Resizer**: tabbable handle; ArrowLeft/ArrowRight adjust width by step (e.g., 16px); `Esc` blurs.
* **Toasts** use `aria-live="polite"` and auto‑dismiss (<= 1.2 s).

---

## 9) SplitPane Implementation (70/30 default)

* `<SplitPane initialRatio={0.7} storageKey="room-split">`

  * Render two slots: `{left}` and `{right}`.
  * Draggable vertical resizer; keyboard accessible.
  * Persist ratio in `localStorage` on change; restore on mount.
  * Add `data-testid="split-resizer"` to the handle.

---

## 10) Device Capability Gate (Mobile View‑Only)

* Implement `device.ts`:

  * `isCoarsePointer()` → `window.matchMedia('(pointer: coarse)').matches`
  * `isNarrow(max = 820)` → `window.innerWidth <= max`
  * `onResize(cb)` → add/remove resize listener
* In `Room.tsx`, compute `viewOnly = isCoarsePointer() || isNarrow()`.
* Provide this flag via context or props to consumers (toolbars, future editor) to **disable write actions** (add `aria-disabled="true"`, visually dim).
* Do **not** block reading/presence; only authoring tools are disabled.

---

## 11) Yjs Providers & Room Hook

### 11.1 URL helpers (`url.ts`)

* `getHttpBase()` → `${location.protocol}//${location.host}`
* `getWsUrl()` → `ws(s)://${location.host}/ws` based on protocol

### 11.2 `useRoom.ts`

* Validate `roomId` (`/^[A-Za-z0-9_\-]+$/`). If invalid, render a friendly message and **do not** attach providers.
* Create `const ydoc = new Y.Doc({ guid: roomId })`.
* Attach IndexedDB: `new IndexeddbPersistence(roomId, ydoc)` (**never** delete on leave).
* Attach WebSocket: `new WebsocketProvider(getWsUrl(), roomId, ydoc, opts)`.
* Expose:

  ```ts
  type RoomHandles = {
    roomId: string;
    ydoc: Y.Doc;
    provider: WebsocketProvider;
    awareness: Awareness; // from provider
    readOnly: boolean;    // advisory from server if available
    destroy: () => void;  // detaches listeners and destroys doc/provider
  };
  ```
* Wire provider events to connection state store.
* Seed presence (see §12) with name/color and cursor.
* On unmount or route change, call `provider.destroy()` and `ydoc.destroy()`; **do not** clear IndexedDB.

---

## 12) Presence (Awareness)

* Presence model:

  ```ts
  type Presence = {
    name: string;        // adjective+animal or repo util
    color: string;       // stable per session
    cursor: { x: number; y: number } | null;
    activity: 'idle' | 'drawing' | 'typing';
  };
  ```
* Cadence: update local presence every **75–100 ms**; throttle outbound sends to **\~30 Hz**.
* Display:

  * **UsersAvatarStack** shows count + colored dots/initials; clicking opens **UsersModal**.
  * Remote cursors: render up to 20; consider a short trail buffer (≤ 24 points) on desktop only. Disable trails on mobile.
* Cleanup: remove local awareness entry on unmount.

---

## 13) Connection Indicator

* Derive state from provider and reconnection helper:

  * **Online** → connected and not read‑only
  * **Reconnecting** → backing off or attempting reconnect
  * **Offline** → `navigator.onLine === false` or provider error
  * **Read‑only** → server advisory (e.g., `room_stats` beyond cap) or local estimate
* Render as a compact chip with `role="status"` and `aria-live="polite"`.
* Add `data-testid="connection-chip"`.

---

## 14) Reconnect Policy (Full Jitter)

* Helper `computeBackoff(attempt: number)`:

  ```ts
  const base = 500; // ms
  const max  = 30_000; // 30s
  const exp  = Math.min(max, base * 2 ** attempt);
  return Math.floor(Math.random() * exp);
  ```
* Emit a `reconnecting` flag during waits; surface it in the **ConnectionChip**.
* Reset attempt counter on successful connect. Cancel timers on unmount.

---

## 15) Copy Link Button (Normative Toast)

* In `CopyLinkButton.tsx`, copy `window.location.href` to clipboard.
* On success, show toast **`Link copied.`** (exact string). On failure, fall back to hidden input copy.
* Provide `data-testid="copy-link"`.

---

## 16) Error Handling & UX Mapping

* `/api/rooms` **429** → toast **`Too many requests — try again shortly.`**
* Room full → toast **`Room is full — create a new room.`** (if surfaced)
* Offline delta too large → toast **`Change too large. Refresh to rejoin.`**
* Unknown network error → toast `Network error. Check connection.` (fallback)
* **Never** show stack traces. Log to console if necessary in dev only.

---

## 17) Read‑Only Advisory

* If server sends a `{ type: 'room_stats', bytes, cap }` message via WS, and `bytes >= cap`, set `readOnly=true`:

  * Disable write tools (reflect in tool rail visuals).
  * **ConnectionChip** shows `Read‑only`.
  * Presence remains active.

---

## 18) Accessibility Guarantees

* **UsersModal** is focus‑trapped; `Esc` closes; focus returns to `#usersBtn`.
* **Resizer** is keyboard operable (Left/Right adjust), `Esc` blurs.
* **Toasts** announced via `aria-live="polite"`.
* **Disabled controls** (Export, Run, drawing tools) expose `aria-disabled="true"` and are removed from tab order if inert.

---

## 19) What to Leave Presentational (Phase‑3/5/6 items)

* Drawing tools (pen/highlighter/eraser/shapes), palette, cursor trails logic, minimap, zoom controls, snapping.
* Export PNG/PDF.
* Code editor execution (JS/Python), console, AI chat panel.
* Any performance optimizations of the renderer.

If the controls are visible, mark them disabled and leave helpful tooltips or toasts like `Coming soon`.

---

## 20) Minimal Implementations (Indicative — adapt to repo)

### 20.1 `utils/device.ts`

```ts
export const isCoarsePointer = () => matchMedia('(pointer: coarse)').matches;
export const isNarrow = (max = 820) => window.innerWidth <= max;
export const onResize = (cb: () => void) => {
  const h = () => cb();
  window.addEventListener('resize', h);
  return () => window.removeEventListener('resize', h);
};
```

### 20.2 `utils/url.ts`

```ts
export const getHttpBase = () => `${location.protocol}//${location.host}`;
export const getWsUrl   = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
```

### 20.3 `hooks/useReconnector.ts`

```ts
export const computeBackoff = (attempt: number) => {
  const base = 500, max = 30_000;
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.floor(Math.random() * exp);
};
```

### 20.4 `components/ConnectionChip.tsx`

```tsx
export function ConnectionChip({ state }: { state: 'Online'|'Reconnecting'|'Offline'|'Read-only' }) {
  return (
    <div role="status" aria-live="polite" data-testid="connection-chip" className="connection-chip">
      {state}
    </div>
  );
}
```

### 20.5 `components/CopyLinkButton.tsx`

```tsx
export function CopyLinkButton() {
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(window.location.href); toast.success('Link copied.'); }
    catch {
      const el = document.createElement('input');
      el.value = window.location.href; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el);
      toast.success('Link copied.');
    }
  };
  return <button type="button" data-testid="copy-link" onClick={onCopy} id="copyLink" aria-label="Copy link">Copy Link</button>;
}
```

### 20.6 `components/SplitPane.tsx` (outline)

```tsx
export function SplitPane({ left, right, initialRatio = 0.7, storageKey = 'split' }: {
  left: React.ReactNode; right: React.ReactNode; initialRatio?: number; storageKey?: string;
}) {
  // implement pointer + keyboard resizer, persist to localStorage
  return (
    <div className="split">
      <div className="left">{left}</div>
      <div className="resizer" role="separator" aria-orientation="vertical" tabIndex={0} data-testid="split-resizer" />
      <div className="right">{right}</div>
    </div>
  );
}
```

---

## 21) Presence Wiring Details

* Generate name/color at startup (adjective+animal; color from a small palette). Store in memory (session‑scoped).
* On pointer move or relevant activity, update local awareness at **≤ 30 Hz**.
* For cursors, render SVG markers or positioned divs inside the board overlay; cap **20** remote cursors.
* Do not render trails on mobile; on desktop, keep a ring buffer of ≤ 24 points per user.

---

## 22) Connection State Store

* Subscribe to provider `status` events → `connected: boolean`.
* Combine with `navigator.onLine` and `reconnecting` flag to derive the 4 states.
* Expose a hook `useConnectionState()` used by **ConnectionChip** and conditionally by the header.

---

## 23) Teardown Discipline

On leaving `/rooms/:id` or unmount:

* Cancel reconnection timers.
* Remove event listeners (provider, window resize, pointermove).
* Call `provider.destroy()` and `ydoc.destroy()`.
* **Do not** delete the per‑room IndexedDB.

---

## 24) Telemetry Touchpoints (if existing client is present)

* `room_join` (omit raw room id if policy requires; hash if needed)
* `presence_count_rendered` (number, capped at 20)
* `status_transition` (Online/Reconnecting/Offline/Read‑only)
* `copy_link_clicked`

If no telemetry infra exists, skip without adding one.

---

## 25) E2E / QA Checklist (add Playwright if present, otherwise manual)

**Selectors to rely on (data‑testids):**

* Landing: `create-room`, `join-room`, `theme-toggle`
* Room: `connection-chip`, `users-avatar-stack`, `copy-link`, `split-resizer`, `export`, `run`

**Happy paths:**

* Navigating to `/rooms/e2e-phase2` renders Room shell with header + split.
* Clicking **Copy link** shows toast **`Link copied.`**
* Disabling network shows **Offline**; restoring shows **Reconnecting** then **Online**.
* Narrow viewport or coarse pointer sets view‑only: write tools disabled, board still visible.
* Two tabs in same room increment users count to 2.

**Accessibility:**

* Users modal traps focus and returns focus to trigger.
* Resizer is keyboard operable; `Esc` blurs.
* Toasts are announced by screen readers.

---

## 26) Mapping Table — HTML → React Components

| HTML (root) file       | Element/ID/Class                         | React target                                  | Notes                               |
| ---------------------- | ---------------------------------------- | --------------------------------------------- | ----------------------------------- |
| AVLO-LANDING-v3.html   | `#themeToggle`                           | `<ThemeToggle />`                             | Keep visuals; re‑implement behavior |
| AVLO-LANDING-v3.html   | `button.btn.btn-primary` (Create Room)   | `<button data-testid="create-room">`          | POST /api/rooms → navigate          |
| AVLO-LANDING-v3.html   | `button.btn.btn-secondary` (Join Room)   | `<button data-testid="join-room">`            | Validate id → navigate              |
| Avlo-Whiteboard...html | `#copyLink`                              | `<CopyLinkButton />`                          | Toast **`Link copied.`**            |
| Avlo-Whiteboard...html | `#export`                                | `<button data-testid="export" aria-disabled>` | Disabled; show "later" toast        |
| Avlo-Whiteboard...html | `#usersBtn` + `#usersModal`              | `<UsersAvatarStack/>` + `<UsersModal/>`       | Focus trap + return focus           |
| Avlo-Whiteboard...html | `#board`                                 | `<BoardContainer/>` (placeholder)             | No drawing logic yet                |
| Avlo-Whiteboard...html | `#code`                                  | `<EditorContainer/>` (placeholder)            | No execution yet                    |
| Avlo-Whiteboard...html | `#runBtn`                                | `<button data-testid="run" aria-disabled>`    | Disabled                            |
| Avlo-Whiteboard...html | `#zoomIn/#zoomOut/#zoomLabel`            | Presentational only                           | No zoom logic                       |
| Avlo-Whiteboard...html | `#palette/#paletteHelp`                  | Presentational only                           | No palette behavior                 |
| Avlo-Whiteboard...html | `#toolRailContainer/#toolbarCollapseBtn` | Presentational only                           | No collapse logic                   |

---

## 27) Commit Hygiene & Handoff

* Keep commits scoped: `feat(client): phase2-router`, `feat(client): phase2-yjs`, `feat(client): phase2-shell`, `feat(client): phase2-presence`, `feat(client): phase2-a11y`.
* Do **not** touch server files in this phase.
* Document any deviation (e.g., router type, styles location) at the top of the PR description.

---

## 28) Acceptance Checklist (mark all ✅)

* [ ] Routes `/` and `/rooms/:id` render migrated UIs; no console errors.
* [ ] Theme toggle works globally via `<html data-theme>`.
* [ ] **Y.Doc** constructed with `{ guid: roomId }`; **never** mutated.
* [ ] `y-indexeddb` attached per room and persists across reloads/offline.
* [ ] `y-websocket` provider connects to `/ws`; URL builders don’t hard‑code hosts.
* [ ] **ConnectionChip** shows **Online / Reconnecting / Offline / Read‑only** appropriately.
* [ ] Presence list/count renders and updates between two tabs; cursors limited on desktop, hidden on mobile.
* [ ] **SplitPane** 70/30 with draggable/keyboard resizer; ratio persisted.
* [ ] **Mobile view‑only** disables writing tools without UA sniffing.
* [ ] **Copy link** shows toast **`Link copied.`**
* [ ] Popovers/sliders are focus‑trapped; `Esc` closes; numeric readout visible for sliders (if shown).
* [ ] Teardown on navigate away disposes providers/docs; IndexedDB remains.

---

**End of Phase 2 task (UI‑Backed Edition).**

---

## 29) Deep Context & Anti‑Drift Addendum (Read First)

> You will be given **only this file**. Treat it as the sole source of truth for Phase 2. If the repo conflicts with these instructions, **do not improvise**: reconcile by following the *verify‑and‑adapt* rules below and stay within scope. This section exists to eliminate ambiguity and prevent agent drift.

### 29.1 North Star (Purpose in One Sentence)

Implement a **thin, reliable client shell** that renders the provided HTML designs as React routes, wires minimal collaboration plumbing (Yjs doc + providers + presence list), and exposes only the MVP controls required by Phase 2 — **nothing more**.

### 29.2 Verify‑and‑Adapt Rules (Never Skip)

1. **Paths & Structure:** Before creating files, list the actual `client/src` tree. If the project uses different folders (e.g., `apps/web`), mirror their conventions. Prefer **extending** existing files over duplicating names.
2. **Styling:** If Tailwind or another system exists, **do not migrate** the imported HTML into that system now. Keep the CSS from the HTML as component‑scoped or `styles/tokens.css`. Only extract **tokens**; do not globalize page‑specific styles.
3. **Types:** If the project is JS, drop types from snippets. If TS, maintain strictness and avoid `any` except where provider types are not available.
4. **Imports:** For any import you reference, confirm it exists. If not, either (a) create the file per this spec, or (b) inline the minimal helper within the module you’re editing (document the decision in a code comment).
5. **URLs:** Never hard‑code hostnames/ports. Build from `window.location` using `getHttpBase()` / `getWsUrl()`.

### 29.3 What NOT to Build (Strict)

* No drawing or scene data structures; no renderer; no tool logic.
* No Monaco/CodeMirror wiring beyond a **placeholder container**.
* No auth, roles, invites, or permissions.
* No analytics payloads; counters only if infra exists.
* No new libraries unless named earlier; do not add popper/headless UI unless already in repo.
* No PWA/service worker; no offline queue mutation logic.

### 29.4 Edge Cases You Must Handle

* **Invalid room id** (regex fails): show page‑level message; do not attach providers.
* **Offline start**: Connection chip must show **Offline** until online; avoid throwing.
* **Server down**: WebSocket connect fails → show **Reconnecting**, then **Offline** after browser reports offline; keep UI responsive.
* **Clipboard denied**: Use hidden input fallback; still toast **`Link copied.`**
* **Narrow / coarse pointer**: Automatically set view‑only and ensure write controls are disabled (`aria-disabled`, non‑focusable).
* **IndexedDB blocked** (private mode): Fail gracefully — continue without local persistence (console warn in dev), never crash.

### 29.5 Pitfalls & How to Avoid Them

* **Leaking listeners/timers:** Always clean up resize, pointer, provider, and backoff timers in `useEffect` cleanup.
* **Reconnection storms:** Use **full jitter** backoff; reset counters on success. Never `setInterval` reconnect loops.
* **Global CSS bleed‑through:** Keep tokens global, but **scope component rules**. Preserve original classes/IDs from HTML only where they’re used by the markup.
* **Presence over‑sending:** Throttle to \~30 Hz max and debounce cursor updates. Skip updates if position hasn’t changed.
* **Toast spam:** Deduplicate identical toasts (e.g., copy‑link) if clicked rapidly; cap duration ≤ 1.2 s.
* **Focus traps that trap forever:** Always provide `Esc` close and return focus to the trigger.

### 29.6 Security & Trust Boundaries

* **Room id is untrusted input:** Validate strictly; never interpolate into HTML; never evaluate.
* **Clipboard content:** Only copy current location; do not read clipboard.
* **WebSocket messages:** Treat any advisory messages as untrusted; parse JSON defensively; ignore unknown types.

### 29.7 Performance Budget (Phase 2)

* Initial route hydration < 120 ms on a mid‑range laptop (dev build aside).
* Reconnect backoff scheduling only; no busy loops.
* Presence cursors render ≤ 20 peers; update DOM only when positions change.

### 29.8 Accessibility Guarantees — Expanded

* **Modals:** `role="dialog"`, labelled by a visible title, focus trapped, `Esc` closes, and returns focus to opener.
* **Resizer:** `role="separator"` + `aria-orientation="vertical"`; Arrow keys adjust; `Esc` blurs.
* **Disabled controls:** `aria-disabled="true"` and `tabIndex={-1}` when inert.
* **Status:** Connection chip has `role="status"` and `aria-live="polite"`.

### 29.9 Mobile View‑Only — Details

* Derive `viewOnly = isCoarsePointer() || isNarrow(820)`; recompute on resize.
* When `viewOnly`, **all authoring controls** (tool rail, editor inputs) must be disabled or hidden; board remains visible; presence still active.

### 29.10 HTML→React Migration — Rules

* Preserve **IDs** used by the HTML where CSS depends on them (`#board`, `#code`, `#copyLink`, `#usersBtn` …). If you rename, update all selectors.
* Extract only **design tokens** to `tokens.css`. Component‑specific styles should live next to the component or in a page stylesheet.
* Normalize button texts to normative strings where applicable (copy‑link toast).

### 29.11 Failure‑Recovery Playbooks

* **WS repeatedly fails:** Show **Reconnecting** with spinner; after multiple attempts, still keep in **Reconnecting** (do not auto‑navigate). When browser reports offline, flip to **Offline**.
* **IndexedDB open error:** Log a one‑line console warning in dev; continue without persistence.
* **POST /api/rooms 429:** Show toast **`Too many requests — try again shortly.`**; re‑enable button after 1.2 s.

### 29.12 Glossary (You will see these terms)

* **Room**: A collaborative session identified by `:id` in the URL.
* **Y.Doc**: In‑memory CRDT instance; created per room with `{ guid: roomId }`.
* **Provider**: Transport adapter (`y-websocket`) plus local persistence (`y-indexeddb`).
* **Awareness**: Ephemeral presence channel used for name/color/cursor.
* **Read‑only**: Client disables authoring when server signals size cap; presence still flows.

### 29.13 Acceptable vs. Unacceptable Changes

* ✅ Renaming a component file to match existing conventions (after verifying imports).
* ✅ Inlining a helper when the planned util file is unnecessary in this repo.
* ❌ Adding a new dependency not listed.
* ❌ Implementing real drawing/zoom/export or code execution.

---

## 30) Decision Log (If/Then Defaults)

* If the router style differs (e.g., file‑based), **adopt the project’s router** but keep the same routes and elements.
* If `nanoid` is missing, use the project’s existing id generator; if none, add `nanoid`.
* If the toast system doesn’t exist, implement the minimal `toast.ts` with `aria-live` and no external deps.
* If theme is already global, mount `<ThemeToggle />` to call the existing setter rather than adding a second store.

---

## 31) PR Description Template (Copy‑Paste)

```
Title: feat(client): phase2 — router, providers, shell, presence, a11y

Summary
- Converts root HTML mocks into React routes (Landing, Room)
- Wires Yjs providers (y-websocket + y-indexeddb) per room
- Adds connection chip, presence list, copy-link, mobile view-only, split-pane
- Extracts design tokens to styles/tokens.css; preserves existing visuals

Notes
- No drawing/editor execution; all advanced controls presentational only
- No new deps beyond react-router-dom (if missing)
- Verified URLs are built from window.location; no host hard-coding

QA
- Added data-testids: create-room, join-room, theme-toggle, connection-chip, users-avatar-stack, copy-link, split-resizer, export, run
- Manual checks: copy-link toast, reconnect states, mobile gating
```

---

## 32) Manual Test Matrix (Expanded)

| Case              | Steps                                          | Expectation                                                         |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| Copy link success | Click Copy Link                                | Toast **Link copied.**; clipboard contains current URL              |
| Clipboard denied  | Manually block clipboard; click                | Hidden input fallback; same toast                                   |
| Offline on load   | Disable network; open `/rooms/test`            | Connection chip **Offline**; no crash                               |
| Server down       | Stop WS server; open room; start server        | **Reconnecting** then **Online** after backoff                      |
| 429 on create     | Spam Create Room; server returns 429           | Toast **Too many requests — try again shortly.**; button re‑enabled |
| Mobile gate       | Shrink viewport ≤820 or emulate coarse pointer | Write controls disabled; board and presence visible                 |
| Two clients       | Open same room in two tabs                     | Users count = 2; cursors render on desktop                          |

---

## 33) Code Comments You Must Include

* At the top of `Room.tsx`: *"Phase 2 shell: no drawing/editor execution; advanced controls are presentational only."*
* In `useRoom.ts`: *"Never mutate Y.Doc guid; persistence is per‑room and not cleared on leave."*
* In `CopyLinkButton.tsx`: *"Normative toast text: `Link copied.` (do not change)."*
* In `SplitPane.tsx`: *"Resizer is keyboard accessible; ratio persisted to localStorage."*

---

## 34) Final Sanity Checklist (No Drift)

* [ ] I verified paths/imports against the repo before creating files.
* [ ] I preserved essential IDs/classes from the HTML where styles depend on them.
* [ ] I extracted only tokens to `styles/tokens.css` and kept component styles local.
* [ ] I implemented routes `/` and `/rooms/:id` with migrated markup.
* [ ] I wired Yjs with `{ guid: roomId }`, y-indexeddb, y-websocket; no host hard‑coding.
* [ ] I implemented ConnectionChip (4 states), CopyLinkButton (normative toast), ThemeToggle, Users list/modal.
* [ ] I implemented SplitPane 70/30 with resizer keyboard support and persistence.
* [ ] I enforced mobile view‑only without UA sniffing.
* [ ] I cleaned up all listeners and timers on unmount.
* [ ] I left all advanced controls presentational/disabled.
* [ ] I added data‑testids and validated the manual test matrix above.

---

**This addendum is binding. If you are uncertain, do less—not more—and align to these constraints.**
