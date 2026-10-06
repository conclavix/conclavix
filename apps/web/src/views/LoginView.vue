<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore, type SignInResult } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const email = ref('');
const password = ref('');
const code = ref('');
const recovery = ref(false);
const step = ref<'password' | 'code'>('password');
const error = ref('');
const busy = ref(false);

const MESSAGES: Record<Exclude<SignInResult, 'ok' | 'mfa'>, string> = {
  invalid: 'E-mail, password or code not accepted.',
  limited: 'Too many attempts. Wait a minute and try again.',
};

async function finish(result: SignInResult): Promise<void> {
  if (result === 'mfa') {
    step.value = 'code';
    return;
  }
  if (result !== 'ok') {
    error.value = MESSAGES[result];
    return;
  }
  const next = typeof route.query['next'] === 'string' ? route.query['next'] : '/';
  await router.replace(auth.me?.mfaRequired ? { name: 'setup-2fa' } : next);
}

async function submit(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await finish(
      step.value === 'password'
        ? await auth.signIn(email.value.trim(), password.value)
        : await auth.verify(code.value, recovery.value),
    );
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-container class="fill-height" style="max-width: 440px">
    <v-card class="w-100 pa-2">
      <v-card-title>Conclavix</v-card-title>
      <v-card-subtitle>{{
        step === 'password' ? 'Sign in' : 'Two-factor authentication'
      }}</v-card-subtitle>
      <v-card-text>
        <v-form @submit.prevent="submit">
          <template v-if="step === 'password'">
            <v-text-field
              v-model="email"
              label="E-mail"
              type="email"
              autocomplete="username"
              autofocus
            />
            <v-text-field
              v-model="password"
              label="Password"
              type="password"
              autocomplete="current-password"
            />
          </template>
          <template v-else>
            <v-text-field
              v-model="code"
              :label="recovery ? 'Recovery code' : 'Code from your authenticator app'"
              :autocomplete="recovery ? 'off' : 'one-time-code'"
              :inputmode="recovery ? 'text' : 'numeric'"
              autofocus
            />
            <v-btn variant="text" size="small" class="mb-2" @click="recovery = !recovery">{{
              recovery ? 'Use an authenticator code' : 'Use a recovery code'
            }}</v-btn>
          </template>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{
            error
          }}</v-alert>
          <v-btn
            type="submit"
            color="primary"
            block
            :loading="busy"
            :disabled="step === 'password' ? !email || !password : !code"
            >{{ step === 'password' ? 'Sign in' : 'Verify' }}</v-btn
          >
        </v-form>
      </v-card-text>
    </v-card>
  </v-container>
</template>
