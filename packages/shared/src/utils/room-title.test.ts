import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeRoomTitle, ROOM_TITLE_MAX_LEN } from './room-title';

describe('normalizeRoomTitle', () => {
  it('collapses internal whitespace runs (incl. tabs/newlines) and trims the ends', () => {
    expect(normalizeRoomTitle('  Board \t of\n\n  Plans  ')).toBe('Board of Plans');
    expect(normalizeRoomTitle('one two')).toBe('one two');
  });

  it('rejects empty and whitespace-only input with null (caller reverts)', () => {
    expect(normalizeRoomTitle('')).toBeNull();
    expect(normalizeRoomTitle('   \t\n ')).toBeNull();
  });

  it('accepts exactly the max length and rejects one past it', () => {
    expect(normalizeRoomTitle('x'.repeat(ROOM_TITLE_MAX_LEN))).toBe('x'.repeat(ROOM_TITLE_MAX_LEN));
    expect(normalizeRoomTitle('x'.repeat(ROOM_TITLE_MAX_LEN + 1))).toBeNull();
  });

  it('measures length AFTER collapsing — a raw over-max string that collapses under the cap is valid', () => {
    const raw = `${'a'.repeat(30)}${' '.repeat(40)}${'b'.repeat(29)}`; // 99 raw → 60 collapsed
    expect(normalizeRoomTitle(raw)).toBe(`${'a'.repeat(30)} ${'b'.repeat(29)}`);
  });

  // The rule is enforced at three boundaries (client input, users Zod, DO guard) —
  // these pin the algebra every boundary silently assumes.
  it('property: normalizing is idempotent — an accepted title re-normalizes to itself', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const n = normalizeRoomTitle(s);
        fc.pre(n !== null);
        expect(normalizeRoomTitle(n as string)).toBe(n);
      }),
    );
  });

  it('property: every accepted title is 1..MAX chars, trimmed, single-spaced, single-line', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const n = normalizeRoomTitle(s);
        fc.pre(n !== null);
        const t = n as string;
        expect(t.length).toBeGreaterThanOrEqual(1);
        expect(t.length).toBeLessThanOrEqual(ROOM_TITLE_MAX_LEN);
        expect(t).toBe(t.trim());
        expect(t).not.toMatch(/\s\s/);
        expect(t).not.toMatch(/[^\S ]/); // the only whitespace left is a single space
      }),
    );
  });
});
