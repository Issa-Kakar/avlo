// Hono route-surface drift guard shared by every worker that exposes a typed
// public API. Each worker has two app surfaces:
//
//   • the real Hono app in `src/index.ts` — reaches ambient CF runtime types
//     (Env, R2Bucket, HTMLRewriter, caches.default) and cannot be imported
//     from client code without leaking those types into client compilation.
//   • the public mock in `src/app-type.ts` — ambient-free, re-imported by
//     @avlo/api-client to type hc<App>(...).
//
// These can drift apart silently: a new route on the real app is invisible to
// typed clients; a route on the mock that doesn't exist on the real app makes
// typed clients 404 at runtime. We don't compare full Hono types — the real
// app has `Bindings: Env`, the mock has empty bindings, and input/output
// shapes differ in approximation depth. What matters for hc<App> safety is:
// same paths, same methods.
//
// Usage in `workers/<name>/src/index.ts`, after the route chain, before the
// default export:
//
//   import { assertSurfaceMatch } from '@avlo/worker-shared';
//   import type { FooApp as PublicSurface } from './app-type';
//   assertSurfaceMatch<typeof app, PublicSurface>(true);
//
// The `true` arg is the assertion target. When real and mock diverge,
// `AssertEqual<...>` resolves to `never`, the parameter type becomes `never`,
// and passing `true` is a compile error pointing at the call site. Verified
// empirically: drift in either direction fires.

import type { Hono } from 'hono';

export type HonoRouteSurface<T> = T extends Hono<infer _E, infer S, infer _BP> ? { [P in keyof S]: keyof S[P] } : never;

export type AssertEqual<A, B> = [A, B] extends [B, A] ? true : never;

export function assertSurfaceMatch<Real, Mock>(_ok: AssertEqual<HonoRouteSurface<Real>, HonoRouteSurface<Mock>>): void {}

/**
 * Companion guard for the binary-RPC cast targets in `rpc-surfaces.ts`. Call sites cast
 * an untyped cross-config binding to a hand-written surface and call through it blindly,
 * so each implementing class asserts, next to its definition, that its real methods stay
 * mutually assignable with that surface:
 *
 *   assertRpcMatch<Pick<RoomDurableObject, keyof RoomDoStub>, RoomDoStub>(true);
 *
 * A renamed/removed method fails the `Pick` constraint; param or return drift collapses
 * `AssertEqual` to `never` and the `true` argument errors at the call site.
 */
export function assertRpcMatch<Impl, Surface>(_ok: AssertEqual<Impl, Surface>): void {}
