<script setup lang="ts">
import { mdiDelete, mdiUpload } from '@mdi/js';
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  AVATAR_ACCEPT,
  avatarFileProblem,
  removeAvatar,
  uploadAvatar,
  type AvatarOwnerType,
} from '../api/avatars';
import AvatarImage from './AvatarImage.vue';

const props = withDefaults(
  defineProps<{
    ownerType: AvatarOwnerType;
    ownerId: string;
    name: string;
    avatarUrl: string | null;
    size?: number;
  }>(),
  { size: 96 },
);
const emit = defineEmits<{ changed: [avatarUrl: string | null] }>();

const input = ref<HTMLInputElement | null>(null);
const picked = ref<File | null>(null);
const preview = ref<string | null>(null);
const error = ref('');
const busy = ref(false);
const dragging = ref(false);

const canRemove = computed(() => props.avatarUrl !== null && picked.value === null);

function clearPick(): void {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = null;
  picked.value = null;
  if (input.value) input.value.value = '';
}

function pick(file: File | undefined): void {
  error.value = '';
  if (!file) return;
  const problem = avatarFileProblem(file);
  if (problem) {
    error.value = problem;
    return;
  }
  clearPick();
  picked.value = file;
  preview.value = URL.createObjectURL(file);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  pick(event.dataTransfer?.files[0]);
}

async function run(action: () => Promise<string | null>): Promise<void> {
  error.value = '';
  busy.value = true;
  try {
    const url = await action();
    clearPick();
    emit('changed', url);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

const save = (): Promise<void> =>
  run(async () => {
    if (!picked.value) return props.avatarUrl;
    return uploadAvatar(props.ownerType, props.ownerId, picked.value);
  });

const remove = (): Promise<void> =>
  run(async () => {
    await removeAvatar(props.ownerType, props.ownerId);
    return null;
  });

onBeforeUnmount(clearPick);
</script>

<template>
  <div class="d-flex align-center ga-4 flex-wrap">
    <div
      class="drop-zone rounded-circle"
      :class="{ 'drop-zone--active': dragging }"
      role="button"
      tabindex="0"
      aria-label="Choose avatar image"
      @click="input?.click()"
      @keydown.enter.prevent="input?.click()"
      @keydown.space.prevent="input?.click()"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <v-avatar v-if="preview" :size="size">
        <v-img :src="preview" :alt="`New avatar for ${name}`" cover />
      </v-avatar>
      <AvatarImage v-else :name="name" :color-key="ownerId" :src="avatarUrl" :size="size" />
    </div>
    <input
      ref="input"
      type="file"
      :accept="AVATAR_ACCEPT"
      class="d-none"
      data-testid="avatar-file"
      @change="pick(($event.target as HTMLInputElement).files?.[0])"
    />
    <div class="d-flex flex-column ga-2">
      <div class="text-caption text-medium-emphasis">
        PNG, JPEG, WebP, or GIF up to 5 MB. Drop a file or click the picture.
      </div>
      <div class="d-flex ga-2">
        <v-btn
          v-if="picked"
          :prepend-icon="mdiUpload"
          color="primary"
          :loading="busy"
          @click="save"
        >
          Upload
        </v-btn>
        <v-btn v-if="picked" variant="text" :disabled="busy" @click="clearPick">Cancel</v-btn>
        <v-btn
          v-if="canRemove"
          :prepend-icon="mdiDelete"
          variant="text"
          color="error"
          :loading="busy"
          @click="remove"
        >
          Remove
        </v-btn>
      </div>
      <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
    </div>
  </div>
</template>

<style scoped>
.drop-zone {
  cursor: pointer;
  outline: 2px dashed transparent;
  outline-offset: 4px;
}
.drop-zone--active,
.drop-zone:focus-visible {
  outline-color: rgb(var(--v-theme-primary));
}
</style>
