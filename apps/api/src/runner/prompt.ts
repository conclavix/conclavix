import type { AgentDoc, IssueDoc } from '../db.js';
import type { OrgPosition } from '../modules/org/position.js';

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

/** The task prompt for one run; the agent's own instructions go into the system prompt. */
export function buildPrompt(
  agent: AgentDoc,
  issue: IssueDoc,
  reason: string,
  position: OrgPosition,
  options: { code?: boolean } = {},
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
    '   in_review with set_status only while waiting for something else; done when finished.',
    '6. Before you stop, memory_save what will still matter later (decisions, pitfalls, rules), not progress.',
    ...(options.code ? ['', ...SCREENSHOT_HINT] : []),
    '',
    'Stop when this step is done. You will be woken again when something changes.',
  ].join('\n');
}
