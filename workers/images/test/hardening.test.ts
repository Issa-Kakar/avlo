/**
 * Hardening invariants at the wire: H5 (CSP profile on every RETURNED response — success
 * bodies, early returns, thrown 403s, the limiter 429) and the tier-1 user rate limiter.
 */
import { ulid } from '@avlo/shared';
import { expectCspProfile } from '@avlo/test-support/csp';
import { describe, expect, it } from 'vitest';
import { hit, keyFor, uniquePng, upload } from './harness';

describe('CSP (H5)', () => {
  it('stamps asset-body on GET returns — the 400 bad-key and 404 missing-object early exits', async () => {
    const bad = await hit('/NOT-A-KEY', {}, { user: null });
    expect(bad.status).toBe(400);
    expectCspProfile(bad, 'asset-body', 'bad key');
    const missing = await hit(`/${'0'.repeat(64)}`, {}, { user: null });
    expect(missing.status).toBe(404);
    expectCspProfile(missing, 'asset-body', 'missing object');
  });

  it('stamps both profiles on the success paths — PUT 201 api-json, GET 200 asset-body', async () => {
    const bytes = uniquePng();
    const key = await keyFor(bytes);
    const put = await upload(key, bytes);
    expect(put.status).toBe(201);
    expectCspProfile(put, 'api-json', 'PUT 201');
    const get = await hit(`/${key}`, {}, { user: null });
    expect(get.status).toBe(200);
    expectCspProfile(get, 'asset-body', 'GET 200');
  });

  it('stamps api-json on the PUT guards — requireAuth 401 and the THROWN csrf 403 (onError path)', async () => {
    const noIdentity = await upload('0'.repeat(64), 'x', { user: null });
    expect(noIdentity.status).toBe(401);
    expectCspProfile(noIdentity, 'api-json', '401');
    // No content-type + disallowed Origin → hono/csrf throws; cspError must stamp it.
    const crossSite = await upload('0'.repeat(64), 'x', { origin: 'https://evil.example', contentType: null });
    expect(crossSite.status).toBe(403);
    expectCspProfile(crossSite, 'api-json', 'csrf 403');
  });
});

describe('user rate limiter (RL_UPLOAD — 120/min, keyed on identity)', () => {
  it('429s exactly the 121st PUT of one identity; other identities are unaffected', async () => {
    const user = ulid();
    // Invalid key ⇒ zod 400 right AFTER the limiter spends — the cheapest spendable request.
    for (let i = 0; i < 120; i++) {
      expect((await upload('zz', 'x', { user })).status, `request ${i + 1}`).toBe(400);
    }
    const limited = await upload('zz', 'x', { user });
    expect(limited.status).toBe(429);
    expectCspProfile(limited, 'api-json', '429');
    expect((await upload('zz', 'x', { user: ulid() })).status).toBe(400); // per-identity, not global
  }, 30000);
});
