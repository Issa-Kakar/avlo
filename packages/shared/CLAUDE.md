# @avlo/shared

Cross-runtime utilities and types used by client and Cloudflare Workers.

## Subsystems

- `types/identifiers.ts`, `types/y-doc.ts` — branded ids + Y.Doc shape alias (`YObjects`).
- `z-order/` — fractional z-key generation + renorm. **`ZKey` is opaque; never construct by hand.**
  Algorithm + branded type + jittered FI wrappers live here so both client (hot-path sort,
  hydrate, observer) and server (`workers/main/src/room.ts` renormalization) consume one
  implementation.
- `utils/` — ULID, image validation, URL helpers.

## Invariants

- **No browser or Cloudflare globals.** Pure TS — both runtimes consume it.
- **`yjs` is a `peerDependency`** (with a dev fallback). Consumers bring their own copy;
  this package imports types only, so client + worker bundles each link a single Yjs.
- **`ZKey` is brand-symbol opaque** (`unique symbol`). Raw strings cannot be assigned;
  the only validating coercion exposed is `isZKey(v)`. Compare keys lex via `<`/`>` only —
  never parse, slice, or arithmetic on them.
