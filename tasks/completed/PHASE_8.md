# Phase 8 — **AGENT TASKFILE** (Limits, banners, and UX guards — **updated for current codebase**)

> ✅ Completed phases right now: **0, 1, 7, 9, 10**.
> ❗️Phase 2 is in-flight; Phases **3–6, 11–12** are **not** in place. This task must be **client-only**, additive, and **must not** change routing/providers, renderer/tools, PWA, or server headers/allowlists.

---

## A. Objective → What you are building

Ship the **limits UI** and **gateway error → UX mapping** so users clearly see size/capacity limits and the app behaves safely at/near caps:

- **Soft warn at 8 MB** via a subtle **header pill** only (no toasts).
- **Hard cap at 10 MB** flips the room to **Read-only** (editing disabled) while **awareness continues**.
- Map canonical gateway errors to specific toasts/states (`room_full`, `room_full_readonly`, `offline_delta_too_large`, `create_room_rate_limited`). &#x20;

---

## B. Context & hard constraints (reflecting 0/1/7/9/10)

- **Phase 1 (server foundation) is live:** caps are normative → **10 MB** size hard cap, **8 MB** soft advisory, **105** capacity, **2 MB** WS frame cap, ≤ **8** concurrent WS/IP, stats published **≤5 s** or after **≥100 KB** growth. **Do not change these.**&#x20;
- **Phase 7 (PWA) is live:** SW handles **cache-first HTML**, **Update available** prompt; **no caching** of `/api/**`, `/yjs/**`, or WS. **Do not modify SW/manifest here.**&#x20;
- **Phase 9 (“My Rooms”) is live:** device-local list + canonical strings; **do not alter** its storage, strings, or flows.&#x20;
- **Phase 10 (security/observability) is live:** origin allowlists, CSP/HSTS, counters; **no content logging**. **Do not** change headers or origin gates. &#x20;
- **Phase 2 (routing/providers) unfinished:** this task **must not** alter router/provider construction or any WS contracts. Use advisory stats if present; otherwise provide safe local estimates.&#x20;

---

## C. Stop conditions (when to stop)

Stop when **all checks in Section Q** pass locally. Do **not** change:

- client routing/providers/shell (Phase 2), renderer/tools/export (Phases 3–5), executors (Phase 6), PWA/SW (Phase 7), My Rooms storage/strings (Phase 9), or server headers/allowlists (Phase 10).&#x20;

---

## D. Branch & flag

```bash
git checkout -b feat/phase-8-limits-ui
```

Feature flag: `LIMITS_UI_ENABLED` (default **on** in dev). No server env changes.

---

## E. File touchpoints (suggested)

```
client/
  src/state/roomStats.ts            # derives {bytes, cap, softWarn, readOnly}
  src/ui/limits/SizePill.tsx        # subtle header pill at ≥80%
  src/ui/limits/ReadonlyBanner.tsx  # inline banner + optional CTA
  src/ui/toast.ts                   # canonical toasts for gateway errors
  src/hooks/useGatewayErrors.ts     # map error codes -> toasts/state
  src/limits/index.ts               # feature flag & exports
```

Stats source: server publishes `{bytes, cap}` **≤5 s** or after **≥100 KB** growth; until first stat arrives, show nothing (optionally estimate locally as **advisory** only). &#x20;

---

## F. Implementation details (normative)

### F.1 Size indicators

- **Default:** show nothing.
- At **≥80% of cap (8 MB/10 MB)**, render a subdued right-aligned pill **`X.Y / 10 MB`**. **No warning toasts** below the hard cap.&#x20;

### F.2 Hard cap behavior (10 MB)

- When `readOnly` = **true**, show single inline banner: **“Board is read-only — size limit reached.”**
- **Disable write operations** (tools, commits); **presence/awareness continues**. Connection chip must reflect **Read-only**. _(Implement gating at the **commit pipeline** level so it remains valid even before the full toolset lands in later phases.)_ &#x20;

### F.3 Gateway error → UI mapping (exact strings)

