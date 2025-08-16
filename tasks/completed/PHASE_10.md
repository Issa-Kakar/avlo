# Phase 10 — **AGENT TASKFILE** (Observability, Security Headers & Hygiene — server-only)

---

## A. Objective → What you are building

Enforce **explicit security headers**, **strict origin allowlists** (HTTP + WS), and **observability counters**—while guaranteeing **no content logging**. This is **server-only** and intentionally isolated so it **cannot** collide with Phase 2–8 client work.&#x20;

---

## B. Stop conditions (when to stop coding)

Stop when every item in **Section Q** passes locally. Do **not** modify routing, client providers, SW/PWA code, renderer, schema, export, or executors. Keep this phase **purely additive on the server**.&#x20;

---

## C. Tooling & prerequisites (no guessing)

- **Stack:** Your Phase-1 server foundation (Express + WS + Redis/Prisma + Sentry) is already in place; we will add/adjust middleware + counters only.&#x20;
- **Env:** Reuse Phase-1 `.env` with `ORIGIN_ALLOWLIST`, `APP_VERSION`, `SENTRY_DSN` (optional).&#x20;
- **No client deps**, no SW edits, no route changes.&#x20;

---

## D. Git hygiene (run)

```bash
git checkout -b feat/phase-10-obs-security
```

---

## E. File layout (exactly)

_No new folders are required; keep server-only scope._

```
server/
  src/
    index.ts        # add helmet + headers; keep middleware order
    util/origin.ts  # reuse allowlist helper (Phase 1)
    obs.ts          # ensure breadcrumb/counter helpers (no content)
    sentry.ts       # already scrubs request bodies/headers
    ws.ts           # add WS origin gate; keep hygiene caps
```

(We’re extending the existing skeleton from Phase-1; do not touch client or SW files.)&#x20;

---

## F. Security headers (strict, but compatible with Monaco/Pyodide)

Add **helmet** with the following **CSP Profile A** and core headers (match text exactly):

- **CSP (Profile A default):**
  `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https: wss:; frame-ancestors 'none'`.
- **HSTS** (enable only after TLS is stable): `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.
- **X-Content-Type-Options:** `nosniff`.
- **Referrer-Policy:** `no-referrer`.&#x20;

> Rationale: keeps Monaco + Pyodide functional, blocks third-party drift, and prevents embedding. (Matches the implementation spec.)&#x20;

---

## G. Origin allowlist (HTTP **and** WS)

- Validate the **HTTP Origin** header against **`ORIGIN_ALLOWLIST`** (CSV of absolute origins `scheme://host[:port]`, no wildcards).
- Validate **WS upgrades** identically before establishing the y-websocket connection.
- Keep **trust proxy** enabled to enforce per-IP caps correctly. &#x20;

---

## H. Observability counters (no content, counters only)

Emit **counters** (or Sentry breadcrumbs) for:

- Flush cadence **p50/p95**, limit events (8 MB soft, 10 MB hard), room capacity/full, **frame-too-large**, **origin reject**, **per-IP cap**, executor timeouts/clamps, **AI panel open/close**, toolbar **pin/unpin/side flip** (names only; no payloads).
- Continue publishing **`room_stats`** advisories ≤ every 5 s or after ≥100 KB growth (already in Phase-1 impl). &#x20;

**Never** log requests’ bodies/headers or Yjs content; keep Phase-1 pino redaction + Sentry scrubbing.&#x20;

---

## I. Middleware order (must match)

In `server/src/index.ts`:

1. `sentryHandlers.request`
2. `pino-http` with redaction (no bodies/headers)
3. `express.json({ limit:'1mb' })`
4. **CORS** with origin callback → **allowlist check**
5. **helmet** (CSP + headers)
6. **rate limits**, routes (`/api/rooms`)
7. `sentryHandlers.error` (last)
   WS: enforce **Origin allowlist** on `upgrade` before handing to y-websocket. (Use the existing Phase-1 gateway.)&#x20;

---

## J. Non-negotiable rules (must follow)

1. **Server-only diff.** No client, SW, or UI changes.
2. **No push/background sync** (belongs to PWA; out-of-scope here).&#x20;
3. **No content logging**—only counters/breadcrumbs. Keep Phase-1 scrubs.&#x20;
4. **Do not loosen caps** (2 MB frame, per-IP ≤8, room ≤105, 10 MB hard) while editing this phase. Those are normative.&#x20;

---

## K. What not to touch (to stay clear of Phases 2–8)

- **Client routing/providers/shell** (Phase 2)
- **Schema/renderer/tools & soft-clear/export** (Phases 3–5)
- **Code exec** (Phase 6)
- **PWA/SW files** (Phase 7)
- **Limits UI wiring** (Phase 8) — server counters only, no UI toasts here. &#x20;

---

## L. Counters & breadcrumbs map (names only; sample)

- `origin_reject`, `per_ip_ws_cap`, `frame_too_large`, `room_stats_publish`, `redis_write_accept`, `redis_write_skip_readonly` (Phase-1 norms).&#x20;
- `flush_p50_ms`, `flush_p95_ms`, `limit_soft_hits`, `limit_hard_hits`, `room_full_events`, `exec_timeout`, `exec_clamp`, `ai_panel_open`, `toolbar_pin`, `toolbar_unpin`.&#x20;

---

## M. Sentry configuration (unchanged behavior)

Confirm we keep:

- `beforeSend` stripping request **data/headers**;
- low traces sample rate;
- **no** content or payloads captured. (Already established in Phase-1.)&#x20;

---

## N. Acceptance checks (drop into CI)

1. **CSP present** with Profile-A directives above (verify headers on `/healthz`).&#x20;
2. **HSTS only in TLS env**; disabled locally; enabled in staging/prod.&#x20;
3. **HTTP Origin allowlist** rejects disallowed origins (same curl check you used in Phase-1).&#x20;
4. **WS Origin allowlist** rejects upgrade from disallowed origin; allowed origin proceeds to y-websocket. (Adapt Phase-1 WS test harness.)&#x20;
5. **Counters fire** without payloads:
   - Send a >2 MB frame → see `frame_too_large` breadcrumb.
   - Open 9 sockets from one IP → `per_ip_ws_cap`.
   - Sustain edits → periodic `room_stats_publish` every ≤5 s or ≥100 KB growth. &#x20;

6. **No content in logs or Sentry events** (pino redaction + Sentry scrub).&#x20;

---

## O. Run (local)

```bash
npm run dev --workspace=server
# Use Phase-1 curl/ws scripts to validate allowlist + caps,
# then inspect response headers for CSP/HSTS/etc.
```

(Reuse Phase-1 harness; we’re extending—not replacing—it.)&#x20;

---

## P. Done = merge-ready

- All **Acceptance checks** green.
- **No client** or SW diffs.
- **No content** logged; only counters/breadcrumbs.
- Headers and allowlists match **spec text**.&#x20;

---

### Notes & provenance

This Phase-10 scope aligns with your Implementation/Overview and builds directly atop **Phase-1** server scaffolding and hygiene conventions; Phase-9 style is mirrored in structure only (device-local feature there; server-only here). &#x20;

_(References for prior taskfile patterns and acceptance harnesses: Phase-9 and Phase-1 docs.)_ &#x20;

If you want, I can now draft the **exact code inserts** (helmet+CSP block, CORS/allowlist callback, WS upgrade guard, and a tiny counters module) to paste into `index.ts` and `ws.ts`.
