// Deterministic-environment kit for reproducible fork boots (consumer:
// prebake-fontcache.mjs; born under make-baseline.mjs, retired at P2 — client
// captures need no determinism, they hash what they wrote). Three sources
// reach the heap during a capture boot (found by byte-diffing two builds):
// (1) entropy — in Node, Emscripten's initRandomFill prefers
//     require('crypto').randomFillSync over webcrypto, so BOTH get seeded
//     stand-ins;
// (2) Date.now — MEMFS stamps every node (the stdlib zip mtime lands in
//     zipimport's heap cache);
// (3) performance.now — clock_gettime anchors.
import { createRequire } from 'node:module';

export function installDeterministicEnv() {
  let s = 0x9e3779b9 >>> 0;
  const next = () => {
    s ^= (s << 13) >>> 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0;
    s >>>= 0;
    return s;
  };
  const fill = (view) => {
    const u8 = new Uint8Array(view.buffer ?? view, view.byteOffset ?? 0, view.byteLength ?? view.length);
    for (let i = 0; i < u8.length; i++) u8[i] = next() & 0xff;
    return view;
  };
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    configurable: true,
    value: fill,
  });
  const nodeCrypto = createRequire(import.meta.url)('crypto');
  nodeCrypto.randomFillSync = (buf, offset, size) => {
    const view = offset !== undefined ? new Uint8Array(buf.buffer ?? buf, offset, size ?? buf.length - offset) : buf;
    fill(view);
    return buf;
  };
  nodeCrypto.randomBytes = (n) => fill(Buffer.alloc(n));
  let fakeNow = 1_750_000_000_000; // fixed epoch; +1 ms per call
  Date.now = () => (fakeNow += 1);
  let perf = 0;
  performance.now = () => (perf += 0.1);
}
