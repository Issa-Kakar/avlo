interface UpdateHooks {
  onUpdateAvailable: (registration: ServiceWorkerRegistration) => void;
}

export function registerSW(hooks: UpdateHooks) {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service workers not supported');
    return;
  }

  const doRegistration = async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/'
      });
      
      console.log('SW: Registration successful:', registration);

      // Handle updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        console.log('SW: New service worker installing');

        newWorker.addEventListener('statechange', () => {
          console.log('SW: New service worker state:', newWorker.state);
          
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New service worker is installed and ready
            console.log('SW: Update available');
            hooks.onUpdateAvailable(registration);
          }
        });
      });

      // Handle controller changes (after skipWaiting)
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        console.log('SW: Controller changed, reloading page');
        window.location.reload();
      });

    } catch (error) {
      console.error('SW: Registration failed:', error);
    }
  };

  // Register immediately if document is already loaded, otherwise wait for load
  if (document.readyState === 'loading') {
    window.addEventListener('load', doRegistration);
  } else {
    // Document is already loaded, register immediately
    doRegistration();
  }
}

export function updateServiceWorker(registration: ServiceWorkerRegistration) {
  if (registration.waiting) {
    console.log('SW: Sending SKIP_WAITING message');
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
}