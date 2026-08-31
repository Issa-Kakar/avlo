// No fork boot: (1) the assert gate names unfrozen intrinsics in a scrubbed-
// but-unfrozen realm (the under-sampling fix), (2) matchesLockEntry over the
// staged serving tree — positive on every artifact, negative on a flipped
// byte and a truncated buffer. Runs in its own fork: this file scrubs and
// freezes the realm.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchesLockEntry } from '@avlo/py-loader';
import { describe, expect, it } from 'vitest';
import * as harden from '../../src/core/py/py-harden';
import { asArrayBuffer, forkDir, LOCK } from './helpers';

describe('assertRealmHardened gate', () => {
  it('names unfrozen intrinsics pre-harden (scrubbed but unfrozen realm)', () => {
    harden.scrubWorkerScope();
    for (const name of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming', 'Module']) {
      delete (WebAssembly as unknown as Record<string, unknown>)[name]; // isolate the freeze branch of the gate
    }
    let msg: string | null = null;
    try {
      harden.assertRealmHardened();
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toContain('not frozen');
    expect(msg).toContain('JSON');
  });
  it('passes once hardenRealm runs', () => {
    harden.hardenRealm();
    expect(() => harden.assertRealmHardened()).not.toThrow();
  });
});

describe('staged serving tree vs the committed lock', () => {
  it.each(Object.keys(LOCK.artifacts))('staged %s matches the committed lock', async (name) => {
    const bytes = asArrayBuffer(readFileSync(join(forkDir, name)));
    expect(await matchesLockEntry(bytes, LOCK.artifacts[name])).toBe(true);
  });
  it('flipped byte fails the lock', async () => {
    const wasm = asArrayBuffer(readFileSync(join(forkDir, 'pyodide.asm.wasm')));
    const flipped = wasm.slice(0);
    new Uint8Array(flipped)[1000] ^= 0xff;
    expect(await matchesLockEntry(flipped, LOCK.artifacts['pyodide.asm.wasm'])).toBe(false);
  });
  it('truncated buffer fails the lock', async () => {
    const wasm = asArrayBuffer(readFileSync(join(forkDir, 'pyodide.asm.wasm')));
    expect(await matchesLockEntry(wasm.slice(0, wasm.byteLength - 1), LOCK.artifacts['pyodide.asm.wasm'])).toBe(false);
  });
});
