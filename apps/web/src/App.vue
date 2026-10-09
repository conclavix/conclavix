<script setup lang="ts">
import {
  mdiAccountTieOutline,
  mdiBookOpenPageVariantOutline,
  mdiBrain,
  mdiFormatListChecks,
  mdiHistory,
  mdiPulse,
  mdiRobotOutline,
  mdiViewDashboardOutline,
} from '@mdi/js';
import { mdiFolderMultipleOutline } from '@mdi/js';
import { computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useVuetiwatch } from 'vuetiwatch';
import DecisionsNavItem from './components/DecisionsNavItem.vue';
import HeaderStatus from './components/HeaderStatus.vue';
import SidebarPinToggle from './components/SidebarPinToggle.vue';
import ThemeToggle from './components/ThemeToggle.vue';
import UserMenu from './components/UserMenu.vue';
import { useAuthStore } from './stores/auth';
import { useLiveStore } from './stores/live';
import { useSidebarStore } from './stores/sidebar';
import { useThemeStore } from './stores/theme';
import { ADMIN_MENU_ITEMS, visibleMenuItems } from './user-menu';

const auth = useAuthStore();
const live = useLiveStore();
const router = useRouter();
const sidebar = useSidebarStore();
const themeStore = useThemeStore();
const vuetiwatch = useVuetiwatch();

watch(
  () => themeStore.resolved.name,
  (name) => {
    if (vuetiwatch.current.value?.name !== name) vuetiwatch.change(name);
  },
  { immediate: true },
);

const adminItems = computed(() => visibleMenuItems(ADMIN_MENU_ITEMS, auth.me?.role));

const statusChip = computed(() => {
  const map = {
    live: { color: 'success', text: 'live' },
    connecting: { color: 'warning', text: 'connecting' },
    offline: { color: 'error', text: 'offline' },
  } as const;
  return map[live.status];
});

const goLogin = async (): Promise<void> => {
  live.disconnect();
  await auth.signOut();
  await router.push({ name: 'login' });
};

watch(
  () => auth.signedIn,
  async (signedIn) => {
    if (!signedIn) return;
    // Names are optional display data; lookup failures must not sign the user out.
    void auth.loadNames().catch(() => undefined);
    try {
      await live.load();
    } catch {
      await goLogin();
      return;
    }
    live.connect(() => void goLogin());
  },
  { immediate: true },
);
</script>

<template>
  <v-app>
    <template v-if="auth.signedIn">
      <v-navigation-drawer permanent :rail="!sidebar.pinned" :expand-on-hover="!sidebar.pinned">
        <v-list density="compact" nav>
          <v-list-item
            :prepend-icon="mdiViewDashboardOutline"
            title="Overview"
            :to="{ name: 'overview' }"
          />
          <v-list-item
            :prepend-icon="mdiFolderMultipleOutline"
            title="Projects"
            :to="{ name: 'projects' }"
          />
          <v-list-item :prepend-icon="mdiPulse" title="Live" :to="{ name: 'live' }" exact />
          <v-list-item :prepend-icon="mdiHistory" title="Runs" :to="{ name: 'runs' }" />
          <v-list-item
            :prepend-icon="mdiFormatListChecks"
            title="Issues"
            :to="{ name: 'issues' }"
          />
          <DecisionsNavItem />
          <v-list-item
            :prepend-icon="mdiAccountTieOutline"
            title="Org chart"
            :to="{ name: 'org' }"
          />
          <v-list-item :prepend-icon="mdiBrain" title="Knowledge" :to="{ name: 'memory' }" />
          <v-list-item :prepend-icon="mdiRobotOutline" title="Agents" :to="{ name: 'agents' }" />
          <v-list-item
            :prepend-icon="mdiBookOpenPageVariantOutline"
            title="Skills"
            :to="{ name: 'skills' }"
          />
        </v-list>
        <template v-if="adminItems.length > 0">
          <v-divider />
          <v-list density="compact" nav aria-label="Administration">
            <v-list-subheader class="admin-nav__header">Administration</v-list-subheader>
            <v-list-item
              v-for="item in adminItems"
              :key="item.key"
              :prepend-icon="item.icon"
              :title="item.title"
              :to="item.to"
            />
          </v-list>
        </template>
        <template #append>
          <SidebarPinToggle />
        </template>
      </v-navigation-drawer>
      <v-app-bar density="compact" flat border>
        <v-app-bar-title>Conclavix</v-app-bar-title>
        <HeaderStatus />
        <v-chip :color="statusChip.color" variant="flat" class="mr-2">{{ statusChip.text }}</v-chip>
        <ThemeToggle />
        <UserMenu @sign-out="goLogin" />
      </v-app-bar>
    </template>
    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<style scoped>
/* The rail is too narrow for the group title; it shows once the drawer expands on hover. */
.v-navigation-drawer--rail:not(.v-navigation-drawer--is-hovering) .admin-nav__header {
  visibility: hidden;
}
</style>
