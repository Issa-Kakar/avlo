/**
 * Hardening invariants at the wire: H5 (CSP profile on every RETURNED response) and the
 * tier-1 user rate limiter.
 */
import { ulid } from '@avlo/shared';
import { expectCspProfile } from '@avlo/test-support/csp';
import { describe, expect, it } from 'vitest';
import { unfurl } from './harness';

describe('CSP (H5)', () => {
  it('stamps api-json on the guard exits — requireAuth 401 and the zod 400', async () => {
    const unauthed = await unfurl('https://example.com', { user: null });
    expect(unauthed.status).toBe(401);
    expectCspProfile(unauthed, 'api-json', '401');
    const missingUrl = await unfurl(null);
    expect(missingUrl.status).toBe(400);
    expectCspProfile(missingUrl, 'api-json', '400');
  });
});

describe('user rate limiter (RL_UPLOAD — 60/min, keyed on identity)', () => {
  it('429s exactly the 61st request of one identity; other identities are unaffected', async () => {
    const user = ulid();
    // A url-less request ⇒ zod 400 right AFTER the limiter spends — cheapest spendable.
    for (let i = 0; i < 60; i++) {
      expect((await unfurl(null, { user })).status, `request ${i + 1}`).toBe(400);
    }
    const limited = await unfurl(null, { user });
    expect(limited.status).toBe(429);
    expectCspProfile(limited, 'api-json', '429');
    expect((await unfurl(null, { user: ulid() })).status).toBe(400); // per-identity, not global
  }, 30000);
});
