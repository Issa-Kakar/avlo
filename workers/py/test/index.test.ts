import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

async function hit(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://py.avlo.io${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('py worker', () => {
  it('404s an unrouted path (Hono routing boots in workerd)', async () => {
    expect((await hit('/')).status).toBe(404);
  });

  it('400s a malformed build hash (zod param validation runs)', async () => {
    // 'nothex' fails pyArtifactParam's /^[0-9a-f]{16}$/ hash rule.
    expect((await hit('/nothex/pyodide.wasm')).status).toBe(400);
  });

  it('404s a valid key absent from R2 (the PY binding is wired)', async () => {
    // Valid 16-hex hash + valid file → passes zod → env.PY.get() → null → 404.
    // If PY weren't bound from wrangler.jsonc this would throw, not 404.
    expect((await hit('/0123456789abcdef/pyodide.mjs')).status).toBe(404);
  });
});
