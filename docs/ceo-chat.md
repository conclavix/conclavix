# CEO chat

The CEO chat lets the board plan with the organisation's lead agent before any work exists: the
board describes what it wants, the lead asks questions and keeps a plan document, and once the
board approves a revision of the plan the lead creates the project and its initial planning
issue. Open it under **CEO Chat** in the navigation.

## Flow

1. **Start a chat.** An admin or owner starts a chat with a topic and, optionally, an existing
   project the plan is about. The chat is bound to the current lead; without a lead (see the org
   chart) no chat can start.
2. **Discuss.** Every board message starts one short run of the lead (a _chat run_). The lead gets
   its own instructions and skills as in every run, plus a chat-mode prompt: ask clarifying
   questions, work towards goal, scope, acceptance criteria and rough work packages, and keep the
   plan document current with `write_chat_plan`. The reply streams into the chat while the run is
   going; each reply links to its run log. One turn at a time: while the lead answers, the board
   waits.
3. **Approve.** The side panel shows the current plan revision. **Approve plan** freezes exactly
   the revision the board sees (a newer revision or a running reply makes the approval fail with
   `409`), records who approved when, and wakes the lead once with "Plan approved - create the
   project and the initial planning issue as agreed".
4. **Create.** In that run the lead calls `create_project` (skipped when the chat is about an
   existing project) and `create_planning_issue`. The planning issue is assigned to the lead and
   labelled `planning`; the assignment wakes the lead on it as usual, so planning continues on the
   board with `create_issue`. The chat shows links to the new project and issue.

If the creation run fails, the board can still write to the approved chat (for example "please
try again") until the planning issue exists. After that the chat is done; archive it or start a
new one.

## Chat runs

A chat run is a run bound to a chat instead of an issue: `kind: 'chat'`, `issueId: null`,
`chatId` set, reason `chat` or `plan_approved`. They appear in the run list and the live view
like every run (filter with `GET /api/runs?chatId=`).

| Limit                                 | Chat runs                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Cost per run                          | Applies (`--max-budget-usd`)                                                                      |
| Cost per day                          | Applies; counts with the lead's issue runs. A turn that hits it waits until the next UTC day      |
| Idle runs per issue, backoff, pausing | Do not apply: chat runs are started by the board, make no issue progress and never pause the lead |
| Runs per issue and day                | Do not apply                                                                                      |

Posting a message is refused (`409`) while the lead is paused, is no longer the lead, or has
reached its daily cost limit. A turn that cannot start any more (the lead was paused or replaced
meanwhile) is dropped and the reason is shown in the chat.

The scheduler turns pending chat turns into runs on every tick, next to the issue wakes. The
runner works in `<WORKSPACES_ROOT>/<agent id>/_chat`, which holds only the agent's skills; chat
runs never use the coding sandbox.

## Tools in chat mode

A chat run gets only these MCP tools, no issue tools:

| Tool                                                       | Notes                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `memory_search`, `memory_save`                             | Global and own memory; project memory only when the chat is about a project                                        |
| `list_projects`, `get_project_board`                       | Read-only, lead only                                                                                               |
| `list_branches`, `get_branch_diff`, `read_file`, ...       | Read-only code tools, only when the chat is about a project                                                        |
| `write_chat_plan({ markdown })`                            | Replaces the plan with a new revision; refused once the plan is approved                                           |
| `create_project({ key, name, description })`               | Refused before the approval and after the chat created its project                                                 |
| `create_planning_issue({ projectId, title, description })` | Refused before the approval and after the chat created its issue; only in the project the chat created or is about |

The approval gate is enforced on the server: every call re-reads the chat in a transaction, and
only the run currently answering the chat may act on it.

## Permissions and audit

| Route                                  | Capability | Purpose                            |
| -------------------------------------- | ---------- | ---------------------------------- |
| `GET /api/chats`, `GET /api/chats/:id` | `read`     | Chats with messages                |
| `GET /api/chats/:id/plan/revisions`    | `read`     | Every plan revision                |
| `POST /api/chats`                      | `agents`   | `{ title, projectId? }`            |
| `PATCH /api/chats/:id`                 | `agents`   | Rename or `{ status: 'archived' }` |
| `POST /api/chats/:id/messages`         | `agents`   | `{ content }`; answers `202`       |
| `POST /api/chats/:id/approve`          | `agents`   | `{ planRevision }`                 |

Owners and admins talk to the lead and approve, because an approved plan makes the lead create a
project and work; members and viewers read along. Approvals are audited as `chat.plan_approved`
(the approving user), the creations as `chat.project_created` and `chat.issue_created` (actor
`system`, with the agent, run, plan revision and approver in the details).

## Data

| Collection            | Holds                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `board_chats`         | Title, status (`open`, `approved`, `archived`), lead, project, current plan, approval, created project and issue, active run, pending turn |
| `chat_messages`       | Board and lead messages; a lead reply carries its run id and, for failed runs, the error                                                   |
| `chat_plan_revisions` | Every plan revision with the run that wrote it                                                                                             |

Replies are redacted like the run log before they are stored.
