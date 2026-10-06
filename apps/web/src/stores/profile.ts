import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { ApiError, AuthError } from '../api/client';
import { profileApi, type AuthSession } from '../api/profile';
import { useAuthStore } from './auth';

/** better-auth answers 403 SESSION_NOT_FRESH when listing sessions with an old sign-in. */
export const SESSION_NOT_FRESH_MESSAGE =
  'For your security, the session list needs a recent sign-in. Sign out and sign in again to see it.';

/** Turn an API failure into text for the page; a wrong TOTP code arrives as 401. */
export function problemText(error: unknown, invalidCode = false): string {
  if (invalidCode && error instanceof AuthError) {
    return 'That code is not valid. Enter the current code from your authenticator app.';
  }
  if (error instanceof ApiError) {
    if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (error.code === 'SESSION_NOT_FRESH') return SESSION_NOT_FRESH_MESSAGE;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The current session first, then the newest sign-ins. */
export function currentFirst(list: readonly AuthSession[], current: string | null): AuthSession[] {
  return [...list].sort((a, b) => {
    if (a.id === current) return -1;
    if (b.id === current) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** Session tokens and API token names of one user must not survive a sign-out or user switch. */
export function forgetOnUserChange(
  auth: ReturnType<typeof useAuthStore>,
  forget: () => void,
): void {
  watch(() => auth.me?.id, forget);
}

/** The signed-in user's own account: name, password, 2FA and sessions. */
export const useProfileStore = defineStore('profile', () => {
  const auth = useAuthStore();
  const sessions = ref<AuthSession[]>([]);
  const currentSessionId = ref<string | null>(null);

  forgetOnUserChange(auth, () => {
    sessions.value = [];
    currentSessionId.value = null;
  });

  async function rename(name: string): Promise<void> {
    const saved = await profileApi.rename(name.trim());
    auth.patchMe({ name: saved.name });
  }

  async function loadSessions(): Promise<void> {
    const user = auth.me?.id;
    const [list, current] = await Promise.all([
      profileApi.listSessions(),
      profileApi.currentSessionId(),
    ]);
    // A response for a user who has signed out since must not refill the list.
    if (auth.me?.id !== user) return;
    currentSessionId.value = current;
    sessions.value = currentFirst(list, current);
  }

  async function revokeSession(session: AuthSession): Promise<void> {
    await profileApi.revokeSession(session.token);
    sessions.value = sessions.value.filter((item) => item.id !== session.id);
  }

  async function revokeOtherSessions(): Promise<void> {
    await profileApi.revokeOtherSessions();
    keepCurrentOnly();
  }

  function keepCurrentOnly(): void {
    sessions.value = sessions.value.filter((item) => item.id === currentSessionId.value);
  }

  /** better-auth replaced every session, this one included; the old list is wrong now. */
  function forgetSessions(err: unknown): void {
    sessions.value = [];
    currentSessionId.value = null;
    // eslint-disable-next-line no-console -- The password change itself succeeded.
    console.warn('profile: could not reload the sessions after the password change', err);
  }

  async function changePassword(
    currentPassword: string,
    newPassword: string,
    revokeOthers: boolean,
  ): Promise<void> {
    await profileApi.changePassword(currentPassword, newPassword, revokeOthers);
    if (revokeOthers) await loadSessions().catch(forgetSessions);
  }

  /** Confirm the TOTP enrolment and refresh /me so twoFactorEnabled is current. */
  async function confirmTwoFactor(code: string): Promise<void> {
    await profileApi.verifyTotp(code);
    await auth.load();
  }

  async function disableTwoFactor(password: string): Promise<void> {
    await profileApi.disableTwoFactor(password);
    await auth.load();
  }

  return {
    sessions,
    currentSessionId,
    rename,
    loadSessions,
    revokeSession,
    revokeOtherSessions,
    changePassword,
    enableTwoFactor: profileApi.enableTwoFactor,
    confirmTwoFactor,
    disableTwoFactor,
    generateBackupCodes: profileApi.generateBackupCodes,
  };
});
