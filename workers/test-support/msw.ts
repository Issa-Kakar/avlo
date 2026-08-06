/**
 * MSW inside the workerd isolate — the official pool-workers pattern (workers-sdk
 * `fixtures/vitest-pool-workers-examples/request-mocking`; Cloudflare recommends MSW as
 * the `fetchMock` replacement since pool-workers 0.13, and it replaced the hand-rolled
 * TestFetchMock here). Worker code under test runs in the SAME isolate as the tests, so
 * `setupServer` from `msw/node` patches the `globalThis.fetch` every egress call rides.
 *
 * `installMswServer()` — call at module scope in a suite's harness. Registers the
 * lifecycle hooks (listen with `onUnhandledRequest: 'error'`, per-test handler reset,
 * close after the file) and returns the server plus a per-test outbound-request log.
 *
 * Conventions:
 * - Per-test handlers via `server.use(http.get(url, resolver, { once: true }))` —
 *   `once` gives consumed-exactly-once semantics; layered `use()` calls model redirect
 *   hops (most-recent handler wins, a used-up `once` handler falls through).
 * - Unmatched egress REJECTS the fetch inside the worker (surfacing wherever the worker
 *   maps egress failure) AND fails the test via MSW's unhandled-request error — a stray
 *   fetch can never pass silently.
 * - Dead mocks can't pass silently either: afterEach fails the test if any `once`
 *   handler was armed but never matched (the old TestFetchMock `assertAllConsumed`
 *   oracle, restored via msw's public `handler.isUsed`). A route you arm to prove it
 *   is NOT fetched must instead stay un-armed + asserted via `requested()`.
 * - Negative SSRF assertions read `requested()` — the security property is that no
 *   request to the blocked host was ever attempted.
 */
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export { delay, HttpResponse, http, passthrough } from 'msw';

export function installMswServer() {
  const server = setupServer();
  const log: string[] = [];
  server.events.on('request:start', ({ request }) => {
    log.push(`${request.method} ${request.url}`);
  });
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => {
    // listHandlers() is typed as AnyHandler (incl. WebSocket handlers, no isUsed) and
    // `options` is TS-private on RequestHandler — both are stable public shapes at runtime.
    type HandlerShape = { isUsed?: boolean; options?: { once?: boolean }; info?: { header?: string } };
    const stale = server.listHandlers().filter((h) => {
      const rh = h as unknown as HandlerShape;
      return rh.isUsed === false && rh.options?.once;
    });
    server.resetHandlers();
    log.length = 0;
    if (stale.length > 0) {
      const headers = stale.map((h) => (h as unknown as HandlerShape).info?.header).join('\n  ');
      throw new Error(`dead mock: once-handler(s) armed but never matched:\n  ${headers}`);
    }
  });
  afterAll(() => server.close());
  /** Outbound requests seen this test, optionally filtered by substring. */
  const requested = (substr?: string) => (substr ? log.filter((r) => r.includes(substr)) : [...log]);
  return { server, requested };
}
