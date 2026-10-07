import { createRouter, createWebHistory } from 'vue-router';
import { isAdminRole } from './admin/gating';
import { useAuthStore } from './stores/auth';

const PUBLIC = new Set(['login', 'reset-password']);

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('./views/LoginView.vue') },
    {
      path: '/reset-password',
      name: 'reset-password',
      component: () => import('./views/ResetPasswordView.vue'),
    },
    {
      path: '/setup-2fa',
      name: 'setup-2fa',
      component: () => import('./views/MfaSetupView.vue'),
    },
    { path: '/projects', name: 'projects', component: () => import('./views/ProjectsView.vue') },
    {
      path: '/projects/:projectKey',
      name: 'project',
      component: () => import('./views/ProjectBoardView.vue'),
      props: true,
    },
    { path: '/', name: 'live', component: () => import('./views/LiveView.vue') },
    {
      path: '/overview',
      name: 'overview',
      component: () => import('./views/OverviewView.vue'),
    },
    { path: '/issues', name: 'issues', component: () => import('./views/IssuesView.vue') },
    {
      path: '/issues/:issueKey',
      name: 'issue',
      component: () => import('./views/IssueView.vue'),
      props: true,
    },
    {
      path: '/decisions',
      name: 'decisions',
      component: () => import('./views/DecisionsView.vue'),
    },
    { path: '/org', name: 'org', component: () => import('./views/OrgView.vue') },
    { path: '/memory', name: 'memory', component: () => import('./views/MemoryView.vue') },
    { path: '/runs', name: 'runs', component: () => import('./views/RunsView.vue') },
    {
      path: '/runs/:runId',
      name: 'run',
      component: () => import('./views/RunDetailView.vue'),
      props: true,
    },
    { path: '/agents', name: 'agents', component: () => import('./views/AgentsView.vue') },
    {
      path: '/agents/:agentId',
      name: 'agent',
      component: () => import('./views/AgentView.vue'),
      props: true,
    },
    {
      path: '/skills',
      name: 'skills',
      component: () => import('./views/SkillsView.vue'),
      props: (route) => ({
        skill: typeof route.query['skill'] === 'string' ? route.query['skill'] : undefined,
        tab: typeof route.query['tab'] === 'string' ? route.query['tab'] : undefined,
      }),
    },
    { path: '/profile', name: 'profile', component: () => import('./views/ProfileView.vue') },
    // Administration: admin+ only. The guard hides it; the API still answers 403 on its own.
    { path: '/admin', redirect: { name: 'admin-users' } },
    {
      path: '/admin/users',
      name: 'admin-users',
      component: () => import('./views/admin/AdminUsersView.vue'),
      meta: { admin: true },
    },
    {
      path: '/admin/roles',
      name: 'admin-roles',
      component: () => import('./views/admin/AdminRolesView.vue'),
      meta: { admin: true },
    },
    {
      path: '/admin/settings',
      name: 'admin-settings',
      component: () => import('./views/admin/AdminSettingsView.vue'),
      meta: { admin: true },
    },
    {
      path: '/admin/skill-directories',
      name: 'admin-skill-directories',
      component: () => import('./views/admin/AdminSkillSourcesView.vue'),
      meta: { admin: true },
    },
    {
      path: '/admin/audit',
      name: 'admin-audit',
      component: () => import('./views/admin/AdminAuditView.vue'),
      meta: { admin: true },
    },
  ],
});

router.beforeEach(async (to) => {
  if (PUBLIC.has(String(to.name))) return true;
  const auth = useAuthStore();
  const me = auth.loaded && auth.me ? auth.me : await auth.load();
  if (!me) return { name: 'login', query: { next: to.fullPath } };
  if (me.mfaRequired && to.name !== 'setup-2fa') return { name: 'setup-2fa' };
  if (to.meta?.['admin'] === true && !isAdminRole(me.role)) return { name: 'overview' };
  return true;
});
