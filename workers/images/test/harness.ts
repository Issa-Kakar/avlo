/**
 * Images-suite harness: direct `worker.fetch` driving with the stub-auth identity
 * cookie. PUTs default to a CSRF-passing shape (allowed Origin + binary content-type);
 * tests override pieces to probe the guard matrix.
 */

import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { ulid } from '@avlo/shared';
import { sha256Hex } from '@avlo/worker-shared';
import worker from '../src/index';

export * from '@avlo/test-support/image-bytes';
export { sha256Hex };

export async function hit(path: string, init: RequestInit = {}, opts: { user?: string | null } = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const user = opts.user === undefined ? ulid() : opts.user;
  const headers = new Headers(init.headers);
  headers.set('host', 'images.avlo.io');
  if (user !== null) headers.set('cookie', `avlo-test-user=${user}:anon`);
  const res = await worker.fetch(new Request(`https://images.avlo.io${path}`, { ...init, headers }), env, ctx);
  await waitOnExecutionContext(ctx); // flushes the edge-cache put waitUntil
  return res;
}

export interface UploadOpts {
  user?: string | null;
  /** null omits the header entirely (each default satisfies the guard it feeds). */
  origin?: string | null;
  contentType?: string | null;
  contentLength?: string | null;
}

/** PUT /:key with CSRF-satisfying defaults; Content-Length is computed from the body
 *  (direct `worker.fetch` never synthesizes it — there is no network hop). A
 *  ReadableStream body needs an explicit `contentLength`. */
export async function upload(key: string, bytes: Uint8Array | string | ReadableStream, opts: UploadOpts = {}): Promise<Response> {
  const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.Origin = opts.origin ?? 'https://avlo.io';
  if (opts.contentType !== null) headers['Content-Type'] = opts.contentType ?? 'application/octet-stream';
  if (opts.contentLength !== null) {
    const auto = body instanceof ReadableStream ? undefined : String(body.byteLength);
    const cl = opts.contentLength ?? auto;
    if (cl !== undefined) headers['Content-Length'] = cl;
  }
  return hit(`/${key}`, { method: 'PUT', body, headers }, { user: opts.user });
}

/** The canonical content-addressed key for `bytes`. */
export const keyFor = (bytes: Uint8Array): Promise<string> => sha256Hex(bytes);
