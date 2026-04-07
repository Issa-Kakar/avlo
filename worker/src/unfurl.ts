import { z } from 'zod/v4';
import type { Context } from 'hono';
import { normalizeUrl, extractDomain, validateImage, parseImageDimensions } from '@avlo/shared';

// --- Constants ---

const OG_IMAGE_MAX = 5 * 1024 * 1024; // 5 MB
const FAVICON_MAX = 500 * 1024; // 500 KB
const FETCH_TIMEOUT = 5000;
const UA = 'AvloBot/1.0 (+https://avlo.io/bot)';

// --- SSRF Guard (server-only) ---

function isPrivateHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Named private hosts
  if (lower === 'localhost' || lower === '[::1]' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    return true;
  }

  // IPv4 private ranges
  const parts = lower.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
    const [a, b] = [parseInt(parts[0]), parseInt(parts[1])];
    if (a === 127) return true; // 127.x.x.x
    if (a === 10) return true; // 10.x.x.x
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16-31.x.x
    if (a === 192 && b === 168) return true; // 192.168.x.x
    if (a === 169 && b === 254) return true; // 169.254.x.x
    if (a === 0) return true; // 0.x.x.x
  }

  return false;
}

// --- Zod Schema ---

export const unfurlQuery = z.object({
  url: z
    .string()
    .min(1, 'url parameter required')
    .transform((raw) => normalizeUrl(raw))
    .refine((v): v is string => v !== null, 'Invalid or non-HTTP URL')
    .refine((url) => !isPrivateHost(new URL(url).hostname), 'URL not allowed'),
});

// --- Helpers ---

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function fetchAndStoreImage(
  assets: R2Bucket,
  imageUrl: string,
  maxBytes: number,
): Promise<{ assetId: string; width: number; height: number } | null> {
  try {
    const res = await fetch(imageUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok || !res.body) {
      console.warn('[unfurl] image fetch failed:', imageUrl, res.status);
      return null;
    }

    // Read with size guard
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        console.warn('[unfurl] image too large:', imageUrl, total);
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }

    // Merge chunks
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const { valid, mimeType } = validateImage(bytes);
    if (!valid) {
      console.warn('[unfurl] image validation failed:', imageUrl);
      return null;
    }

    const dims = parseImageDimensions(bytes, mimeType);
    console.warn('[unfurl] image dims:', imageUrl, dims.width, 'x', dims.height);
    const assetId = await sha256Hex(bytes);

    // Content-addressed dedup
    if (await assets.head(assetId)) return { assetId, width: dims.width, height: dims.height };

    await assets.put(assetId, bytes, {
      httpMetadata: { contentType: mimeType },
    });
    return { assetId, width: dims.width, height: dims.height };
  } catch (err) {
    console.warn('[unfurl] image fetch error:', imageUrl, err);
    return null;
  }
}

function resolveUrl(href: string | null | undefined, pageUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return null;
  }
}

// --- Handler ---

