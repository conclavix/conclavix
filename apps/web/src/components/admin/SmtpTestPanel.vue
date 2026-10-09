<script setup lang="ts">
import { mdiEmailFastOutline } from '@mdi/js';
import { computed, ref } from 'vue';
import { adminApi, type SmtpTestResult, type SmtpValues } from '../../admin/api';
import { errorText } from '../../admin/gating';
import {
  describeSmtpTest,
  smtpTestBody,
  validateSmtp,
  type SmtpDraft,
} from '../../admin/settings-form';
import { useAuthStore } from '../../stores/auth';

/** Sends a test mail with the SMTP form as it stands: saved values plus any unsaved edits. */
const props = defineProps<{ draft: SmtpDraft; values: SmtpValues }>();

const auth = useAuthStore();
const testTo = ref<string | null>('');
const testing = ref(false);
const testResult = ref<SmtpTestResult | null>(null);
const testError = ref<string | null>(null);

const dirty = computed(() => smtpTestBody(props.draft, props.values, '').smtp !== undefined);
const invalid = computed(() => Object.keys(validateSmtp(props.draft, props.values)).length > 0);
const testView = computed(() => (testResult.value ? describeSmtpTest(testResult.value) : null));
const testBlocked = computed(() => {
  if (invalid.value) return 'Fix the fields above first.';
  if (!props.draft.host.trim() || !props.draft.from.trim()) {
    return 'Set the host and the sender first.';
  }
  return null;
});
const testHint = computed(() => {
  const target = auth.me?.email ? `Empty: sent to you (${auth.me.email}).` : 'Required.';
  const values = dirty.value
    ? 'Uses the unsaved values above without saving them.'
    : 'Uses the saved settings.';
  return `${target} ${values}`;
});

async function sendTest(): Promise<void> {
  if (testing.value || testBlocked.value) return;
  testing.value = true;
  testResult.value = null;
  testError.value = null;
  try {
    testResult.value = await adminApi.testSmtp(
      smtpTestBody(props.draft, props.values, testTo.value ?? ''),
    );
  } catch (error) {
    testError.value = errorText(error);
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div>
    <v-divider class="my-4" />
    <div class="text-subtitle-2 mb-2">Test</div>
    <v-row dense align="start">
      <v-col cols="12" md="8">
        <v-text-field
          v-model="testTo"
          label="Recipient"
          type="email"
          autocomplete="email"
          :placeholder="auth.me?.email ?? 'name@example.com'"
          :hint="testHint"
          persistent-hint
          clearable
          data-testid="smtp-test-to"
          @keydown.enter.prevent="sendTest"
        />
      </v-col>
      <v-col cols="12" md="4" class="d-flex align-center pt-md-3">
        <v-btn
          variant="tonal"
          color="primary"
          :prepend-icon="mdiEmailFastOutline"
          :loading="testing"
          :disabled="testBlocked !== null"
          :title="testBlocked ?? 'Send a test mail'"
          data-testid="smtp-test-send"
          @click="sendTest"
        >
          Send test mail
        </v-btn>
      </v-col>
    </v-row>
    <v-alert
      v-if="testView && testResult"
      :type="testResult.ok ? 'success' : 'error'"
      :title="testView.title"
      variant="tonal"
      density="compact"
      class="mt-3"
      closable
      data-testid="smtp-test-result"
      @click:close="testResult = null"
    >
      <div>{{ testView.text }}</div>
      <div v-if="testResult.response" class="text-caption mt-1">
        Server: <code class="smtp-response">{{ testResult.response }}</code>
      </div>
    </v-alert>
    <v-alert
      v-else-if="testError"
      type="error"
      variant="tonal"
      density="compact"
      class="mt-3"
      closable
      data-testid="smtp-test-result"
      @click:close="testError = null"
    >
      {{ testError }}
    </v-alert>
  </div>
</template>

<style scoped>
.smtp-response {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
