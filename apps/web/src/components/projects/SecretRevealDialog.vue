<script setup lang="ts">
import { ref, watch } from 'vue';
import { secretsApi, type Secret } from '../../api/secrets';
import { secretErrorText } from '../../secrets/form';

const props = defineProps<{ projectId: string; secret: Secret | null }>();
const open = defineModel<boolean>({ required: true });

const password = ref('');
const revealBusy = ref(false);
const revealError = ref('');
const revealed = ref<string | null>(null);

async function reveal(): Promise<void> {
  const secret = props.secret;
  if (!secret || !password.value) return;
  revealBusy.value = true;
  revealError.value = '';
  try {
    revealed.value = (await secretsApi.reveal(props.projectId, secret.id, password.value)).value;
  } catch (cause) {
    revealError.value = secretErrorText(cause);
  } finally {
    password.value = '';
    revealBusy.value = false;
  }
}

// The value stays in memory only while the dialog is open.
watch(open, () => {
  revealed.value = null;
  password.value = '';
  revealError.value = '';
});
</script>

<template>
  <v-dialog v-model="open" max-width="520">
    <v-card :title="`Show ${secret?.envName ?? ''}`">
      <v-card-text>
        <template v-if="revealed === null">
          <p class="text-body-2 mb-3">
            Enter your password to show the value. Every reveal is written to the audit log.
          </p>
          <v-text-field
            v-model="password"
            label="Your password"
            type="password"
            autocomplete="current-password"
            data-test="secret-reveal-password"
            @keydown.enter="reveal"
          />
        </template>
        <v-textarea
          v-else
          :model-value="revealed"
          label="Value"
          readonly
          auto-grow
          rows="1"
          class="secret-value"
          data-test="secret-revealed"
        />
        <v-alert v-if="revealError" type="error" variant="tonal" density="compact" class="mt-2">
          {{ revealError }}
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="open = false">Close</v-btn>
        <v-btn
          v-if="revealed === null"
          color="primary"
          variant="flat"
          :loading="revealBusy"
          :disabled="!password"
          data-test="secret-reveal-confirm"
          @click="reveal"
        >
          Show
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.secret-value :deep(textarea) {
  font-family: monospace;
}
</style>
