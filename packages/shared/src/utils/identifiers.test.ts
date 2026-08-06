import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generateRoomId, normalizeRoomId, ROOM_ID_RE } from './room-id';
import { ulid } from './ulid';
import { generateUserId, USER_ID_RE } from './user-id';

describe('ROOM_ID_RE', () => {
  it('accepts exactly 14 base62 chars, case-SENSITIVE alphabet included', () => {
    expect(ROOM_ID_RE.test('abcDEF12345678')).toBe(true);
    expect(ROOM_ID_RE.test('AAAAAAAAAAAAAA')).toBe(true);
    expect(ROOM_ID_RE.test('00000000000000')).toBe(true);
  });

  it('rejects off-by-one lengths and out-of-alphabet chars', () => {
    expect(ROOM_ID_RE.test('a'.repeat(13))).toBe(false);
    expect(ROOM_ID_RE.test('a'.repeat(15))).toBe(false);
    expect(ROOM_ID_RE.test('abc-efghijklmn')).toBe(false);
    expect(ROOM_ID_RE.test('abc_efghijklmn')).toBe(false);
    expect(ROOM_ID_RE.test('abc efghijklmn')).toBe(false);
    expect(ROOM_ID_RE.test('')).toBe(false);
  });

  it('accepts every generated id and round-trips through normalizeRoomId', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateRoomId();
      expect(ROOM_ID_RE.test(id)).toBe(true);
      expect(normalizeRoomId(id)).toBe(id);
    }
    expect(normalizeRoomId('nope')).toBeNull();
  });
});

describe('USER_ID_RE', () => {
  it('accepts ULIDs — 26 chars, uppercase Crockford base32', () => {
    for (let i = 0; i < 50; i++) {
      expect(USER_ID_RE.test(ulid())).toBe(true);
      expect(USER_ID_RE.test(generateUserId())).toBe(true);
    }
  });

  it('rejects wrong lengths, lowercase, and the excluded Crockford letters I/L/O/U', () => {
    const valid = generateUserId();
    expect(USER_ID_RE.test(valid.slice(0, 25))).toBe(false);
    expect(USER_ID_RE.test(`${valid}A`)).toBe(false);
    expect(USER_ID_RE.test(valid.toLowerCase())).toBe(false);
    for (const ch of ['I', 'L', 'O', 'U']) {
      expect(USER_ID_RE.test(ch + valid.slice(1)), `letter ${ch}`).toBe(false);
    }
  });
});

describe('identifier regex properties', () => {
  // Both regexes gate WIRE input (URL params, cookies, queue events) — the property
  // re-states each contract independently so anchoring/multiline/char-class slips
  // (e.g. a `\n`-smuggled 15th char) can't survive. Arbitrary unicode input included.
  it('ROOM_ID_RE accepts exactly {base62}×14 — nothing else, no matter the input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (s) => {
        expect(ROOM_ID_RE.test(s), JSON.stringify(s)).toBe(s.length === 14 && /^[0-9A-Za-z]{14}$/.test(s));
      }),
    );
  });

  it('USER_ID_RE accepts exactly {Crockford-uppercase}×26 — I/L/O/U excluded everywhere', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        expect(USER_ID_RE.test(s), JSON.stringify(s)).toBe(s.length === 26 && /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(s));
      }),
    );
  });
});
