/**
 * Motyw light/dark: start z localStorage, fallback prefers-color-scheme.
 * Tokeny kolorów w styles/theme.css (:root = light, [data-theme="dark"] = dark).
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'pomagierkb.theme';

export function getStoredTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

export function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

/** Wywoływane raz w main.tsx PRZED renderem (bez migotania motywu). */
export function initTheme(): void {
  const stored = getStoredTheme();
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(stored ?? (prefersDark ? 'dark' : 'light'));
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* prywatny tryb — motyw po prostu nie przetrwa odświeżenia */
  }
  return next;
}

/** Jawny wybór motywu (menu w topbarze): aplikuje i zapamiętuje. */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* prywatny tryb — motyw po prostu nie przetrwa odświeżenia */
  }
}

/** Tryb „system": usuwa zapisany wybór — initTheme/prefers-color-scheme przejmują. */
export function clearStoredTheme(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* localStorage może być zablokowany — ignorujemy */
  }
}
