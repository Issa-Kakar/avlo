/**
 * H5 at the wire for auth: the api-json profile on identity bodies AND on the csrf 403,
 * which is THROWN (hono/csrf) and reaches the client only through the cspError onError
 * stamp — the one path the egress middleware cannot cover.
 */
import { expectCspProfile } from '@avlo/test-support/csp';
import { describe, expect, it } from 'vitest';
import { hit } from './harness';

describe('CSP (H5)', () => {
  it('stamps api-json on the /me identity body', async () => {
    const res = await hit('/me');
    expect(res.status).toBe(200);
    expectCspProfile(res, 'api-json', '/me 200');
  });

  it('stamps api-json on the thrown csrf 403 via the onError path', async () => {
    const res = await hit('/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expectCspProfile(res, 'api-json', 'csrf 403');
  });
});
