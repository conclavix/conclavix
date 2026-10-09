import type { MfaPolicy, Role } from '@conclavix/core';

/**
 * read: everything a viewer sees. self: own profile and API tokens. work: projects, issues,
 * comments, documents, memories, waking agents. agents: creating, changing and removing agents,
 * the org chart (lead, links, layout), which agents may work in which project, and the skill
 * library, which feeds agent instructions.
 * users, settings, audit: instance administration. Owner-only actions (granting or touching the
 * owner role, owner-only settings) are checked where they happen.
 */
export type Capability = 'read' | 'self' | 'work' | 'agents' | 'users' | 'settings' | 'audit';

const VIEWER: readonly Capability[] = ['read', 'self'];
const MEMBER: readonly Capability[] = [...VIEWER, 'work'];
const ADMIN: readonly Capability[] = [...MEMBER, 'agents', 'users', 'settings', 'audit'];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set(ADMIN),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
  viewer: new Set(VIEWER),
};

/** Human descriptions of each capability, in display order, for the roles overview. */
export const CAPABILITY_DESCRIPTIONS: Readonly<Record<Capability, string>> = {
  read: 'See projects, issues, runs, agents, the org chart, skills, memories and project code',
  self: 'Manage the own profile, theme and personal API tokens',
  work: 'Create and change projects, issues, comments, documents and memories; wake agents',
  agents:
    'Create, change and remove agents; choose which agents work in which project; edit the org chart and the skill library; import skills from directories; manage issue workspaces',
  users: 'Invite users, change roles, ban, reset passwords and 2FA, delete users',
  settings:
    'Change instance settings, skill directory sources and project secrets (MFA policy, SMTP and revealing secret values stay owner-only)',
  audit: 'Read the security audit log',
};

/** Human descriptions of each role, including the rules no capability expresses. */
export const ROLE_DESCRIPTIONS: Readonly<Record<Role, string>> = {
  owner:
    'Everything an admin may, plus granting or changing the owner role, the MFA policy and SMTP. At least one active owner always remains.',
  admin: 'Runs the instance: agents, skills, org chart, users, settings and the audit log.',
  member: 'Works with the agents: projects, issues, comments, documents and memories.',
  viewer: 'Reads everything and manages only the own profile and API tokens.',
};

