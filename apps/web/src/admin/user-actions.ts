import type { UserAction } from './gating';

export interface ActionDialog {
  title: (who: string) => string;
  confirm: string;
  color: string;
  /** What confirming does, shown as bullets so nobody confirms blind. */
  consequences: string[];
}

export const ACTION_DIALOGS: Record<UserAction, ActionDialog> = {
  role: {
    title: (who) => `Change the role of ${who}`,
    confirm: 'Change role',
    color: 'primary',
    consequences: [
      'The new permissions apply to the next request; open live views are re-checked at once.',
      'Only an owner can grant the owner role.',
    ],
  },
  ban: {
    title: (who) => `Ban ${who}?`,
    confirm: 'Ban user',
    color: 'error',
    consequences: [
      'All of their sessions end and their personal API tokens are revoked now.',
      'They cannot sign in until an admin unbans them.',
      'Their issues, comments and documents stay.',
    ],
  },
  unban: {
    title: (who) => `Unban ${who}?`,
    confirm: 'Unban user',
    color: 'primary',
    consequences: [
      'They can sign in again with their password.',
      'Revoked API tokens stay revoked; they create new ones themselves.',
    ],
  },
  resetPassword: {
    title: (who) => `Reset the password of ${who}?`,
    confirm: 'Reset password',
    color: 'warning',
    consequences: [
      'Their current password stops working; all sessions end and API tokens are revoked.',
      'Without a password below they get a reset e-mail if SMTP is set up, otherwise you see a temporary password once.',
    ],
  },
  resetMfa: {
    title: (who) => `Reset two-factor authentication of ${who}?`,
    confirm: 'Reset 2FA',
    color: 'warning',
    consequences: [
      'Their authenticator secret and recovery codes are removed.',
      'If the MFA policy requires it, they have to enrol again at their next sign-in.',
    ],
  },
  delete: {
    title: (who) => `Delete ${who}?`,
    confirm: 'Delete user',
    color: 'error',
    consequences: [
      'The account, its sessions, API tokens and 2FA secret are removed for good.',
      'This cannot be undone. Ban instead if you might need the account again.',
      'Issues, comments and audit entries they authored stay.',
    ],
  },
};

/** Password rule shared by the create and reset dialogs; empty means "generate one". */
export const optionalPassword = (value: string): true | string =>
  value === '' || (value.length >= 12 && value.length <= 128) || '12 to 128 characters';
