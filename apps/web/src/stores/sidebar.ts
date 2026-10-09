import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export type SidebarMode = 'rail' | 'pinned';

export const SIDEBAR_STORAGE_KEY = 'conclavix.sidebar';
/** Narrower screens keep the rail: a pinned drawer would take most of a phone's width. */
export const SIDEBAR_PIN_QUERY = '(min-width: 960px)';

/** Saves a signed-in user's sidebar choice to their profile. */
export type SidebarPersister = (mode: SidebarMode) => Promise<unknown>;

export const isSidebarMode = (value: unknown): value is SidebarMode =>
  value === 'rail' || value === 'pinned';

function readStored(): SidebarMode {
  try {
    const raw = globalThis.localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return isSidebarMode(raw) ? raw : 'rail';
  } catch {
    return 'rail';
  }
}

function writeStored(mode: SidebarMode): void {
  try {
    globalThis.localStorage.setItem(SIDEBAR_STORAGE_KEY, mode);
  } catch {
    // Storage can be blocked; the choice still applies until the page reloads.
  }
}

function pinQuery(): MediaQueryList | null {
  try {
    return typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia(SIDEBAR_PIN_QUERY)
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether the navigation drawer stays open (pinned) or is a rail that expands on hover. The
 * choice lives on this device and, for a signed-in user, in the profile, like the theme.
 */
export const useSidebarStore = defineStore('sidebar', () => {
  const mode = ref<SidebarMode>(readStored());
  const query = pinQuery();
  const wide = ref(query?.matches ?? true);
  query?.addEventListener('change', (event) => {
    wide.value = event.matches;
  });
  let persist: SidebarPersister | null = null;

  /** Pinned only applies on wide screens; narrow ones always get the rail. */
  const pinned = computed(() => mode.value === 'pinned' && wide.value);

  function setMode(next: SidebarMode): void {
    mode.value = next;
    writeStored(next);
    persist?.(next).catch((err: unknown) => {
      // eslint-disable-next-line no-console -- The choice still applies on this device.
      console.warn('sidebar: could not save the preference to the profile', err);
    });
  }

  function toggle(): void {
    setMode(mode.value === 'pinned' ? 'rail' : 'pinned');
  }

  /** Adopt a profile choice on this device; a missing or invalid one keeps the device's. */
  function applyPreference(value: unknown): void {
    if (!isSidebarMode(value)) return;
    mode.value = value;
    writeStored(value);
  }

  /** Save future choices to the signed-in user's profile; null keeps them on this device only. */
  function setPersister(next: SidebarPersister | null): void {
    persist = next;
  }

  return { mode, wide, pinned, setMode, toggle, applyPreference, setPersister };
});
