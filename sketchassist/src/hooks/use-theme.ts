import { useState, useEffect } from 'react';

type Theme = 'dark' | 'light';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>('dark');

  // Sync with what index.html init script already applied
  useEffect(() => {
    const current = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    setTheme(current);
  }, []);

  function toggle() {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      localStorage.setItem('sa-theme', next);
      return next;
    });
  }

  return { theme, toggle, isDark: theme === 'dark' };
}
