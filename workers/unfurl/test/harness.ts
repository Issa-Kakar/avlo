/**
 * Unfurl-suite harness: direct `worker.fetch` driving with the stub-auth identity cookie,
 * MSW (msw/node patching `globalThis.fetch` in this same isolate) for every outbound
 * page/image fetch, and minimal valid image byte builders (real magic bytes + parseable
 * dimensions).
 *
 * `installMswServer` registers the lifecycle hooks (listen with
 * `onUnhandledRequest: 'error'`, per-test handler + log reset, close) for every file
 * importing this module. Same-URL multi-hop chains (content-type sniff → re-fetch,
 * redirect → follow) MUST land in ONE `server.use(hop1, hop2)` call — handlers resolve
 * in array order with `once` handlers retiring after use; a second `use()` call would
 * prepend and reverse the hop order.
 */

import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { ulid } from '@avlo/shared';
import { HttpResponse, http, installMswServer } from '@avlo/test-support/msw';
import worker from '../src/index';

export const { server, requested } = installMswServer();

// Unique page origin per call — edge-cache entries are keyed by URL and outlive tests.
export { uniqueUrl } from '@avlo/test-support/unique';
export { HttpResponse, http };

export interface UnfurlOpts {
  /** Identity for the stub auth cookie; null sends NO cookie (the 401 path). */
  user?: string | null;
}

/** GET /?url=… through the real app (cors → csp → requireAuth → limiter → zod → handler). */
export async function unfurl(url: string | null, opts: UnfurlOpts = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const user = opts.user === undefined ? ulid() : opts.user;
  const headers = new Headers({ host: 'unfurl.avlo.io' });
  if (user !== null) headers.set('cookie', `avlo-test-user=${user}:anon`);
  const q = url === null ? '' : `?url=${encodeURIComponent(url)}`;
  const res = await worker.fetch(new Request(`https://unfurl.avlo.io/${q}`, { headers }), env, ctx);
  await waitOnExecutionContext(ctx); // flushes the jsonCached waitUntil edge-cache put
  return res;
}

/** Register a consumed-exactly-once HTML page at `url`. */
export function pageRoute(url: string, htmlBody: string, opts: { status?: number } = {}): void {
  server.use(
    http.get(
      url,
      () => new HttpResponse(htmlBody, { status: opts.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
      {
        once: true,
      },
    ),
  );
}

/** `<head>` metadata → full page. */
export const html = (head: string, body = ''): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

export { gifBytes, pngBytes, svgBytes } from '@avlo/test-support/image-bytes';

export interface UnfurlBody {
  url: string;
  domain: string;
  title?: string;
  description?: string;
  ogImageAssetId?: string;
  ogImageWidth?: number;
  ogImageHeight?: number;
  faviconAssetId?: string;
  faviconSvgBase64?: string;
}

export const bodyOf = (res: Response): Promise<UnfurlBody> => res.json() as Promise<UnfurlBody>;
