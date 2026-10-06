<script setup lang="ts">
import { mdiAccountCircleOutline, mdiLogout, mdiPaletteOutline } from '@mdi/js';
import { computed, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { ADMIN_MENU_ITEMS, visibleMenuItems } from '../user-menu';
import AvatarImage from './AvatarImage.vue';
import ThemePicker from './ThemePicker.vue';

const emit = defineEmits<{ 'sign-out': [] }>();

const auth = useAuthStore();
const open = ref(false);
const themeOpen = ref(false);

const isUser = computed(() => auth.me?.kind === 'user');
const name = computed(() =>
  isUser.value ? auth.me?.name || auth.me?.email || 'User' : 'Board token',
);
const role = computed(() => auth.me?.role ?? '');
const adminItems = computed(() => visibleMenuItems(ADMIN_MENU_ITEMS, role.value));

const ROLE_COLORS: Record<string, string> = {
  owner: 'primary',
  admin: 'secondary',
  member: 'info',
  viewer: 'default',
};

function openTheme(): void {
  open.value = false;
  themeOpen.value = true;
}
</script>

<template>
  <v-menu v-model="open" location="bottom end" :close-on-content-click="true">
    <template #activator="{ props: menu }">
      <v-btn
        v-bind="menu"
        icon
        variant="text"
        class="ml-1 mr-2"
        :aria-label="`Account menu for ${name}`"
        data-testid="user-menu"
      >
        <AvatarImage
          :name="name"
          :color-key="auth.me?.id ?? 'board'"
          :src="auth.me?.avatarUrl ?? null"
          :size="32"
        />
      </v-btn>
    </template>
    <v-card min-width="260">
      <v-list density="compact" nav>
        <div class="d-flex align-center ga-3 px-2 pt-1 pb-3">
          <AvatarImage
            :name="name"
            :color-key="auth.me?.id ?? 'board'"
            :src="auth.me?.avatarUrl ?? null"
            :size="40"
          />
          <div class="flex-grow-1" style="min-width: 0">
            <div class="text-body-1 font-weight-medium text-truncate" data-testid="user-name">
              {{ name }}
            </div>
            <div class="text-caption text-medium-emphasis text-truncate">
              {{ isUser ? auth.me?.email : 'Legacy owner access' }}
            </div>
          </div>
          <v-chip
            v-if="role"
            size="x-small"
            label
            :color="ROLE_COLORS[role] ?? 'default'"
            data-testid="user-role"
            >{{ role }}</v-chip
          >
        </div>
        <v-divider class="mb-1" />
        <v-list-item
          v-if="isUser"
          :prepend-icon="mdiAccountCircleOutline"
          title="Profile"
          :to="{ name: 'profile' }"
        />
        <v-list-item :prepend-icon="mdiPaletteOutline" title="Theme" @click="openTheme" />
        <template v-if="adminItems.length > 0 || $slots['admin-items']">
          <v-divider class="my-1" />
          <v-list-subheader>Administration</v-list-subheader>
          <v-list-item
            v-for="item in adminItems"
            :key="item.key"
            :prepend-icon="item.icon"
            :title="item.title"
            :to="item.to"
          />
          <slot name="admin-items" />
        </template>
        <v-divider class="my-1" />
        <v-list-item :prepend-icon="mdiLogout" title="Sign out" @click="emit('sign-out')" />
      </v-list>
    </v-card>
  </v-menu>
  <v-dialog v-model="themeOpen" max-width="760" scrollable>
    <v-card title="Theme">
      <v-card-text>
        <ThemePicker />
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn text="Done" @click="themeOpen = false" />
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
