import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialThemeName, useThemeStore } from '../src/stores/theme';
import {
  THEME_STORAGE_KEY,
  parseStoredPreference,
  readStoredPreference,
  writeStoredPreference,
} from '../src/theme/storage';

type Listener = (event: { matches: boolean }) => void;

/** Stubs the OS color scheme and exposes a way to emit preference changes. */
function fakeMedia(initialDark: boolean) {
  const listeners: Listener[] = [];
  const media = {
    matches: initialDark,
    addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  return {
    /** Updates the simulated OS preference and notifies registered listeners. */
    flip(dark: boolean): void {
      media.matches = dark;
      for (const listener of listeners) listener({ matches: dark });
    },
  };
}

/** Simulates browser storage that rejects both reads and writes. */
function throwingStorage(): void {
  const deny = () => {
    throw new Error('denied');
  };
  vi.stubGlobal('localStorage', { getItem: deny, setItem: deny });
}

const stored = (): unknown => JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'null');

describe('theme store', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('follows OS changes live in system mode', () => {
    const media = fakeMedia(false);
    const store = useThemeStore();
    expect(store.resolved.name).toBe('atlas');
    media.flip(true);
    expect(store.resolved.name).toBe('atlasDark');
  });

  it('ignores OS changes while an explicit mode is set', () => {
    const media = fakeMedia(false);
    const store = useThemeStore();
    store.setMode('light');
    media.flip(true);
    expect(store.resolved.name).toBe('atlas');
  });

  it('switches to the sibling when the mode changes', () => {
    fakeMedia(false);
    const store = useThemeStore();
    store.setTemplate('atlasSepia');
    store.setMode('dark');
    expect(store.resolved.name).toBe('atlasDark');
    store.setMode('light');
    expect(store.resolved.name).toBe('atlasSepia');
  });

  it('shows the clicked variant even when the mode points elsewhere', () => {
    fakeMedia(false);
    const store = useThemeStore();
    store.setTemplate('atlasDark');
    expect(store.resolved.name).toBe('atlasDark');
    expect(store.mode).toBe('dark');
    store.setTemplate('neon');
    expect(store.mode).toBe('dark');
    expect(store.resolved.modeAvailable).toBe(false);
  });

  it('keeps system mode when the clicked variant already matches the OS', () => {
    fakeMedia(true);
    const store = useThemeStore();
    store.setTemplate('atlasDark');
    expect(store.mode).toBe('system');
  });

  it('persists the choice as JSON and restores it', () => {
    const store = useThemeStore();
    store.setTemplate('paper');
    store.setMode('light');
    expect(stored()).toEqual({ template: 'paper', mode: 'light' });
    setActivePinia(createPinia());
    expect(useThemeStore().preferences).toEqual({ theme: { template: 'paper', mode: 'light' } });
    expect(initialThemeName()).toBe('paper');
  });

  it('migrates a plain mode value from the old format', () => {
    fakeMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(initialThemeName()).toBe('atlasDark');
    const store = useThemeStore();
    expect(store.mode).toBe('dark');
    expect(store.template).toBe('atlas');
    expect(stored()).toEqual({ mode: 'dark' });
  });

  it('ignores corrupt or unknown stored values', () => {
    expect(parseStoredPreference('{not json')).toEqual({});
    expect(parseStoredPreference('neon')).toEqual({});
    expect(parseStoredPreference('{"template":"bogus","mode":"dark"}')).toEqual({ mode: 'dark' });
    expect(parseStoredPreference('[]')).toEqual({});
    localStorage.setItem(THEME_STORAGE_KEY, '{oops');
    expect(useThemeStore().resolved.template).toBe('atlas');
  });

  it('works without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(useThemeStore().resolved.name).toBe('atlas');
    expect(initialThemeName()).toBe('atlas');
  });

  it('falls back when matchMedia throws', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        throw new Error('unavailable');
      }),
    );
    const store = useThemeStore();
    expect(store.mode).toBe('system');
    expect(store.resolved.name).toBe('atlas');
    expect(initialThemeName()).toBe('atlas');
  });

  it('keeps working when storage throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    throwingStorage();
    expect(readStoredPreference()).toEqual({});
    expect(() => writeStoredPreference({ mode: 'dark' })).not.toThrow();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'theme: could not persist preference to localStorage',
      new Error('denied'),
    );
    warn.mockClear();
    const store = useThemeStore();
    store.setTemplate('neon');
    expect(store.resolved.name).toBe('neon');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'theme: could not persist preference to localStorage',
      new Error('denied'),
    );
  });

  it('keeps working when storage is not accessible at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readStoredPreference()).toEqual({});
    expect(() => writeStoredPreference({ mode: 'light' })).not.toThrow();
    expect(() => useThemeStore().setMode('dark')).not.toThrow();
  });

  it('layers user preferences and the instance default under the local choice', () => {
    fakeMedia(false);
    const store = useThemeStore();
    store.setInstanceDefault({ template: 'slate' });
    expect(store.resolved.name).toBe('slate');
    store.applyPreferences({ theme: { template: 'lux', mode: 'bogus' as never } });
    expect(store.resolved.name).toBe('lux');
    store.setTemplate('calm');
    expect(store.resolved.name).toBe('calm');
    store.applyPreferences({});
    expect(store.template).toBe('calm');
  });
});
