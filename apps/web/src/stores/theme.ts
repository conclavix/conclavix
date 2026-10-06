import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  resolveTheme,
  sanitizeLayer,
  templateOf,
  type ThemeLayer,
  type ThemeMode,
  type TemplateName,
} from '../theme/resolve';
import {
  darkQuery,
  migrateStoredPreference,
  readStoredPreference,
  writeStoredPreference,
} from '../theme/storage';

export interface UserPreferences {
  theme: ThemeLayer;
}

/** Saves a signed-in user's theme choice to their profile. */
export type ThemePersister = (theme: Required<ThemeLayer>) => Promise<unknown>;

/** The theme name Vuetify starts with, so the first paint already uses the stored choice. */
export function initialThemeName(): TemplateName {
  return resolveTheme({ local: readStoredPreference(), systemDark: darkQuery()?.matches ?? false })
    .name;
}

/** Manages the layered theme preference and tracks changes to the OS color scheme. */
export const useThemeStore = defineStore('theme', () => {
  migrateStoredPreference();
  const local = ref<ThemeLayer>(readStoredPreference());
  const user = ref<ThemeLayer>({});
  const instanceDefault = ref<ThemeLayer>({});
  let persist: ThemePersister | null = null;

  const query = darkQuery();
  const systemDark = ref(query?.matches ?? false);
  query?.addEventListener('change', (event) => {
    systemDark.value = event.matches;
  });

  const resolved = computed(() =>
    resolveTheme({
      instanceDefault: instanceDefault.value,
      user: user.value,
      local: local.value,
      systemDark: systemDark.value,
    }),
  );
  const mode = computed(() => resolved.value.mode);
  const template = computed(() => resolved.value.template);
  const preferences = computed<UserPreferences>(() => ({
    theme: { template: template.value, mode: mode.value },
  }));

  /**
   * Merges a change into the local choice and stores it on this device. When a user is signed
   * in, the resulting choice also becomes their profile preference (user layer and PATCH /me).
   */
  function updateLocal(patch: ThemeLayer): void {
    local.value = sanitizeLayer({ ...local.value, ...patch });
    writeStoredPreference(local.value);
    if (!persist) return;
    const choice = { template: template.value, mode: mode.value };
    user.value = choice;
    persist(choice).catch((err: unknown) => {
      // eslint-disable-next-line no-console -- The choice still applies on this device.
      console.warn('theme: could not save the preference to the profile', err);
    });
  }

  /** Save future choices to the signed-in user's profile; null keeps them on this device only. */
  function setPersister(next: ThemePersister | null): void {
    persist = next;
  }

  /** Sets light, dark or system mode for the current template family. */
  function setMode(next: ThemeMode): void {
    updateLocal({ mode: next });
  }

  /** Applies a template; switches the mode when the picked variant does not match it. */
  function setTemplate(next: TemplateName): void {
    const patch: ThemeLayer = { template: next };
    const preview = resolveTheme({
      instanceDefault: instanceDefault.value,
      user: user.value,
      local: { ...local.value, ...patch },
      systemDark: systemDark.value,
    });
    if (preview.name !== next) patch.mode = templateOf(next).meta.dark ? 'dark' : 'light';
    updateLocal(patch);
  }

  /**
   * Applies a user's stored preference, ignoring missing or invalid values. A profile choice is
   * also adopted as this device's choice, so it follows the user to every device they sign in on.
   */
  function applyPreferences(prefs: Partial<UserPreferences>): void {
    user.value = sanitizeLayer(prefs.theme);
    if (Object.keys(user.value).length === 0) return;
    local.value = { ...user.value };
    writeStoredPreference(local.value);
  }

  /** Sets the instance-wide default layer below the user and local choices. */
  function setInstanceDefault(layer: ThemeLayer): void {
    instanceDefault.value = sanitizeLayer(layer);
  }

  return {
    local,
    systemDark,
    resolved,
    mode,
    template,
    preferences,
    setMode,
    setTemplate,
    applyPreferences,
    setInstanceDefault,
    setPersister,
  };
});
