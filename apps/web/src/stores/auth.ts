import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { ApiError, AuthError, api, tokenStore } from '../api/client';
import type { MfaPolicy } from '../api/profile';
import type { ThemeLayer } from '../theme/resolve';
import { useThemeStore } from './theme';

export interface Me {
  kind: 'user' | 'board';
  id: string | null;
  email?: string;
  name?: string;
  role: string;
  twoFactorEnabled?: boolean;
  mfaRequired: boolean;
  mfaPolicy?: MfaPolicy;
  /** How this request was authenticated: the session cookie or a personal API token. */
  via?: 'session' | 'token';
  avatarUrl?: string | null;
  createdAt?: string;
  /** The user's stored theme layer; absent for the board token. */
  preferences?: { theme?: ThemeLayer };
}

export type SignInResult = 'ok' | 'mfa' | 'invalid' | 'limited';

const post = <T>(path: string, body: object = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** Signed in as a user: the profile theme applies and new choices are saved to it. */
function syncTheme(me: Me | null): void {
  const theme = useThemeStore();
  if (me?.kind !== 'user') {
    theme.setPersister(null);
    theme.applyPreferences({ theme: {} });
    return;
  }
  theme.applyPreferences({ theme: me.preferences?.theme ?? {} });
  theme.setPersister((choice) =>
    api('/me', { method: 'PATCH', body: JSON.stringify({ preferences: { theme: choice } }) }),
  );
}

export const useAuthStore = defineStore('auth', () => {
  const me = ref<Me | null>(null);
  const loaded = ref(false);
  const names = ref<Record<string, string>>({});
  const signedIn = computed(() => me.value !== null && !me.value.mfaRequired);

  async function load(): Promise<Me | null> {
    try {
      me.value = await api<Me>('/me');
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      me.value = null;
    }
    syncTheme(me.value);
    loaded.value = true;
    return me.value;
  }

  async function loadNames(): Promise<void> {
    const page = await api<{ items: { id: string; name: string }[] }>('/users/names');
    names.value = Object.fromEntries(page.items.map((user) => [user.id, user.name]));
  }

  async function settle<T>(call: Promise<T>): Promise<SignInResult | T> {
    try {
      return await call;
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) return 'limited';
      if (error instanceof ApiError || error instanceof AuthError) return 'invalid';
      throw error;
    }
  }

  async function signIn(email: string, password: string): Promise<SignInResult> {
    tokenStore.clear();
    const result = await settle(
      post<{ twoFactorRedirect?: boolean }>('/auth/sign-in/email', { email, password }),
    );
    if (typeof result === 'string') return result;
    if (result.twoFactorRedirect) return 'mfa';
    await load();
    return 'ok';
  }

  async function verify(code: string, recovery: boolean): Promise<SignInResult> {
    const path = recovery ? '/auth/two-factor/verify-backup-code' : '/auth/two-factor/verify-totp';
    const result = await settle(post<unknown>(path, { code: code.trim() }));
    if (result === 'invalid' || result === 'limited') return result;
    await load();
    return 'ok';
  }

  /** Apply a change the profile page has already saved, without reloading /me. */
  function patchMe(change: Partial<Pick<Me, 'name' | 'avatarUrl'>>): void {
    if (me.value) me.value = { ...me.value, ...change };
    if (me.value?.id && change.name !== undefined) {
      names.value = { ...names.value, [me.value.id]: change.name };
    }
  }

  async function signOut(): Promise<void> {
    tokenStore.clear();
    await post('/auth/sign-out');
    me.value = null;
    syncTheme(null);
  }

  return { me, loaded, names, signedIn, load, loadNames, signIn, verify, signOut, patchMe };
});
