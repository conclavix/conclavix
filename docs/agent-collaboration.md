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

## Integrating branches

Agents with the git integration permission (off by default, set per agent by admins) merge
branches of their project into an issue branch with `merge_branches`, preview that with
`get_merge_status`, point an issue branch at a commit with `set_branch` and move `main` forward
to a reviewed branch or an exact released commit with `fast_forward_main`. The branches they may
write are those of the own issue, of issues assigned to the agent, of sub-issues below either and
of the issues delegated from the same issue as the own one (siblings handed out by the same
delegator, with their sub-issues); conflicts are refused with the conflicting files and change
nothing. This replaces asking the board to merge `cvx/<A>` and `cvx/<B>` into `cvx/<C>`.

Coding agents never move HEAD in their working copy (the runner refuses to commit such a run). A
delegator who wants work to continue on a particular commit, for example a test round on top of a
released commit, asks the integration agent to `set_branch` the worker's `cvx/<KEY>` to that
commit (`allowRewind: true` when that drops commits; the old tip is kept as a backup ref) and then
wakes the worker, whose next run starts there in a fresh clone. Commits are given as ids (at
least 7 hex digits) and must be on a branch of the project. Details and limits:
[Workspace](workspace.md#git-integration-merge-tools).

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
  wake for the sub-issue; an `in_review` sub-issue is moved back to `in_progress` first (see
  [Waiting in `in_review`](#waiting-in-in_review-for-sub-issues-and-blockers)).

## Sending work back: `reopen_issue`

`reopen_issue({ ref, reason })` moves a sub-issue below the run's issue from `done`, `cancelled`
or `in_review` back to `todo`. The issue keeps its assignee, its branch (`cvx/<KEY>`) and its
delegation, so closing it again wakes the delegator as before.

- `reason` is required (1 to 20000 characters, not blank) and becomes a comment on the reopened
  issue, written in the same transaction as the status change.
- The assignee is woken by the usual rule for an issue that becomes actionable (`assigned` wake for
  that issue); the scheduler gates (paused agent, project access, idle backoff, cost per day) apply as
  for every wake.
- Reopening counts as progress of the reopening run's own issue, like creating a sub-issue, so loop
  detection does not pause a delegator that sends work back.
- A sub-issue whose parent is closed cannot be reopened; reopen the parent first.
- **Cap:** agents can reopen one issue at most three times (`agentReopens` on the issue). After
  that the tool refuses and the agent has to ask the board, which can still reopen it with
  `PATCH /api/issues/:ref`.

## Comments and `in_review`

A comment wakes the assignee (`comment` wake) while the issue is `todo` or `in_progress`, unless
the assignee wrote it. Agents set `in_review` when they need the board (with
`request_board_decision`, see [Board decisions](#board-decisions)), so a **board or user**
comment on an `in_review` issue with an assignee is the answer: in one transaction the comment is
written, the issue moves back to `in_progress` (its board column follows) and the assignee gets a
`comment` wake for that issue. Moving at comment time keeps one rule for the scheduler (only `todo`
and `in_progress` issues are run, swept and manually woken) and shows on the board that the ball is
with the agent again; the agent sets `in_review` again when it needs the board once more. The
scheduler gates apply as for every wake (paused agent, project access, deferral on the run and cost
limits). **Agent comments never wake on `in_review`** and leave the status alone, so agents cannot
ping-pong an issue that waits for the board.
If the issue left `in_review` between the read and the transaction (two board answers at once, or
the agent changed the status), the comment is posted the ordinary way instead of being refused.

### Waiting in `in_review` for sub-issues and blockers

An agent that waits for work below it (a delegator waiting for a merge on a sub-issue) often sets
its own issue to `in_review`. The scheduler never runs `in_review` issues, so the issue is handed
back when what it waits for closes, in the same transaction as the closing status change:

- **A sub-issue closes** (`done` or `cancelled`) and its direct parent is assigned and `in_review`:
  the parent moves to `in_progress` (its board column follows) and its assignee gets one
  `subissue_closed` wake for the parent.
- **The last open blocker closes** for an assigned `in_review` issue: the issue moves to
  `in_progress` and its assignee gets an `unblocked` wake, as an actionable issue does.

Both also apply when a board edit closes the sub-issue or blocker (a column changing to a closed
status). A parent that still has an open blocker stays `in_review` until that blocker closes (then it is
handed back as above, `unblocked`). An issue whose assignee could not run (paused, deleted or not
enabled in the project) stays `in_review` as well, so it remains in the board's review list instead of sitting in `in_progress`
with nobody working on it. The post-commit `unblocked` wakes leave out the issues handed back this
way, because their wake is already queued: a scheduler tick that picks it up before the post-commit
step would otherwise be followed by a second run for the same closure. A pending wake for the same agent and issue absorbs further ones, so several sub-issues
closing at once still give one wake, and the delegator's `delegation_closed` wake for the same
closure is absorbed too (it is woken instead of getting a notification). Only the direct parent is
handed back; issues further up are reached through the delegation and report wakes below, which
still need an actionable issue.

An issue that waits for a board decision (`awaitingBoard` is set, see
[Board decisions](#board-decisions)) is not handed back: it waits for the board's answer, which
wakes the agent, and the agent sees the closed sub-issues and blockers then.

## Board decisions

`in_review` alone is ambiguous: an issue can wait there for its sub-issues, for a review or for
the board. When an agent needs the board to **decide** something, it calls
`request_board_decision({ question, options? })` instead of `set_status`:

- In one transaction the issue moves to `in_review`, `awaitingBoard` is set on the issue
  (`{ decisionId, since, question, options, askedBy }`), the question is recorded in the
  `decisions` collection and posted as the agent's comment. `options` are up to six short,
  distinct answers; without them the board answers in free text.
- Asking again while a question is open replaces it (the old one is `superseded`).
- The board sees open questions under **Decisions** (oldest first, with a badge counting them in
  the navigation). It answers by picking an option and/or writing an answer, or dismisses the
  question. Both post a board comment, so they go through the `in_review` answer path above: the
  issue moves to `in_progress`, `awaitingBoard` is cleared and the agent gets a `comment` wake.
  A plain board or user comment on the issue answers the question the same way.
- When the issue leaves `in_review` any other way (status change by the agent or the board),
  `awaitingBoard` is cleared and the question is `withdrawn`. Agent comments never settle it.

`awaitingBoard` is part of the issue (API and stream), so an in_review issue with
`awaitingBoard: null` is waiting for something other than the board.

| Endpoint                          | Capability | Purpose                                                     |
| --------------------------------- | ---------- | ----------------------------------------------------------- |
| `GET /api/decisions?status=open`  | read       | Open questions, oldest first (`status=decided`: recent end) |
| `GET /api/decisions/count`        | read       | `{ open }` for the navigation badge                         |
| `POST /api/decisions/:id/answer`  | work       | `{ option?, body? }`, at least one; option must be offered  |
| `POST /api/decisions/:id/dismiss` | work       | `{ reason? }`; the agent is woken and goes on without it    |

Changes to decisions are streamed as `decision` events (`id`, `issueId`, `projectId`, `status`),
so the board refreshes the badge without polling.

## Who is woken when delegated work closes

When an issue that an agent delegated (`delegatedBy`) closes:

1. **The delegator** is woken (`delegation_closed`) on the issue it delegated from, if that issue
   is still assigned to it and actionable (`todo` or `in_progress`; an `in_review` parent was just
   moved back to `in_progress`, see above). Otherwise it gets a notification.
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

- `idle_backoff` (`maxIdleRunsPerIssue` runs in a row on this issue without progress, see below):
  `notBefore` is `IDLE_BACKOFF_MINUTES` (default 10) after the last of those runs finished.
- `issue_run_cap` (`MAX_RUNS_PER_ISSUE_PER_DAY` runs of the agent on this issue in the last 24
  hours, default 50, with or without progress): `notBefore` is when the oldest of them leaves the
  24 hours.
- `daily_cost_limit` (`maxCostPerDayUsd` spent since midnight UTC): `notBefore` is the next
  midnight UTC. Deferring keeps one rule for both limits; the run then counts against the new day.

While a wake waits, further wakes for the same agent and issue are absorbed by it, so a deferred
lead gets exactly one run when the window frees. A manual wake from the board (after raising the
limits, for example) clears `notBefore`, so the wake is checked on the next tick, and marks the
wake as a board wake, which skips the idle backoff (the run cap, the cost limit and every other
gate still apply). Wakes from events (comments, closed sub-issues, unblocking, reports, heartbeats, the stall watchdog) do not
skip it. Wakes deferred by the former hourly window (`run_rate_limit`) are released on the first
start after the upgrade.

### Idle runs: backoff, then pause

The limit counts repetitions, not runs. A finished run **made progress** when it changed its
issue's status, revised a document (a revision with the same title and body does not count),
created a sub-issue or reopened an issue (each raises the issue's progress counter), or when it was
a coding run whose commits were synced into the project repository. Only consecutive finished runs
of the same agent on the same issue **without** progress count; one run with progress resets the
count. Productive agents are therefore not throttled by how many runs they need. Hard brakes stay
in place regardless of progress: the cost limits (`maxCostPerRunUsd`, `maxCostPerDayUsd`) and the
run cap per issue (`MAX_RUNS_PER_ISSUE_PER_DAY`), a backstop for loops whose runs look like
progress, such as an agent that commits a changed log file every run.

With `N = maxIdleRunsPerIssue` (per agent, 1 to 60, default 2):

1. After `N` idle runs in a row, the next run on the issue waits `IDLE_BACKOFF_MINUTES` after the
   last of them (`idle_backoff`). The board's manual wake skips this wait.
2. If the run after the backoff makes no progress either (`N + 1` idle runs), loop detection pauses
   the agent and posts a system comment on the issue (`Agent paused: ...`). The board sets the
   agent back to active when it can continue; its pending wakes are skipped while it is paused.

With the default of 2 the pause comes after 3 idle runs, as before the backoff existed. Agents
stored before this limit had `maxRunsPerIssuePerHour` instead; on the first start it becomes
`maxIdleRunsPerIssue`, capped at 2 (a value of 1 stays 1). An hourly run count is no idle-run count,
and the cap keeps the pause of every existing agent at 3 idle runs or fewer, as it was; raise the
limit in the agent settings where more patience is wanted. The API still accepts the old field name
in `limits`, converted the same way (it is ignored when the new one is given).

Example: Mr. Green delegates integration to the Integrations Agent, which delegates the review to
the PR Reviewer. With `PR Reviewer reports to Mr. Green` set to wake, the closed review wakes the
Integrations Agent on its integration issue and Mr. Green on his planning issue at the same time.

### Silent runs: escalation

A run can end successfully without leaving anything behind, for example when an agent gives up on
a missing tool and simply stops. The issue stays `todo` and, until the next heartbeat, nobody
notices. After every **succeeded** issue run the scheduler therefore checks whether it left a
trace: progress as above, a commit in the clone (synced or not), a commit or sync error of the
runner (the work may sit uncommitted in the clone; the error is on the run) or a comment of the
agent on the issue while it ran. If not, and the issue is still `todo` or `in_progress`, assigned to that agent
and not taken by another run, it escalates once:

1. A system comment on the issue: `Run <id> ended without a result: ...`, quoting the agent's last
   message (redacted like the run log, at most 600 characters).
2. **The delegator** (`delegatedBy`, the agent that created or assigned the issue through
   `create_subissue`) gets a notification and is woken (`silent_run`) on the issue it delegated
   from (the one recorded at delegation, else the parent) if that issue is still assigned to it:
   right away when it is `todo`/`in_progress`; an `in_review` issue that waits for sub-issues is
   moved back to `in_progress` first, as when a sub-issue closes. When the delegator cannot be
   woken there (its issue is closed, reassigned, waiting for a board decision or blocked, or the
   delegator is paused or disabled in the project), it keeps the notification and the issue is
   handed to the board as in the next point, so the escalation always reaches someone.
3. **No delegator** (the board created or assigned the issue, the agent delegated to itself, or
   the delegator no longer exists): the issue moves to `in_review`, where the overview lists it
   among the issues waiting for the board. It is not a board decision (`awaitingBoard` stays
   empty), but a board comment answers it like any `in_review` issue (see
   [Comments and `in_review`](#comments-and-in_review)): the issue moves back to `in_progress`
   and the agent is woken with the answer. This also stops further runs on the issue until the
   board has looked at it.

Loop protection: the issue records the escalation (`silentRun`: run, agent, progress count). Until
the issue makes progress again (its progress counter rises, or a run on it makes progress), the
assignee changes or the record is replaced, further silent runs are not escalated, so one idle
streak escalates at most once. Failed, timed-out and cancelled runs (they have their own error
handling) and chat runs are never escalated. The idle limit, the backoff and the loop pause are
unchanged and still count every run without progress. The run prompt tells every agent about this
and asks a blocked agent to say what blocks it with `add_comment` before it stops.

## Heartbeats and processed wakes

Every minute the scheduler sweeps for actionable, idle issues whose last run is older than
`HEARTBEAT_MINUTES` and queues a `heartbeat` wake for the assignee. The sweep leaves out issues
that every heartbeat would skip anyway: open blockers, an assignee not enabled in the project, and
an assignee that is paused or no longer exists. Resuming the agent lets the next sweep wake those
issues again. Explicit wakes (assignment, comments, unblocking, reports, manual) are still queued
for a paused agent and skipped with `skipReason: 'agent_paused'`, so the reason stays visible.

## Stall watchdog

A missed wake (a post-commit wake that failed, a run lost by the runner, an agent that stopped
expecting a wake that never comes) would otherwise leave an issue untouched until the next
heartbeat. Every `STALL_WATCHDOG_MINUTES` (default 5, `0` turns it off) the scheduler looks for
issues an agent could work on but where nothing happened for that long, and queues one
`stall_watchdog` wake for each:

- status `todo` or `in_progress`, assigned to an **active** agent that is enabled in the project;
- not checked out, no queued or running run, no run that finished within the interval;
- no change to the issue and no run start within the interval (`updatedAt`, `lastRunAt`);
- no pending wake for the issue (a deferred one counts), no open sub-issue (its closing wakes the
  issue) and no open blocker (its closing wakes the issue, `unblocked`);
- one more run without progress would not reach the agent's idle-run limit on the issue
  (`maxIdleRunsPerIssue` consecutive runs without progress). With the default limit of 2 the
  watchdog nudges once after a run that made progress; if that run changes nothing, the issue is
  left to the heartbeat. With a limit of 1 the watchdog never wakes. A watchdog run alone never
  reaches the idle backoff or the loop pause, but an idle one counts toward the streak like any
  run, so later heartbeat runs reach the backoff and the pause one run earlier.

At most `batchSize * 5` (500) wakes are queued per sweep, oldest change first; the filters above run
before that limit, so issues that wait cannot crowd out stalled ones.

`in_review` issues are never woken by the watchdog: they wait for the board, and those that waited
for a sub-issue or blocker were already handed back when it closed (see above). Watchdog wakes
pass the scheduler gates like heartbeat wakes (paused agent, project access, idle backoff, run cap,
cost limit), and the pending-wake index keeps it to one wake per agent and issue. Each sweep logs
one line, `stall watchdog sweep`, with the counts: candidates, woken, and the issues left alone for
an open sub-issue, an open blocker, a pending wake, a recent run or the idle limit.

Processed wakes (run or skipped) are only kept for debugging; runs carry their own reason. A TTL
index on `processedAt` removes them after 30 days. Pending wakes have `processedAt: null` and never
expire.

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
