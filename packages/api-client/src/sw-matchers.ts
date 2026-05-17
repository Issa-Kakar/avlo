// Zero-dep helpers for URL matching. The SW only recognizes request URLs (matching,
// not building) — plain string/origin checks are the right tool. `hc` is unused here
// to keep the SW bundle small.

export function isImagesRequest(url: URL, imagesOrigin: string): boolean {
  return imagesOrigin.startsWith('http')
    ? url.origin === imagesOrigin
    : url.pathname.startsWith(`${imagesOrigin}/`); // dev: '/api/images/...'
}

export function isSyncRequest(url: URL, syncHostProd: string | null): boolean {
  if (syncHostProd && url.host === syncHostProd && url.pathname.startsWith('/parties/')) return true;
  return url.pathname.startsWith('/parties/'); // dev fallback
}
