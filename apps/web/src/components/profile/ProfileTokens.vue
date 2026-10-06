<script setup lang="ts">
import { mdiKeyPlus } from '@mdi/js';
import { computed, onMounted, ref } from 'vue';
import type { ApiToken, CreatedApiToken } from '../../api/profile';
import { useAuthStore } from '../../stores/auth';
import { useApiTokensStore } from '../../stores/api-tokens';
import { problemText } from '../../stores/profile';
import SecretValue from './SecretValue.vue';

const auth = useAuthStore();
const store = useApiTokensStore();

const loading = ref(false);
const error = ref('');
const createOpen = ref(false);
const name = ref('');
const expiry = ref<number | null>(90);
const creating = ref(false);
const createError = ref('');
const created = ref<CreatedApiToken | null>(null);
const pendingRevoke = ref<ApiToken | null>(null);
const revoking = ref(false);

const EXPIRY_OPTIONS = [
  { title: '7 days', value: 7 },
  { title: '30 days', value: 30 },
  { title: '90 days', value: 90 },
  { title: '1 year', value: 365 },
  { title: 'Never', value: null },
];
const nameRules = [
  (value: string) => value.trim().length > 0 || 'Give the token a name',
  (value: string) => value.trim().length <= 80 || 'At most 80 characters',
];
const nameValid = computed(() => nameRules.every((rule) => rule(name.value) === true));
const viaToken = computed(() => auth.me?.via === 'token');

const headers = [
  { title: 'Name', key: 'name' },
  { title: 'Prefix', key: 'prefix', sortable: false },
  { title: 'Created', key: 'createdAt' },
  { title: 'Last used', key: 'lastUsedAt' },
  { title: 'Expires', key: 'expiresAt' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
];

const day = (iso: string | null, empty: string): string =>
  iso ? new Date(iso).toLocaleDateString() : empty;
const expired = (token: ApiToken): boolean =>
  token.expiresAt !== null && new Date(token.expiresAt).getTime() <= Date.now();

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await store.load();
  } catch (cause) {
    error.value = problemText(cause);
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  name.value = '';
  expiry.value = 90;
  createError.value = '';
  created.value = null;
  createOpen.value = true;
}

async function create(): Promise<void> {
  if (!nameValid.value || creating.value || created.value) return;
  creating.value = true;
  createError.value = '';
  try {
    created.value = await store.create(name.value, expiry.value ?? undefined);
  } catch (cause) {
    createError.value = problemText(cause);
  } finally {
    creating.value = false;
  }
}

function closeCreate(): void {
  createOpen.value = false;
  created.value = null;
}

async function revoke(): Promise<void> {
  const token = pendingRevoke.value;
  if (!token || revoking.value) return;
  revoking.value = true;
  error.value = '';
  try {
    await store.revoke(token.id);
    pendingRevoke.value = null;
  } catch (cause) {
    error.value = problemText(cause);
    pendingRevoke.value = null;
  } finally {
    revoking.value = false;
  }
}

onMounted(load);
</script>

<template>
  <v-card title="API tokens" subtitle="For scripts and tools that call the board API">
    <template #append>
      <v-btn
        color="primary"
        :prepend-icon="mdiKeyPlus"
        :disabled="viaToken"
        data-testid="create-token"
        @click="openCreate"
        >New token</v-btn
      >
    </template>
    <v-card-text>
      <p class="text-body-2 mb-3">
        Send a token as <code>Authorization: Bearer &lt;token&gt;</code>. It acts with your role, so
        revoke tokens you no longer use.
      </p>
      <v-alert v-if="viaToken" type="info" variant="tonal" density="compact" class="mb-3">
        You are using an API token right now. Sign in with your password to create tokens.
      </v-alert>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
        error
      }}</v-alert>
      <v-data-table
        :headers="headers"
        :items="store.tokens"
        :loading="loading"
        density="compact"
        items-per-page="-1"
        hide-default-footer
        no-data-text="No API tokens yet."
        data-testid="token-table"
      >
        <template #[`item.prefix`]="{ item }">
          <code>{{ item.prefix }}…</code>
        </template>
        <template #[`item.createdAt`]="{ item }">{{ day(item.createdAt, '') }}</template>
        <template #[`item.lastUsedAt`]="{ item }">{{ day(item.lastUsedAt, 'Never') }}</template>
        <template #[`item.expiresAt`]="{ item }">
          <v-chip v-if="expired(item)" size="x-small" color="error" label>expired</v-chip>
          <span v-else>{{ day(item.expiresAt, 'Never') }}</span>
        </template>
        <template #[`item.actions`]="{ item }">
          <v-btn
            variant="text"
            color="error"
            size="small"
            data-testid="revoke-token"
            @click="pendingRevoke = item"
            >Revoke</v-btn
          >
        </template>
      </v-data-table>
    </v-card-text>

    <v-dialog v-model="createOpen" max-width="520" persistent>
      <v-card :title="created ? 'Copy your new token' : 'New API token'">
        <v-card-text v-if="created">
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
            This is the only time the token is shown. Copy it now and store it like a password; the
            board keeps only a hash.
          </v-alert>
          <SecretValue :value="created.token" label="API token" data-testid="new-token" />
        </v-card-text>
        <v-form v-else @submit.prevent="create">
          <v-card-text>
            <v-text-field
              v-model="name"
              label="Name"
              hint="Where it is used, e.g. CI deploy"
              :rules="nameRules"
              maxlength="80"
              autofocus
              data-testid="token-name"
            />
            <v-select
              v-model="expiry"
              :items="EXPIRY_OPTIONS"
              label="Expires after"
              data-testid="token-expiry"
            />
            <v-alert v-if="createError" type="error" variant="tonal" density="compact">{{
              createError
            }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" :disabled="creating" @click="closeCreate">Cancel</v-btn>
            <v-btn
              type="submit"
              color="primary"
              :loading="creating"
              :disabled="!nameValid"
              data-testid="token-create-submit"
              >Create</v-btn
            >
          </v-card-actions>
        </v-form>
        <v-card-actions v-if="created">
          <v-spacer />
          <v-btn color="primary" data-testid="token-done" @click="closeCreate"
            >I have copied it</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog
      :model-value="pendingRevoke !== null"
      max-width="420"
      @update:model-value="(open: boolean) => !open && (pendingRevoke = null)"
    >
      <v-card v-if="pendingRevoke" title="Revoke this token?">
        <v-card-text
          >Anything that uses <strong>{{ pendingRevoke.name }}</strong> ({{
            pendingRevoke.prefix
          }}…) stops working immediately. This cannot be undone.</v-card-text
        >
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="revoking" @click="pendingRevoke = null">Cancel</v-btn>
          <v-btn
            color="error"
            :loading="revoking"
            data-testid="confirm-revoke-token"
            @click="revoke"
            >Revoke</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>
