<script setup lang="ts">
import { mdiCheckDecagramOutline, mdiFileDocumentOutline } from '@mdi/js';
import { computed, ref } from 'vue';
import type { Chat } from '../../chats/api';
import { approveBlock } from '../../chats/logic';
import { useAuthStore } from '../../stores/auth';
import MarkdownBlock from '../MarkdownBlock.vue';

const props = defineProps<{ chat: Chat; leadName: string; approving: boolean }>();
const emit = defineEmits<{ approve: [revision: number] }>();

const auth = useAuthStore();
const confirming = ref(false);

const blocked = computed(() => approveBlock(props.chat, auth.me?.role));
const approver = computed(() => {
  const id = props.chat.approval?.userId;
  return id ? (auth.names[id] ?? 'a board member') : 'the board';
});
const created = computed(() => props.chat.created);

function confirm(): void {
  if (!props.chat.plan) return;
  confirming.value = false;
  emit('approve', props.chat.plan.revision);
}
</script>

<template>
  <v-card class="chat-plan" data-test="chat-plan">
    <v-card-title class="d-flex align-center ga-2">
      <v-icon :icon="mdiFileDocumentOutline" size="20" />
      Plan
      <v-chip v-if="chat.plan" size="small" data-test="plan-revision">
        revision {{ chat.plan.revision }}
      </v-chip>
      <v-spacer />
    </v-card-title>
    <v-card-subtitle v-if="chat.plan">
      updated {{ new Date(chat.plan.updatedAt).toLocaleString() }}
    </v-card-subtitle>
    <v-card-text class="chat-plan__body">
      <MarkdownBlock v-if="chat.plan" :source="chat.plan.markdown" />
      <div v-else class="text-medium-emphasis">
        {{ leadName }} writes the plan here as the discussion goes on: goal, scope, acceptance
        criteria and work packages.
      </div>
    </v-card-text>
    <v-divider />
    <v-card-text class="d-flex flex-column ga-2">
      <template v-if="chat.approval">
        <v-alert type="success" variant="tonal" density="compact" data-test="approval">
          Revision {{ chat.approval.planRevision }} approved by {{ approver }} on
          {{ new Date(chat.approval.at).toLocaleString() }}.
        </v-alert>
        <div v-if="created?.projectKey || created?.issueKey" class="d-flex flex-wrap ga-2">
          <v-chip
            v-if="created?.projectKey"
            :to="{ name: 'project', params: { projectKey: created.projectKey } }"
            color="primary"
            variant="tonal"
            data-test="created-project"
          >
            Project {{ created.projectKey }}
          </v-chip>
          <v-chip
            v-if="created?.issueKey"
            :to="{ name: 'issue', params: { issueKey: created.issueKey } }"
            color="primary"
            variant="tonal"
            data-test="created-issue"
          >
            Planning issue {{ created.issueKey }}
          </v-chip>
        </div>
        <div v-else class="text-body-2 text-medium-emphasis">
          {{ leadName }} creates the project and its planning issue next.
        </div>
      </template>
      <template v-else>
        <v-btn
          color="success"
          :prepend-icon="mdiCheckDecagramOutline"
          :disabled="blocked !== null"
          :loading="approving"
          data-test="approve-plan"
          @click="confirming = true"
        >
          Approve plan
        </v-btn>
        <div v-if="blocked" class="text-caption text-medium-emphasis">{{ blocked }}</div>
      </template>
    </v-card-text>
    <v-dialog v-model="confirming" max-width="480">
      <v-card title="Approve the plan?" data-test="approve-dialog">
        <v-card-text>
          This freezes revision {{ chat.plan?.revision }}. {{ leadName }} then creates the project
          (if the plan needs a new one) and the initial planning issue, once.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="confirming = false">Cancel</v-btn>
          <v-btn color="success" data-test="approve-confirm" @click="confirm">Approve</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped>
.chat-plan__body {
  max-height: calc(100vh - 360px);
  overflow-y: auto;
}
</style>
