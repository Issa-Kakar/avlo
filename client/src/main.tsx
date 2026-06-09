import { RouterProvider } from '@tanstack/react-router';
import ReactDOM from 'react-dom/client';
import { router } from './router';
import './index.css';
import { ensureFontsLoaded } from './core/text/font-loader';
import { resetFontMetrics } from './core/text/text-measure';
import { restoreQueryCache } from './query/client';

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
  // The query-cache restore MUST complete before the router mounts: route
  // beforeLoad/loaders fire during mount, and the me query's restored
  // `dataUpdatedAt` is what keeps `/me` a background-only cookie slide
  // (see query/client.ts). Concurrent with fonts; neither ever rejects.
  await Promise.all([restoreQueryCache(), loadFonts()]);

  ReactDOM.createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
}

init();
