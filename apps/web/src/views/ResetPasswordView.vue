<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';

const route = useRoute();
const router = useRouter();
const token = typeof route.query['token'] === 'string' ? route.query['token'] : '';
const password = ref('');
const repeat = ref('');
const error = ref(route.query['error'] ? 'This link is invalid or has expired.' : '');
const busy = ref(false);

async function submit(): Promise<void> {
  if (password.value !== repeat.value) {
    error.value = 'The passwords do not match.';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword: password.value }),
    });
    await router.replace({ name: 'login' });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-container class="fill-height" style="max-width: 440px">
    <v-card class="w-100 pa-2">
      <v-card-title>Set a new password</v-card-title>
      <v-card-text>
        <v-form @submit.prevent="submit">
          <v-text-field
            v-model="password"
            label="New password (at least 12 characters)"
            type="password"
            autocomplete="new-password"
            autofocus
          />
          <v-text-field
            v-model="repeat"
            label="Repeat the password"
            type="password"
            autocomplete="new-password"
          />
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
            error
          }}</v-alert>
          <v-btn
            type="submit"
            color="primary"
            block
            :loading="busy"
            :disabled="!token || password.length < 12"
            >Save password</v-btn
          >
        </v-form>
      </v-card-text>
    </v-card>
  </v-container>
</template>
