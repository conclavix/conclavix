import { secretEnvNameProblem, SECRET_LIMITS } from '@conclavix/core';
import { ApiError } from '../api/client';
import type { Secret, SecretInput } from '../api/secrets';

export interface SecretDraft {
  name: string;
  envName: string;
  value: string;
  agentIds: string[];
}

export const emptySecretDraft = (): SecretDraft => ({
  name: '',
  envName: '',
  value: '',
  agentIds: [],
});

export const draftOf = (secret: Secret): SecretDraft => ({
  name: secret.name,
  envName: secret.envName,
  value: '',
  agentIds: [...secret.agentIds],
});

/** A variable name suggested from the display name: STRIPE_TEST_KEY for "Stripe test key". */
export const suggestEnvName = (name: string): string =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^[^A-Z]+/, '')
    .replace(/_+$/, '')
    .slice(0, SECRET_LIMITS.envNameLength);

export const envNameRules = [(value: string) => secretEnvNameProblem(value) ?? true];

/** Rules for the write-only value; empty is fine when editing (the stored value stays). */
export const valueRules = (required: boolean) => [
  (value: string) =>
    (!required && value === '') ||
    value.length >= SECRET_LIMITS.valueMinLength ||
    `at least ${SECRET_LIMITS.valueMinLength} characters (shorter values could not be redacted from run logs)`,
  (value: string) => value.length <= SECRET_LIMITS.valueMaxLength || 'too long',
  (value: string) => value.trim() === value || 'no leading or trailing whitespace',
];

/** The request body: a create sends everything, an edit only what changed. */
export function secretPayload(draft: SecretDraft, editing: Secret | null): SecretInput {
  if (!editing) {
    return {
      name: draft.name.trim(),
      envName: draft.envName,
      value: draft.value,
      agentIds: draft.agentIds,
    };
  }
  const body: SecretInput = {};
  if (draft.name.trim() !== editing.name) body.name = draft.name.trim();
  if (draft.envName !== editing.envName) body.envName = draft.envName;
  if (draft.value !== '') body.value = draft.value;
  const sameAgents =
    draft.agentIds.length === editing.agentIds.length &&
    draft.agentIds.every((id) => editing.agentIds.includes(id));
  if (!sameAgents) body.agentIds = draft.agentIds;
  return body;
}

const ERRORS: Record<string, string> = {
  owner_required: 'Only an owner can reveal a secret.',
  reauth_required: 'Sign in as an owner to reveal a secret.',
  invalid_password: 'The password is not correct.',
  too_many_attempts: 'Too many wrong passwords. Try again in a few minutes.',
  conflict: 'A secret with this name or variable already exists in the project.',
};

export function secretErrorText(error: unknown): string {
  if (error instanceof ApiError) return (error.code && ERRORS[error.code]) || error.message;
  return error instanceof Error ? error.message : String(error);
}
