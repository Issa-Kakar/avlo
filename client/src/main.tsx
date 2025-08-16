import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './styles/tokens.css';
import './styles/app.css';
import AppRouter from './app/router.js';
import { setTheme, getTheme } from './app/hooks/useTheme.js';

// Initialize theme on app start
setTheme(getTheme());

// Load Phase 9 test exports (for E2E testing)
import('./app/features/myrooms/test-exports.js').then(() => {
  console.warn('Phase 9 test exports loaded successfully');
}).catch((error) => {
  console.error('Failed to load Phase 9 test exports:', error);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);
