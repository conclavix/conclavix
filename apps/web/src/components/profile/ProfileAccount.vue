<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useAuthStore } from '../../stores/auth';
import { problemText, useProfileStore } from '../../stores/profile';
import AvatarUpload from '../AvatarUpload.vue';

const auth = useAuthStore();
const profile = useProfileStore();

const name = ref(auth.me?.name ?? '');
const busy = ref(false);
const error = ref('');
const saved = ref(false);

watch(
  () => auth.me?.name,
  (value) => {
    if (!busy.value) name.value = value ?? '';
  },
);

const rules = [
  (value: string) => value.trim().length > 0 || 'Enter a name',
  (value: string) => value.trim().length <= 100 || 'At most 100 characters',
];
const dirty = computed(() => name.value.trim() !== (auth.me?.name ?? ''));
const valid = computed(() => rules.every((rule) => rule(name.value) === true));

async function save(): Promise<void> {
  if (!dirty.value || !valid.value || busy.value) return;
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    await profile.rename(name.value);
    name.value = auth.me?.name ?? name.value;
    saved.value = true;
  } catch (cause) {
    error.value = problemText(cause);
  } finally {
    busy.value = false;
  }
}

const memberSince = computed(() =>
  auth.me?.createdAt ? new Date(auth.me.createdAt).toLocaleDateString() : '',
);
</script>

<template>
  <div v-if="auth.me" class="d-flex flex-column ga-4">
    <v-card title="Account" subtitle="How you appear on the board">
      <v-card-text>
        <v-form @submit.prevent="save">
          <v-text-field
            v-model="name"
            label="Name"
            :rules="rules"
            autocomplete="name"
            maxlength="100"
            data-testid="profile-name"
            @update:model-value="saved = false"
          />
          <v-text-field
            :model-value="auth.me.email"
            label="E-mail"
            readonly
            variant="plain"
            persistent-hint
            hint="Your e-mail is your sign-in name and cannot be changed. Ask an owner or admin if you need a different address."
            class="mb-4"
          />
          <v-text-field
            :model-value="auth.me.role"
            label="Role"
            readonly
            variant="plain"
            persistent-hint
            :hint="`Roles are assigned by owners and admins.${memberSince ? ` Member since ${memberSince}.` : ''}`"
            class="mb-4"
          />
          <div class="d-flex align-center ga-3">
            <v-btn
              type="submit"
              color="primary"
              :loading="busy"
              :disabled="!dirty || !valid"
              data-testid="profile-save"
              >Save</v-btn
            >
            <span v-if="saved" class="text-success text-body-2" role="status">Saved</span>
          </div>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{
            error
          }}</v-alert>
        </v-form>
      </v-card-text>
    </v-card>

    <v-card title="Avatar" subtitle="Shown in the account menu of the app bar">
      <v-card-text>
        <AvatarUpload
          v-if="auth.me.id"
          owner-type="user"
          :owner-id="auth.me.id"
          :name="auth.me.name || auth.me.email || 'User'"
          :avatar-url="auth.me.avatarUrl ?? null"
          @changed="(avatarUrl) => auth.patchMe({ avatarUrl })"
        />
      </v-card-text>
    </v-card>
  </div>
</template>
