# DSO grouping (67 → 4) — critical second opinion

**Date:** 2026-07-19 · **Build analyzed:** `58ae9021763d19f0` (Pyodide 314.0.2 / CPython 3.14.2
/ emsdk 5.0.3 / ABI 2026_0, MAIN_MODULE=2 closed world) · **Status:** investigation only, no
code changed. Analyzer script: scratchpad `analyze-dsos.mjs` (parses every shipped `.so` out of
`dist/stage/bundles/*.tar` + the main wasm; promote into `scripts/` at replan time).

## Verdict

**Viable, and the plan rejected it on a false premise.** The rejected-alternatives entry
("Grouped side modules (67→5): grouping needs the same source-build surgery as static…
~90% of the win is captured by module-clone + incremental GOT") priced grouping at
static-linking's cost while none of static's actual killers apply:

- Static's killers were **off-ABI forever** (can't consume upstream wheels → "become a
  distro"), **per-set main-module builds**, and "meson can't emit static archives". A grouped
  side module is a *normal 2026_0 side module* — same ABI, same dlopen, same main module for
  every set, and it needs no static archives: it links each package's **original `.o`/`.a`
  link inputs** into one `-sSIDE_MODULE=2` `.so`. That is plain linking, which wasm-ld does
  natively.
- "~90% captured by module-clone + incremental GOT" undersells structurally: those are
  *runtime machinery* (a 66-entry compiled-Module RAM cache with TTL policy + a custom emsdk
  patch), and module-clone only helps **respawns within one page session** — first boot of
  every page still pays 67× everything. Grouping is *build-time*, permanent, helps every
  boot/restore path, and **deletes** the incremental-GOT patch and most of the machinery the
  plan adds to compensate.

Every technical premise in the owner's framing checked out against the binaries, the
toolchain source, and upstream — with the corrections and calibrations below. The one real
cost is standing up from-source package builds (bounded, one-time per toolchain bump,
pins all named below). Recommendation: **land as "Phase 1.5" before any P2 snapshot
capture** — snapshots bake DSO tables/bases, so grouping after P2 means recapturing
everything and throwing away the incremental-GOT work P2 would have built.

---

## 1 · Premise-by-premise check

| Owner's claim | Verdict | Evidence |
|---|---|---|
| A finished `.so` cannot be re-linked; `wasm-ld -r` needs relocatable objects; a final side module has relocs consumed, PIC `__memory_base` addressing, GOT imports, `dylink.0` | **Correct** | Shipped DSOs carry only a `dylink.0` MEM_INFO subsection (verified by parse — no linking metadata at all). Nothing for `-r` to consume. |
| wasm-merge can't merge PIC side modules (would need per-module derived bases, GOT dedup, ctor/reloc-fn merging, dylink recompute = writing a PIC static linker) | **Correct** | binaryen's own tool header: "Unlike wasm-ld, this does not have the full semantics of native linkers… connect modules the way JS could at runtime." Zero dylink/GOT/`__memory_base` handling in the tool ([wasm-merge.cpp](https://github.com/WebAssembly/binaryen/blob/main/src/tools/wasm-merge.cpp)). Dead end confirmed — don't revisit. |
| Group at the original link from `.o`/`.a` inputs — "just linking" | **Correct, with one refinement** | Skip the `-r` intermediate entirely (a relocatable pre-link *pulls archive members in*, baking duplicate static-lib copies that then collide at the group link). One-shot `emcc -sSIDE_MODULE=2` over the **deduped union of original objects + archives** keeps normal lazy archive-member semantics — dupes never materialize. `--allow-multiple-definition` exists as an escape hatch ([lld/wasm/Options.td](https://github.com/llvm/llvm-project/blob/main/lld/wasm/Options.td)) but shouldn't be needed. |
| The weak-COMDAT GOT trap fires when `.so` files are passed to the main link; keep them off the line | **Correct — and already our architecture** | Loop B's `--export-if-defined` union (fetch-wheels.mjs:128–211) exists precisely for this. Quote source found: [emscripten#23107](https://github.com/emscripten-core/emscripten/issues/23107) (sbc100, 2024-12; still open). Grouping *changes nothing* about the main link recipe — `link.rsp` regenerates from whatever DSOs ship (the scan is DSO-set-agnostic) and shrinks. |
| "Stub TU in main to own canonical COMDAT copies" | **Unnecessary** | Empirical: main already exports 157 libc++ COMDATs the DSOs import (via export-if-defined), and every remaining ODR symbol is self-satisfied (see §3). No new mechanism needed. |
| pywasmcross already wraps every compile/link; recording a manifest is an extension of existing machinery | **Correct — stronger than claimed** | Verified in-tree (`.work/pyodide/pyodide-build/pyodide_build/pywasmcross.py`): every tool is a symlink shim (`SYMLINKS` incl. `cc/c++/ld/meson/cmake`), `is_link_cmd()` detects `.so` links, **`filter_objects()` already extracts the `.o`/`.a`/`@rsp` args**, and `get_export_flags()` already links extensions `-sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=@file` with PyInit-only exports computed by `emnm` over those objects. The manifest/stash mode is ~40 lines beside functions that already do 90% of it. Bonus: `pywasmcross_env.json` + the symlink dir are *deliberately left in the build tree* ("This helps with reproducing"), and `packages/<pkg>/build.log` records every wrapped command. |
| Tier model: (1) support libs, (2) Cython near-perfectly groupable, (3) hand C/C++ bounded collision risk | **Right model; tier 1 is empty here** | See census. No `PyInit`-less DSO ships: Pyodide's numpy uses lapack-lite (no OpenBLAS), freetype/qhull are static inside `ft2font`/`_qhull`. The "support libs have no business being side modules" concern is moot for this closure. |
| `-fvisibility=hidden` doesn't fix link-time collisions | **Correct** (and confirmed in #23107 it doesn't even suppress the ODR exports) | Moot in practice — zero real collisions found (§3). |
| Runtime: finder resolves name → group handle + PyInit, "expose a tiny builtin rather than ctypes" | **Simpler than claimed: pure Python, zero C** | CPython 3.14 derives the init symbol from the **last dotted component** and dlopens **`spec.origin`** — so a meta-path finder returning `ExtensionFileLoader(fullname, group_so_path)` specs is the entire runtime (§4). No builtin, no ctypes (tombstoned anyway), no inittab (which wouldn't work post-`Py_Initialize` anyway). |

## 2 · Ground truth: census of the 67

From the staged tars (the shipped truth), all parsed per-DSO (imports incl. GOT.mem/GOT.func,
exports, dylink.0, data/table sizes, toolchain fingerprint from embedded strings):

| bundle | DSOs | bytes | data seg | toolchain | export entries | GOT entries | PyInit |
|---|---|---|---|---|---|---|---|
| pandas | **45** | 8.2 MB | 1.16 MB | 42 Cython + 3 C | 135 (≈3/DSO!) | 90 | 45 |
| numpy | **13** | 4.9 MB | 1.83 MB | 9 Cython + 4 C/C++ | 129 | 228 | 13 |
| matplotlib | **7** | 1.9 MB | 0.30 MB | 7 pybind11/C++ | 493 | 453 | 7 |
| mpl-deps | **2** | 0.36 MB | 0.03 MB | contourpy (pybind11) + kiwisolver (C++) | 460 | 177 | 2 |
| dateutil / pytz / seaborn | 0 | — | — | pure Python | — | — | — |
| **total** | **67** | 15.4 MB | 3.39 MB | 51 Cython / 16 C-C++ | 1,217 | 3,133 | 67 |

Tier classification: **T1 = ∅**, **T2 (Cython) = 51/67**, **T3 (hand C/C++) = 16**. pandas
already ships `_cyutility` — Cython 3.1's shared utility module ([pandas#61384](https://github.com/pandas-dev/pandas/pull/61384));
the ecosystem is *already* consolidating Cython boilerplate in our exact package set.

**Collision audit (the tier-3 worry): empty.**
- Duplicate export names inside a proposed group: pandas/numpy/mpl-deps have **only**
  `__wasm_call_ctors` + `__wasm_apply_data_relocs` — linker-synthesized per module,
  regenerated fresh by any link; **not symbols, not collisions**. matplotlib adds 23
  pybind11 typeinfo/vtable names (`_ZTI/_ZTV/_ZTS…`) exported by all 7 modules — C++
  ODR vague linkage (COMDAT in the objects); a grouped link **folds them to one copy
  automatically**. That's the C++ compilation model working, not a conflict.
- **PyInit last-component uniqueness: no collisions in any bundle** (`pandas._libs.json` →
  `PyInit_json` is unique within pandas; every group clean). This is the one hard
  constraint of the finder design (pygame-static hit it and renamed; we don't have to).
- Residual risk (invisible to export scans): duplicated *hidden* copies of static helper
  libs (numpy's `libnpymath.a`/`libnpyrandom.a` linked into several extensions). At a group
  link from original inputs the archive dedupes by path and members pull once; if any build
  passed raw objects instead, wasm-ld fails **loudly** with duplicate-symbol errors —
  detected at build time, fixed mechanically (dedup input list; worst case
  `--allow-multiple-definition` for identical copies; last resort split the group).

## 3 · The decisive measurement: zero hard cross-DSO dependencies

Classifying **every** import entry of all 67 DSOs (env func/global/tag + GOT.mem/GOT.func,
`invoke_*` and dylink plumbing excluded) by provider, self-inclusive:

| provider | entries |
|---|---|
| main module exports | 10,701 |
| **the importing DSO itself** (ODR/PIC self-reference: exports X *and* imports X) | 1,023 |
| JS glue (`exit`) | 1 |
| a sibling DSO, same bundle | **0** |
| a DSO in another bundle | **0** |

The self class is exactly the pattern from emscripten#23107: each C++ module exports its
template/typeinfo instantiations *and* GOT-imports them because the dynamic linker picks one
at runtime; `updateGOT(own exports)` runs before `reportUndefinedSymbols`
(libdylink.js:826–831), so every entry self-satisfies. Consequences:

- **Groups are fully independent.** No inter-group load-order constraint at the symbol
  level; deps-first set order stays a Python-level concern only.
- **Group exports need only be `PyInit_*`** (+ whatever wasm-ld auto-exports as
  GOT-referenced, e.g. ft2font's static-freetype tables) — the same `exports: pyinit`
  policy the wheels are built with today, applied at the group link.
- Cross-DSO C++ calls *within* a package today bounce through **permanent JS stub
  trampolines** (unresolved env func imports get a closure that resolves at first call —
  libdylink.js:785–796 — and stays a JS hop forever). Cython modules interop via
  `__pyx_capi__` capsules (zero dynamic-symbol coupling — confirmed in Cython source and
  empirically: 0 sibling edges). A grouped link turns the C++ self/sibling traffic into
  direct wasm calls and leaves capsules untouched.

## 4 · What grouping actually buys (mechanism-level, from the 5.0.3 glue we ship)

Per dlopen today (×67, all eager at mount — `py-executor.ts:151–160` → fork `dynload.ts`
`_emscripten_dlopen_promise(path, RTLD_NOW|RTLD_LOCAL)`):

1. wasm compile + instantiate (per-module fixed cost; V8 can't batch 67 tiny modules).
2. `relocateExports` — walk every export, offset by `__memory_base`.
3. `updateGOT(exports)` — walk every export; `addFunction()` table-wraps each GOT-filled
   function (libdylink.js:227–277).
4. `reportUndefinedSymbols()` — **`Object.entries()` over the entire accumulated GOT, every
   dlopen** (libdylink.js:325–370; the dlopen path never sets `allowUndefined` —
   `dlopenInternal`, libdylink.js:1283–1305). Cost is Σᵢ|GOTᵢ| — quadratic-flavored; the GOT
   ends at ~735 unique symbols. This is the P0-measured "~75% of dso-replay is glue-side
   bookkeeping" and the P2 incremental-GOT patch target.
5. Stub-proxy creation for unresolved env imports; `updateTableMap` over new table region;
   C-side `load_library` mallocs the whole `.so` into `file_data` (the P2 free+zero item).

Post-grouping (×4): same total wasm bytes compile (browsers parallelize *within* a module —
better, not worse), and the bookkeeping collapses:

| surface | today (67) | grouped (4) |
|---|---|---|
| module instantiations + per-module fixed costs | 67 | 4 |
| import entries resolved at instantiate | 8,592 | ~1,372 (main-API names deduped per group: pandas alone repeats the Py C-API 45×) |
| GOT import entries | 3,133 | ~420–1,400 (lower bound = pure intra-group dedup; upper keeps every default-visibility self-ODR entry — the real number falls out of the first link; either way the `reportUndefinedSymbols` integral collapses from 67 growing scans to 4 small ones, ≳30×) |
| export entries walked by updateGOT/mergeLibSymbols | 1,217 | ~950 (synthetics + COMDAT dedup) |
| JS stub trampolines for C++ intra-package calls | hundreds (contourpy alone: 232 env imports) | ~0 intra-group |
| `file_data` mallocs / MEMFS `.so` files / P2 truncate-to-0 entries | 67 | 4 |
| wasm `Module`+`Instance` objects + heap-snapshot overhead ([pyodide#5264](https://github.com/pyodide/pyodide/issues/5264): "a lot of memory overhead") | 67 | 4 |

**Honest ledger math (calibrate "biggest lever"):**
- **Cold boot today** (`all` = 1,854 ms): grouping touches only the mount span (197 ms:
  extract + 67 dlopens) and trims tar/wire bytes slightly. Expect **~60–150 ms** saved.
  load-pyodide (~390 ms), fetch, and Python-side `import numpy` (the only boot-baked import,
  `py-executor.ts:48`) don't move. On cold boots, **P2 snapshots remain the big lever.**
- **P2 restore path** (the architecture this decision shapes): P0 measured dso-replay at
  **428–464 ms, ~75% glue bookkeeping** — the dominant restore cost. Grouping shrinks the
  replay loop 67→4 and deletes most of the bookkeeping *by construction*: estimated
  **~250–350 ms off every restore**, before P2's own optimizations. It also deletes the
  planned **incremental-GOT emsdk patch** (4 scans over a small GOT ≈ sub-ms — the patch's
  entire purpose evaporates), shrinks the P4 module-clone map 66→4 (RAM-floor concern
  mostly dissolves), and cuts container-v2 manifest/handles bookkeeping to 4 entries.
- **Robustness:** 67 wasm modules is the class that produces Firefox "failed to allocate
  executable memory" and tab crashes upstream (#5264, scipy 110/pandas 44). The FF/Safari
  sweep is still an open item in NOTES — 4 modules preempts the whole class.
- **So:** biggest lever for the *snapshot-era architecture + permanent complexity/memory/
  portability*, a modest cold-boot win today. The plan's "re-open only if P4 trace shows
  per-module instantiate overhead still dominating" had it backwards — by P4 the snapshots
  are captured against the 67-DSO layout and the incremental-GOT patch is already built;
  the option is cheapest **now**, before P2 bakes anything.

## 5 · Runtime design: a ~40-line pure-Python finder (verified against CPython 3.14 source)

Mechanism (all verified in `.work/pyodide/cpython/build/Python-3.14.2/`):
- `Python/importdl.c` `get_encoded_name()` takes the substring **after the last dot** of
  `spec.name` → hook = `PyInit_<short>` (`PyInitU_` only for non-ASCII — none here).
- `Python/dynload_shlib.c` `_PyImport_FindSharedFuncptr()` = `dlopen(spec.origin)` +
  `dlsym(handle, "PyInit_<short>")`. The old dev/ino handle cache was **removed in 3.11**
  ([bpo-43895](https://github.com/python/cpython/issues/88061)) — irrelevant: emscripten's
  LDSO dedupes by path (`loadedLibsByName`, refcount++), so dlopen #2..#45 of the group file
  are O(1) registry hits, no re-instantiation.

Design:
1. Bundle tars ship `<bundle>.so` (one grouped side module) instead of N `.so` files;
   `meta.loadOrder = ["<bundle>.so"]`. Executor `mountBundle` is unchanged — it dlopens 4
   files instead of 67, still eagerly at mount, still before scrub/harden (the
   "all DSO loads are boot-time, then delete the WebAssembly compile surface" invariant is
   untouched).
2. A generated manifest (same codegen slot as `_avlo_pruned` registries / `stage.mjs`
   codegen) maps dotted extension names → group `.so` path, e.g.
   `{"pandas._libs.algos": "/lib/python3.14/site-packages/.avlo/pandas.so", …}` — minted at
   pack time from the recorded `PyInit_*` lists.
3. A meta-path finder in the `sitecustomize` overlay (installed before user code, like the
   tombstone finder):
   ```python
   class _AvloGroupFinder:
       def find_spec(self, fullname, path=None, target=None):
           so = _GROUPS.get(fullname)
           if so is None: return None
           return spec_from_file_location(fullname, so,
                    loader=ExtensionFileLoader(fullname, so))
   ```
   `_imp.create_dynamic` does the rest: dlopen(group) → registry hit → dlsym
   `PyInit_<last>` → PEP 489 init with the correct dotted `__name__`. Multi-phase (Cython 3)
   and single-phase (pybind11) both flow through the same path; single-phase caching keys on
   (name, filename) so same-file/different-name is clean (`Python/import.c` extensions dict).
4. Semantics preserved exactly: PyInit still runs at *import* time (lazy imports like
   `matplotlib._tri`, `pandas._libs.testing` stay lazy); C++ static ctors run at group
   dlopen = mount time, which is **when they already run today** (all 67 dlopen at mount);
   `__pyx_capi__` capsule imports go through normal imports → the finder. Data-segment
   residency is unchanged (everything is eager today). `__file__` points at the group `.so`
   (cosmetic).

Prior-art placement: mypyc ships group libs + per-module **shim `.so`s** resolved via
capsules; pygame-static and PyOxidizer use **inittab** (pre-init only — unusable for our
post-boot mounts); pyodide upstream calls per-package single-`.so` "the holy grail" /
"the real fix" but never built it ([#5264](https://github.com/pyodide/pyodide/issues/5264)).
The finder+grouped-side-module combination is novel *assembly*, but every ingredient is
verified upstream behavior. In wasm, shims would defeat the purpose (still N instantiates)
— the finder is strictly better here.

## 6 · Build design: harvest + group link (all pins verified)

**Reproduction pins (agent-verified):** recipes tag `314-20260629` (= pyodide-recipes commit
`732e33c3…`, already in `build.config.json` as `recipes.release`) with its **vendored
pyodide-build submodule**; xbuildenv `314.0.2`
(`…/releases/download/314.0.2/xbuildenv-314.0.2.tar.bz2`, sha256 `01ab1b22…`, emscripten
5.0.3 auto-installed by pyodide-build). Upstream builds these wheels in a conda env on
ubuntu-latest (NOT the pyodide-env image) — for our hermetic loop, run the same conda env
inside a pinned container. Only 5 packages need source builds: numpy, pandas, matplotlib,
contourpy, kiwisolver (~1–2 h total on the 2-core WSL2 pin; **cached until a toolchain
bump** — same cadence as today's wheel re-pins).

**Harvest** (two mechanisms, both verified to exist; belt-and-braces use both):
- meson-python deletes its temp builddir by default; numpy's recipe already sets
  `backend-flags: build-dir=build` — add the same one-liner to pandas/matplotlib/contourpy
  recipes (kiwisolver/setuptools persists under the source tree anyway). Build trees live at
  `packages/<pkg>/build/` and **persist** (`--clean` is opt-in); `build.log` records every
  wrapped command; `pywasmcross_env.json` records the exact flags.
- Patch pywasmcross with a record mode: on `is_link_cmd`, append
  `{output, filter_objects(line), flags}` to a manifest and copy the inputs into a stash
  keyed by output name (~40 lines, beside the existing machinery).

**Group link, per bundle:**
```
emcc -sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=@pyinits.json \
     <union of recorded objects+archives, deduped by path> \
     <reconciled recorded link flags>   →  <bundle>.so
```
Flags are uniform per package by construction (one pywasmcross env per build). wasm-ld folds
COMDATs, merges `__wasm_call_ctors`/`__wasm_apply_data_relocs`, recomputes `dylink.0`.
No post-processing exists to replicate (pyodide-build runs **no wasm-opt** on side wheels;
`strip` is a no-op for ABI > 2026 to protect `dylink.0`).

**Packaging (provenance-preserving):** keep consuming **upstream release wheels for the
`.py` trees** (wheel patches, prune lists, tombstones all untouched); the rebuild
contributes **only the grouped `.so`** per bundle. Gate: assert rebuilt-wheel `.py` bytes ==
upstream-wheel `.py` bytes (same sdist + same recipes ⇒ equal; a mismatch is a pin bug).
pack-package drops the per-extension `.so`s, injects `<bundle>.so` + the finder manifest.
The `.o` stash is a pinned intermediate cache like `.cache/wheels` — group links from it are
deterministic (wasm-ld, no timestamps); keep the `--repro` double-link gate.

**Downstream adapts automatically:** fetch-wheels' link-sos scan reads whatever DSOs ship →
`link.rsp` regenerates (1,764 → ~1,370, all main-satisfiable) → incremental main relink
(~19 s). Corpus/harness/budgets/stage gates operate on tars and carry over; budgets restamp;
buildHash rotates (restage ⇒ reseed as usual).

## 7 · Risks

| Risk | Assessment |
|---|---|
| Duplicate-symbol errors at group link (hidden static-lib copies: npymath/npyrandom) | **Loud, mechanical.** Dedup archive inputs; `--allow-multiple-definition` escape hatch; split-group last resort. Zero *dynamic* collisions measured. |
| Rebuilt `.so` behaves differently from upstream wheel `.so` | Same sources, same recipes, same xbuildenv, same flags (recorded); corpus 7/7 + harness + per-loadOrder import probes gate it. The `.py` byte-equality gate pins provenance. |
| pywasmcross/meson drift on future Pyodide bumps | Patch is additive (~40 lines); pywasmcross has been architecturally stable for years; recipe `build-dir` one-liners are upstreamable. |
| Ctor/data-residency semantics change | **None measured** — all 67 DSOs already dlopen eagerly at mount; grouping moves nothing earlier. |
| Group link produces a huge module V8 dislikes | Opposite direction: 8 MB pandas group ≈ the main module's size class; browsers tier big modules well; upstream's pain is *many small* modules (#5264). |
| Build-infra weight (the real price) | Conda env + recipes checkout + 5 package builds, ~1–2 h once per toolchain bump, cached. Owner already accepted heavier (Docker fork builds). |
| PyInit shortname collision from a future package | Audit is one grep in the analyzer; pygame precedent shows rename-at-link fixes it if it ever appears. |

## 8 · What this deletes / shrinks in the existing plan

- **P2:** incremental-GOT emsdk patch — **delete** (purpose evaporates). Container v2 dso
  manifest/handles: 4 entries. `.so` truncate-to-0: 4 files. Capture/restore-verify
  import-probe loops: unchanged in shape, 17× fewer modules. `file_data` free+zero patch:
  still wanted (4 buffers instead of 67).
- **P3 (WasmFS):** orthogonal and *helped* — the DSO-replay surface both P2 and P3 must
  carry shrinks 17×; no duplicated work between grouping and WasmFS (grouping is the
  link model; WasmFS is the FS model).
- **P4:** module-clone map 66→4 (RAM floor concern mostly gone; TTL still fine); SW/spawn
  work unchanged.
- **Loop-B artifacts:** `link.rsp` shrinks; main export table likely shrinks a bit further
  via metadce.

## 9 · Recommended sequencing for the replan

1. **Phase 1.5 (before any P2 capture):** stand up the recipe-build loop (pins above) →
   pywasmcross record/stash patch + recipe `build-dir` one-liners → group links → packaging
   swap + finder overlay + manifest codegen → full gate (corpus 7/7, harness, tracer,
   budgets restamp, `stage --check`, typecheck, browser board) → commit + seed.
   First step of implementation: add a `mount-extract` vs `mount-dlopen` trace split so the
   cold-path win is measured, not estimated.
2. **P2 proceeds against the 4-DSO world** with its scope reduced as in §8.
3. Analyzer promotion: move `analyze-dsos.mjs` into `scripts/` as a standing gate
   (collision audit + shortname audit + import-closure check on every restage).

## Appendix: prior-art index

[pyodide#5264](https://github.com/pyodide/pyodide/issues/5264) (the problem + "holy grail" framing) ·
[emscripten#23107](https://github.com/emscripten-core/emscripten/issues/23107) (the ODR/GOT quote, sbc100) ·
[pygame static.c](https://github.com/pygame/pygame/blob/main/src_c/static.c) (single-`.so` WASM build, inittab + renames) ·
[mypyc emitmodule.py](https://github.com/python/mypy/blob/master/mypyc/codegen/emitmodule.py) + [module_shim.tmpl](https://github.com/python/mypy/blob/master/mypyc/lib-rt/module_shim.tmpl) (compilation groups, shim+capsule dispatch) ·
[PyOxidizer](https://pyoxidizer.readthedocs.io/en/stable/pyembed_extension_modules.html) (inittab finder) ·
[CPython importdl.c / dynload_shlib.c (3.14)](https://github.com/python/cpython/blob/3.14/Python/importdl.c) + [bpo-43895](https://github.com/python/cpython/issues/88061) ·
[Cython ImportExport.c](https://github.com/cython/cython/blob/master/Cython/Utility/ImportExport.c) (`__pyx_capi__` capsules) + [Cython 3.1 `--shared`](https://cython.readthedocs.io/en/latest/src/userguide/source_files_and_compilation.html) + [pandas#61384](https://github.com/pandas-dev/pandas/pull/61384) ·
[pyodide#6033](https://github.com/pyodide/pyodide/pull/6033)/[#5995](https://github.com/pyodide/pyodide/pull/5995)/[#6240](https://github.com/pyodide/pyodide/pull/6240) (314's static-into-main precedent — the same lever at N=main) ·
[binaryen wasm-merge](https://github.com/WebAssembly/binaryen/blob/main/src/tools/wasm-merge.cpp) (why merging finals is dead) ·
pyodide-build permalinks in the agent report (pywasmcross symlinks/exports machinery, build-dir persistence, xbuildenv pinning).