export const handleUnfurl = async (c: Context<{ Bindings: Env }>, url: string) => {
  console.warn('[unfurl] request:', url);
  const domain = extractDomain(url);

  // --- Edge cache check ---
  const cacheKey = `https://unfurl.avlo.internal/${await sha256Hex(new TextEncoder().encode(url))}`;
  const cache = caches.default;
  try {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  } catch {
    /* cache miss or unavailable */
  }

  // --- Fetch page ---
  let pageRes: Response;
  try {
    pageRes = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html, application/xhtml+xml, application/xml;q=0.9, image/*;q=0.8',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
  } catch (err) {
    console.warn('[unfurl] page fetch error:', url, err);
    return c.body(null, 502);
  }

  if (!pageRes.ok) {
    console.warn('[unfurl] page fetch non-OK:', url, pageRes.status);
    return c.body(null, 502);
  }

  const ct = pageRes.headers.get('content-type') ?? '';

  // --- Direct image URL handling ---
  if (ct.startsWith('image/')) {
    const imageResult = await fetchAndStoreImage(c.env.ASSETS, url, OG_IMAGE_MAX);
    if (!imageResult) {
      console.warn('[unfurl] direct image failed to store:', url);
      return c.body(null, 204);
    }
    const data: Record<string, string | number> = { url, domain };
    try {
      const pathname = new URL(url).pathname;
      const filename = pathname.split('/').pop() || '';
      if (filename) data.title = decodeURIComponent(filename);
    } catch {
      /* no title */
    }
    data.ogImageAssetId = imageResult.assetId;
    data.ogImageWidth = imageResult.width;
    data.ogImageHeight = imageResult.height;
    return jsonCached(c, cache, cacheKey, data);
  }

  // --- Non-HTML content ---
  if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml') && !ct.includes('application/xml')) {
    console.warn('[unfurl] non-HTML content type:', url, ct);
    return c.body(null, 204);
  }

  // --- HTMLRewriter parse ---
  let ogTitle: string | null = null;
  let ogDescription: string | null = null;
  let ogImage: string | null = null;
  let ogImageSecure: string | null = null;
  let twitterTitle: string | null = null;
  let twitterDescription: string | null = null;
  let twitterImage: string | null = null;
  let metaDescription: string | null = null;
  let titleText = '';
  let faviconHref: string | null = null;
  let appleTouchIconHref: string | null = null;
  let inTitle = false;

  const rewritten = new HTMLRewriter()
    .on('meta', {
      element(el) {
        const property = el.getAttribute('property');
        const name = el.getAttribute('name');
        const content = el.getAttribute('content');
        const key = property || name;
        if (!content || !key) return;

        if (key === 'og:title') ogTitle = content;
        else if (key === 'og:description') ogDescription = content;
        else if (key === 'og:image') ogImage = content;
        else if (key === 'og:image:secure_url') ogImageSecure = content;
        else if (key === 'twitter:title') twitterTitle = content;
        else if (key === 'twitter:description') twitterDescription = content;
        else if (key === 'twitter:image') twitterImage = content;
        else if (key === 'description') metaDescription = content;
      },
    })
    .on('title', {
      element() {
        inTitle = true;
      },
      text(text) {
        if (inTitle) titleText += text.text;
        if (text.lastInTextNode) inTitle = false;
      },
    })
    .on('link', {
      element(el) {
        const rel = (el.getAttribute('rel') ?? '').toLowerCase();
        const href = el.getAttribute('href');
        if (!href) return;
        if (rel === 'apple-touch-icon') appleTouchIconHref = href;
        else if (rel === 'icon' || rel === 'shortcut icon') faviconHref = href;
      },
    })
    .transform(pageRes);

  // Consume the stream to run all handlers
  await rewritten.blob();

  // --- Resolve metadata ---
  const title = ogTitle ?? twitterTitle ?? (titleText.trim() || null);
  const description = ogDescription ?? twitterDescription ?? metaDescription;
  const rawOgImage = resolveUrl(ogImageSecure ?? ogImage ?? twitterImage, url);
  const rawFavicon = resolveUrl(appleTouchIconHref ?? faviconHref, url);

  // --- Fetch + store images in parallel ---
  const [ogImageResult, faviconAssetId] = await Promise.all([
    rawOgImage ? fetchAndStoreImage(c.env.ASSETS, rawOgImage, OG_IMAGE_MAX) : null,
    rawFavicon ? fetchAndStoreImage(c.env.ASSETS, rawFavicon, FAVICON_MAX).then((r) => r?.assetId ?? null) : null,
  ]);

  // --- Check for useful metadata ---
  if (!title && !ogImageResult) {
    console.warn('[unfurl] no useful metadata:', url);
    return c.body(null, 204);
  }

  // --- Build response ---
  const data: Record<string, string | number> = { url, domain };
  if (title) data.title = title;
  if (description) data.description = description;
  if (ogImageResult) {
    data.ogImageAssetId = ogImageResult.assetId;
    data.ogImageWidth = ogImageResult.width;
    data.ogImageHeight = ogImageResult.height;
  }
  if (faviconAssetId) data.faviconAssetId = faviconAssetId;
  console.warn('[unfurl] success:', url, {
    title: !!title,
    ogImage: !!ogImageResult,
    favicon: !!faviconAssetId,
  });

  return jsonCached(c, cache, cacheKey, data);
};

function jsonCached(c: Context<{ Bindings: Env }>, cache: Cache, cacheKey: string, data: Record<string, string | number>): Response {
  const body = JSON.stringify(data);
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=604800',
  });
  const response = new Response(body, { status: 200, headers });

  // Populate edge cache in background (clone for cache)
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}
