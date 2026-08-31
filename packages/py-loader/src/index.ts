// The committed app↔artifact coupling for the Python runtime: the supervisor
// verifies every fetched artifact against THIS lock (no boot-time manifest
// discovery), and the SW/supervisor cache is keyed `avlo-py-<PY_BUILD_HASH>`.
// ONLY py-build's `avlo-build stage` writes build-lock.json (byte-gated by
// `avlo-build stage --check`); restage ⇒ new hash ⇒ reseed R2 (`avlo-build
// publish`) + commit.
import lock from '../build-lock.json';

export interface BuildLock {
  readonly schema: 1;
  readonly buildHash: string;
  readonly artifacts: Readonly<Record<string, { readonly sha256: string; readonly size: number }>>;
  readonly bundles: Readonly<Record<string, { readonly sha256: string; readonly size: number }>>;
  readonly sets: Readonly<Record<string, readonly string[]>>;
}

// Deep-freeze at module scope (Session-5 freeze discipline): the lock rides
// into the supervisor worker where it gates artifact integrity — its tables
// must not be reshapeable at runtime in any thread.
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
};

export const BUILD_LOCK: BuildLock = deepFreeze(lock) as BuildLock;
export const PY_BUILD_HASH: string = BUILD_LOCK.buildHash;

export { matchesLockEntry, sha256Hex } from './verify';
