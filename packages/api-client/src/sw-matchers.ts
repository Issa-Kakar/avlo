// Zero-dep helpers for URL matching. The SW only recognizes request URLs (matching,
// not building) — plain string/origin checks are the right tool. `hc` is unused here
// to keep the SW bundle small.

// `imagesOrigin` is always absolute (see origins.ts) — `https://images.avlo.io` in
// prod, `http://<host>/api/images` in dev. Compare origin first, then enforce the
// path prefix when one is present (dev proxy path).
export function isImagesRequest(url: URL, imagesOrigin: string): boolean {
  const o = new URL(imagesOrigin);
  if (url.origin !== o.origin) return false;
  return o.pathname === '/' || url.pathname.startsWith(`${o.pathname}/`);
}

// Same shape as `isImagesRequest` — py artifacts are a second immutable content-hashed
// origin (`https://py.avlo.io` prod, `http://<host>/api/py` dev proxy).
export function isPyRequest(url: URL, pyOrigin: string): boolean {
  const o = new URL(pyOrigin);
  if (url.origin !== o.origin) return false;
  return o.pathname === '/' || url.pathname.startsWith(`${o.pathname}/`);
}

export function isSyncRequest(url: URL, syncHostProd: string | null): boolean {
  // '/sync/' must match SYNC_WS_PREFIX (@avlo/shared) — kept a literal so SW-graph code doesn't
  // pull @avlo/shared into the SW bundle (the CI isolation grep).
  if (syncHostProd && url.host === syncHostProd && url.pathname.startsWith('/sync/')) return true;
  return url.pathname.startsWith('/sync/'); // dev fallback
}
