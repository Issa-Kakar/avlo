/**
 * AVS2 codec unit tests — the pure half of py-snapshot.ts (hash, header
 * plan/encode/parse, chunked heap read). The OPFS store + the live capture/
 * restore loop are covered by the py-build Node harness (`pnpm harness
 * --section snapshot`, real fork boots) and `e2e/py-snapshot.spec.ts` (real
 * browser, real OPFS).
 */

import { describe, expect, it } from 'vitest';
import {
  type AvsCaptureMeta,
  type AvsHeader,
  encodeAvsHeaderBlock,
  parseAvsHeader,
  planAvsHeapOff,
  readSnapshotToBuffer,
  type SnapReadHandle,
  Xxh32,
} from './py-snapshot';

const LIVE = { live: () => true, abandoned: () => false };

const memHandle = (bytes: Uint8Array): SnapReadHandle => ({
  size: bytes.length,
  read: (view, at) => {
    const n = Math.min(view.length, Math.max(0, bytes.length - at));
    view.set(bytes.subarray(at, at + n));
    return n;
  },
  close: () => {},
});

/** Deterministic pseudo-random fill (LCG) — content is irrelevant, stability is not. */
function fill(len: number, seed = 0x12345678): Uint8Array {
  const out = new Uint8Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

const hashOf = (u8: Uint8Array): string => {
  const x = new Xxh32();
  x.update(u8);
  return x.hex();
};

describe('Xxh32', () => {
  it('matches the known-answer vectors (seed 0)', () => {
    expect(hashOf(new Uint8Array(0))).toBe('02cc5d05');
    expect(hashOf(new TextEncoder().encode('abc'))).toBe('32d153ff');
    expect(hashOf(new TextEncoder().encode('Nobody inspects the spammish repetition'))).toBe('e2293b2f');
  });

  it('is chunking-invariant (streaming carry across odd split points)', () => {
    const data = fill(100_000);
    const oneShot = hashOf(data);
    const x = new Xxh32();
    for (let off = 0, step = 1; off < data.length; off += step, step = (step * 7) % 4096 || 1) {
      x.update(data.subarray(off, Math.min(off + step, data.length)));
    }
    expect(x.hex()).toBe(oneShot);
  });

  it('handles unaligned views (DataView slow path == u32 fast path)', () => {
    const buf = new Uint8Array(65 + 1);
    buf.set(fill(65), 1);
    const unaligned = buf.subarray(1); // byteOffset 1 — the fast path is unreachable
    expect(hashOf(unaligned)).toBe(hashOf(fill(65)));
  });
});

/** A small-but-realistic capture: header JSON with a few DSOs + a heap. */
function makeSnapshot(heapLen = (8 << 20) + 1000): { file: Uint8Array; header: Omit<AvsHeader, 'heapOff'>; heap: Uint8Array } {
  const heap = fill(heapLen);
  const meta: AvsCaptureMeta = {
    dso: {
      loadOrder: ['/lib/python3.14/site-packages/.avlo/numpy.so'],
      soMemoryBases: { '/lib/python3.14/site-packages/.avlo/numpy.so': 20_800_000 },
      soTableBases: { '/lib/python3.14/site-packages/.avlo/numpy.so': 8104 },
    },
    dsoHandles: { '/lib/python3.14/site-packages/.avlo/numpy.so': { handles: [1234] } },
    hiwire: { hiwireKeys: [], immortalKeys: [] },
    buildId: 'test-build-id',
    tableLenAtCapture: 21_526,
    heapLen,
  };
  const header: Omit<AvsHeader, 'heapOff'> = {
    v: 2,
    buildHash: 'cafebabe12345678',
    setKey: 'numpy',
    heapHash: { algo: 'xxh32', value: hashOf(heap) },
    ...meta,
  };
  const heapOff = planAvsHeapOff(header);
  const block = encodeAvsHeaderBlock(header, heapOff);
  const file = new Uint8Array(heapOff + heapLen);
  file.set(block, 0);
  file.set(heap, heapOff);
  return { file, header, heap };
}

const EXPECT = { buildHash: 'cafebabe12345678', setKey: 'numpy' };

describe('AVS2 header', () => {
  it('planAvsHeapOff reaches a fixed point and encode agrees', () => {
    const { header } = makeSnapshot(1000);
    const heapOff = planAvsHeapOff(header);
    expect(heapOff % 4096).toBe(16); // 16 + alignUp(len, 4096)
    expect(encodeAvsHeaderBlock(header, heapOff).length).toBe(heapOff);
  });

  it('the hash placeholder is length-identical to any real digest', () => {
    const { header } = makeSnapshot(1000);
    const placeholder = { ...header, heapHash: { algo: 'xxh32' as const, value: '00000000' } };
    const heapOff = planAvsHeapOff(placeholder);
    // Sized with the placeholder, finalized with the real digest — the shipped
    // writeSetSnapshot order. A length shift would throw here.
    expect(() => encodeAvsHeaderBlock(header, heapOff)).not.toThrow();
  });

  it('round-trips every field through parseAvsHeader', () => {
    const { file, header } = makeSnapshot(1000);
    const { heapOff, ...rest } = parseAvsHeader(memHandle(file), EXPECT);
    expect(rest).toEqual(header);
    expect(heapOff).toBe(planAvsHeapOff(header));
  });

  it('rejects a corrupt magic', () => {
    const { file } = makeSnapshot(1000);
    file[0] ^= 0xff;
    expect(() => parseAvsHeader(memHandle(file), EXPECT)).toThrow(/magic/);
  });

  it('rejects a corrupt header JSON byte (crc)', () => {
    const { file } = makeSnapshot(1000);
    file[20] ^= 0xff;
    expect(() => parseAvsHeader(memHandle(file), EXPECT)).toThrow(/crc/);
  });

  it('rejects a fixed-header heapLen that disagrees with the JSON', () => {
    const { file } = makeSnapshot(1000);
    file[8] ^= 0x01; // u32 heapLen lives at offset 8, outside the crc'd JSON
    expect(() => parseAvsHeader(memHandle(file), EXPECT)).toThrow(/heapLen/);
  });

  it('rejects buildHash / setKey mismatches (stale build, wrong set)', () => {
    const { file } = makeSnapshot(1000);
    expect(() => parseAvsHeader(memHandle(file), { ...EXPECT, buildHash: 'deadbeefdeadbeef' })).toThrow(/buildHash/);
    expect(() => parseAvsHeader(memHandle(file), { ...EXPECT, setKey: 'all' })).toThrow(/setKey/);
  });

  it('rejects a truncated file (fileSize − heapOff ≠ heapLen — torn write)', () => {
    const { file } = makeSnapshot(1000);
    expect(() => parseAvsHeader(memHandle(file.subarray(0, file.length - 1)), EXPECT)).toThrow(/heapOff ≠ heapLen/);
  });
});

describe('readSnapshotToBuffer', () => {
  it('lands the exact heap bytes across chunk boundaries and verifies the hash', async () => {
    const { file, heap } = makeSnapshot(); // > one 8 MB chunk — exercises the loop
    const header = parseAvsHeader(memHandle(file), EXPECT);
    const buf = await readSnapshotToBuffer(memHandle(file), header, LIVE);
    expect(buf).not.toBeNull();
    // memcmp, not toEqual — vitest's deep-equal diff on multi-MB typed arrays
    // allocates per element and OOMs the worker.
    expect(Buffer.compare(Buffer.from(buf as ArrayBuffer), Buffer.from(heap))).toBe(0);
  });

  it('throws on a corrupt heap byte (fast-hash mismatch)', async () => {
    const { file } = makeSnapshot(1000);
    const header = parseAvsHeader(memHandle(file), EXPECT);
    file[header.heapOff + 500] ^= 0xff;
    await expect(readSnapshotToBuffer(memHandle(file), header, LIVE)).rejects.toThrow(/hash mismatch/);
  });

  it('throws on a short read (handle EOF before heapLen)', async () => {
    const { file } = makeSnapshot(1000);
    const header = parseAvsHeader(memHandle(file), EXPECT);
    await expect(readSnapshotToBuffer(memHandle(file.subarray(0, file.length - 10)), header, LIVE)).rejects.toThrow(/short heap read/);
  });

  it('resolves null without reading further when the generation is superseded or abandoned', async () => {
    const { file } = makeSnapshot(1000);
    const header = parseAvsHeader(memHandle(file), EXPECT);
    expect(await readSnapshotToBuffer(memHandle(file), header, { live: () => false, abandoned: () => false })).toBeNull();
    expect(await readSnapshotToBuffer(memHandle(file), header, { live: () => true, abandoned: () => true })).toBeNull();
  });
});
