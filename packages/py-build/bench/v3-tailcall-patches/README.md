# V3 tail-call redo kit — REDONE 2026-08-03: variant 0 REJECTED on clean data

**Executed verdict (policy=aggressive pinned, interleaved ×3 + liftoff
pair, `V1-redo-*`/`V3-redo-*` ledger rows):** geomean **+25% regression**
(run2 medians — meth_noargs +38%, meth_o +46%, fib_rec +48%, pycall +35%,
tuple_alloc +37%, json +7%; fastcall the only ~flat probe), Liftoff-only
ALSO worse (meth +6%, fib +31%, json +5%), bootMs flat (2,805 vs 2,830),
wasm +11,042 B. The musttail gate passed (`ceval.o` target_features carried
`tail-call` — real tail calls), so this is V8's per-bytecode
`return_call_indirect` being genuinely slow, confirming the original
rejection (which had been voided only for policy reasons). Patches deleted;
the cleanup rebuild was functionally correct but NOT byte-identical
(cpython-nuke non-reproducibility — NOTES learnings), so dist/raw was
restored from `bench/builds/v1-ship`, `stage --check` clean. The kit below
stays as the protocol for Cloudflare PR #6122's dispatcher variants 3/4
(direct `return_call` switch) and 6 (`br_table`) — the only untested
angles.

**2026-08-03 addendum — read `bench/tailcall-bridge/README.md` before acting
on PR #16's +20–27% variant-3/4/6 numbers.** Cross-verification showed the
remote's standalone baseline is ~2× slower than the fork's (build config, not
host), tail-call dispatch speed is build-insensitive, and the v0 verdict
INVERTS between builds on the same machine — so those wins are against
headroom the fork already banked. A fork-lane build of variant 4
(`-DTAIL_CALL_DISPATCH_MODE=4`, needs the PR's 0010 patch alongside 0011)
A/B'd per this kit is the only decisive experiment.

## Original context (2026-08-02)

The 2026-08-02 variant-0 "rejection" was measured under a shifting Windows
processor-boost policy (see the ledger's POLICY CONTAMINATION note) — its
numbers mixed slow-mode and fast-mode probes and were unusable standalone.

## Redo protocol (everything same-policy, "aggressive", interleaved)

1. Baseline exists: `bench/builds/v1-ship/` (copy `dist/raw` there after the
   final O2 ship build lands — O2 + trampoline + arity + zstd).
2. Recreate the two patches (both were verified TREE IDENTICAL / dry-run
   clean when first built):
   - **`patches/cpython/0011-avlo-tail-call-musttail.patch`** — header text of
     your choice + the exact body saved at `0011-body.diff` here (drops the
     `preserve_none` conjunct in `Python/ceval_macros.h`, defines
     `Py_PRESERVE_NONE_CC` empty under `__EMSCRIPTEN__`). AVLO marker
     required (the body's comment lines carry it).
   - **`patches/pyodide/0004-avlo-tail-call-build.patch`** — git-native flow:
     checkout the 0003 commit in `.work/pyodide`, apply exactly:
     ```python
     p = 'cpython/Makefile'
     s = open(p).read()
     old = "PYTHON_CFLAGS=$(CFLAGS_BASE) -DPY_CALL_TRAMPOLINE\n"
     new = ("# AVLO: -mtail-call enables musttail->return_call for the tail-call\n"
            "# interpreter (pairs with cpython patch 0011 + --with-tail-call-interp).\n"
            "PYTHON_CFLAGS=$(CFLAGS_BASE) -DPY_CALL_TRAMPOLINE -mtail-call\n")
     assert s.count(old) == 1; s = s.replace(old, new)
     old2 = "\t\t\t  --enable-big-digits=30 \\\n"
     new2 = old2 + "\t\t\t  --with-tail-call-interp \\\n"
     assert s.count(old2) == 1
     open(p, 'w').write(s.replace(old2, new2))
     ```
     commit as `0004-avlo-tail-call-build.patch`, cherry-pick the rest,
     `git diff <0003-commit> <0004-commit>` under a kept header, replay-verify.
3. `uv run avlo-build fork` (a cpython-lane change rebuilds the cpython stage, ~20 min; or iterate in `fork --dev`).
   Sanity: `pyconfig.h` has `#define Py_TAIL_CALL_INTERP 1`; glue still has
   2× `getWasmTrampolineModule`.

   **⚠️ Silent-musttail gotcha (confirmed 2026-08 remote session): without
   `-mtail-call`, clang IGNORES `musttail` with only a warning** — the 0011
   gate can't catch it (`_Py__has_attribute(musttail)` is true either way),
   so the build "looks fine" while emitting plain calls. Three-part proof
   the build actually tail-calls:
   1. **Compile-stage (the real gate):** the object's `target_features`
      section must list the feature —
      `node -e 'const b=require("fs").readFileSync(".work/pyodide/cpython/build/Python-3.14.2/Python/ceval.o");console.log(b.includes(Buffer.from("tail-call")))'`
      → must print `true` (the -O2 ship ceval.o prints `false`; verified
      both ways 2026-08-02). Do NOT check the final `pyodide.asm.wasm` —
      the linked binary carries no `target_features` section at all
      (verified: stripped at final link).
   2. `pyconfig.h` has `#define Py_TAIL_CALL_INTERP 1` (configure honored
      `--with-tail-call-interp`).
   3. Runtime: with (2) on and musttail silently dropped, every dispatched
      bytecode nests one real wasm frame — boot alone executes millions, so
      the interpreter overflows the engine call stack almost immediately.
      A V3 build that boots and runs the suite therefore genuinely
      tail-calls. (This retro-validates the original 2026-08-02 V3 build:
      patch 0004 carried `-mtail-call` in PYTHON_CFLAGS and the build ran
      8-second json benches — its numbers were void for POLICY reasons
      only, not because tail calls were fake.)
4. `cp -r dist/raw bench/builds/v3-tailcall/`, then interleave ×3:
   ```
   for i in 1 2 3; do
     node bench/probe-tramp.mjs --fork=bench/builds/v1-ship  --label=V1-redo-$i | tail -1 >> bench/ledger-2026-08.jsonl
     node bench/probe-tramp.mjs --fork=bench/builds/v3-tailcall --label=V3-redo-$i | tail -1 >> bench/ledger-2026-08.jsonl
   done
   ```
   plus `node --liftoff-only` pairs (compile-tier throughput) and 2-3 bootMs
   readings — the tier-up/compile story is the owner's actual hypothesis.
5. Ship rule: ≥ ~5% geomean on run2 medians OR clear compile/tier-up win
   with flat steady state; no probe regresses >10%. If variant 0 is flat/
   negative on throughput but compile wins, the next angle is Cloudflare
   PR #6122's dispatcher variants 3/4 (direct `return_call` switch) and 6
   (`br_table`) — their patch targets this exact 3.14.2 base. Skip variant 5
   (post-link binary rewrite pinned to LLVM 22 lowering; ours is clang 23).
6. Loser cleanup: delete the two patches → rebuild (lane auto-busts) →
   confirm `dist/raw` matches `bench/builds/v1-ship` numbers.

Keep the boost policy pinned for the WHOLE session and stamp it in the
ledger line (`{"note": "policy=aggressive"}`).
