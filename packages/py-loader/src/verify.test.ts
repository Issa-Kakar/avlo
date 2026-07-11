import { describe, expect, it } from 'vitest';
import { matchesLockEntry, sha256Hex } from './verify';

describe('py-loader/verify', () => {
  it('sha256Hex returns the well-known empty-input vector', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matchesLockEntry gates on size first, then sha', async () => {
    const bytes = new TextEncoder().encode('hi');
    const sha256 = await sha256Hex(bytes);
    expect(await matchesLockEntry(bytes.buffer, { sha256, size: 2 })).toBe(true);
    expect(await matchesLockEntry(bytes.buffer, { sha256, size: 3 })).toBe(false); // size mismatch short-circuits
    expect(await matchesLockEntry(bytes.buffer, { sha256: '0'.repeat(64), size: 2 })).toBe(false); // sha mismatch
  });
});
