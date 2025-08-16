// Desktop detection utility
function isDesktop(): boolean {
  // Use media queries to detect desktop
  const hasPointerFine = window.matchMedia('(pointer: fine)').matches;
  const hasHover = window.matchMedia('(hover: hover)').matches;
  const isWideScreen = window.innerWidth >= 1024;
  
  return hasPointerFine && hasHover && isWideScreen;
}

// Pyodide assets to warm cache (based on typical Pyodide structure)
const PYODIDE_VERSION = '0.26.4'; // Should match package.json version
const PYODIDE_ASSETS = [
  `/pyodide/${PYODIDE_VERSION}/pyodide.js`,
  `/pyodide/${PYODIDE_VERSION}/pyodide.asm.js`,
  `/pyodide/${PYODIDE_VERSION}/pyodide.asm.wasm`,
  `/pyodide/${PYODIDE_VERSION}/python_stdlib.zip`,
  `/pyodide/${PYODIDE_VERSION}/packages.json`,
];

export async function warmPyodide(): Promise<void> {
  // Only run on desktop
  if (!isDesktop()) {
    console.log('PWA: Skipping Pyodide warm-cache (not desktop)');
    return;
  }

  console.log('PWA: Starting desktop-only Pyodide warm-cache');

  const warmPromises = PYODIDE_ASSETS.map(async (url) => {
    try {
      // Trigger fetch - Service Worker will intercept and cache
      const response = await fetch(url, { 
        method: 'GET',
        cache: 'default' // Let SW handle caching strategy
      });
      
      if (response.ok) {
        console.log('PWA: Warmed Pyodide asset:', url);
        // Consume the response to complete the fetch
        await response.blob();
      } else {
        console.warn('PWA: Failed to warm Pyodide asset:', url, response.status);
      }
    } catch (error) {
      // Silent failure for warm cache - don't block app functionality
      console.warn('PWA: Error warming Pyodide asset:', url, error);
    }
  });

  try {
    await Promise.allSettled(warmPromises);
    console.log('PWA: Pyodide warm-cache completed');
  } catch (error) {
    console.warn('PWA: Pyodide warm-cache failed:', error);
  }
}

// Initialize warm cache after service worker is active
export function initPyodideWarmCache(): void {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  // Wait for service worker to be ready
  navigator.serviceWorker.ready.then(() => {
    // Small delay to let SW settle
    setTimeout(() => {
      warmPyodide();
    }, 1000);
  });
}