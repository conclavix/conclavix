import { describe, expect, it } from 'vitest';
import type { SettingsValues } from '../src/admin/api';
import {
  groupPatch,
  isDirty,
  normalizeModels,
  resetPatch,
  revertGroup,
  toDraft,
  validateGroup,
} from '../src/admin/settings-form';

const values = (): SettingsValues => ({
  instanceName: 'Conclavix',
  mfaPolicy: 'required_for_admins',
  models: ['opus', 'sonnet'],
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'mailer',
    from: 'board@example.com',
    passSet: true,
  },
});

describe('settings form', () => {
  it('starts clean and never puts the stored password into the draft', () => {
    const draft = toDraft(values());
    expect(draft.smtp.pass).toBe('');
    expect(draft.smtp.clearPass).toBe(false);
    for (const group of ['instanceName', 'mfaPolicy', 'models', 'smtp'] as const) {
      expect(isDirty(group, draft, values())).toBe(false);
    }
  });

  it('sends only the changed group and trims text', () => {
    const draft = toDraft(values());
    draft.instanceName = '  Board  ';
    draft.mfaPolicy = 'required';
    expect(groupPatch('instanceName', draft, values())).toEqual({ instanceName: 'Board' });
    expect(groupPatch('mfaPolicy', draft, values())).toEqual({ mfaPolicy: 'required' });
    expect(groupPatch('models', draft, values())).toBeUndefined();
    draft.instanceName = 'Conclavix ';
    expect(isDirty('instanceName', draft, values())).toBe(false);
  });

  it('diffs the model list after normalising it', () => {
    const draft = toDraft(values());
    draft.models = [' opus', 'sonnet', 'opus', ''];
    expect(isDirty('models', draft, values())).toBe(false);
    draft.models = ['sonnet', 'opus'];
    expect(groupPatch('models', draft, values())).toEqual({ models: ['sonnet', 'opus'] });
    expect(normalizeModels(['a ', ' a', 'b'])).toEqual(['a', 'b']);
  });

  it('sends only changed SMTP fields and a port as a number', () => {
    const draft = toDraft(values());
    draft.smtp.port = '2525';
    draft.smtp.secure = true;
    expect(groupPatch('smtp', draft, values())).toEqual({ smtp: { port: 2525, secure: true } });
  });

  it('keeps the SMTP password when the field stays empty', () => {
    const draft = toDraft(values());
    draft.smtp.host = 'smtp.other.test';
    expect(groupPatch('smtp', draft, values())).toEqual({ smtp: { host: 'smtp.other.test' } });
  });

  it('sends a typed password and nulls it only on an explicit clear', () => {
    const draft = toDraft(values());
    draft.smtp.pass = 'new secret';
    expect(groupPatch('smtp', draft, values())).toEqual({ smtp: { pass: 'new secret' } });
    draft.smtp.clearPass = true;
    expect(groupPatch('smtp', draft, values())).toEqual({ smtp: { pass: null } });
    // Nothing to clear: no request.
    expect(
      groupPatch('smtp', draft, { ...values(), smtp: { ...values().smtp, passSet: false } }),
    ).toBeUndefined();
  });

  it('resets a group to the environment default with null', () => {
    expect(resetPatch('smtp')).toEqual({ smtp: null });
    expect(resetPatch('instanceName')).toEqual({ instanceName: null });
  });

  it('reverts one group and keeps unsaved edits of the others', () => {
    const draft = toDraft(values());
    draft.instanceName = 'Edited';
    draft.smtp.pass = 'typed';
    const fresh = { ...values(), instanceName: 'Saved' };
    const next = revertGroup('instanceName', draft, fresh);
    expect(next.instanceName).toBe('Saved');
    expect(next.smtp.pass).toBe('typed');
    expect(isDirty('instanceName', next, fresh)).toBe(false);
  });

  it('validates the limits the API enforces', () => {
    const draft = toDraft(values());
    draft.instanceName = ' ';
    draft.models = [];
    draft.smtp.port = '70000';
    draft.smtp.host = '';
    draft.smtp.from = 'ab';
    expect(validateGroup('instanceName', draft, values())).toHaveProperty('instanceName');
    expect(validateGroup('models', draft, values())).toHaveProperty('models');
    const smtp = validateGroup('smtp', draft, values());
    expect(Object.keys(smtp).sort()).toEqual(['from', 'host', 'port']);
    expect(smtp['host']).toContain('Reset to default');
    // An unset host may stay empty.
    const unset = { ...values(), smtp: { ...values().smtp, host: null } };
    expect(validateGroup('smtp', toDraft(unset), unset)).toEqual({});
  });
});
