# @avlo/worker-shared

Server-only shared primitives for Cloudflare Workers. Uses ambient types (`R2Bucket`, `HTMLRewriter`, `caches.default`, `crypto.subtle`). **Never import from any client-side bundle.**

The package publishes TS source directly via `exports` (no dist build). Consumers (`workers/*`) resolve via the `@avlo/worker-shared` workspace dep + path mapping in their `tsconfig.json`. Client `tsconfig.json` and `tsconfig.sw.json` deliberately omit this path — accidental imports fail at typecheck.

## Files

| File | Exports |
|---|---|
| `src/index.ts` | Barrel re-export (only entry — no subpath exports declared) |
| `src/cors.ts` | `createCors(serviceName)` — Hono CORS middleware factory. Allows `localhost:*` + the prod `avlo.io`/`www.avlo.io` allow-list. `serviceName` arg is reserved for future per-service logging. |
| `src/csp.ts` | `applyCsp(headers, profile)` + `CspProfile` (`'asset-body'` | `'api-json'`). Per-response factory, not middleware. **SPA HTTP headers are not set by a worker** — they live in `client/public/_headers` since `run_worker_first: ["/parties/*"]` means main never sees HTML responses. |
| `src/ssrf.ts` | `isPrivateHost(hostname)` — blocks `localhost`, `[::1]`, `.local`, `.internal`, 127/10/172.16-31/192.168/169.254/0.x. Used in Zod `.refine`. |
| `src/cache-keys.ts` | `syntheticCacheUrl(service, key)` — namespaces synthetic edge-cache keys by service. `caches.default` keys on full URL; real URLs include host but synthetic keys are bare and easy to collide cross-service. |
| `src/surface-drift.ts` | `assertSurfaceMatch<Real, Mock>(true)` — Hono route-surface drift guard for the `app-type.ts` pattern. See `workers/CLAUDE.md` → App-Type Pattern. |
| `src/zod/asset-key.ts` | `assetKeyParam` — `{ key: regex(/^[0-9a-f]{64}$/) }`. Canonical lowercase hex, no uppercase. |
| `src/zod/content-length.ts` | `contentLengthBound(max)` + `MAX_UPLOAD_BYTES = 10MB`. Hono `header` validator that rejects oversize requests BEFORE the body is awaited (H2). |
| `src/zod/url-param.ts` | `unfurlQuery` — `{ url: normalizeUrl + isPrivateHost refine }`. SSRF guard runs inside Zod (H9). |

## Invariants

- **Barrel-only exports.** No subpath exports in `package.json`. Every consumer imports from `@avlo/worker-shared`. Keeps the public surface flat and the package.json minimal.
- **Inline schemas — `zValidator` only.** `unfurlQuery` and `contentLengthBound` use `zod/v4` (project standard). The asset-key regex is lowercase-hex-only — canonical form, uppercase rejected.
- **`responses.ts` is intentionally absent.** Earlier drafts had `jsonErr`/`notFound` helpers; they were never used. Most workers want raw `new Response(...)` for full header control. Reintroduce only if there's a real call site.
