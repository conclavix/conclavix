<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const password = ref('');
const code = ref('');
const enrolment = ref<{ totpURI: string; backupCodes: string[] } | null>(null);
const error = ref('');
const busy = ref(false);

const secret = computed(() =>
  enrolment.value ? (new URL(enrolment.value.totpURI).searchParams.get('secret') ?? '') : '',
);

async function run(work: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await work();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

const start = () =>
  run(async () => {
    enrolment.value = await api('/auth/two-factor/enable', {
      method: 'POST',
      body: JSON.stringify({ password: password.value }),
    });
  });

const confirm = () =>
  run(async () => {
    await api('/auth/two-factor/verify-totp', {
      method: 'POST',
      body: JSON.stringify({ code: code.value.trim() }),
    });
    await auth.load();
    await router.replace('/');
  });

const leave = async (): Promise<void> => {
  await auth.signOut();
  await router.replace({ name: 'login' });
};
</script>

<template>
  <v-container style="max-width: 560px">
    <v-card class="pa-2">
      <v-card-title>Set up two-factor authentication</v-card-title>
      <v-card-subtitle>Required for your role on this instance</v-card-subtitle>
      <v-card-text>
        <v-form v-if="!enrolment" @submit.prevent="start">
          <v-text-field
            v-model="password"
            label="Confirm your password"
            type="password"
            autocomplete="current-password"
            autofocus
          />
          <v-btn type="submit" color="primary" :loading="busy" :disabled="!password"
            >Continue</v-btn
          >
        </v-form>
        <v-form v-else @submit.prevent="confirm">
          <p class="mb-2">Add this key to your authenticator app (time-based, 6 digits):</p>
          <code class="d-block mb-2 text-wrap" data-testid="totp-secret">{{ secret }}</code>
          <p class="mb-2">
            Store these recovery codes somewhere safe. Each works once if you lose the app:
          </p>
          <code class="d-block mb-4" data-testid="recovery-codes">{{
            enrolment.backupCodes.join('  ')
          }}</code>
          <v-text-field
            v-model="code"
            label="Code from your authenticator app"
            autocomplete="one-time-code"
            inputmode="numeric"
            autofocus
          />
          <v-btn type="submit" color="primary" :loading="busy" :disabled="!code">Verify</v-btn>
        </v-form>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{
          error
        }}</v-alert>
        <v-btn variant="text" class="mt-3" @click="leave">Sign out</v-btn>
      </v-card-text>
    </v-card>
  </v-container>
</template>