/** Every board API route and the capability it needs; routes missing here fail at startup. */
export const ROUTE_PERMISSIONS: Readonly<Record<string, Capability>> = {
  'GET /api/stream': 'read',
  'GET /api/overview': 'read',
  'GET /api/models': 'read',
  'GET /api/projects': 'read',
  'GET /api/projects/:id': 'read',
  'POST /api/projects': 'work',
  'PATCH /api/projects/:id': 'work',
  'GET /api/projects/:id/board': 'read',
  'PUT /api/projects/:id/board': 'work',
  'GET /api/projects/:id/agents': 'read',
  'PUT /api/projects/:id/agents/:agentId': 'agents',
  'GET /api/projects/:id/branches': 'read',
  'GET /api/projects/:id/commits': 'read',
  'GET /api/projects/:id/commits/:sha': 'read',
  'GET /api/projects/:id/tree': 'read',
  'GET /api/projects/:id/file': 'read',
  'GET /api/projects/:id/raw': 'read',
  'GET /api/projects/:id/media': 'read',
  'GET /api/projects/:id/compare': 'read',
  'GET /api/projects/:id/archive': 'read',
  // Project secrets: admins manage them and see metadata; revealing a value is owner-only.
  'GET /api/projects/:id/secrets': 'settings',
  'POST /api/projects/:id/secrets': 'settings',
  'PATCH /api/projects/:id/secrets/:secretId': 'settings',
  'DELETE /api/projects/:id/secrets/:secretId': 'settings',
  'POST /api/projects/:id/secrets/:secretId/reveal': 'settings',
  // Issue workspaces: admin and owner only.
  'POST /api/issues/:ref/workspace': 'agents',
  'POST /api/issues/:ref/workspace/sync': 'agents',
  'DELETE /api/issues/:ref/workspace': 'agents',
  'GET /api/agents': 'read',
  'GET /api/org-chart': 'read',
  'GET /api/org': 'read',
  'GET /api/org-graph': 'read',
  'PUT /api/org/lead': 'agents',
  'PUT /api/org/layout': 'agents',
  'POST /api/agent-links': 'agents',
  'PATCH /api/agent-links/:id': 'agents',
  'DELETE /api/agent-links/:id': 'agents',
  'GET /api/skills': 'read',
  'GET /api/skills/:id': 'read',
  'POST /api/skills': 'agents',
  'PATCH /api/skills/:id': 'agents',
  'DELETE /api/skills/:id': 'agents',
  // Directory sources hold API keys: managing them is instance administration. Browsing and
  // importing feed the skill library, so they need the same capability as editing it.
  'GET /api/skill-sources': 'agents',
  'POST /api/skill-sources': 'settings',
  'PATCH /api/skill-sources/:id': 'settings',
  'DELETE /api/skill-sources/:id': 'settings',
  'POST /api/skill-sources/:id/test': 'settings',
  'GET /api/skill-sources/:id/categories': 'agents',
  'GET /api/skill-sources/:id/skills': 'agents',
  'GET /api/skill-sources/:id/skills/:slug': 'agents',
  'POST /api/skill-sources/:id/import': 'agents',
  'GET /api/agents/:id': 'read',
  'POST /api/agents': 'agents',
  'PATCH /api/agents/:id': 'agents',
  'DELETE /api/agents/:id': 'agents',
  'POST /api/agents/:id/wake': 'work',
  'GET /api/avatars/:type/:id': 'read',
  // Writes depend on the owner type, so the avatar owner handler checks the role itself.
  'PUT /api/avatars/:type/:id': 'self',
  'DELETE /api/avatars/:type/:id': 'self',
  'GET /api/issues': 'read',
  'GET /api/issues/:ref': 'read',
  'POST /api/issues': 'work',
  'PATCH /api/issues/:ref': 'work',
  'GET /api/issues/:ref/comments': 'read',
  'POST /api/issues/:ref/comments': 'work',
  'GET /api/issues/:ref/documents': 'read',
  'GET /api/issues/:ref/documents/:key': 'read',
  'GET /api/issues/:ref/documents/:key/revisions': 'read',
  'GET /api/issues/:ref/documents/:key/revisions/:revision': 'read',
  'PUT /api/issues/:ref/documents/:key': 'work',
  'GET /api/decisions': 'read',
  'GET /api/decisions/count': 'read',
  'POST /api/decisions/:id/answer': 'work',
  'POST /api/decisions/:id/dismiss': 'work',
  'GET /api/runs': 'read',
  'GET /api/runs/:id': 'read',
  'GET /api/runs/:id/events': 'read',
  'GET /api/memories': 'read',
  'GET /api/memories/:id': 'read',
  'POST /api/memories': 'work',
  'PATCH /api/memories/:id': 'work',
  'DELETE /api/memories/:id': 'work',
  'GET /api/me': 'self',
  'PATCH /api/me': 'self',
  'GET /api/me/tokens': 'self',
  'POST /api/me/tokens': 'self',
  'DELETE /api/me/tokens/:id': 'self',
  'GET /api/users/names': 'read',
  'GET /api/users': 'users',
  'POST /api/users': 'users',
  'GET /api/users/:id': 'users',
  'PATCH /api/users/:id': 'users',
  'DELETE /api/users/:id': 'users',
  'POST /api/users/:id/ban': 'users',
  'POST /api/users/:id/unban': 'users',
  'POST /api/users/:id/reset-password': 'users',
  'POST /api/users/:id/reset-2fa': 'users',
  'GET /api/settings': 'settings',
  'PATCH /api/settings': 'settings',
  'POST /api/settings/smtp/test': 'settings',
  'GET /api/audit': 'audit',
  'GET /api/roles': 'users',
};

/** Routes a signed-in user may still call while the MFA policy demands an enrolment. */
export const MFA_ENROLMENT_ROUTES: ReadonlySet<string> = new Set(['GET /api/me']);

/** better-auth paths reachable while enrolment is pending: enrol, look at the session, leave. */
export const MFA_ENROLMENT_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/get-session',
  '/sign-out',
  '/two-factor/enable',
  '/two-factor/get-totp-uri',
  '/two-factor/verify-totp',
]);

export function routeKey(method: string, url: string): string {
  return `${method === 'HEAD' ? 'GET' : method} ${url}`;
}

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

export function mfaRequiredFor(policy: MfaPolicy, role: Role): boolean {
  if (policy === 'required') return true;
  if (policy === 'required_for_admins') return role === 'owner' || role === 'admin';
  return false;
}
