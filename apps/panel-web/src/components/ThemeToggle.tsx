import { useState } from 'react';
import { currentTheme, toggleTheme, type Theme } from '../lib/theme';
import { t } from '../i18n/t';

/** Przełącznik motywu (persist w localStorage — lib/theme.ts). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  return (
    <button
      type="button"
      className="btn btn-ghost"
      title={t('header.theme.toggle')}
      aria-label={theme === 'dark' ? t('header.theme.light') : t('header.theme.dark')}
      onClick={() => setTheme(toggleTheme())}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}
