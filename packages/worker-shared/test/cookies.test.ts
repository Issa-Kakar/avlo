import { asUserId, ulid } from '@avlo/shared';
import { hmacBase64, mintAnonCookie, signedCookie } from '@avlo/test-support/cookies';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cookieOpts, mintAnonToken, parseCookieHeader, verifyAnonToken } from '../src/cookies';

const SECRET = 'unit-secret';
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('mint → verify round trip', () => {
  it('verifies a token minted with mintAnonToken and signed in the hono wire format', async () => {
    const cookie = await signedCookie('avlo_anon', mintAnonToken(asUserId(ULID)), SECRET);
    expect(await verifyAnonToken(cookie, SECRET)).toEqual({ userId: ULID, isAnon: true });
  });

  it('verifies the test-support mint helper (the cross-suite cookie contract)', async () => {
    expect(await verifyAnonToken(await mintAnonCookie(ULID, SECRET), SECRET)).toEqual({ userId: ULID, isAnon: true });
  });

  it('CHARACTERIZED: iat is carried but never checked — a 1970 token still verifies', async () => {
    // The anon cookie's lifetime is the browser Max-Age (sliding); the payload iat is
    // informational. Pinned so adding server-side expiry is a deliberate change.
    const cookie = await mintAnonCookie(ULID, SECRET, { iat: 0 });
    expect(await verifyAnonToken(cookie, SECRET)).toEqual({ userId: ULID, isAnon: true });
  });
});

describe('verifyAnonToken rejections', () => {
  it('nulls on absent header, absent cookie, and empty values', async () => {
    expect(await verifyAnonToken(null, SECRET)).toBeNull();
    expect(await verifyAnonToken('', SECRET)).toBeNull();
    expect(await verifyAnonToken('other=1', SECRET)).toBeNull();
  });

  it('nulls a tampered payload and a wrong-secret signature', async () => {
    const cookie = await mintAnonCookie(ULID, SECRET);
    expect(await verifyAnonToken(cookie.replace('avlo_anon=', 'avlo_anon=x'), SECRET)).toBeNull();
    expect(await verifyAnonToken(cookie, 'a-different-secret')).toBeNull();
  });

  it('nulls structurally broken values: no dot, short signature, non-base64 signature', async () => {
    expect(await verifyAnonToken('avlo_anon=nodothere', SECRET)).toBeNull();
    expect(await verifyAnonToken(`avlo_anon=${encodeURIComponent('{"userId":"x"}.shortsig=')}`, SECRET)).toBeNull();
    const cookie = await mintAnonCookie(ULID, SECRET);
    const junkSig = cookie.slice(0, cookie.lastIndexOf('.') + 1) + encodeURIComponent(`${'!'.repeat(43)}=`);
    expect(await verifyAnonToken(junkSig, SECRET)).toBeNull();
  });

  it('nulls a correctly-SIGNED payload that is not valid token JSON or not a ULID', async () => {
    // Signature verifies (we signed it) — the Zod gate must still reject the shape.
    const badJson = await signedCookie('avlo_anon', 'not json at all', SECRET);
    expect(await verifyAnonToken(badJson, SECRET)).toBeNull();

    const badId = await signedCookie('avlo_anon', JSON.stringify({ userId: 'lowercase-not-ulid', iat: 1, nonce: 'n' }), SECRET);
    expect(await verifyAnonToken(badId, SECRET)).toBeNull();
  });
});

describe('cookieOpts', () => {
  const req = (host: string) => new Request(`https://${host}/me`, { headers: { host } });

  it('prod: Secure + Domain=.avlo.io + Lax (sibling workers read it; OAuth top-level GET keeps it)', () => {
    expect(cookieOpts(req('auth.avlo.io'), 60)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      domain: '.avlo.io',
      maxAge: 60,
    });
  });

  it('dev: host-only, no Secure (plain-http localhost), same Lax posture', () => {
    expect(cookieOpts(req('localhost:8792'), 60)).toEqual({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 });
    expect(cookieOpts(req('127.0.0.1:8792'), 60)).not.toHaveProperty('domain');
  });
});

describe('parseCookieHeader', () => {
  it('extracts by exact name among multiple cookies, preserving = inside values', () => {
    expect(parseCookieHeader('a=1; avlo_anon=x%3D%3D.sig=; b=2', 'avlo_anon')).toBe('x%3D%3D.sig=');
    expect(parseCookieHeader('avlo_anon=v', 'avlo_anon')).toBe('v');
    expect(parseCookieHeader('avlo_anonymous=v', 'avlo_anon')).toBeNull(); // exact, not prefix
    expect(parseCookieHeader('noequals', 'avlo_anon')).toBeNull();
  });
});

describe('anon token — properties', () => {
  it('round-trips every generated ULID through mint → sign → verify', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const id = ulid();
        expect(await verifyAnonToken(await mintAnonCookie(id, SECRET), SECRET)).toEqual({ userId: id, isAnon: true });
      }),
      { numRuns: 25 },
    );
  });

  it('no single-character substitution can move verification to a different identity', async () => {
    // The HMAC covers the DECODED payload (hono's format), so a substitution that only
    // flips percent-escape hex case (`%3A` → `%3a`) decodes identically and still
    // verifies — as the SAME user. Every substitution that changes the decoded value
    // (or breaks decoding) must fail outright. Probed exhaustively once; pinned here
    // over random positions.
    const cookie = await mintAnonCookie(ULID, SECRET);
    const value = cookie.slice('avlo_anon='.length);
    const decodedOrNull = (s: string): string | null => {
      try {
        return decodeURIComponent(s);
      } catch {
        return null;
      }
    };
    const original = decodedOrNull(value);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: value.length - 1 }), fc.constantFrom(...'AZaz09_-'.split('')), async (pos, ch) => {
        fc.pre(value[pos] !== ch);
        const tampered = value.slice(0, pos) + ch + value.slice(pos + 1);
        const verdict = await verifyAnonToken(`avlo_anon=${tampered}`, SECRET);
        if (decodedOrNull(tampered) === original) {
          expect(verdict, `pos ${pos} → ${ch} (encoding-case twin)`).toEqual({ userId: ULID, isAnon: true });
        } else {
          expect(verdict, `pos ${pos} → ${ch}`).toBeNull();
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('hmacBase64 (test-support) matches the verify-side pre-filter', () => {
  it('always emits a 44-char base64 string ending in =', async () => {
    const sig = await hmacBase64('any value', SECRET);
    expect(sig).toHaveLength(44);
    expect(sig.endsWith('=')).toBe(true);
  });
});
