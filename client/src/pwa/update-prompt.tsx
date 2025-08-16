import { useState, useEffect } from 'react';
import { updateServiceWorker } from './register-sw.js';

interface UpdatePromptProps {
  registration: ServiceWorkerRegistration | null;
  onClose: () => void;
}

export function UpdatePrompt({ registration, onClose }: UpdatePromptProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (registration) {
      setIsVisible(true);
    }
  }, [registration]);

  const handleUpdate = () => {
    if (registration) {
      updateServiceWorker(registration);
      setIsVisible(false);
      onClose();
    }
  };

  const handleDismiss = () => {
    setIsVisible(false);
    onClose();
  };

  if (!isVisible || !registration) {
    return null;
  }

  return (
    <div className="fixed top-4 right-4 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-4 max-w-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h3 className="font-medium text-gray-900 mb-1">Update available</h3>
          <p className="text-sm text-gray-600 mb-3">
            A new version of Avlo is ready. Restart to get the latest features.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleUpdate}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            >
              Update
            </button>
            <button
              onClick={handleDismiss}
              className="px-3 py-1.5 bg-gray-100 text-gray-700 text-sm rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
            >
              Later
            </button>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 rounded"
          aria-label="Close"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function useUpdatePrompt() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  const showUpdatePrompt = (reg: ServiceWorkerRegistration) => {
    setRegistration(reg);
  };

  const hideUpdatePrompt = () => {
    setRegistration(null);
  };

  return {
    registration,
    showUpdatePrompt,
    hideUpdatePrompt
  };
}