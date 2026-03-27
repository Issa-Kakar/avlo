/**
 * URL utilities shared between worker (cache key) and client (dedup, display).
 */

export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Lowercase host, strip fragment, strip trailing slash on path
  url.hash = '';
  let normalized = url.href;
  if (normalized.endsWith('/') && url.pathname === '/') {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function isValidHttpUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function extractDomain(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}
