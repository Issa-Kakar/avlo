import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './styles/tokens.css';
import './styles/app.css';
import AppRouter from './app/router.js';
import { setTheme, getTheme } from './app/hooks/useTheme.js';

// Initialize theme on app start
setTheme(getTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);
