/**
 * H5 at the wire for py: the asset-body profile must ride every return — py serves
 * artifacts app-wide under one profile, including the zod 400 and both 404 shapes.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { expectCspProfile } from '@avlo/test-support/csp';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

async function hit(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://py.avlo.io${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('CSP (H5)', () => {
  it('stamps asset-body on the unrouted 404, the zod 400, and the missing-object 404', async () => {
    const unrouted = await hit('/');
    expect(unrouted.status).toBe(404);
    expectCspProfile(unrouted, 'asset-body', 'unrouted');
    const badHash = await hit('/nothex/pyodide.wasm');
    expect(badHash.status).toBe(400);
    expectCspProfile(badHash, 'asset-body', 'bad hash');
    const missing = await hit('/0123456789abcdef/pyodide.mjs');
    expect(missing.status).toBe(404);
    expectCspProfile(missing, 'asset-body', 'missing object');
  });
});
