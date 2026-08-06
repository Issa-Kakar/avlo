/**
 * H5 oracle — every returned worker response must carry its CSP profile. The literals
 * are DELIBERATELY duplicated from `@avlo/worker-shared/csp` (not imported): the test
 * asserts the wire contract, so a profile edit must consciously touch both sides.
 */
import { expect } from 'vitest';

const PROFILES = {
  'asset-body': {
    'content-security-policy': "default-src 'none'; sandbox",
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'cross-origin',
  },
  'api-json': {
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-site',
    'referrer-policy': 'no-referrer',
  },
} as const;

export function expectCspProfile(res: Response, profile: keyof typeof PROFILES, label = ''): void {
  for (const [header, value] of Object.entries(PROFILES[profile])) {
    expect(res.headers.get(header), `${label || res.url} [${res.status}] ${header}`).toBe(value);
  }
}
