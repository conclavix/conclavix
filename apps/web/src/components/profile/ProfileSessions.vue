<script setup lang="ts">
import { mdiLaptop, mdiRefresh } from '@mdi/js';
import { onMounted, ref } from 'vue';
import { describeUserAgent, type AuthSession } from '../../api/profile';
import { problemText, useProfileStore } from '../../stores/profile';

const profile = useProfileStore();
const loading = ref(false);
const error = ref('');
const busyId = ref<string | null>(null);
const confirmOthers = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await profile.loadSessions();
  } catch (cause) {
    error.value = problemText(cause);
  } finally {
    loading.value = false;
  }
}

async function revoke(session: AuthSession): Promise<void> {
  busyId.value = session.id;
  error.value = '';
  try {
    await profile.revokeSession(session);
  } catch (cause) {
    error.value = problemText(cause);
  } finally {
    busyId.value = null;
  }
}

async function revokeOthers(): Promise<void> {
  busyId.value = 'others';
  error.value = '';
  try {
    await profile.revokeOtherSessions();
    confirmOthers.value = false;
  } catch (cause) {
    error.value = problemText(cause);
  } finally {
    busyId.value = null;
  }
}

const when = (iso: string): string => new Date(iso).toLocaleString();

onMounted(load);
</script>

<template>
  <v-card title="Active sessions" subtitle="Browsers signed in to your account">
    <template #append>
      <v-btn
        :icon="mdiRefresh"
        variant="text"
        :loading="loading"
        aria-label="Reload sessions"
        @click="load"
      />
    </template>
    <v-card-text>
      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
        error
      }}</v-alert>
      <v-list v-if="profile.sessions.length > 0" density="compact" lines="two" class="py-0">
        <v-list-item
          v-for="session in profile.sessions"
          :key="session.id"
          :prepend-icon="mdiLaptop"
          :title="describeUserAgent(session.userAgent)"
          :subtitle="`${session.ipAddress || 'unknown address'} · signed in ${when(session.createdAt)} · expires ${when(session.expiresAt)}`"
          data-testid="session-item"
        >
          <template #append>
            <v-chip
              v-if="session.id === profile.currentSessionId"
              size="small"
              color="success"
              label
              data-testid="current-session"
              >This browser</v-chip
            >
            <v-btn
              v-else
              variant="text"
              color="error"
              size="small"
              :loading="busyId === session.id"
              :disabled="busyId !== null"
              data-testid="revoke-session"
              @click="revoke(session)"
              >Sign out</v-btn
            >
          </template>
        </v-list-item>
      </v-list>
      <p v-else-if="!loading && !error" class="text-body-2 text-medium-emphasis">
        No sessions loaded. Use the reload button to list them.
      </p>
    </v-card-text>
    <v-card-actions v-if="profile.sessions.length > 1">
      <v-btn
        color="error"
        variant="text"
        :disabled="busyId !== null"
        data-testid="revoke-other-sessions"
        @click="confirmOthers = true"
        >Sign out other sessions</v-btn
      >
    </v-card-actions>

    <v-dialog v-model="confirmOthers" max-width="420">
      <v-card title="Sign out other sessions?">
        <v-card-text
          >Every browser except this one is signed out and has to sign in again. API tokens are not
          affected.</v-card-text
        >
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmOthers = false">Cancel</v-btn>
          <v-btn
            color="error"
            :loading="busyId === 'others'"
            data-testid="confirm-revoke-others"
            @click="revokeOthers"
            >Sign out others</v-btn
          >
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>
