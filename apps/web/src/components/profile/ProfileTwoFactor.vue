<script setup lang="ts">
import { mdiShieldCheckOutline, mdiShieldOffOutline } from '@mdi/js';
import { computed, ref } from 'vue';
import { mfaDisableBlockedReason, totpSecret, type TwoFactorEnrolment } from '../../api/profile';
import { useAuthStore } from '../../stores/auth';
import { problemText, useProfileStore } from '../../stores/profile';
import SecretValue from './SecretValue.vue';

type Action = 'enable' | 'codes' | 'disable';

const auth = useAuthStore();
const profile = useProfileStore();

const enabled = computed(() => auth.me?.twoFactorEnabled === true);
const blockedReason = computed(() =>
  mfaDisableBlockedReason(auth.me?.mfaPolicy, auth.me?.role ?? ''),
);

const action = ref<Action | null>(null);
const password = ref('');
const busy = ref(false);
const error = ref('');
const enrolment = ref<TwoFactorEnrolment | null>(null);
const code = ref('');
const freshCodes = ref<string[] | null>(null);
const notice = ref('');

const TITLES: Record<Action, { title: string; button: string; color: string }> = {
  enable: { title: 'Turn on two-factor authentication', button: 'Continue', color: 'primary' },
  codes: { title: 'Create new recovery codes', button: 'Create codes', color: 'primary' },
  disable: { title: 'Turn off two-factor authentication', button: 'Turn off', color: 'error' },
};

const dialogOpen = computed({
  get: () => action.value !== null,
  set: (open: boolean) => {
    if (!open) close();
  },
});

function start(next: Action): void {
  action.value = next;
  password.value = '';
  error.value = '';
  notice.value = '';
}

function close(): void {
  action.value = null;
  password.value = '';
  error.value = '';
}

async function run(work: () => Promise<void>, invalidCode = false): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await work();
  } catch (cause) {
    error.value = problemText(cause, invalidCode);
  } finally {
    busy.value = false;
  }
}

const confirmPassword = () =>
  run(async () => {
    const current = action.value;
    if (current === 'enable') {
      enrolment.value = await profile.enableTwoFactor(password.value);
      code.value = '';
    } else if (current === 'codes') {
      freshCodes.value = await profile.generateBackupCodes(password.value);
    } else if (current === 'disable') {
      await profile.disableTwoFactor(password.value);
      freshCodes.value = null;
      notice.value = 'Two-factor authentication is off.';
    }
    close();
  });

const verify = () =>
  run(async () => {
    await profile.confirmTwoFactor(code.value);
    freshCodes.value = enrolment.value?.backupCodes ?? null;
    enrolment.value = null;
    notice.value = 'Two-factor authentication is on.';
  }, true);

function cancelEnrolment(): void {
  enrolment.value = null;
  code.value = '';
  error.value = '';
}
</script>

<template>
  <v-card title="Two-factor authentication">
    <template #append>
      <v-chip
        :color="enabled ? 'success' : 'default'"
        :prepend-icon="enabled ? mdiShieldCheckOutline : mdiShieldOffOutline"
        label
        size="small"
        data-testid="mfa-status"
        >{{ enabled ? 'On' : 'Off' }}</v-chip
      >
    </template>
    <v-card-text>
      <p class="mb-4 text-body-2">
        A time-based code from an authenticator app is asked for after your password when you sign
        in. Recovery codes let you in once each if you lose the app.
      </p>

      <v-alert v-if="notice" type="success" variant="tonal" density="compact" class="mb-4">{{
        notice
      }}</v-alert>

      <template v-if="enrolment">
        <p class="mb-2 text-body-2">
          1. Add this key to your authenticator app (time-based, 6 digits), or open the setup link
          on a device that has one.
        </p>
        <SecretValue :value="totpSecret(enrolment.totpURI)" label="setup key" class="mb-2" />
        <SecretValue :value="enrolment.totpURI" label="setup link" class="mb-4" />
        <p class="mb-2 text-body-2">
          2. Store these recovery codes somewhere safe. They are shown only now.
        </p>
        <SecretValue
          :value="enrolment.backupCodes.join('\n')"
          label="recovery codes"
          class="mb-4"
          data-testid="enrol-codes"
        />
        <v-form @submit.prevent="verify">
          <p class="mb-2 text-body-2">3. Enter the code the app shows now.</p>
          <v-text-field
            v-model="code"
            label="Code from your authenticator app"
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="6"
            style="max-width: 280px"
            data-testid="totp-code"
          />
          <div class="d-flex ga-2">
            <v-btn
              type="submit"
              color="primary"
              :loading="busy"
              :disabled="code.trim().length < 6"
              data-testid="totp-verify"
              >Verify and turn on</v-btn
            >
            <v-btn variant="text" :disabled="busy" @click="cancelEnrolment">Cancel</v-btn>
          </div>
        </v-form>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{
          error
        }}</v-alert>
      </template>

      <template v-else-if="enabled">
        <template v-if="freshCodes">
          <v-alert type="warning" variant="tonal" density="compact" class="mb-2">
            These recovery codes are shown only once. Each works one time; older codes no longer
            work.
          </v-alert>
          <SecretValue
            :value="freshCodes.join('\n')"
            label="recovery codes"
            class="mb-2"
            data-testid="fresh-codes"
          />
          <v-btn variant="text" class="mb-4" @click="freshCodes = null">I have stored them</v-btn>
        </template>
        <v-alert
          v-if="blockedReason"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-4"
          data-testid="mfa-policy-note"
        >
          {{ blockedReason }} It cannot be turned off.
        </v-alert>
        <div class="d-flex flex-wrap ga-2">
          <v-btn variant="tonal" data-testid="regenerate-codes" @click="start('codes')"
            >New recovery codes</v-btn
          >
          <v-btn
            variant="text"
            color="error"
            :disabled="blockedReason !== null"
            data-testid="disable-mfa"
            @click="start('disable')"
            >Turn off</v-btn
          >
        </div>
      </template>

      <template v-else>
        <v-btn color="primary" data-testid="enable-mfa" @click="start('enable')">Turn on</v-btn>
      </template>
    </v-card-text>

    <v-dialog v-model="dialogOpen" max-width="440">
      <v-card v-if="action" :title="TITLES[action].title">
        <v-form @submit.prevent="confirmPassword">
          <v-card-text>
            <p v-if="action === 'disable'" class="mb-3 text-body-2">
              Signing in will only need your password. Your recovery codes stop working.
            </p>
            <p v-else-if="action === 'codes'" class="mb-3 text-body-2">
              New codes replace all existing recovery codes.
            </p>
            <v-text-field
              v-model="password"
              label="Confirm with your password"
              type="password"
              autocomplete="current-password"
              autofocus
              data-testid="confirm-password"
            />
            <v-alert v-if="error" type="error" variant="tonal" density="compact">{{
              error
            }}</v-alert>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn variant="text" :disabled="busy" @click="close">Cancel</v-btn>
            <v-btn
              type="submit"
              :color="TITLES[action].color"
              :loading="busy"
              :disabled="!password"
              data-testid="confirm-password-submit"
              >{{ TITLES[action].button }}</v-btn
            >
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
  </v-card>
</template>
