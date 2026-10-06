import { describe, expect, it } from 'vitest';
import {
  describeUserAgent,
  mfaDisableBlockedReason,
  mfaRequiredFor,
  passwordStrength,
  totpSecret,
} from '../src/api/profile';
import { ADMIN_ROLES, visibleMenuItems, type UserMenuItem } from '../src/user-menu';

describe('profile helpers', () => {
  it('mirrors the server MFA policy per role', () => {
    expect(mfaRequiredFor('optional', 'owner')).toBe(false);
    expect(mfaRequiredFor('required', 'viewer')).toBe(true);
    expect(mfaRequiredFor('required_for_admins', 'admin')).toBe(true);
    expect(mfaRequiredFor('required_for_admins', 'member')).toBe(false);
    expect(mfaRequiredFor(undefined, 'owner')).toBe(false);
  });

  it('explains why 2FA cannot be turned off, and only when it cannot', () => {
    expect(mfaDisableBlockedReason('optional', 'owner')).toBeNull();
    expect(mfaDisableBlockedReason('required_for_admins', 'member')).toBeNull();
    expect(mfaDisableBlockedReason('required_for_admins', 'owner')).toMatch(
      /owners and admins, and your role is owner/,
    );
    expect(mfaDisableBlockedReason('required', 'member')).toMatch(/every account/);
  });

  it('rates passwords: too short, weak, and strong', () => {
    expect(passwordStrength('short')).toMatchObject({ score: 0, label: 'Too short' });
    expect(passwordStrength('aaaaaaaaaaaa').score).toBe(1);
    expect(passwordStrength('password1234').color).toBe('error');
    expect(passwordStrength('Correct-Horse-Battery-Staple-42')).toMatchObject({
      score: 4,
      label: 'Strong',
    });
    expect(passwordStrength('correct horse battery').score).toBeGreaterThanOrEqual(2);
  });

  it('reads the secret from an otpauth URI and tolerates garbage', () => {
    expect(totpSecret('otpauth://totp/Conclavix:a%40b.c?secret=JBSWY3DP&issuer=Conclavix')).toBe(
      'JBSWY3DP',
    );
    expect(totpSecret('not a uri')).toBe('');
  });

  it('describes user agents briefly', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      ),
    ).toBe('Chrome on Linux');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/130.0')).toBe(
      'Firefox on Windows',
    );
    expect(describeUserAgent('curl/8.5.0')).toBe('curl');
    expect(describeUserAgent(null)).toBe('Unknown device');
  });

  it('shows admin menu entries only to the roles they name', () => {
    const items: UserMenuItem[] = [
      { key: 'users', title: 'Users', icon: 'i', to: '/admin/users', roles: ADMIN_ROLES },
      { key: 'help', title: 'Help', icon: 'i', to: '/help' },
    ];
    expect(visibleMenuItems(items, 'admin').map((item) => item.key)).toEqual(['users', 'help']);
    expect(visibleMenuItems(items, 'member').map((item) => item.key)).toEqual(['help']);
    expect(visibleMenuItems(items, undefined).map((item) => item.key)).toEqual(['help']);
  });
});
