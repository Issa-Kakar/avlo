// SPA HTTP headers are NOT set by a worker. With `run_worker_first: ["/parties/*"]`
// the main worker never sees HTML responses. SPA-level CSP, COOP, COEP, and
// X-Content-Type-Options live in `client/public/_headers`, applied by the Static
// Assets binding to all matching responses.

export type CspProfile = 'asset-body' | 'api-json';

const PROFILES: Record<CspProfile, Record<string, string>> = {
  'asset-body': {
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  },
  'api-json': {
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-site',
    'Referrer-Policy': 'no-referrer',
  },
};

export function applyCsp(headers: Headers, profile: CspProfile): void {
  for (const [k, v] of Object.entries(PROFILES[profile])) headers.set(k, v);
}
