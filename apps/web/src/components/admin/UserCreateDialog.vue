<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { adminApi, type AdminUser, type PasswordDelivery, type Role } from '../../admin/api';
import { errorText } from '../../admin/gating';
import { optionalPassword } from '../../admin/user-actions';

const props = defineProps<{ roles: Role[]; ownerHint: boolean }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ created: [user: AdminUser, result: PasswordDelivery] }>();

const form = ref<{ validate: () => Promise<{ valid: boolean }> } | null>(null);
const draft = reactive({ name: '', email: '', role: 'member' as Role, password: '' });
const error = ref<string | null>(null);
const creating = ref(false);
const rules = {
  required: (value: string) => !!value.trim() || 'Required',
  email: (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) || 'Not an e-mail',
};

watch(open, (value) => {
  if (!value) return;
  Object.assign(draft, { name: '', email: '', role: 'member', password: '' });
  error.value = null;
});

async function create(): Promise<void> {
  if (creating.value || !(await form.value?.validate())?.valid) return;
  creating.value = true;
  error.value = null;
  try {
    const { user, ...result } = await adminApi.createUser({
      name: draft.name.trim(),
      email: draft.email.trim(),
      role: draft.role,
      ...(draft.password ? { password: draft.password } : {}),
    });
    draft.password = '';
    open.value = false;
    emit('created', user, result);
  } catch (cause) {
    error.value = errorText(cause);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="520" :persistent="creating">
    <v-card title="Add user">
      <v-form ref="form" @submit.prevent="create">
        <v-card-text>
          <v-text-field v-model="draft.name" label="Name" :rules="[rules.required]" />
          <v-text-field
            v-model="draft.email"
            label="E-mail"
            type="email"
            autocomplete="off"
            :rules="[rules.required, rules.email]"
          />
          <v-select
            v-model="draft.role"
            :items="props.roles"
            label="Role"
            :hint="ownerHint ? 'Only an owner can grant the owner role.' : ''"
            persistent-hint
          />
          <v-text-field
            v-model="draft.password"
            class="mt-2"
            type="password"
            label="Initial password (optional)"
            autocomplete="new-password"
            :rules="[optionalPassword]"
            hint="Leave empty: with SMTP set up the user gets an e-mail to set a password, otherwise you see a temporary password once."
            persistent-hint
          />
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">
            {{ error }}
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" :disabled="creating" @click="open = false">Cancel</v-btn>
          <v-btn type="submit" color="primary" variant="flat" :loading="creating">Add user</v-btn>
        </v-card-actions>
      </v-form>
    </v-card>
  </v-dialog>
</template>
