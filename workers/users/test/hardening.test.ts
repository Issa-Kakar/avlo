/**
 * Hardening invariants at the wire: H5 (CSP profile on every RETURNED response) and the
 * tier-1 user rate limiter.
 */
import { expectCspProfile } from '@avlo/test-support/csp';
import { describe, expect, it } from 'vitest';
import { hit, newUserId } from './harness';

describe('CSP (H5)', () => {
  it('stamps api-json on the requireAuth 401 and the /rooms 200', async () => {
    const unauthed = await hit('/rooms', {}, { user: null });
    expect(unauthed.status).toBe(401);
    expectCspProfile(unauthed, 'api-json', '401');
    const ok = await hit('/rooms');
    expect(ok.status).toBe(200);
    expectCspProfile(ok, 'api-json', '200');
  });
});

describe('user rate limiter (RL_ROOMS — 120/min, keyed on identity)', () => {
  it('429s exactly the 121st request of one identity; other identities are unaffected', async () => {
    const user = newUserId();
    for (let i = 0; i < 120; i++) {
      expect((await hit('/rooms', {}, { user })).status, `request ${i + 1}`).toBe(200);
    }
    const limited = await hit('/rooms', {}, { user });
    expect(limited.status).toBe(429);
    expectCspProfile(limited, 'api-json', '429');
    expect((await hit('/rooms')).status).toBe(200); // fresh identity — per-identity, not global
  }, 30000);
});
