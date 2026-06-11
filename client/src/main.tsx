import { RouterProvider } from '@tanstack/react-router';
import ReactDOM from 'react-dom/client';
import { router } from './router';
import './index.css';
import { ensureFontsLoaded } from './core/text/font-loader';
import { resetFontMetrics } from './core/text/text-measure';
import { consumeAuthMarker, refreshIdentityForAuthChange } from './query/auth-redirect';
import { restoreQueryCache } from './query/client';
// Side-effect: registers the rename mutation defaults BEFORE restoreQueryCache() resumes
// hydrated paused mutations (route code-splitting would otherwise register them too late).
import './query/room-rename';

async function loadFonts() {
  try {
    // CRITICAL: Load fonts before React renders
    // This prevents measuring fallback "cursive" font (ascent 1.1)
    await ensureFontsLoaded();

    // Reset metrics cache so first measurement uses correct font
    resetFontMetrics();
  } catch (error) {
    console.error('[init] Font loading failed:', error);
    // Continue anyway - will use fallback metrics
  }
}

async function init() {
  // First statement: read + strip any `?auth=` OAuth marker before the router can see it.
  const marker = consumeAuthMarker();

  // The query-cache restore MUST complete before the router mounts: route
  // beforeLoad/loaders fire during mount, and the me query's restored
  // `dataUpdatedAt` is what keeps `/me` a background-only cookie slide
  // (see query/client.ts). Concurrent with fonts; neither ever rejects.
  await Promise.all([restoreQueryCache(), loadFonts()]);

  // Identity changed server-side → force one clean /me. AFTER restore (hydration would
  // resurrect the removed entries), BEFORE mount (the room route's `await ensureIdentity()`
  // + connectRoom must stamp the NEW userId).
  if (marker === 'ok' || marker === 'out') await refreshIdentityForAuthChange();

  ReactDOM.createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
}

init();
