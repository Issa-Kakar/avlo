import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const THEME_KEY = 'avlo-theme';

export function getTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') {
    return stored;
  }

  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }

  return 'light';
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  useEffect(() => {
    setTheme(theme);
  }, [theme]);

  useEffect(() => {
    setTheme(getTheme());
  }, []);

  const toggleTheme = () => {
    const newTheme: Theme = theme === 'light' ? 'dark' : 'light';
    setThemeState(newTheme);
    setTheme(newTheme);
  };

  return {
    theme,
    setTheme: (newTheme: Theme) => {
      setThemeState(newTheme);
      setTheme(newTheme);
    },
    toggleTheme,
  };
}
