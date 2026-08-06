import { describe, expect, it } from 'vitest';
import { syntheticCacheUrl } from '../src/cache-keys';
import { retryTransient } from '../src/retry';
import { AnonToken } from '../src/zod/anon-token';
import { contentLengthBound, MAX_UPLOAD_BYTES } from '../src/zod/content-length';
import { MetaEvent, MigrateEvent, VisitEvent } from '../src/zod/room-event';
import { unfurlQuery } from '../src/zod/url-param';

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ROOM = 'abcDEF12345678';

describe('retryTransient', () => {
  it('retries ANY error up to maxAttempts, returning the first success', async () => {
    let calls = 0;
    const result = await retryTransient(async () => {
      if (++calls < 3) throw new Error(`fail ${calls}`);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after exactly maxAttempts and rethrows the last error', async () => {
    let calls = 0;
    await expect(
      retryTransient(async () => {
        calls++;
        throw new Error('always');
      }, 3),
    ).rejects.toThrow('always');
    expect(calls).toBe(3);
  });

  it('honors maxAttempts=1 (no retry at all)', async () => {
    let calls = 0;
    await expect(
      retryTransient(async () => {
        calls++;
        throw new Error('once');
      }, 1),
    ).rejects.toThrow('once');
    expect(calls).toBe(1);
  });
});

describe('syntheticCacheUrl', () => {
  it('namespaces by service so bare keys can never collide across workers', () => {
    expect(syntheticCacheUrl('unfurl', 'abc')).toBe('https://unfurl.cache.avlo.internal/abc');
    expect(syntheticCacheUrl('py', 'abc')).not.toBe(syntheticCacheUrl('unfurl', 'abc'));
  });
});

describe('contentLengthBound', () => {
  const schema = contentLengthBound(MAX_UPLOAD_BYTES);
  const parse = (v?: string) => schema.safeParse(v === undefined ? {} : { 'content-length': v });

  it('accepts a positive integer up to and including the max', () => {
    expect(parse('123').success).toBe(true);
    expect(parse(String(MAX_UPLOAD_BYTES)).success).toBe(true);
  });

  it('rejects missing, zero, negative, non-numeric, fractional, and over-max', () => {
    for (const v of [undefined, '0', '-1', 'abc', '1.5', String(MAX_UPLOAD_BYTES + 1)]) {
      expect(parse(v).success, String(v)).toBe(false);
    }
  });
});

describe('AnonToken', () => {
  it('parses and BRANDS a well-formed payload', () => {
    const parsed = AnonToken.safeParse({ userId: ULID, iat: 1, nonce: 'n' });
    expect(parsed.success).toBe(true);
  });

  it('rejects malformed user ids and missing fields (the truncated-cookie gate)', () => {
    expect(AnonToken.safeParse({ userId: ULID.slice(0, 20), iat: 1, nonce: 'n' }).success).toBe(false);
    expect(AnonToken.safeParse({ userId: ULID.toLowerCase(), iat: 1, nonce: 'n' }).success).toBe(false);
    expect(AnonToken.safeParse({ userId: ULID, nonce: 'n' }).success).toBe(false);
    expect(AnonToken.safeParse({ userId: ULID, iat: 1 }).success).toBe(false);
  });
});

describe('queue event schemas (the poison-drop gates)', () => {
  it('parse well-formed events', () => {
    expect(VisitEvent.safeParse({ userId: ULID, roomId: ROOM, visitedAt: 1 }).success).toBe(true);
    expect(
      MetaEvent.safeParse({ roomId: ROOM, ownerId: ULID, permission: 'public', createdAt: 1, title: 't', rev: 1, deletedAt: null }).success,
    ).toBe(true);
    expect(MigrateEvent.safeParse({ roomId: ROOM, from: ULID, to: ULID }).success).toBe(true);
  });

  it('drop malformed ids and out-of-vocabulary permissions cleanly', () => {
    expect(VisitEvent.safeParse({ userId: 'not-a-ulid', roomId: ROOM, visitedAt: 1 }).success).toBe(false);
    expect(VisitEvent.safeParse({ userId: ULID, roomId: 'short', visitedAt: 1 }).success).toBe(false);
    expect(
      MetaEvent.safeParse({ roomId: ROOM, ownerId: ULID, permission: 'secret', createdAt: 1, title: 't', rev: 1, deletedAt: null }).success,
    ).toBe(false);
    expect(MigrateEvent.safeParse({ roomId: ROOM, from: ULID }).success).toBe(false);
  });
});

describe('unfurlQuery', () => {
  it('normalizes and accepts a public http(s) URL', () => {
    const parsed = unfurlQuery.safeParse({ url: 'https://Example.com/Page#frag' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.url).toBe('https://example.com/Page');
  });

  it('FAILS (never throws) on unparseable input — the abort-refine regression pin', () => {
    // Without `abort` on the null-refine, zod v4 runs the SSRF refine on null and
    // throws inside validation, turning a bad request into a 500.
    const parsed = unfurlQuery.safeParse({ url: 'not a url at all' });
    expect(parsed.success).toBe(false);
  });

  it("labels SSRF-refused hosts 'URL not allowed', distinct from 'invalid URL'", () => {
    const priv = unfurlQuery.safeParse({ url: 'http://169.254.169.254/x' });
    expect(priv.success).toBe(false);
    if (!priv.success) expect(priv.error.issues[0]?.message).toBe('URL not allowed');

    const bad = unfurlQuery.safeParse({ url: 'ftp://example.com/x' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toBe('invalid URL');
  });
});
