import type { SandboxTool } from '@conclavix/core';
import type { AgentDoc, IssueDoc } from '../db.js';
import type { OrgPosition } from '../modules/org/position.js';
import type { PackageRegistry } from './adapters/sandbox.js';

export type { PackageRegistry };

const names = (agents: OrgPosition['delegates'], none: string): string =>
  agents.length === 0 ? none : agents.map((agent) => `${agent.name} (${agent.role})`).join(', ');

/** The agent's place in the organisation and the delegation rule, in a few lines. */
export function describePosition(position: OrgPosition): string[] {
  const lines = [
    'Your position:',
    position.isLead
      ? '- You are the lead. You plan projects: list_projects, get_project_board, create_issue.'
      : '- You are not the lead.',
    `- Can delegate to you: ${names(position.delegators, 'nobody; your work comes from the board')}.`,
    `- You can delegate to: ${names(position.delegates, 'nobody; do the work yourself')}.`,
    ...(position.delegatesNotInProject.length > 0
      ? [
          `- Not enabled in this project, do not assign them work here: ${names(position.delegatesNotInProject, '')}.`,
        ]
      : []),
    `- You report to: ${names(position.reportsTo, 'nobody')}.`,
    'Assign work only to yourself or to agents you can delegate to; they delegate further themselves.',
  ];
  if (position.notifications.length > 0) {
    lines.push('', 'Unread notifications (mark_notifications_read once handled):');
    lines.push(...position.notifications.map((item) => `- ${item.text}`));
  }
  return lines;
}

/** How a coding agent shows screenshots it committed in documents and comments. */
export const SCREENSHOT_HINT = [
  'Screenshots: save them in the repository under docs/screenshots/<module>/ (they are committed',
  'with your work) and embed them in documents and comments as',
  '![what it shows](repo:docs/screenshots/<module>/<name>.png); repo: paths resolve against the',
  "issue's branch. Supported: png, jpg, gif, webp, svg up to 10 MB.",
];

/** How an agent with the git integration permission integrates branches. */
export const GIT_INTEGRATION_HINT = [
  'Git integration (you have this permission; it runs on the server, not in a working copy):',
  '- get_merge_status previews a merge: what the target already contains, which files conflict.',
  '- merge_branches merges existing branches into cvx/<KEY> of your issue or of an issue assigned',
  '  to you, one merge commit per source. On a conflict nothing changes and you get the files;',
  '  have them resolved on one of the branches, then merge again.',
  '- fast_forward_main moves main to an issue branch that passed review, fast-forward only.',
  'A merge into your own branch reaches your working copy in your next run, not in this one:',
  'merge before you edit files the sources also change.',
];

/**
 * The host programs a coding run may execute (CODE_SANDBOX_TOOLS). The sandbox refuses to list or
 * stat their directories (reads outside the clone are blocked), so the agent must use the path.
 */
export function sandboxToolsHint(tools: readonly SandboxTool[]): string[] {
  if (tools.length === 0) return [];
  return [
    'Test tools on this host, not on PATH: each variable below is set in your environment. Run them',
    `by path (for example "$${tools[0]?.name ?? ''}"); their directories cannot be listed.`,
    ...tools.map((tool) => `- ${tool.name}=${tool.path} is set`),
  ];
}

/**
 * Where packages come from in a coding run with a package registry (CODE_PACKAGE_REGISTRY):
 * npm, pnpm and yarn are already pointed at it, and internal packages are installed from it.
 */
export function packageRegistryHint(registry: PackageRegistry | null | undefined): string[] {
  if (!registry) return [];
  const scopes = registry.scopes.length > 0 ? registry.scopes.join(', ') : '@<scope>';
  return [
    `Packages: npm, pnpm and yarn install from the package registry ${registry.url} (already`,
    'configured in your environment; it caches the public npm registry).',
    registry.fallback
      ? 'The public npm registry stays reachable as a fallback.'
      : 'The public npm registry is not reachable directly; do not point installs elsewhere.',
    `Internal packages (${scopes}/...) are published there: add them as normal dependencies and`,
    'install them from the registry; never copy them into the repository or a scratch directory.',
    'You cannot publish to the registry; ask in a comment when an internal package is missing.',
  ];
}

/** What the platform does after a run that left no trace; every agent should know it. */
export const SILENT_RUN_HINT = [
  'Always leave a trace: a run that ends without a comment, status change, document, sub-issue or',
  'commit counts as ended without a result. The platform then posts your last message on the',
  'issue and escalates to whoever delegated it (or to the board). If something blocks you',
  '(a missing tool, access, information), say what with add_comment before you stop.',
];

/** The task prompt for one run; the agent's own instructions go into the system prompt. */
export function buildPrompt(
  agent: AgentDoc,
  issue: IssueDoc,
  reason: string,
  position: OrgPosition,
  options: {
    code?: boolean;
    git?: boolean;
    tools?: readonly SandboxTool[];
    registry?: PackageRegistry | null;
  } = {},
): string {
  return [
    `You are ${agent.name}${agent.title ? `, ${agent.title}` : ''} (role: ${agent.role}) in a Conclavix organisation.`,
    `You were woken (${reason}) to work on issue ${issue.key}: "${issue.title}".`,
    '',
    ...describePosition(position),
    '',
    'Work through the conclavix tools:',
    '1. Call get_issue first and read the description, comments, documents and sub-issues.',
    '   Use memory_search for house rules, project decisions and pitfalls before non-trivial work.',
    "   Read the project's code (read-only, no sandbox needed) with list_branches, get_branch_diff",
    '   (a branch against main, like a pull request), list_files, read_file and get_commit_log.',
    '   Issue branches are cvx/<ISSUE-KEY>; they hold what earlier runs committed, not work in progress.',
    '2. Do the next concrete step. Record plans and results with write_document.',
    '3. Delegate work with create_subissue to agents you can delegate to (see list_team);',
    '   order dependent sub-issues with blockedBy. Read what your sub-issues produced with',
    '   list_documents and read_document; send one back on its branch with reopen_issue.',
    '4. Comment on progress with add_comment.',
    '5. When you need the board to decide, call request_board_decision with the question and',
    '   options, then stop: its answer moves the issue back to in_progress and wakes you. Set',
    '   in_review with set_status only while waiting for something else; done when finished. A',
    '   sub-issue or your last blocker closing moves such an in_review issue back to in_progress',
    '   and wakes you; set in_review again if you are still waiting.',
    '6. Before you stop, memory_save what will still matter later (decisions, pitfalls, rules), not progress.',
    ...(options.code ? ['', ...SCREENSHOT_HINT] : []),
    ...(options.code && options.tools?.length ? ['', ...sandboxToolsHint(options.tools)] : []),
    ...(options.code && options.registry ? ['', ...packageRegistryHint(options.registry)] : []),
    ...(options.git ? ['', ...GIT_INTEGRATION_HINT] : []),
    '',
    ...SILENT_RUN_HINT,
    '',
    'Stop when this step is done. You will be woken again when something changes.',
  ].join('\n');
}
