<script setup lang="ts">
import { mdiCheck, mdiThemeLightDark, mdiWeatherNight, mdiWeatherSunny } from '@mdi/js';
import { computed } from 'vue';
import { useThemeStore } from '../stores/theme';
import { TEMPLATES, hasModeVariants, templateOf, type TemplateName } from '../theme/resolve';

const store = useThemeStore();

const MODES = [
  { value: 'light', title: 'Light', icon: mdiWeatherSunny },
  { value: 'dark', title: 'Dark', icon: mdiWeatherNight },
  { value: 'system', title: 'System', icon: mdiThemeLightDark },
] as const;

const cards = TEMPLATES.map((t) => {
  const [background, surface, primary] = t.meta.swatch;
  const radius = String(t.theme.variables?.['vw-radius'] ?? '4px');
  return {
    name: t.name,
    title: t.meta.title,
    description: t.meta.description,
    tag: hasModeVariants(t.name) ? 'light + dark' : t.meta.dark ? 'dark' : 'light',
    frame: { background, borderRadius: radius },
    panel: { background: surface, borderRadius: radius },
    accent: { background: primary, borderRadius: radius },
  };
});

const modeHint = computed(() =>
  store.resolved.modeAvailable
    ? ''
    : `${templateOf(store.template).meta.title} has no light/dark variants, so the mode is fixed.`,
);

const pick = (name: TemplateName): void => store.setTemplate(name);
</script>

<template>
  <div class="theme-picker">
    <div class="d-flex align-center flex-wrap ga-3 mb-4">
      <span class="text-subtitle-2">Mode</span>
      <v-tooltip :text="modeHint" :disabled="store.resolved.modeAvailable" location="bottom">
        <template #activator="{ props: tip }">
          <span v-bind="tip">
            <v-btn-toggle
              :model-value="store.mode"
              mandatory
              density="compact"
              variant="outlined"
              divided
              :disabled="!store.resolved.modeAvailable"
              aria-label="Colour mode"
              @update:model-value="store.setMode"
            >
              <v-btn
                v-for="mode in MODES"
                :key="mode.value"
                :value="mode.value"
                :prepend-icon="mode.icon"
                :text="mode.title"
              />
            </v-btn-toggle>
          </span>
        </template>
      </v-tooltip>
    </div>
    <div class="theme-picker__grid" role="radiogroup" aria-label="Theme template">
      <button
        v-for="card in cards"
        :key="card.name"
        type="button"
        role="radio"
        class="theme-picker__card"
        :class="{ 'theme-picker__card--active': card.name === store.template }"
        :aria-checked="card.name === store.template"
        :title="card.description"
        :data-template="card.name"
        @click="pick(card.name)"
      >
        <span class="theme-picker__frame" :style="card.frame">
          <span class="theme-picker__panel" :style="card.panel">
            <span class="theme-picker__accent" :style="card.accent" />
          </span>
        </span>
        <span class="d-flex align-center ga-1 mt-2">
          <span class="text-body-2 font-weight-medium">{{ card.title }}</span>
          <v-icon v-if="card.name === store.template" :icon="mdiCheck" size="small" />
        </span>
        <span class="text-caption text-medium-emphasis">{{ card.tag }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.theme-picker__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 12px;
}
.theme-picker__card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 8px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: var(--v-vw-radius, 4px);
  color: rgb(var(--v-theme-on-surface));
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.theme-picker__card:hover {
  background: rgba(var(--v-theme-on-surface), var(--v-hover-opacity));
}
.theme-picker__card:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: 2px;
}
.theme-picker__card--active {
  border-color: rgb(var(--v-theme-primary));
  box-shadow: inset 0 0 0 1px rgb(var(--v-theme-primary));
}
.theme-picker__frame {
  display: block;
  width: 100%;
  height: 64px;
  padding: 10px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.theme-picker__panel {
  display: flex;
  align-items: flex-end;
  height: 100%;
  padding: 6px;
}
.theme-picker__accent {
  display: block;
  width: 40%;
  height: 12px;
}
</style>
