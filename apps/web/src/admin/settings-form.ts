import type {
  MfaPolicy,
  SettingGroup,
  SettingsPatch,
  SettingsValues,
  SmtpPatch,
  SmtpValues,
} from './api';

export interface SmtpDraft {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  from: string;
  /** A new password; empty keeps the stored one. */
  pass: string;
  /** Explicitly remove the stored password. */
  clearPass: boolean;
}

/** Editable copy of the settings values; text fields hold strings, never null. */
export interface SettingsDraft {
  instanceName: string;
  mfaPolicy: MfaPolicy;
  models: string[];
  smtp: SmtpDraft;
}

export function toDraft(values: SettingsValues): SettingsDraft {
  return {
    instanceName: values.instanceName,
    mfaPolicy: values.mfaPolicy,
    models: [...values.models],
    smtp: smtpDraft(values.smtp),
  };
}

const smtpDraft = (smtp: SmtpValues): SmtpDraft => ({
  host: smtp.host ?? '',
  port: String(smtp.port),
  secure: smtp.secure,
  user: smtp.user ?? '',
  from: smtp.from ?? '',
  pass: '',
  clearPass: false,
});

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** Model names as the API stores them: trimmed, without blanks or duplicates, in order. */
export const normalizeModels = (models: readonly string[]): string[] => [
  ...new Set(models.map((model) => model.trim()).filter(Boolean)),
];

/** Changed SMTP fields only; the password is sent only when typed or explicitly cleared. */
function smtpPatch(draft: SmtpDraft, values: SmtpValues): SmtpPatch | undefined {
  const patch: SmtpPatch = {};
  const host = draft.host.trim();
  if (host !== (values.host ?? '')) patch.host = host;
  const port = Number(draft.port);
  if (port !== values.port) patch.port = port;
  if (draft.secure !== values.secure) patch.secure = draft.secure;
  if (draft.user !== (values.user ?? '')) patch.user = draft.user;
  const from = draft.from.trim();
  if (from !== (values.from ?? '')) patch.from = from;
  if (draft.clearPass) {
    if (values.passSet) patch.pass = null;
  } else if (draft.pass !== '') {
    patch.pass = draft.pass;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** The PATCH body for one group, or undefined when the draft matches the stored value. */
export function groupPatch(
  group: SettingGroup,
  draft: SettingsDraft,
  values: SettingsValues,
): SettingsPatch | undefined {
  switch (group) {
    case 'instanceName': {
      const name = draft.instanceName.trim();
      return name === values.instanceName ? undefined : { instanceName: name };
    }
    case 'mfaPolicy':
      return draft.mfaPolicy === values.mfaPolicy ? undefined : { mfaPolicy: draft.mfaPolicy };
    case 'models': {
      const models = normalizeModels(draft.models);
      return sameList(models, values.models) ? undefined : { models };
    }
    case 'smtp': {
      const smtp = smtpPatch(draft.smtp, values.smtp);
      return smtp ? { smtp } : undefined;
    }
  }
}

export const isDirty = (
  group: SettingGroup,
  draft: SettingsDraft,
  values: SettingsValues,
): boolean => groupPatch(group, draft, values) !== undefined;

/** A null value removes the stored override so the environment default applies again. */
export const resetPatch = (group: SettingGroup): SettingsPatch => ({ [group]: null });

/** Put one group of the draft back to the stored values, leaving other groups' edits alone. */
export function revertGroup(
  group: SettingGroup,
  draft: SettingsDraft,
  values: SettingsValues,
): SettingsDraft {
  const fresh = toDraft(values);
  return { ...draft, [group]: fresh[group] };
}

const BLANK = 'Cannot be emptied; use "Reset to default" instead';

/** Client-side checks matching the API's limits; returns a message per invalid field. */
export function validateGroup(
  group: SettingGroup,
  draft: SettingsDraft,
  values: SettingsValues,
): Record<string, string> {
  if (group === 'instanceName') return validateName(draft.instanceName);
  if (group === 'models') return validateModels(draft.models);
  if (group === 'smtp') return validateSmtp(draft.smtp, values.smtp);
  return {};
}

function validateName(value: string): Record<string, string> {
  const name = value.trim();
  if (!name) return { instanceName: 'Required' };
  return name.length > 80 ? { instanceName: 'At most 80 characters' } : {};
}

function validateModels(value: readonly string[]): Record<string, string> {
  const models = normalizeModels(value);
  if (models.length === 0) return { models: 'Keep at least one model' };
  if (models.length > 100) return { models: 'At most 100 models' };
  return models.some((model) => model.length > 120)
    ? { models: 'Model names have at most 120 characters' }
    : {};
}

/** The API cannot store an empty host or sender; only "reset to default" drops them. */
function required(draft: string, stored: string | null, max: number, min = 1): string | null {
  const value = draft.trim();
  if (value === '') return (stored ?? '') !== '' ? BLANK : null;
  if (value.length < min || value.length > max) return `${min} to ${max} characters`;
  return null;
}

function validateSmtp(smtp: SmtpDraft, stored: SmtpValues): Record<string, string> {
  const port = Number(smtp.port);
  const checks: [string, string | null][] = [
    ['host', required(smtp.host, stored.host, 253)],
    ['from', required(smtp.from, stored.from, 254, 3)],
    ['port', Number.isInteger(port) && port >= 1 && port <= 65535 ? null : '1 to 65535'],
    ['user', smtp.user.length > 254 ? 'At most 254 characters' : null],
    ['pass', smtp.pass.length > 1024 ? 'At most 1024 characters' : null],
  ];
  return Object.fromEntries(checks.filter((check): check is [string, string] => !!check[1]));
}
