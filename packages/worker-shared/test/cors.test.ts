import fc from 'fast-check';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createCors, isAllowedOrigin, isDevHost } from '../src/cors';

describe('isDevHost', () => {
  it('treats localhost / 127.0.0.1 hosts as dev, real hosts and absent as prod', () => {
    expect(isDevHost('localhost:8787')).toBe(true);
    expect(isDevHost('127.0.0.1:8790')).toBe(true);
    expect(isDevHost('avlo.io')).toBe(false);
    expect(isDevHost(undefined)).toBe(false);
    expect(isDevHost(null)).toBe(false);
    expect(isDevHost('')).toBe(false);
  });

  it('matches the dev hosts exactly — substring and suffix look-alikes are prod', () => {
    // Was `includes('localhost')`, which read 'notlocalhost.evil.com' as dev (pinned
    // here as a characterization until tightened). Exact-boundary matching now: only
    // bare `localhost`/`127.0.0.1` with an optional `:port` flip the dev gate.
    expect(isDevHost('localhost')).toBe(true);
    expect(isDevHost('127.0.0.1')).toBe(true);
    expect(isDevHost('notlocalhost.evil.com')).toBe(false);
    expect(isDevHost('localhost.evil.com')).toBe(false);
    expect(isDevHost('127.0.0.100')).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  it('accepts exactly the two prod origins, reflected back verbatim', () => {
    expect(isAllowedOrigin('https://avlo.io', false)).toBe('https://avlo.io');
    expect(isAllowedOrigin('https://www.avlo.io', false)).toBe('https://www.avlo.io');
  });

  it('rejects every near-miss serialization: explicit port, slash, scheme, subdomain, empty', () => {
    for (const origin of ['https://avlo.io:443', 'https://avlo.io/', 'http://avlo.io', 'https://evil.avlo.io', '', undefined, null]) {
      expect(isAllowedOrigin(origin, false), String(origin)).toBeNull();
    }
  });

  it('allows localhost origins ONLY with a colon-port AND a dev request Host', () => {
    expect(isAllowedOrigin('http://localhost:3000', true)).toBe('http://localhost:3000');
    expect(isAllowedOrigin('http://localhost:3000', false)).toBeNull(); // prod never reflects localhost
    expect(isAllowedOrigin('http://localhost', true)).toBeNull(); // no colon — not the dev shape
    expect(isAllowedOrigin('https://localhost:3000', true)).toBeNull(); // https variant unmatched
  });

  it('rejects an origin that merely STARTS with the dev shape — reflection is exact-match only', () => {
    // The predicate feeds credentialed CORS reflection AND the csrf allowlist; a prefix
    // check would bless `http://localhost:3000.evil.com`. Non-browser clients can send
    // any Origin string, so the string boundary is the guard.
    expect(isAllowedOrigin('http://localhost:3000.evil.com', true)).toBeNull();
    expect(isAllowedOrigin('http://localhost:3000/', true)).toBeNull();
    expect(isAllowedOrigin('http://localhost:99999x', true)).toBeNull();
  });

  it('never treats 127.0.0.1 origins as dev — only the localhost FORM is reflected', () => {
    // 127.0.0.1 appears in isDevHost (the request Host side); the Origin side is
    // deliberately localhost-only, matching what the Vite dev server actually sends.
    expect(isAllowedOrigin('http://127.0.0.1:3000', true)).toBeNull();
  });
});

describe('origin allowlist — properties', () => {
  const printable = fc.string({ minLength: 1, maxLength: 12, unit: fc.constantFrom(...'abz09.:/-%\\@ '.split('')) });

  it('never reflects a prod origin extended or prefixed by ANY string — exact match only', () => {
    fc.assert(
      fc.property(printable, (s) => {
        expect(isAllowedOrigin(`https://avlo.io${s}`, false), `suffix ${JSON.stringify(s)}`).toBeNull();
        expect(isAllowedOrigin(`${s}https://avlo.io`, false), `prefix ${JSON.stringify(s)}`).toBeNull();
      }),
    );
  });

  it('localhost reflection tolerates ONLY a ≤5-digit port — any other extension is rejected', () => {
    fc.assert(
      fc.property(printable, (s) => {
        const origin = `http://localhost:3000${s}`;
        const stillPortShaped = /^\d{1,5}$/.test(`3000${s}`);
        expect(isAllowedOrigin(origin, true) !== null, origin).toBe(stillPortShaped);
      }),
    );
  });

  it('the dev-host gate accepts only a bare dev host with an optional ≤5-digit port', () => {
    fc.assert(
      fc.property(printable, (s) => {
        expect(isDevHost(`localhost${s}`), `localhost${s}`).toBe(s === '' || /^:\d{1,5}$/.test(s));
        expect(isDevHost(`127.0.0.1${s}`), `127.0.0.1${s}`).toBe(s === '' || /^:\d{1,5}$/.test(s));
      }),
    );
  });
});

describe('createCors', () => {
  const app = new Hono().use('*', createCors({ methods: ['GET'], exposeHeaders: ['ETag'] })).get('/x', (c) => c.text('ok'));
  const hit = (headers: Record<string, string>, method = 'GET') =>
    app.request('https://images.avlo.io/x', { method, headers: { host: 'images.avlo.io', ...headers } });

  it('reflects an allowed origin with credentials — never a wildcard', async () => {
    const res = await hit({ origin: 'https://avlo.io' });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://avlo.io');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('emits no allow-origin for a disallowed origin', async () => {
    const res = await hit({ origin: 'https://evil.example' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('advertises only the declared verbs (+OPTIONS) and expose-headers on preflight', async () => {
    const res = await hit({ origin: 'https://avlo.io', 'access-control-request-method': 'GET' }, 'OPTIONS');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET,OPTIONS');
    const ok = await hit({ origin: 'https://avlo.io' });
    expect(ok.headers.get('access-control-expose-headers')).toBe('ETag');
  });
});
