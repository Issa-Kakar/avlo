import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import './index.css';
import { ensureFontsLoaded } from './lib/text/font-loader';
import { resetFontMetrics } from './lib/text/text-system';

async function init() {
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

  ReactDOM.createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
}

init();
