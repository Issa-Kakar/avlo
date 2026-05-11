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
  const host = url.hostname;
  if (!host.includes('.') && host !== 'localhost' && host !== '[::1]') return null;
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

const TWO_SEGMENT_TLDS = new Set([
  'co.uk',
  'co.jp',
  'co.in',
  'co.nz',
  'co.kr',
  'co.za',
  'com.au',
  'com.br',
  'com.mx',
  'com.tr',
  'com.sg',
  'ac.uk',
  'org.uk',
  'ne.jp',
  'or.jp',
]);

/**
 * Turn a hostname into a human-readable site name.
 *   github.com           → "Github"
 *   excalidraw.com       → "Excalidraw"
 *   docs.github.com      → "Github"
 *   play.google.com      → "Google"
 *   amazon.co.uk         → "Amazon"
 *   news.ycombinator.com → "Ycombinator"
 */
export function prettifyDomain(domain: string): string {
  if (!domain) return '';
  const parts = domain.split('.');
  if (parts.length === 1) return capitalize(parts[0]);
  let labelIdx = parts.length - 2;
  if (parts.length >= 3) {
    const lastTwo = parts[parts.length - 2] + '.' + parts[parts.length - 1];
    if (TWO_SEGMENT_TLDS.has(lastTwo)) labelIdx = parts.length - 3;
  }
  if (labelIdx < 0) labelIdx = 0;
  return capitalize(parts[labelIdx]);
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}
