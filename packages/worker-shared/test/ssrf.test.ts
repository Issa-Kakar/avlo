import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isPrivateHost } from '../src/ssrf';

/** Run through WHATWG URL first — exactly what every call site's hostname went through. */
const viaUrl = (url: string) => isPrivateHost(new URL(url).hostname);

describe('isPrivateHost — blocked space', () => {
  it('blocks name-based local space incl. trailing-dot resolution twins', () => {
    for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'sub.localhost', 'printer.local', 'db.corp.internal', 'foo.internal.']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it('blocks every special IPv4 range', () => {
    const blocked = [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '100.64.0.1', // CGNAT
      '100.127.255.255',
      '192.0.0.1', // IETF protocol assignments
      '198.18.0.1', // benchmarking
      '198.19.255.255',
      '224.0.0.1', // multicast
      '239.255.255.255',
      '240.0.0.1', // reserved
      '255.255.255.255',
      '127.0.0.1.', // trailing dot
    ];
    for (const host of blocked) expect(isPrivateHost(host), host).toBe(true);
  });

  it('blocks WHATWG-normalized encodings of loopback — decimal, shorthand, hex octets', () => {
    // The URL parser canonicalizes these to dotted-quad BEFORE the guard sees them.
    for (const url of ['http://2130706433/', 'http://127.1/', 'http://0x7f.0.0.1/', 'http://017700000001/']) {
      expect(viaUrl(url), url).toBe(true);
    }
  });

  it('blocks IPv6 local space: unspecified, loopback, ULA, link-local', () => {
    for (const host of ['[::]', '[::1]', '[fd00::1]', '[fc00::1]', '[fdff:aaaa::2]', '[fe80::1]', '[febf::1]']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it('blocks IPv4-mapped IPv6 in BOTH serializations — dotted and hex-group', () => {
    // WHATWG re-serializes a dotted mapped literal to hex groups; the guard must catch
    // the normalized form (what URL.hostname yields) AND a hand-built dotted one.
    expect(viaUrl('http://[::ffff:127.0.0.1]/')).toBe(true);
    expect(viaUrl('http://[::ffff:10.0.0.1]/')).toBe(true);
    expect(viaUrl('http://[::ffff:192.168.1.1]/')).toBe(true);
    expect(isPrivateHost('[::ffff:169.254.169.254]')).toBe(true); // raw dotted form
    expect(isPrivateHost('[::ffff:7f00:1]')).toBe(true); // raw hex form
  });
});

describe('isPrivateHost — public space stays open', () => {
  it('allows real public hosts and the near-miss boundaries of every blocked range', () => {
    const allowed = [
      'example.com',
      'avlo.io',
      'a.b.c.example.co.uk',
      '8.8.8.8',
      '1.1.1.1',
      '172.15.255.255', // just below 172.16/12
      '172.32.0.0', // just above
      '100.63.255.255', // below CGNAT
      '100.128.0.0', // above
      '192.169.0.1', // beside 192.168/16
      '192.0.1.1', // beside 192.0.0/24
      '198.17.255.255', // below benchmarking
      '198.20.0.1', // above
      '223.255.255.255', // last unicast before multicast
      '169.253.1.1',
      '11.0.0.1',
      '[2606:4700::1111]', // public IPv6 (Cloudflare)
      '[2001:db8::1]', // doc range — not in the blocked classes
      '[::ffff:808:808]', // IPv4-mapped 8.8.8.8 — the mapped path must re-open for public v4
      '[::ffff:8.8.8.8]', // same, raw dotted form
    ];
    for (const host of allowed) expect(isPrivateHost(host), host).toBe(false);
  });

  it('does not over-match name lookalikes', () => {
    for (const host of ['localhost.example.com', 'mylocalhost.com', 'internal.example.com', 'local.example.com']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Properties — the guard checked against an INDEPENDENT reference over the whole
// IPv4 space, plus the invariances the hand-picked examples above can only sample.
// ---------------------------------------------------------------------------

/** The blocked space, expressed the boring way: CIDR prefixes over the 32-bit value. */
const BLOCKED_CIDRS: Array<[number, number]> = [
  [0x00000000, 8], // 0/8 "this network"
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 CGNAT
  [0x7f000000, 8], // 127/8
  [0xa9fe0000, 16], // 169.254/16
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15
  [0xe0000000, 3], // 224/3 multicast + reserved + broadcast
];
const refBlocked = (ip: number): boolean => BLOCKED_CIDRS.some(([base, bits]) => ip >>> (32 - bits) === base >>> (32 - bits));

const octet = fc.integer({ min: 0, max: 255 });
const quad = fc.tuple(octet, octet, octet, octet);
const toIp32 = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

describe('isPrivateHost — properties', () => {
  it('agrees with an independent CIDR reference over the entire IPv4 space', () => {
    fc.assert(
      fc.property(quad, ([a, b, c, d]) => {
        expect(isPrivateHost(`${a}.${b}.${c}.${d}`), `${a}.${b}.${c}.${d}`).toBe(refBlocked(toIp32(a, b, c, d)));
      }),
    );
  });

  it('cannot be bypassed by integer-encoded URLs — WHATWG normalizes, the verdict must match', () => {
    fc.assert(
      fc.property(quad, ([a, b, c, d]) => {
        const asDecimal = String(toIp32(a, b, c, d));
        expect(viaUrl(`http://${asDecimal}/`), asDecimal).toBe(refBlocked(toIp32(a, b, c, d)));
      }),
    );
  });

  it('is invariant under a trailing resolution dot and under case, for domains and IPs alike', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.domain(),
          quad.map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
        ),
        (host) => {
          const verdict = isPrivateHost(host);
          expect(isPrivateHost(`${host}.`), `${host}.`).toBe(verdict);
          expect(isPrivateHost(host.toUpperCase()), host.toUpperCase()).toBe(verdict);
        },
      ),
    );
  });

  it('gives IPv4-mapped IPv6 the same verdict as the bare IPv4, in every serialization', () => {
    fc.assert(
      fc.property(quad, ([a, b, c, d]) => {
        const verdict = isPrivateHost(`${a}.${b}.${c}.${d}`);
        const hex = `${(toIp32(a, b, c, d) >>> 16).toString(16)}:${(toIp32(a, b, c, d) & 0xffff).toString(16)}`;
        expect(isPrivateHost(`[::ffff:${a}.${b}.${c}.${d}]`), 'dotted').toBe(verdict);
        expect(isPrivateHost(`[::ffff:${hex}]`), `hex ${hex}`).toBe(verdict);
        // What URL.hostname actually yields for the dotted input (WHATWG re-serialization).
        expect(viaUrl(`http://[::ffff:${a}.${b}.${c}.${d}]/`), 'via URL').toBe(verdict);
      }),
    );
  });
});
