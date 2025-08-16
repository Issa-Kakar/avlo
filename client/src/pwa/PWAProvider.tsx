import React, { useEffect } from 'react';
import { registerSW } from './register-sw.js';
import { UpdatePrompt, useUpdatePrompt } from './update-prompt.js';
import { initPyodideWarmCache } from './warm-pyodide.js';

interface PWAProviderProps {
  children: React.ReactNode;
}

export function PWAProvider({ children }: PWAProviderProps) {
  const { registration, showUpdatePrompt, hideUpdatePrompt } = useUpdatePrompt();

  useEffect(() => {
    // Register service worker
    registerSW({
      onUpdateAvailable: showUpdatePrompt
    });

    // Initialize Pyodide warm cache (desktop only)
    initPyodideWarmCache();

  }, [showUpdatePrompt]);

  return (
    <>
      {children}
      <UpdatePrompt 
        registration={registration} 
        onClose={hideUpdatePrompt}
      />
    </>
  );
}