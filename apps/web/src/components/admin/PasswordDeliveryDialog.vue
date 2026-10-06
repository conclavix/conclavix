<script setup lang="ts">
import type { PasswordDelivery } from '../../admin/api';
import OneTimeSecret from './OneTimeSecret.vue';

/** Tells the admin how a new or reset password reaches the user; a temporary one shows once. */
defineProps<{ title: string; email: string; result: PasswordDelivery }>();
const emit = defineEmits<{ done: [] }>();
</script>

<template>
  <v-dialog :model-value="true" max-width="520" persistent>
    <v-card :title="title">
      <v-card-text>
        <template v-if="result.delivery === 'email'">
          An e-mail with a link to set a password was sent to {{ email }}.
        </template>
        <template v-else-if="result.delivery === 'manual'">
          The password you entered is set. Hand it to {{ email }} over a secure channel.
        </template>
        <template v-else>
          <v-alert
            v-if="result.reason === 'mail_failed'"
            type="warning"
            variant="tonal"
            density="compact"
            class="mb-3"
          >
            The reset e-mail could not be sent, so a temporary password was set instead.
          </v-alert>
          <p class="mb-3">
            No e-mail was sent. Give this temporary password to {{ email }} over a secure channel.
            It is shown only now.
          </p>
          <OneTimeSecret :secret="result.temporaryPassword" />
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn color="primary" variant="flat" @click="emit('done')">Done</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