- `room_full` → toast **“Room is full — create a new room.”**
- `room_full_readonly` → switch client to **Read-only** and show the banner; awareness continues.
- `offline_delta_too_large` → toast **“Change too large. Refresh to rejoin.”**
- `create_room_rate_limited` (HTTP 429) → toast **“Too many requests — try again shortly.”** (include a backoff hint).&#x20;

### F.4 Derivation logic

- Maintain `{ bytes, cap }` snapshot per room; compute:
  - `softWarn = bytes >= 0.8 * cap`
  - `readOnly = bytes >= cap`

- Update UI within **≤5 s** of growth or after **≥100 KB** deltas (matches server publish cadence).&#x20;

### F.5 UX specifics

- **SizePill:** quiet styling; numeric `X.Y / 10 MB`.
- **ReadonlyBanner:** inline, single row; optional CTA “Create room” (opens standard create-room flow; respect server rate-limit → 429 toast).&#x20;

---

## G. Non-negotiable rules

1. **Client-only diff.** No server, SW, routing, or schema edits.&#x20;
2. **Do not loosen caps** (2 MB frame, ≤8 WS/IP, 105 capacity, 10 MB hard).&#x20;
3. **No warning toasts** for size below hard cap; pill only at 8 MB.&#x20;
4. **Awareness continues** while read-only; only writes are disabled.&#x20;

---

## H. What not to touch (to stay clear of current work)

- **Phase 2**: routing/provider construction and WS contracts.
- **Phases 3–5**: schema/renderer/tools/export. (Export spec exists but is not live.)&#x20;
- **Phase 6**: executors / Pyodide warm logic (only SW warming from Phase 7 already exists).&#x20;
- **Phase 7**: PWA/SW & manifest.&#x20;
- **Phase 9**: My Rooms storage, strings.&#x20;
- **Phase 10**: headers/allowlist/observability.&#x20;

---

## I. Minimal wires (compatible with today’s code)

- **roomStats store** subscribes to the server’s `{bytes, cap}` advisories; until the first stat arrives, show nothing (or advisory estimate).&#x20;
- **Tool gating** sits at the **commit dispatcher** so it remains valid even if only a subset of tools exists right now.
- **Connection chip** derives **Read-only** by combining provider state (when available) with `readOnly` from `roomStats`.&#x20;

---

## J. Strings (normative)

- Pill: **`X.Y / 10 MB`**
- Banner: **“Board is read-only — size limit reached.”**
- Toasts per F.3 above. &#x20;

---

## K. Telemetry (already server-side)

Server emits counters/breadcrumbs for **limit soft/hard hits**, **room full**, **frame too large**, **room_stats publish**, etc. **Do not** add payload logging in the client.&#x20;

---

## L. Run (local)

1. Enable `LIMITS_UI_ENABLED`.
2. Use dev harness or a mock publisher to push size over **8 MB** then **10 MB**; verify pill timing and read-only banner/tool gating.
3. Trigger gateway errors from the WS/API harness to verify toasts and state transitions (`room_full`, `room_full_readonly`, `offline_delta_too_large`, `create_room_rate_limited`).&#x20;

---

## Q. Acceptance checks (must all pass)

1. **Soft warn at 8 MB** → header pill **`X.Y / 10 MB`** appears **≤5 s** after growth; **no** warning toast.&#x20;
2. **Hard cap at 10 MB** → writing disabled; banner shows **“Board is read-only — size limit reached.”**; awareness continues; connection chip shows **Read-only**.&#x20;
3. **Capacity = 105** → join rejected with toast **“Room is full — create a new room.”**&#x20;
4. **Oversize frame** (>2 MB) → toast **“Change too large. Refresh to rejoin.”**&#x20;
5. **Create room 429** → toast **“Too many requests — try again shortly.”** with backoff hint.&#x20;

---

## R. Done = merge-ready

- Limits UI fully wired behind `LIMITS_UI_ENABLED`.
- Pill/banner behavior, tool-gating, error mappings, and connection chip state match the **Overview/Implementation** spec and are safe given only Phases **0, 1, 7, 9, 10** exist right now. &#x20;

## S. What's Next (Add anything that has to be implemented at a later date)
