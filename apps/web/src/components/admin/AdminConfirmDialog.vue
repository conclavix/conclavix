<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    confirmText: string;
    /** What happens when the admin confirms; each entry is shown as a bullet. */
    consequences?: string[];
    color?: string;
    loading?: boolean;
    error?: string | null;
    disabled?: boolean;
  }>(),
  { consequences: () => [], color: 'primary', loading: false, error: null, disabled: false },
);
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ confirm: [] }>();
</script>

<template>
  <v-dialog v-model="open" max-width="520" :persistent="loading">
    <v-card :title="title">
      <v-card-text>
        <slot />
        <ul v-if="consequences.length" class="admin-confirm__list text-body-2">
          <li v-for="line in consequences" :key="line">{{ line }}</li>
        </ul>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">
          {{ error }}
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="loading" @click="open = false">Cancel</v-btn>
        <v-btn
          :color="color"
          variant="flat"
          :loading="loading"
          :disabled="disabled"
          @click="emit('confirm')"
        >
          {{ confirmText }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.admin-confirm__list {
  padding-left: 20px;
  margin-top: 8px;
}
</style>
