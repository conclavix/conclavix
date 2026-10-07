<script setup lang="ts">
import { mdiChatProcessingOutline, mdiPlus } from '@mdi/js';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { CHAT_STATUS_COLORS, canChat } from '../chats/logic';
import NewChatDialog from '../components/chats/NewChatDialog.vue';
import { describeError } from '../issues';
import { useAuthStore } from '../stores/auth';
import { useChatsStore } from '../stores/chats';
import { useLiveStore } from '../stores/live';

const chats = useChatsStore();
const live = useLiveStore();
const auth = useAuthStore();
const router = useRouter();
const error = ref('');
const creating = ref(false);
const showArchived = ref(false);

const mayChat = computed(() => canChat(auth.me?.role));
const visible = computed(() =>
  chats.sorted.filter((chat) => showArchived.value || chat.status !== 'archived'),
);
const leadName = (id: string): string => live.state.agents[id]?.name ?? 'the lead';

const stop = live.subscribe((type, data) => chats.applyStream(type, data));
onBeforeUnmount(stop);
onMounted(() => chats.load().catch((cause) => (error.value = describeError(cause))));

async function created(id: string): Promise<void> {
  await router.push({ name: 'chat', params: { chatId: id } });
}
</script>

<template>
  <v-container class="pa-3" style="max-width: 1100px">
    <div class="d-flex align-center flex-wrap ga-2 mb-3">
      <span class="text-h6">CEO Chat</span>
      <span class="text-body-2 text-medium-emphasis">
        Plan with the lead; an approved plan becomes a project and its planning issue.
      </span>
      <v-spacer />
      <v-switch v-model="showArchived" label="Show archived" hide-details density="compact" />
      <v-btn
        v-if="mayChat"
        color="primary"
        :prepend-icon="mdiPlus"
        data-test="new-chat"
        @click="creating = true"
      >
        New chat
      </v-btn>
    </div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-2">{{ error }}</v-alert>
    <v-alert v-if="!mayChat" type="info" variant="tonal" density="compact" class="mb-2">
      You can read the chats; admins and owners plan with the lead.
    </v-alert>
    <v-card>
      <v-list lines="two">
        <v-list-item
          v-for="chat in visible"
          :key="chat.id"
          :to="{ name: 'chat', params: { chatId: chat.id } }"
          :prepend-icon="mdiChatProcessingOutline"
          :data-chat="chat.id"
        >
          <template #title>
            <span class="font-weight-medium">{{ chat.title }}</span>
            <v-chip :color="CHAT_STATUS_COLORS[chat.status]" size="small" class="ml-2">
              {{ chat.status }}
            </v-chip>
            <v-chip v-if="chat.activeRunId" color="primary" size="small" class="ml-1">
              answering
            </v-chip>
          </template>
          <v-list-item-subtitle>
            with {{ leadName(chat.leadAgentId) }}
            <template v-if="chat.plan"> · plan revision {{ chat.plan.revision }}</template>
            · {{ new Date(chat.updatedAt).toLocaleString() }}
          </v-list-item-subtitle>
        </v-list-item>
        <v-list-item
          v-if="chats.loaded && visible.length === 0"
          subtitle="No chats yet. Start one to plan a project with the lead."
        />
      </v-list>
    </v-card>
    <NewChatDialog v-model="creating" @created="created" />
  </v-container>
</template>
