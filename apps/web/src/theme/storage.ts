import { isThemeMode, sanitizeLayer, type ThemeLayer } from './resolve';

export const THEME_STORAGE_KEY = 'conclavix.theme';

export function parseStoredPreference(raw: string | null): ThemeLayer {
  if (raw === null) return {};
  if (isThemeMode(raw)) return { mode: raw };
  try {
    return sanitizeLayer(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Restores the stored preference, or an empty layer when storage is invalid or inaccessible. */
export function readStoredPreference(): ThemeLayer {
  try {
    return parseStoredPreference(globalThis.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return {};
  }
}

/** Persists the preference when browser storage is available; ignores storage failures. */
export function writeStoredPreference(layer: ThemeLayer): void {
  try {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(sanitizeLayer(layer)));
  } catch (err) {
    // eslint-disable-next-line no-console -- Surface persistence failures without logging preferences.
    console.warn('theme: could not persist preference to localStorage', err);
  }
}

export function migrateStoredPreference(): void {
  try {
    const raw = globalThis.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(raw)) writeStoredPreference({ mode: raw });
  } catch {
    return;
  }
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Returns the OS dark-mode query, or null when matchMedia is missing or throws. */
export function darkQuery(): MediaQueryList | null {
  try {
    return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(DARK_QUERY) : null;
  } catch {
    return null;
  }
}
