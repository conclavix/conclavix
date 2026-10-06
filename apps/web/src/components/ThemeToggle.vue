<script setup lang="ts">
import { mdiCheck, mdiThemeLightDark, mdiWeatherNight, mdiWeatherSunny } from '@mdi/js';
import { computed, ref } from 'vue';
import { useThemeStore } from '../stores/theme';
import { templateOf, type ThemeMode } from '../theme/resolve';

const store = useThemeStore();
const menuOpen = ref(false);

const OPTIONS: Record<ThemeMode, { title: string; icon: string }> = {
  light: { title: 'Light', icon: mdiWeatherSunny },
  dark: { title: 'Dark', icon: mdiWeatherNight },
  system: { title: 'System', icon: mdiThemeLightDark },
};

const current = computed(() => OPTIONS[store.mode]);
const label = computed(() => {
  const { modeAvailable, template, dark } = store.resolved;
  if (!modeAvailable) {
    return `${templateOf(template).meta.title} has no light/dark variants`;
  }
  const shade = dark ? 'dark' : 'light';
  return store.mode === 'system' ? `Mode: System (${shade})` : `Mode: ${current.value.title}`;
});
</script>

<template>
  <v-menu v-model="menuOpen" location="bottom end" :disabled="!store.resolved.modeAvailable">
    <template #activator="{ props: menu }">
      <v-tooltip :text="label" :disabled="menuOpen" location="bottom">
        <template #activator="{ props: tip }">
          <span v-bind="tip">
            <v-btn
              v-bind="menu"
              :icon="current.icon"
              variant="text"
              :disabled="!store.resolved.modeAvailable"
              :aria-label="`${label}. Change mode`"
            />
          </span>
        </template>
      </v-tooltip>
    </template>
    <v-list density="compact" aria-label="Colour mode">
      <v-list-item
        v-for="(option, mode) in OPTIONS"
        :key="mode"
        :title="option.title"
        :prepend-icon="option.icon"
        :active="store.mode === mode"
        @click="store.setMode(mode)"
      >
        <template v-if="store.mode === mode" #append>
          <v-icon :icon="mdiCheck" size="small" />
        </template>
      </v-list-item>
    </v-list>
  </v-menu>
</template>
