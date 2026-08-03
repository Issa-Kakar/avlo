# bench/ — perf probes for the fork (Node ≥ 24, dev-only, never in CI)

Salvaged from the 2026-08-01 analysis session (`prompt.md` lineage). All probes
boot the **staged** fork (`web/public/py-dev/fork/`) by default; pass
`--fork=<dir>` (e.g. `dist/raw`) to bench an unstaged build. Bundle-mounting
probes (fig / snapsize / zstrat) read `bundles/*.tar` under the same dir, so
they need the staged tree or a dir you've copied tars into.

| Script | What it measures |
|---|---|
| `probe-tramp.mjs` | THE A/B workhorse: boot ms, trampoline ptr readout, `wasmTable.get` crossings per 10k METH_NOARGS calls, `bench.py` suite ×2 (run1 = incl. warmup, run2 = warm). Flags: `--fork=`, `--shim` (inject the wasm-gc trampoline from the cpython build tree — the pre-fix simulation), `--malloc=mimalloc`, `--interrupt` (arm a throwaway SAB), `--label=` |
| `bench.py` | The mixed suite probe-tramp templates in (`result` JSON global) |
| `probe-fig.mjs` | matplotlib figure render/savefig timings (mounts numpy+mpl bundles) |
| `probe-signal.mjs` | armed/unarmed interrupt tax, interleaved pairs |
| `probe-snapsize.mjs` | captured-heap size per set (V4 mimalloc check) |
| `probe-zstrat.mjs` | zlib level/strategy A/B on real Agg buffers |
| `tramp_main.c` / `sigc_main.c` | reference C sources from the analysis (not built) |

Ledger convention: paste JSON outputs into NOTES.md under the phase entry —
span-level browser numbers stay the province of the `py:trace` ledger.
**Pin the CPU boost policy for the whole session and stamp it in a ledger
note line** (see the 2026-08 POLICY CONTAMINATION entry); interleave A/B
pairs.

`builds/` holds saved raw builds for A/Bs (gitignored): `v1-ship/` = THE
ship bytes (also the tail-call-redo baseline), `v2-o3-ref/` = the -O3
reference, `v3-tailcall/` = the rejected variant-0 build.
