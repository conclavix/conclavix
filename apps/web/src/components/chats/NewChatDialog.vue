<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { describeError } from '../../issues';
import { useChatsStore } from '../../stores/chats';
import { useProjectsStore } from '../../stores/projects';

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ created: [id: string] }>();

const chats = useChatsStore();
const projects = useProjectsStore();
const title = ref('');
const projectId = ref<string | null>(null);
const error = ref('');
const saving = ref(false);

const projectItems = computed(() =>
  projects.active.map((project) => ({
    title: `${project.key} · ${project.name}`,
    value: project.id,
  })),
);

watch(open, (isOpen) => {
  if (!isOpen) return;
  title.value = '';
  projectId.value = null;
  error.value = '';
  void projects.ensureLoaded().catch(() => undefined);
});

async function submit(): Promise<void> {
  if (!title.value.trim()) {
    error.value = 'Give the chat a title.';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    const chat = await chats.create(title.value.trim(), projectId.value);
    open.value = false;
    emit('created', chat.id);
  } catch (cause) {
    error.value = describeError(cause);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="560">
    <v-card title="New chat with the lead" data-test="new-chat-dialog">
      <v-card-text class="d-flex flex-column ga-2">
        <v-text-field
          v-model="title"
          label="Topic"
          hint="What you want to plan, e.g. 'Customer portal'"
          persistent-hint
          autofocus
          @keydown.enter="submit"
        />
        <v-select
          v-model="projectId"
          :items="projectItems"
          label="About an existing project (optional)"
          hint="The lead can then read its code and project memory"
          persistent-hint
          clearable
        />
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="open = false">Cancel</v-btn>
        <v-btn color="primary" :loading="saving" data-test="create-chat" @click="submit">
          Start chat
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
