<script setup lang="ts">
import {
  mdiAccountCancelOutline,
  mdiAccountCheckOutline,
  mdiAccountPlusOutline,
  mdiDeleteOutline,
  mdiDotsVertical,
  mdiKeyVariant,
  mdiRefresh,
  mdiShieldAccountOutline,
  mdiShieldOffOutline,
} from '@mdi/js';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import AdminConfirmDialog from '../../components/admin/AdminConfirmDialog.vue';
import PasswordDeliveryDialog from '../../components/admin/PasswordDeliveryDialog.vue';
import UserCreateDialog from '../../components/admin/UserCreateDialog.vue';
import { adminApi, ROLES, type AdminUser, type PasswordDelivery, type Role } from '../../admin/api';
import {
  actionBlock,
  activeOwners,
  errorText,
  grantableRoles,
  type UserAction,
} from '../../admin/gating';
import { ACTION_DIALOGS, optionalPassword } from '../../admin/user-actions';
import { useAuthStore } from '../../stores/auth';

const HEADERS = [
  { title: 'Name', key: 'name' },
  { title: 'E-mail', key: 'email' },
  { title: 'Role', key: 'role' },
  { title: '2FA', key: 'twoFactorEnabled', sortable: false },
  { title: 'Status', key: 'banned' },
  { title: 'Last sign-in', key: 'lastSignInAt' },
  { title: 'Created', key: 'createdAt' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
];
const ROLE_COLORS: Record<Role, string> = {
  owner: 'deep-purple',
  admin: 'primary',
  member: 'teal',
  viewer: 'grey',
};

const auth = useAuthStore();
const route = useRoute();
const users = ref<AdminUser[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const notice = ref<string | null>(null);
const search = ref('');
const initialRole = String(route.query['role'] ?? '');
const roleFilter = ref<Role[]>(
  (ROLES as readonly string[]).includes(initialRole) ? [initialRole as Role] : [],
);
const statusFilter = ref<'all' | 'active' | 'banned'>('all');

const actor = computed(() => ({ id: auth.me?.id ?? null, role: auth.me?.role ?? 'viewer' }));
const owners = computed(() => activeOwners(users.value));
const roleChoices = computed(() => grantableRoles(actor.value.role));

const rows = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return users.value.filter(
    (user) =>
      (!needle ||
        user.name.toLowerCase().includes(needle) ||
        user.email.toLowerCase().includes(needle)) &&
      (roleFilter.value.length === 0 || roleFilter.value.includes(user.role)) &&
      (statusFilter.value === 'all' || (statusFilter.value === 'banned') === user.banned),
  );
});

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    users.value = await adminApi.users();
  } catch (error) {
    loadError.value = errorText(error);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const when = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString() : '—';
const blockOf = (user: AdminUser, action: UserAction): string | null =>
  actionBlock(actor.value, user, action, owners.value);

/* --- confirmed actions on one user --- */

type Pending = { action: UserAction; user: AdminUser };
const pending = ref<Pending | null>(null);
const dialogOpen = ref(false);
const busy = ref(false);
const actionError = ref<string | null>(null);
const nextRole = ref<Role>('member');
const manualPassword = ref('');

/** The last password outcome; cleared on "Done" so a temporary password does not linger. */
const delivery = ref<{ title: string; result: PasswordDelivery; email: string } | null>(null);

function start(action: UserAction, user: AdminUser): void {
  pending.value = { action, user };
  actionError.value = null;
  nextRole.value = user.role;
  manualPassword.value = '';
  dialogOpen.value = true;
}

const dialog = computed(() => {
  const current = pending.value;
  if (!current) return { title: '', confirm: '', color: 'primary', consequences: [] };
  const spec = ACTION_DIALOGS[current.action];
  return { ...spec, title: spec.title(`${current.user.name} (${current.user.email})`) };
});

function replace(user: AdminUser): void {
  users.value = users.value.map((item) => (item.id === user.id ? { ...item, ...user } : item));
}

async function confirmAction(): Promise<void> {
  const current = pending.value;
  if (!current || busy.value) return;
  busy.value = true;
  actionError.value = null;
  const { user } = current;
  try {
    switch (current.action) {
      case 'role':
        if (nextRole.value === user.role) break;
        replace(await adminApi.updateUser(user.id, { role: nextRole.value }));
        notice.value = `${user.name} is now ${nextRole.value}.`;
        break;
      case 'ban':
        replace(await adminApi.ban(user.id));
        notice.value = `${user.name} is banned.`;
        break;
      case 'unban':
        replace(await adminApi.unban(user.id));
        notice.value = `${user.name} can sign in again.`;
        break;
      case 'resetMfa':
        replace(await adminApi.resetMfa(user.id));
        notice.value = `Two-factor authentication of ${user.name} was reset.`;
        break;
      case 'delete':
        await adminApi.deleteUser(user.id);
        users.value = users.value.filter((item) => item.id !== user.id);
        notice.value = `${user.name} was deleted.`;
        break;
      case 'resetPassword': {
        const result = await adminApi.resetPassword(user.id, manualPassword.value || undefined);
        manualPassword.value = '';
        delivery.value = { title: 'Password reset', result, email: user.email };
        break;
      }
    }
    dialogOpen.value = false;
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    busy.value = false;
  }
}

const createOpen = ref(false);

function created(user: AdminUser, result: PasswordDelivery): void {
  users.value = [...users.value, { ...user, lastSignInAt: null }];
  delivery.value = { title: `${user.name} was added`, result, email: user.email };
}

const menuItems: { action: UserAction; title: string; icon: string; danger?: boolean }[] = [
  { action: 'role', title: 'Change role', icon: mdiShieldAccountOutline },
  { action: 'resetPassword', title: 'Reset password', icon: mdiKeyVariant },
  { action: 'resetMfa', title: 'Reset 2FA', icon: mdiShieldOffOutline },
  { action: 'ban', title: 'Ban', icon: mdiAccountCancelOutline, danger: true },
  { action: 'unban', title: 'Unban', icon: mdiAccountCheckOutline },
  { action: 'delete', title: 'Delete', icon: mdiDeleteOutline, danger: true },
];
const itemsFor = (user: AdminUser) =>
  menuItems.filter((item) =>
    item.action === 'ban' ? !user.banned : item.action === 'unban' ? user.banned : true,
  );
</script>

<template>
  <v-container fluid class="pa-3">
    <v-card>
      <v-card-title class="d-flex align-center flex-wrap ga-2">
        Users
        <v-spacer />
        <v-btn
          :icon="mdiRefresh"
          variant="text"
          size="small"
          aria-label="Reload users"
          @click="load"
        />
        <v-btn :prepend-icon="mdiAccountPlusOutline" color="primary" @click="createOpen = true">
          Add user
        </v-btn>
      </v-card-title>
      <v-card-text class="pb-0">
        <v-row dense>
          <v-col cols="12" md="5">
            <v-text-field
              v-model="search"
              label="Search name or e-mail"
              density="compact"
              clearable
              hide-details
            />
          </v-col>
          <v-col cols="12" sm="6" md="4">
            <v-select
              v-model="roleFilter"
              :items="[...ROLES]"
              label="Role"
              multiple
              chips
              closable-chips
              clearable
              density="compact"
              hide-details
            />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <v-select
              v-model="statusFilter"
              :items="[
                { title: 'All', value: 'all' },
                { title: 'Active', value: 'active' },
                { title: 'Banned', value: 'banned' },
              ]"
              label="Status"
              density="compact"
              hide-details
            />
          </v-col>
        </v-row>
      </v-card-text>
      <v-alert v-if="loadError" type="error" variant="tonal" class="ma-4">{{ loadError }}</v-alert>
      <v-data-table
        :headers="HEADERS"
        :items="rows"
        :loading="loading"
        item-value="id"
        density="compact"
        class="admin-users"
        :items-per-page="25"
      >
        <template #[`item.name`]="{ item }">
          <span class="font-weight-medium">{{ item.name }}</span>
          <v-chip v-if="item.id === actor.id" size="x-small" class="ml-2" variant="outlined">
            you
          </v-chip>
        </template>
        <template #[`item.role`]="{ item }">
          <v-chip :color="ROLE_COLORS[item.role]" variant="tonal">{{ item.role }}</v-chip>
        </template>
        <template #[`item.twoFactorEnabled`]="{ item }">
          <v-chip :color="item.twoFactorEnabled ? 'success' : undefined" variant="tonal">
            {{ item.twoFactorEnabled ? 'on' : 'off' }}
          </v-chip>
        </template>
        <template #[`item.banned`]="{ item }">
          <v-chip :color="item.banned ? 'error' : 'success'" variant="tonal">
            {{ item.banned ? 'banned' : 'active' }}
          </v-chip>
        </template>
        <template #[`item.lastSignInAt`]="{ item }">{{ when(item.lastSignInAt) }}</template>
        <template #[`item.createdAt`]="{ item }">{{ when(item.createdAt) }}</template>
        <template #[`item.actions`]="{ item }">
          <v-menu location="bottom end">
            <template #activator="{ props: menu }">
              <v-btn
                v-bind="menu"
                :icon="mdiDotsVertical"
                variant="text"
                size="small"
                :aria-label="`Actions for ${item.email}`"
              />
            </template>
            <v-list density="compact" min-width="220">
              <v-tooltip
                v-for="entry in itemsFor(item)"
                :key="entry.action"
                :text="blockOf(item, entry.action) ?? ''"
                :disabled="!blockOf(item, entry.action)"
                location="start"
              >
                <template #activator="{ props: tip }">
                  <div v-bind="tip">
                    <v-list-item
                      :title="entry.title"
                      :prepend-icon="entry.icon"
                      :disabled="!!blockOf(item, entry.action)"
                      :base-color="entry.danger ? 'error' : undefined"
                      @click="start(entry.action, item)"
                    />
                  </div>
                </template>
              </v-tooltip>
            </v-list>
          </v-menu>
        </template>
        <template #no-data>No users match these filters.</template>
      </v-data-table>
    </v-card>

    <AdminConfirmDialog
      v-model="dialogOpen"
      :title="dialog.title"
      :confirm-text="dialog.confirm"
      :color="dialog.color"
      :consequences="dialog.consequences"
      :loading="busy"
      :error="actionError"
      :disabled="pending?.action === 'role' && nextRole === pending?.user.role"
      @confirm="confirmAction"
    >
      <v-select
        v-if="pending?.action === 'role'"
        v-model="nextRole"
        :items="roleChoices"
        label="New role"
        :hint="actor.role === 'owner' ? '' : 'The owner role can only be granted by an owner.'"
        persistent-hint
      />
      <v-text-field
        v-if="pending?.action === 'resetPassword'"
        v-model="manualPassword"
        type="password"
        label="New password (optional)"
        autocomplete="new-password"
        :rules="[optionalPassword]"
        hint="Leave empty to send a reset e-mail or get a temporary password."
        persistent-hint
      />
    </AdminConfirmDialog>

    <UserCreateDialog
      v-model="createOpen"
      :roles="roleChoices"
      :owner-hint="actor.role !== 'owner'"
      @created="created"
    />

    <PasswordDeliveryDialog
      v-if="delivery"
      :title="delivery.title"
      :email="delivery.email"
      :result="delivery.result"
      @done="delivery = null"
    />

    <v-snackbar
      :model-value="notice !== null"
      color="success"
      :timeout="4000"
      @update:model-value="notice = null"
    >
      {{ notice }}
    </v-snackbar>
  </v-container>
</template>
