<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AvatarImage from '../components/AvatarImage.vue';
import ProfileAccount from '../components/profile/ProfileAccount.vue';
import ProfilePassword from '../components/profile/ProfilePassword.vue';
import ProfileSessions from '../components/profile/ProfileSessions.vue';
import ProfileTokens from '../components/profile/ProfileTokens.vue';
import ProfileTwoFactor from '../components/profile/ProfileTwoFactor.vue';
import ThemePicker from '../components/ThemePicker.vue';
import { useAuthStore } from '../stores/auth';

const TABS = ['account', 'security', 'tokens', 'appearance'] as const;
type Tab = (typeof TABS)[number];

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const tab = computed<Tab>({
  get: () => {
    const value = String(route.query['tab'] ?? 'account');
    return (TABS as readonly string[]).includes(value) ? (value as Tab) : 'account';
  },
  set: (value) => void router.replace({ query: { ...route.query, tab: value } }),
});

const isUser = computed(() => auth.me?.kind === 'user');
const viaSession = computed(() => auth.me?.via !== 'token');
const displayName = computed(() => auth.me?.name || auth.me?.email || 'User');
</script>

<template>
  <v-container style="max-width: 960px">
    <v-alert v-if="!isUser" type="info" variant="tonal">
      You are signed in with the board token, which has no user profile. Sign in with a user account
      to manage a profile.
    </v-alert>
    <template v-else-if="auth.me">
      <div class="d-flex align-center ga-4 mb-4">
        <AvatarImage
          :name="displayName"
          :color-key="auth.me.id ?? undefined"
          :src="auth.me.avatarUrl ?? null"
          :size="56"
        />
        <div>
          <h1 class="text-h5 mb-1">{{ displayName }}</h1>
          <div class="text-body-2 text-medium-emphasis">
            {{ auth.me.email }} · <span class="text-capitalize">{{ auth.me.role }}</span>
          </div>
        </div>
      </div>
      <v-tabs v-model="tab" class="mb-4">
        <v-tab value="account">Account</v-tab>
        <v-tab value="security">Security</v-tab>
        <v-tab value="tokens">API tokens</v-tab>
        <v-tab value="appearance">Appearance</v-tab>
      </v-tabs>
      <v-tabs-window v-model="tab">
        <v-tabs-window-item value="account">
          <ProfileAccount />
        </v-tabs-window-item>
        <v-tabs-window-item value="security">
          <div v-if="viaSession" class="d-flex flex-column ga-4">
            <ProfilePassword />
            <ProfileTwoFactor />
            <ProfileSessions />
          </div>
          <v-alert v-else type="info" variant="tonal">
            You are using an API token. Password, two-factor authentication and sessions can only be
            changed when you sign in with your password.
          </v-alert>
        </v-tabs-window-item>
        <v-tabs-window-item value="tokens">
          <ProfileTokens />
        </v-tabs-window-item>
        <v-tabs-window-item value="appearance">
          <v-card title="Appearance" subtitle="Saved to your profile and used on every device">
            <v-card-text>
              <ThemePicker />
            </v-card-text>
          </v-card>
        </v-tabs-window-item>
      </v-tabs-window>
    </template>
  </v-container>
</template>
