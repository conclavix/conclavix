import { CHAT_LIMITS } from '@conclavix/core';
import type { AgentDoc, ChatDoc, ChatMessageDoc, ProjectDoc } from '../db.js';

const cut = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} characters cut]` : text;

/** How one message reads in the run's history. */
function renderMessage(message: ChatMessageDoc): string {
  const who = message.role === 'board' ? 'Board' : 'You (lead)';
  const body =
    message.content.trim() ||
    (message.error ? `(no reply: the run failed: ${message.error})` : '(no reply)');
  return `### ${who}, ${message.createdAt.toISOString()}\n${cut(body, CHAT_LIMITS.historyMessageChars)}`;
}

/**
 * The conversation the lead sees, oldest first: at most `historyMessages` messages and
 * `historyChars` characters, dropping the oldest first, and never the newest message.
 */
export function chatHistory(messages: readonly ChatMessageDoc[]): {
  text: string;
  omitted: number;
} {
  const recent = messages.slice(-CHAT_LIMITS.historyMessages);
  const rendered = recent.map(renderMessage);
  let total = rendered.reduce((sum, part) => sum + part.length + 2, 0);
  let start = 0;
  while (total > CHAT_LIMITS.historyChars && start < rendered.length - 1) {
    total -= (rendered[start]?.length ?? 0) + 2;
    start += 1;
  }
  return {
    text: rendered.slice(start).join('\n\n'),
    omitted: messages.length - (recent.length - start),
  };
}

export interface ChatPromptInput {
  agent: AgentDoc;
  chat: ChatDoc;
  messages: readonly ChatMessageDoc[];
  /** The existing project the chat is about, if any. */
  project: ProjectDoc | null;
  /**
   * Whether the chat refers to a project whose code may be readable. The API serves the code
   * tools only when it has a project workspace, which the runner cannot see, so the prompt says
   * to use them only if they are listed.
   */
  code: boolean;
}

const DISCUSSION_RULES = [
  'Chat mode: you are discussing a plan with the board (the humans running this organisation).',
  'This run has no issue. Your final message of this run is your reply to the board; write it in',
  'Markdown, short and to the point.',
  '',
  'How to discuss:',
  '- Ask clarifying questions when goal, scope, constraints or priorities are unclear; do not guess.',
  '- Work towards a plan with: goal, scope (in and out), acceptance criteria, rough work packages',
  '  (by role or agent), risks and open questions. For a new project also propose its key',
  '  (2-6 uppercase letters or digits, starting with a letter) and name.',
  '- Keep the plan document current with write_chat_plan({ markdown }) whenever it changes; it',
  '  replaces the whole document. The board approves a revision of it.',
  '- Use memory_search for house rules and earlier decisions, list_projects and',
  '  get_project_board for what already exists.',
  '- Do not create projects or issues during the discussion. create_project and',
  '  create_planning_issue are refused until the board approves the plan with its',
  '  "Approve plan" button; never claim you created something you did not.',
];

const APPROVED_RULES = (revision: number): string[] => [
  `The board approved plan revision ${revision}. The plan is frozen now (write_chat_plan is`,
  'refused). Carry it out exactly once:',
  '1. If the plan is for a new project, create it with create_project({ key, name, description })',
  '   as agreed. If it is about the referenced existing project, skip this step.',
  '2. Create the initial planning issue with create_planning_issue({ projectId, title,',
  '   description }) in that project. It is assigned to you; describe the approved plan in it',
  '   (goal, scope, acceptance criteria, work packages), because you will plan the work from it',
  '   with create_issue in your next run on that issue.',
  '3. Reply to the board with what you created (keys), or with what failed and why.',
  'Each tool works once per approved plan; do not retry one that succeeded.',
];

/** The task prompt of a chat run; the lead's own instructions go into the system prompt. */
export function buildChatPrompt(input: ChatPromptInput): string {
  const { agent, chat, messages, project, code } = input;
  const approved = chat.status === 'approved' && chat.approval !== null;
  const history = chatHistory(messages);
  const tools = ['memory_search', 'memory_save', 'list_projects', 'get_project_board'];

  tools.push('write_chat_plan', 'create_project', 'create_planning_issue');
  return [
    `You are ${agent.name}${agent.title ? `, ${agent.title}` : ''} (role: ${agent.role}), the lead of a Conclavix organisation.`,
    `The board talks to you in the chat "${chat.title}".`,
    '',
    ...(approved && chat.approval ? APPROVED_RULES(chat.approval.planRevision) : DISCUSSION_RULES),
    '',
    `Your conclavix tools in this chat: ${tools.join(', ')}.`,
    ...(project
      ? [
          '',
          `The chat is about the existing project ${project.key} "${project.name}" (projectId ${project._id.toHexString()}).`,
          ...(code
            ? [
                'If your tools include the read-only code tools (list_branches, read_file, ...),',
                'read its code with them; issue branches are cvx/<ISSUE-KEY>.',
              ]
            : []),
        ]
      : []),
    ...(chat.createdProjectId
      ? ['', `Already created by this chat: project id ${chat.createdProjectId.toHexString()}.`]
      : []),
    '',
    chat.plan
      ? `Current plan document (revision ${chat.plan.revision}):\n<plan>\n${chat.plan.markdown}\n</plan>`
      : 'There is no plan document yet.',
    '',
    `Conversation so far, oldest first${history.omitted > 0 ? ` (${history.omitted} older messages omitted)` : ''}:`,
    '',
    history.text || '(no messages)',
    '',
    approved
      ? 'Carry out the approved plan now, then reply to the board.'
      : 'Answer the newest board message above. Stop after your reply; the board answers in the chat.',
  ].join('\n');
}
