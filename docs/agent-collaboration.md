# Agent collaboration

How agents hand work down an issue tree, get results back up, and who is woken when work closes.
Everything here is enforced by the agent MCP API (`/mcp`, one run token per run) and the scheduler.

## Issue tree and scope

A run belongs to one issue, its **own issue**. Its **issue tree** is that issue, its parents (up
the `parentId` chain) and its sub-issues at any depth (direct and transitive children). Issues of
the same project outside the tree stay readable with `get_issue` (comments, sub-issue list), but
their documents do not.

| Tool              | Scope                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `read_document`   | Documents on any issue of the tree. Anything else: tool error `issue tree only`.                   |
| `list_documents`  | Key, title, revision and issue (`relation`: `own`, `parent`, `sub-issue`) of the tree's documents. |
| `write_document`  | The own issue only.                                                                                |
| `create_subissue` | Creates a child of the own issue; optional `blockedBy` (see below).                                |
| `reopen_issue`    | Sub-issues below the own issue only (not the own issue, not parents, not other trees).             |

`list_documents` is bounded: at most 200 issues of the tree (20 levels up and down) and 200
documents; `truncated: true` says the list was cut. It returns no document bodies; read them with
`read_document` and the issue key.

## Screenshots in documents and comments

Coding agents save screenshots in the repository under `docs/screenshots/<module>/` (the runner
commits them with the rest of the run's work and syncs the branch) and embed them in documents and
comments with a `repo:` path:

```markdown
![list view](repo:docs/screenshots/feedback/list.png)
```

The board resolves `repo:` against the branch of the issue the document or comment belongs to
(`cvx/<KEY>`, or `main` while the issue has no workspace) and loads the image through
`GET /api/projects/:id/raw` (see [workspace.md](workspace.md#images)). A document of a parent
issue therefore resolves against the parent's branch: an image from a sub-issue's branch shows
there only once it has been merged into that branch. Coding runs get this as a short paragraph in
their prompt.

## Ordering sub-issues: `blockedBy`

`create_subissue` takes `blockedBy`: up to 20 keys of **sibling** sub-issues, that is other
children of the run's own issue. Keys from elsewhere are rejected (`is not a sub-issue of your
issue`). The new sub-issue uses the normal blocker mechanism:

- its assignee's wake is skipped with `skipReason: 'blocked'` while any blocker is open;
- when the last open blocker closes (`done` or `cancelled`), the assignee gets an `unblocked`
  wake for the sub-issue.

## Sending work back: `reopen_issue`

`reopen_issue({ ref, reason })` moves a sub-issue below the run's issue from `done`, `cancelled`
or `in_review` back to `todo`. The issue keeps its assignee, its branch (`cvx/<KEY>`) and its
delegation, so closing it again wakes the delegator as before.

- `reason` is required (1 to 20000 characters, not blank) and becomes a comment on the reopened
  issue, written in the same transaction as the status change.
- The assignee is woken by the usual rule for an issue that becomes actionable (`assigned` wake for
  that issue); the scheduler gates (paused agent, project access, runs per issue and hour, cost per
  day) apply as for every wake.
- Reopening counts as progress of the reopening run's own issue, like creating a sub-issue, so loop
  detection does not pause a delegator that sends work back.
- A sub-issue whose parent is closed cannot be reopened; reopen the parent first.
- **Cap:** agents can reopen one issue at most three times (`agentReopens` on the issue). After
  that the tool refuses and the agent has to ask the board, which can still reopen it with
  `PATCH /api/issues/:ref`.

## Who is woken when delegated work closes

When an issue that an agent delegated (`delegatedBy`) closes:

1. **The delegator** is woken (`delegation_closed`) on the issue it delegated from, if that issue
   is still assigned to it and actionable (`todo` or `in_progress`). Otherwise it gets a
   notification.
2. **Every other `reports` target** of the assignee gets a notification (`list_notifications`,
   also listed in the next run's prompt) naming the closed issue.
3. **A `reports` link with `wakeOnReport: true`** additionally wakes its target (`report_closed`)
   on the target's own issue above the closed one: the nearest issue up the chain (the issue each
   step was delegated from, else its parent) that is assigned to the target. The wake only happens
   when that issue is actionable; otherwise the notification is all the target gets.

Loop protection for report wakes: the wake always targets an issue strictly above the closed one,
never the closed issue itself, and at most once per target and closure (a pending wake for the same
agent and issue absorbs further ones). A closed issue only reports again after it was reopened,
which agents can do at most three times per issue. Every wake passes the scheduler gates, so a
paused target is not started (`skipReason: 'agent_paused'`).

### Limit windows: deferred wakes

A wake that hits a limit whose window frees on its own is **deferred, not dropped**. It stays
pending with `deferReason` and `notBefore`, keeps its agent and issue, and the scheduler checks it
again from `notBefore` on (all gates again, so a closed issue, an unassigned agent or a pause still
skip it):

- `run_rate_limit` (`maxRunsPerIssuePerHour` runs on this issue in the last hour): `notBefore` is
  when the oldest of those runs leaves the hour.
- `daily_cost_limit` (`maxCostPerDayUsd` spent since midnight UTC): `notBefore` is the next
  midnight UTC. Deferring keeps one rule for both limits; the run then counts against the new day.

While a wake waits, further wakes for the same agent and issue are absorbed by it, so a deferred
lead gets exactly one run when the window frees. A manual wake from the board (after raising the
limits, for example) clears `notBefore`, so the wake is checked on the next tick. Loop detection is
unchanged: runs started from deferred wakes count, and an agent paused for making no progress has
its pending wake skipped.

Example: Mr. Green delegates integration to the Integrations Agent, which delegates the review to
the PR Reviewer. With `PR Reviewer reports to Mr. Green` set to wake, the closed review wakes the
Integrations Agent on its integration issue and Mr. Green on his planning issue at the same time.

## Link option in the API and the canvas

| Route                        | Capability | Body                                                              |
| ---------------------------- | ---------- | ----------------------------------------------------------------- |
| `POST /api/agent-links`      | `agents`   | `{ from, to, type, wakeOnReport? }` (`true` only on `reports`)    |
| `PATCH /api/agent-links/:id` | `agents`   | `{ wakeOnReport: boolean }`; 422 on a `delegates` link            |
| `GET /api/org-graph`         | `read`     | every link carries `wakeOnReport` (always `false` on `delegates`) |

The default is `false`, so existing links keep their behaviour; links stored before the option
existed count as `false`. Changes are streamed as `agent_link` events with `wakeOnReport`.

In the org canvas, select a `reports` link and switch **Wake on report**. A waking reports link is
drawn with a denser dash, as shown in the legend.
