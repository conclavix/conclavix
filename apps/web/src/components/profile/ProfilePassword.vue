<script setup lang="ts">
import { computed, ref } from 'vue';
import { PASSWORD_MAX, PASSWORD_MIN, passwordStrength } from '../../api/profile';
import { problemText, useProfileStore } from '../../stores/profile';

const profile = useProfileStore();

const current = ref('');
const next = ref('');
const repeat = ref('');
const revokeOthers = ref(true);
const busy = ref(false);
const error = ref('');
const done = ref('');

const strength = computed(() => passwordStrength(next.value));
const newRules = [
  (value: string) => value.length >= PASSWORD_MIN || `At least ${PASSWORD_MIN} characters`,
  (value: string) => value.length <= PASSWORD_MAX || `At most ${PASSWORD_MAX} characters`,
  (value: string) => value !== current.value || 'Choose a password you have not used here',
];
const repeatRules = [(value: string) => value === next.value || 'The passwords do not match'];
const valid = computed(
  () =>
    current.value.length > 0 &&
    newRules.every((rule) => rule(next.value) === true) &&
    repeat.value === next.value,
);

async function submit(): Promise<void> {
  if (!valid.value || busy.value) return;
  busy.value = true;
  error.value = '';
  done.value = '';
  try {
    await profile.changePassword(current.value, next.value, revokeOthers.value);
    done.value = revokeOthers.value
      ? 'Password changed. Your other sessions were signed out.'
      : 'Password changed.';
    current.value = '';
    next.value = '';
    repeat.value = '';
  } catch (cause) {
    error.value = problemText(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <v-card title="Password">
    <v-card-text>
      <v-form autocomplete="on" @submit.prevent="submit">
        <v-text-field
          v-model="current"
          label="Current password"
          type="password"
          autocomplete="current-password"
          data-testid="current-password"
        />
        <v-text-field
          v-model="next"
          label="New password"
          type="password"
          autocomplete="new-password"
          :rules="next ? newRules : []"
          :counter="PASSWORD_MAX"
          data-testid="new-password"
        />
        <div v-if="next" class="mb-4" data-testid="password-strength">
          <v-progress-linear
            :model-value="strength.score * 25"
            :color="strength.color"
            height="6"
            rounded
            :aria-label="`Password strength: ${strength.label}`"
          />
          <div class="text-caption mt-1">
            Strength: <span :class="`text-${strength.color}`">{{ strength.label }}</span
            >. Long passphrases of several unrelated words are the easiest strong passwords.
          </div>
        </div>
        <v-text-field
          v-model="repeat"
          label="Repeat new password"
          type="password"
          autocomplete="new-password"
          :rules="repeat ? repeatRules : []"
          data-testid="repeat-password"
        />
        <v-checkbox
          v-model="revokeOthers"
          label="Sign out my other sessions"
          density="compact"
          hide-details
          class="mb-3"
        />
        <v-btn
          type="submit"
          color="primary"
          :loading="busy"
          :disabled="!valid"
          data-testid="change-password"
          >Change password</v-btn
        >
        <v-alert v-if="done" type="success" variant="tonal" density="compact" class="mt-3">{{
          done
        }}</v-alert>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{
          error
        }}</v-alert>
      </v-form>
    </v-card-text>
  </v-card>
</template>
