import { extractDomain, isSvg, parseImageDimensions, validateImage } from '@avlo/shared';
import { syntheticCacheUrl } from '@avlo/worker-shared';
import type { Context } from 'hono';

// --- Constants ---

const OG_IMAGE_MAX = 5 * 1024 * 1024; // 5 MB
const FAVICON_MAX = 500 * 1024; // 500 KB
const FETCH_TIMEOUT = 5000;
const UA = 'AvloBot/1.0 (+https://avlo.io/bot)';

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

async function fetchBytesCapped(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok || !res.body) {
    console.warn('[unfurl] fetch failed:', url, res.status);
    return null;
  }

  const contentType = res.headers.get('content-type') ?? '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      console.warn('[unfurl] too large:', url, total);
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, contentType };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function storeRaster(assets: R2Bucket, bytes: Uint8Array, mimeType: string): Promise<string> {
  const assetId = await sha256Hex(bytes);
  if (!(await assets.head(assetId))) {
    await assets.put(assetId, bytes, { httpMetadata: { contentType: mimeType } });
  }
  return assetId;
}

async function fetchAndStoreImage(
  assets: R2Bucket,
  imageUrl: string,
  maxBytes: number,
): Promise<{ assetId: string; width: number; height: number } | null> {
  try {
    const fetched = await fetchBytesCapped(imageUrl, maxBytes);
    if (!fetched) return null;
    const { bytes } = fetched;

    const { valid, mimeType } = validateImage(bytes);
    if (!valid) {
      console.warn('[unfurl] image validation failed:', imageUrl);
      return null;
    }

    const dims = parseImageDimensions(bytes, mimeType);
    console.warn('[unfurl] image dims:', imageUrl, dims.width, 'x', dims.height);
    const assetId = await storeRaster(assets, bytes, mimeType);
    return { assetId, width: dims.width, height: dims.height };
  } catch (err) {
    console.warn('[unfurl] image fetch error:', imageUrl, err);
    return null;
  }
}

type FaviconResult = { kind: 'raster'; assetId: string } | { kind: 'svg'; base64: string };

async function fetchFavicon(assets: R2Bucket, faviconUrl: string, maxBytes: number): Promise<FaviconResult | null> {
  try {
    const fetched = await fetchBytesCapped(faviconUrl, maxBytes);
    if (!fetched) return null;
    const { bytes, contentType } = fetched;

    if (contentType.startsWith('image/svg+xml') || isSvg(bytes)) {
      return { kind: 'svg', base64: bytesToBase64(bytes) };
    }

    const { valid, mimeType } = validateImage(bytes);
    if (!valid) {
      console.warn('[unfurl] favicon validation failed:', faviconUrl);
      return null;
    }
    const assetId = await storeRaster(assets, bytes, mimeType);
    return { kind: 'raster', assetId };
  } catch (err) {
    console.warn('[unfurl] favicon fetch error:', faviconUrl, err);
    return null;
  }
}

function parseIconArea(sizes: string | null): number {
  if (!sizes) return 0;
  let max = 0;
  for (const token of sizes.toLowerCase().split(/\s+/)) {
    if (token === 'any') return Number.MAX_SAFE_INTEGER;
    const m = token.match(/^(\d+)x(\d+)$/);
    if (m) {
      const area = parseInt(m[1], 10) * parseInt(m[2], 10);
      if (area > max) max = area;
    }
  }
  return max;
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
  const cacheKey = syntheticCacheUrl('unfurl', await sha256Hex(new TextEncoder().encode(url)));
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
    const imageResult = await fetchAndStoreImage(c.env.IMAGES, url, OG_IMAGE_MAX);
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
  let faviconArea = -1;
  let appleTouchIconHref: string | null = null;
  let imageSrcHref: string | null = null;
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
        else if (key === 'og:image' || key === 'og:image:url') ogImage = content;
        else if (key === 'og:image:secure_url') ogImageSecure = content;
        else if (key === 'twitter:title') twitterTitle = content;
        else if (key === 'twitter:description') twitterDescription = content;
        else if (key === 'twitter:image' || key === 'twitter:image:src') twitterImage = content;
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

        if (rel === 'apple-touch-icon' || rel === 'apple-touch-icon-precomposed') {
          appleTouchIconHref = href;
        } else if (rel === 'icon' || rel === 'shortcut icon') {
          const area = parseIconArea(el.getAttribute('sizes'));
          if (area > faviconArea) {
            faviconHref = href;
            faviconArea = area;
          }
        } else if (rel === 'image_src') {
          imageSrcHref = href;
        }
      },
    })
    .transform(pageRes);

  // Consume the stream to run all handlers
  await rewritten.blob();

  // --- Resolve metadata ---
  const title = ogTitle ?? twitterTitle ?? (titleText.trim() || null);
  const description = ogDescription ?? twitterDescription ?? metaDescription;
  const rawOgImage = resolveUrl(ogImageSecure ?? ogImage ?? twitterImage ?? imageSrcHref, url);
  const rawFavicon = resolveUrl(appleTouchIconHref ?? faviconHref, url);

  // --- Fetch + store images in parallel ---
  const [ogImageResult, faviconResult] = await Promise.all([
    rawOgImage ? fetchAndStoreImage(c.env.IMAGES, rawOgImage, OG_IMAGE_MAX) : null,
    rawFavicon ? fetchFavicon(c.env.IMAGES, rawFavicon, FAVICON_MAX) : null,
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
  if (faviconResult?.kind === 'raster') data.faviconAssetId = faviconResult.assetId;
  else if (faviconResult?.kind === 'svg') data.faviconSvgBase64 = faviconResult.base64;

  console.warn('[unfurl] success:', url, {
    title: !!title,
    ogImage: !!ogImageResult,
    favicon: faviconResult?.kind ?? false,
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
