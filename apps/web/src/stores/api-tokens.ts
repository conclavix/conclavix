import { defineStore } from 'pinia';
import { ref } from 'vue';
import { apiTokenSchema, profileApi, type ApiToken, type CreatedApiToken } from '../api/profile';
import { useAuthStore } from './auth';
import { forgetOnUserChange } from './profile';

/** The signed-in user's personal API tokens; secrets are never kept here. */
export const useApiTokensStore = defineStore('apiTokens', () => {
  const auth = useAuthStore();
  const tokens = ref<ApiToken[]>([]);

  forgetOnUserChange(auth, () => {
    tokens.value = [];
  });

  async function load(): Promise<void> {
    const user = auth.me?.id;
    const list = await profileApi.listTokens();
    // A response for a user who has signed out since must not refill the list.
    if (auth.me?.id === user) tokens.value = list;
  }

  /** Create a token; the secret is only in the returned value and is never stored here. */
  async function create(name: string, expiresInDays?: number): Promise<CreatedApiToken> {
    const user = auth.me?.id;
    const created = await profileApi.createToken(name.trim(), expiresInDays);
    if (auth.me?.id === user) {
      const summary = apiTokenSchema.parse(created);
      tokens.value = [summary, ...tokens.value.filter((item) => item.id !== summary.id)];
    }
    return created;
  }

  async function revoke(id: string): Promise<void> {
    await profileApi.revokeToken(id);
    tokens.value = tokens.value.filter((item) => item.id !== id);
  }

  return { tokens, load, create, revoke };
});
