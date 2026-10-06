# Auto-fixer

When the automated review (`docs/review.md`) reports blocking findings on a pull request, or the
newest CI run on its head is red, the auto-fixer tries to fix them on the PR branch, under fixed
rules, for at most three rounds. When the PR has merge conflicts with its base branch, it merges the
base into the PR branch and resolves the conflicts (see [Merge conflicts](#merge-conflicts)). When
the review and CI are green, it labels the PR `merge-ready`. It never merges a PR: a maintainer
checks the scope of every merge-ready PR and merges it.

The workflow is `.github/workflows/fix.yml`. Prompt, rules, configuration and helper scripts live in
`.github/fixer/`.

## The loop

```text
push to main (or the daily schedule) -> scan: one fixer run per conflicting PR
  PR conflicts with its base (mergeable false / mergeable_state dirty) -> merge round n (n <= 3)
    git merge of the base tip, Claude resolves only the conflicted files, same gates
    green -> one merge commit (parents: PR head, base tip), pushed -> CI + Review run again
    lockfile/workspace/CI conflict, semantic conflict, red gate -> no push, label needs-human
push to PR -> CI + Review
  Review or CI completed (workflow_run), both finished on the head
    review "failure" and/or CI "failure" -> fix round n (n <= 3)
      Claude fixes blocking findings and failed CI steps in the PR checkout (no write token, no PAT)
      policy check + gates (pnpm install --frozen-lockfile, pnpm check, pnpm smoke if defined)
      green -> one commit, pushed by the bot account -> CI + Review run again
      not green / disputed / needs a decision -> no push (or push + escalate), label needs-human
    round limit reached, or CI red only for infrastructure (ci_infra)
      -> label needs-human, comment mentioning the maintainer
  Review or CI completed, review "success" and CI "success" on the head
    -> label merge-ready, remove needs-human, one comment. No auto-merge.
```

## Trigger

The fixer runs on `workflow_run` (completed) of the workflows `Review` and `CI`, on
`workflow_dispatch` with `pr_number`, and for merge conflicts on `push` to `main` and a daily
`schedule` (the conflict scan).

- **Why not the `status` event.** The review job sets the `review` commit status with the workflow's
  `GITHUB_TOKEN`. Events caused by `GITHUB_TOKEN` do not start new workflow runs (except
  `workflow_dispatch` and `repository_dispatch`), so a `status` workflow would never fire for the
  review. `workflow_run` fires when the Review run has finished, after its publish job set the
  status, and it carries the run id needed to download the `review-pr-<n>` artifact.
- **What counts.** The route job reads the authoritative state through the API: the PR (open, not a
  draft, same repository, trusted author, labels, `mergeable_state`), the `review` commit status of
  the current head, and the newest run of each required workflow (`CI`) for that head. A run for an
  older head is ignored.
- **When a round starts.** Once the `review` status (`success`, `failure` or `error`) and every
  required workflow have finished on the head and at least one of them is red. Which completion
  triggered the run does not matter, so a red CI with a green review starts a
  round, and a head with both red is handled in one round. A red review waits for CI and a red CI
  waits for the review; a dispatch while one of them still runs does nothing. The review status is set before
  the Review run itself completes; a CI completion in that window finds no completed Review run (no
  findings artifact) and waits too, the Review run's own completion then starts the round.
- **One run per PR at a time.** The whole workflow has the concurrency group `fixer-pr-<n>` without
  cancellation. When Review and CI finish on the same head close together, the second run waits and
  then sees the state the first one left: a new head (pushed fix) or `needs-human`. GitHub keeps only
  one waiting run per group; a newer waiting run replaces an older one, which is harmless because
  each run reads the current state through the API.
- **Conflicts.** GitHub does not run `pull_request` workflows for a PR that has merge conflicts, so
  no Review or CI completion ever reports one. The conflict check therefore comes first in the
  route job, before review and CI are looked at, and the `scan` job finds conflicting PRs: on every
  push to `main` (a merge can make other PRs conflict) and once a day (a PR pushed while it already
  conflicted). The scan lists the open PRs, keeps every eligible one (same rules as below; no cap
  before the conflict filter), reads each once and re-reads the ones whose `mergeable` GitHub has
  not computed yet, up to `merge.mergeable_polls` times, and starts one `workflow_dispatch` run with
  `conflicts_only: true` per PR that actually conflicts, at most `merge.max_dispatch` per scan (the
  rest follow on the next scan). A PR that cannot be read or dispatched is reported and skipped;
  the others are still handled, and the scan job fails at the end so the error is visible. Each
  of those runs has the PR's own concurrency group, so a merge round never overlaps another round on
  the same PR; with `conflicts_only` a run whose PR no longer conflicts does nothing. The scan
  reads PR metadata only and never checks out PR code.
- **Only from the default branch.** `workflow_run` always runs the workflow file of the default
  branch. Manual dispatches are ignored unless they run on the default branch. Changes to the fixer
  therefore take effect after they are merged.

## Who is handled

- Same-repository PRs only, never forks (`head.repo` must be this repository).
  Workflow runs of fork PRs also need maintainer approval first (repository setting "Require
  approval for all outside collaborators"); keep it enabled on a public repository.
- Authors listed in `trusted_logins` of `.github/fixer/config.json` (the maintainers and the bot
  account).
- Drafts are skipped. PRs with the label `no-autofix` or `needs-human` are not fixed. Remove
  `needs-human` to let the fixer work on the PR again.

## Security model

| Job    | Token permissions                                   | Runs PR code       | Secrets                   |
| ------ | --------------------------------------------------- | ------------------ | ------------------------- |
| scan   | contents, pull-requests: read; actions: write       | no                 | none                      |
| route  | contents, pull-requests, statuses, actions: read    | no                 | none                      |
| fix    | contents: read, actions: read (artifact, CI logs)   | yes (pnpm, Claude) | `CLAUDE_CODE_OAUTH_TOKEN` |
| repair | contents: read                                      | yes (pnpm, Claude) | `CLAUDE_CODE_OAUTH_TOKEN` |
| push   | contents: read, actions: read                       | no                 | `FIXER_BOT_PAT`           |
| report | contents: read, issues: write, pull-requests: write | no                 | none                      |

- **Trusted fixer.** Prompt, rules, config and scripts are always taken from the default branch
  (`github.sha` of the `workflow_run`), never from the PR. A PR cannot weaken its own fixer.
- **The PAT never meets PR code.** Only the final push step has `FIXER_BOT_PAT`. The push job checks
  out the PR head without running anything from it, loads the commit from a git bundle produced by
  the fix job, re-checks it with the trusted `verify.mjs` (exactly one new commit whose parent is the
  reviewed head, round trailer, the same path and content policy as in the fix job; for a merge
  round exactly one merge commit whose parents are the reviewed head and the base tip, see
  [Merge conflicts](#merge-conflicts)) and pushes with hooks disabled. The push is a normal, non-force push of `<sha>:refs/heads/<branch>`, so it is
  rejected when the branch moved in the meantime. Pushes with the PAT (not `GITHUB_TOKEN`) start CI
  and the review again.
- **Checkouts** use `persist-credentials: false`. The fix job's `GITHUB_TOKEN` can only read.
- **The scan job** has `actions: write` only to start fixer runs with `workflow_dispatch`; it runs
  the trusted scripts from the default branch and nothing from a PR.
- **Claude's tools.** `--tools Read,Grep,Glob,Edit,Write,Bash` with `--permission-mode dontAsk`:
  every call that is not allowed by a rule is denied. Bash is allowed only for the prefixes in
  `bash_allow` and `bash_allow_per_package` of `config.json` (`pnpm lint`, `format:check`,
  `exec prettier --write`, `build`, `typecheck`, `test`, `check`, `smoke`, the per-package
  `--filter` forms, and `git status`, `git diff`, `git log`, `git show`). Claude Code splits
  compound commands (`&&`, `;`, `|`) and requires every part to match. Claude cannot stage, commit,
  push, reset or check out: the workflow commits. Edits under `.git/`, WebFetch and WebSearch are
  denied; `--setting-sources user` and `--strict-mcp-config` keep project settings and MCP servers
  of the PR out. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` removes the Anthropic and GitHub credentials
  from the environment of the commands Claude runs.
- **Sandbox for that scrub.** On Linux the scrub runs every command in bubblewrap, and Claude Code
  refuses to start without it. The runner image has no bubblewrap, so the fix job installs
  `bubblewrap` and `socat` first. Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`
  and ships no AppArmor profile for `bwrap`, so `bwrap` fails with
  `setting up uid map: Permission denied` (or `Failed RTM_NEWADDR` for the network namespace). The
  job then loads a profile `fixer-bwrap` that grants `userns` to the `bwrap` binary only (the
  profile Ubuntu documents for this case) instead of setting the sysctl to 0, which would lift the
  restriction for every process on the runner. A self-test (`bwrap --ro-bind / / --unshare-all ... true`) must pass before Claude
  runs; if it fails, Claude is skipped and the escalation says `Claude could not start:` with the
  first error line. Turning the scrub off is not an option: it is what keeps a test written by
  Claude from reading the OAuth token.
- **CI logs are untrusted.** A CI log is written by the PR's code, tests and scripts, and step names
  come from the PR's own `ci.yml`. The route job passes only job and step ids, names (printable
  ASCII, capped) and times. The fix job downloads the logs with its read-only token in the prepare
  step, before any PR code runs, and writes the excerpts only to `ci-failures.md` in the input
  directory, under a header that marks them as untrusted data. They never reach a step output, the
  job log, the step summary, a shell command or the PR comment (the comment names the steps only).
  Each excerpt is the failed step's own lines (cut by the step's time window, from its `Run` line to
  its exit code), with ANSI and control characters removed, workflow commands (`::x::`, `##[x]`)
  defused, secret-looking values replaced by `[REDACTED]` (GitHub, Anthropic, AWS and Slack tokens,
  JWTs, private keys, `Authorization`/`Bearer` values, credentials in URLs, `*password*=`,
  `*token*=` and similar assignments, long mixed-case-and-digit strings), lines cut at 400
  characters, the last 200 lines and at most 20 kB per step, at most 5 steps per round. Redaction
  runs on the joined step text before it is split and cut, so a multi-line secret such as a PEM
  key is replaced as a whole and a secret is never left half visible.
- **Limits of that model.** Allowing `pnpm test` or `pnpm build` after `Edit` means Claude (or a
  prompt injection in code or findings) can run arbitrary code through a test it writes. That is
  why the PAT is in a separate job, the fix job token is read-only, and only trusted authors' PRs
  are handled. A compromised fix job can at worst produce a bad commit; the push job still refuses
  anything outside the policy, and a maintainer reviews every PR before merging.
- **Secrets as repository secrets.** `CLAUDE_CODE_OAUTH_TOKEN` and `FIXER_BOT_PAT` are repository
  secrets by decision (zizmor `secrets-outside-env` is suppressed for them). Only the fix job's
  Claude step and the push job's push step reference them.

## Round counting and loop control

- Every fixer commit carries the trailer `Conclavix-Fixer-Round: <n>`.
- The route job walks the PR's commits from the tip backwards while they carry the trailer and takes
  the highest round. The first commit without the trailer (a human commit) ends the walk, so a human
  push resets the count.
- The next round is that number plus one. A merge round counts like a fix round (its merge commit
  carries the trailer). With 3 rounds done and the review or CI still red, or the branch still
  conflicting, the PR is escalated (`round_limit`) instead of starting round 4; the comment names
  what is still open (blocking findings, red CI, merge conflicts).
- A round that does not push always escalates, which sets `needs-human` and stops further rounds.
  The loop is bounded: each round either pushes (at most 3 times since the last human commit) or
  stops.
- The fix job has a per-PR concurrency group without cancellation; a newer queued run replaces an
  older queued one.

## What a round does

1. `prepare.mjs` validates the review artifact (`findings.json`: live mode, same PR, same head) and
   selects the **blocking** findings. Code findings become `F1..Fn` for Claude. Blocking scope
   findings (`S1..`) are never given to Claude; they are escalated (rule F-ESC-2). When the review
   is not red, no review artifact is used.
   Failed steps of the newest red CI run become `C1..Cn` with a log excerpt (see the security
   model). Infrastructure failures (`I1..`) are never given to Claude and escalate as `ci_infra`:
   decided by the route job without logs (setup steps such as `Set up job`, `actions/*`,
   `pnpm/action-setup`, `Start MongoDB`, `Start Redis`; a run or job that timed out or was
   cancelled; a job without a failed step, for example a lost runner) and by `prepare.mjs` on the
   excerpt (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `ENOTFOUND`, registry fetch errors, rate limits,
   502/503/504, `No space left on device`, runner shutdown, Docker daemon errors; the list is
   `ci.transient_patterns` in `config.json`). When the review is green and every CI failure is
   infrastructure, the route job escalates `ci_infra` directly and no fix job runs.
2. Claude works on the findings with the rules in `.github/fixer/rules.md`: re-check the head first
   (`already_fixed`), dispute wrong findings (`disputed`), hand product, scope, security,
   dependency, CI and migration decisions to a human (`needs_human`), otherwise write a proof test
   that fails, fix, and see it pass (`fixed`). For a failed CI step (rules F-CI) Claude runs the
   step's command: when it passes on the unchanged head or the log shows an infrastructure cause,
   it reports `not_reproducible` (escalated as `ci_infra`) and changes nothing; otherwise the proof
   is that command failing before and passing after the fix, plus a regression test when a
   behaviour bug caused it. The result is structured output (`schema.json`).
3. `collect.mjs` stages the work tree and checks the policy (`config.json`):
   - never: `.env*`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (deliberate build policy such as the
     `msgpackr-extract` setting), `.npmrc`, `.pnpmfile.cjs`/`.pnpmfile.mjs` (run by `pnpm install`);
   - guarded, allowed only when a selected review finding is about that exact file (a failed CI
     step never unlocks one, so a failure caused by CI, workflow or tool configuration goes to a
     human): `.github/**`,
     `package.json` files, ESLint, Prettier, TypeScript, Vite and Vitest configs, `Dockerfile*`,
     `deploy/**`, `scripts/**`, `.nvmrc`;
   - no deleted or renamed test files, no binary changes;
   - no added `eslint-disable`, `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `.skip`, `.only`,
     `.todo`, `xit`, `xdescribe`;
   - at most 150 changed non-test lines.
4. Gates, only when there is a change and the policy holds: `pnpm install --frozen-lockfile`,
   `pnpm check`, `pnpm smoke` when the head's `package.json` defines it. MongoDB and Redis run as
   in CI. The gates must not change tracked files. When `pnpm check` or `pnpm smoke` fails, the
   round gets one [gate repair pass](#gate-repair-pass) before it gives up.
5. `finalize.mjs` decides (`decide.mjs`):
   - push when the change is non-empty, every gate is green, the policy holds and at least one
     finding is `fixed`;
   - escalate when anything is left open (disputed, needs a human, not reported, scope,
     `not_reproducible` or infrastructure CI failures with the cause `ci_infra`), when a
     gate or the policy failed, when a fix has no proof test that failed before the fix, or when
     Claude returned no valid result. When Claude did not start (sandbox self-test failed, or the
     Claude step failed without writing any output) the cause reads `Claude could not start:` with
     the first error line of the sandbox step, or a pointer to the step log. The error file lives
     outside the directories Claude may write to and is read only when the sandbox step failed.
     The commit is written by the workflow as the bot account (`bot_login`): a conventional subject
     from Claude (`fix:`/`test:`, otherwise a fixed default), a body listing each fixed finding and
     CI step with what changed and the proof, the review and CI run links, the round trailer and the
     attribution line.
6. `report.mjs` posts one comment on the PR and sets labels. It lists every addressed finding and CI
   step (`C1 CI: <job> / <step>`) with what was changed and the proof command. Escalations mention
   the maintainer in `escalation_mention` and list the open findings and CI steps with the fixer's
   explanation, the policy violations and the gate results. The job summary shows the round,
   Claude's cost, duration and turns.

The fixer never force-pushes, never rebases and never merges a PR. Conflicts are handled by merge
rounds, never inside a fix round.

## Gate repair pass

When the round's change is otherwise accepted (the decision would push with green gates: policy
holds, findings fixed or every conflict resolved) and `pnpm check` or `pnpm smoke` fails, the round
gets one repair pass by Claude (`repair.mjs`, `repair-prompt.md`, `repair-schema.json`). A failed
`pnpm install --frozen-lockfile` is never repaired (lockfile, human).

The repair runs in its own job (`repair`) on a fresh runner. The gates of the fix job execute code
Claude wrote in this round outside the Claude sandbox; on the same runner that code could leave a
process behind or change files on disk (the downloaded actions, `~/.claude`) and reach a later step
that holds `CLAUDE_CODE_OAUTH_TOKEN`. On the fresh runner, as in the fix job before its first Claude
step, only the PR head's own MongoDB and Redis start scripts (run before the round's tree is
restored) and `pnpm install` have run when Claude starts (the workspace has no lifecycle scripts,
`allowBuilds` disables dependency builds, and a fix round that changes `package.json` is not
repaired). In addition, every PR-code step (install, check, smoke)
runs through `isolate.sh` in its own PID namespace (bubblewrap), so no process outlives its step.
Files on the runner, including the trusted scripts extracted to `$RUNNER_TEMP`, stay writable for
round code, so every step of a job after its gates is treated as influenceable: what such a step
produces is checked again by a later job with its own fresh copy of the fixer (the repair job's
restore step, the push job's `verify.mjs`).

1. **Input** (fix job, `repair.mjs prepare`). The gate steps write their output to
   `$RUNNER_TEMP/fixer-gates/<gate>.log`. That output comes from PR code and is untrusted. The
   script decides whether a repair runs (same decision as `finalize.mjs` with green gates, and a
   budget left) and hands the round over as an artifact (`fixer-handoff-pr-<n>`): a bundle with one
   commit of the collect step's tree on the PR head, the input directory, the first Claude run's
   result, the tracked files named in the gate output (prettier, eslint, tsc, vitest paths, at most 20) and the raw excerpt. The fix job then stops without a commit. Everything in the handoff was
   written after round code ran in the gates and is treated as untrusted; only the step outcomes
   of the gates, the first run's cost (read by the collect step before any PR code ran) and the
   gate name (one of `check`, `smoke`) are passed on as job outputs.
2. **Restore and check** (repair job, `repair.mjs restore`, before any PR code runs on the repair
   runner). The bundle's commit must have the PR head as its only parent; its tree is staged on top
   of the PR head and checked again with the round policy: a fix round against the selected review
   findings and without any `package.json` change (so install cannot run code of the round), a
   merge round with `checkResolution`. A tree that fails stops the job. The step then computes on
   its own: the allowed files (files the round changed plus at most 20 named tracked files),
   `repair.md` (the excerpt sanitized again as in `cilog.mjs`: ANSI and control characters removed,
   secrets redacted, workflow commands defused, last 200 lines, 20 kB), the budget, the prompt and
   the tool rules.
3. **Repair.** Same tools, sandbox and Bash allow list (`pnpm exec prettier --write`,
   `pnpm exec eslint --fix` included). Budget: `FIXER_REPAIR_MAX_BUDGET_USD`, reduced to what
   `FIXER_MAX_BUDGET_USD` has left after the first Claude run of the round (its cost is read by
   the collect step right after that run, before any PR code runs); with less than $1 left
   no repair runs, so one round never spends more than `FIXER_MAX_BUDGET_USD`. Rules: CI-fix rules,
   smallest change, no weakening, no guarded or forbidden path, `needs_human` otherwise. Output:
   `decision` (`repaired` or `needs_human`), `repair_edits` (path and reason per file), `summary`.
4. **Policy** (`repair.mjs collect`): the repair diff alone (handed-over tree to the repaired tree)
   may only touch allowed files, every path must be listed in `repair_edits`, no forbidden or
   guarded path, no weakening patterns, no binary change, no deleted test, at most `max_fix_lines`
   (150) non-test lines. Then the whole round is checked again: a fix round with the usual policy
   (150-line total), a merge round with `checkResolution`, where the repair paths have their own
   150-line budget next to the conflict files and the small extra-edit budget.
5. **Gates again**: install, check and smoke (`Gate after repair: ...`). Only when they are green
   does `finalize.mjs` (in the repair job) commit; the repair edits are listed in the commit message
   and the PR comment, and the job summary shows the repair run's cost next to the first run's and
   their total (the first run's cost from the collect step's output, not from the handoff).
   Otherwise the round escalates as before, with the repair outcome and the cause
   (`repair pass for <gate>: ...` or `gates failed: ...`).
6. **Push.** The repair stays in the round's single commit and round count. The repair verdict
   (`ok`) and the repair paths come from the repair collect step, which runs before the re-run
   gates; the repair job's `push` output is only true when that verdict is. The paths reach the
   push job as a job output, never through a file. `verify.mjs` parses them (at most 50 relative
   paths) and accepts edits on them in a merge commit within the repair budget, still outside
   forbidden and guarded paths and without weakening; for a clean merge, files other than the
   repair paths must equal git's merge. A fix commit stays under the normal fix policy.

## Merge conflicts

A round in merge mode (route `mode: merge`) runs in the same fix job, with the same sandbox, tools,
gates and token split as a fix round. Only same-repository PRs of trusted authors without
`no-autofix`/`needs-human` are handled; the round limit applies.

1. **Merge without committing** (`prepare.mjs`, before any PR code runs): the PR head is checked out
   with full history and `git merge --no-ff --no-commit <base tip>` runs with hooks off (merge
   drivers can only be git's built-in ones). The base tip is the one the route job read from the
   API. The conflicted files are computed with `git merge-tree --write-tree` (the same computation
   the push job repeats) and must match the unmerged paths `git merge` left.
   - The base is already contained: nothing to merge, a short comment, no escalation.
   - Merged cleanly: no Claude; the merge goes straight to the gates.
   - Conflicts the fixer never resolves stop the round before Claude, with `needs-human`: the
     lockfile, `pnpm-workspace.yaml`, `.npmrc`, `.env*` (forbidden paths), `.github/**` and every
     other guarded path (lint, format, TypeScript, Vite configs, `Dockerfile*`, `deploy/`,
     `scripts/`, `.nvmrc`), files deleted or renamed on one side, binary files, symlinks and
     submodules, more than `merge.max_files` conflicted files.
   - A conflicted `package.json` is merged by the workflow, not by Claude: every field and every
     script may be changed on at most one side (or identically on both); `scripts` is merged per
     script name, so two branches that each added a script keep both. Anything else (the same
     script or a dependency changed differently on both sides) escalates.
2. **Claude resolves the rest** with `merge-prompt.md` and `merge-schema.json`. It gets only the
   conflicted files (`conflicts.md`: per file the commits and the change of each side since the
   merge base, marked as data). Task: keep the intent of both sides, no new behaviour, drop
   neither side's changes, edit other files only where the resolution strictly needs it (for
   example a call to a signature the base changed), and report each file as `resolved` (with the
   resolution and the reasoning) or `needs_human` (both sides changed the same logic differently and
   cannot both be kept). Every other changed file must be listed in `extra_edits` with a reason.
   Claude cannot run `git merge`, `git commit` or any other writing git command.
3. **Policy** (`collect.mjs`, again in `verify.mjs`): the resolved tree is compared with git's own
   merge (`git merge-tree`, conflicted files with markers). Only the conflicted files may differ,
   no markers may be left, no conflicted file may be deleted, a `package.json` must be exactly the
   union above, edits outside the conflicted files must not touch forbidden or guarded paths and
   stay within `merge.max_extra_lines` lines, the conflicted files within
   `merge.max_conflict_lines` lines, and the usual rules hold (no binary changes, no deleted test
   files, no added `eslint-disable`/`@ts-ignore`/`.skip`/... lines). A clean merge must be exactly
   git's merge.
4. **Gates** unchanged: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm smoke`, without the
   PAT, with the same [gate repair pass](#gate-repair-pass) as a fix round. A merge round may only
   touch the conflicted files, and CI never runs on a conflicting PR, so without the repair a gate
   that was already red on the PR head (for example a file prettier rejects) would block the merge
   and the CI fix at the same time.
5. **Decision** (`mergedecide.mjs`): push only when every conflicted file is resolved, the policy
   holds, every extra edit is explained and the gates are green. Otherwise nothing is pushed and the
   PR is escalated with the cause `conflict_unresolved: ...` or `gates failed: <gate>`; a partly
   resolved merge is never pushed.
6. **Commit** (`finalize.mjs`): the workflow writes the merge commit with `git commit-tree` from the
   tree the policy and the gates saw, with exactly two parents, the PR head and the base tip (so
   nothing done to `HEAD` or `MERGE_HEAD` during the round can change them), the subject
   `Merge branch '<base>' into <branch>`, one entry per conflicted file with resolution and
   reasoning, and the round trailer, and bundles it.
7. **Push** (`verify.mjs`): accepts exactly one merge commit whose parents are the reviewed head and
   the base tip, with the round trailer, and repeats the policy of step 3 against its own
   `git merge-tree`. The merged base commit must still be on the base branch. When the branch moved
   on after the route job read it, the merge is pushed anyway: it is still a correct merge of a
   base commit, the round is counted (so a busy base branch cannot make merge rounds unbounded), and
   if the newer tip conflicts again, the scan of that push starts the next round. The push itself is the same non-force push as for a fix commit (a merge commit on top of the
   head is a fast-forward), with the bot PAT, so CI and the review run again on it.
8. **Report**: the comment lists every conflicted file and how it was resolved (or why it needs a
   human), the extra edits, and the gates. A maintainer reviews and merges the PR as always.

The conflict scan starts fixer runs with `workflow_dispatch` using the workflow's `GITHUB_TOKEN`, so those runs are initiated by `github-actions[bot]`. `claude-code-action` refuses bot actors unless they are listed, therefore `fix.yml` sets `allowed_bots: github-actions`. Only workflows in this repository can dispatch as that bot.

## No automatic CI re-run

The fixer never re-runs CI, not even for a failure that looks transient. A re-run needs
`actions: write` on a job token, a misclassified code failure would be retried silently, and a flaky
test is a problem a human should see. A `ci_infra` escalation names the failed steps; re-running
the failed jobs is one click for a human. Removing `needs-human` afterwards lets the fixer work on
the PR again.

## Merge-ready

When a Review or CI run finishes and the head has `review` = `success` and the newest `CI` run
succeeded, the PR gets `merge-ready` (and loses `needs-human`) with a short comment. When the review
or CI turns red again on a later head, `merge-ready` is removed. The per-PR concurrency group makes
the second of two simultaneous completions see the label and stay quiet.

## Configuration

| Name                          | Kind                | Default           | Purpose                                                      |
| ----------------------------- | ------------------- | ----------------- | ------------------------------------------------------------ |
| `CLAUDE_CODE_OAUTH_TOKEN`     | repository secret   | (required)        | Claude Code OAuth token (`claude setup-token`)               |
| `FIXER_BOT_PAT`               | repository secret   | (required)        | PAT of the bot account, push access + `workflow` scope (1)   |
| `FIXER_MODEL`                 | repository variable | `claude-opus-5-5` | Model for the fixer                                          |
| `FIXER_MAX_BUDGET_USD`        | repository variable | `25`              | Abort a runaway round                                        |
| `FIXER_REPAIR_MAX_BUDGET_USD` | repository variable | `10`              | Abort a runaway gate repair pass                             |
| `.github/fixer/config.json`   | file                |                   | Trusted logins, labels, round limit, policy, Bash allow list |

(1) A merge round pushes a merge commit that brings in every base change since the merge base. When
those include files under `.github/workflows/`, GitHub rejects the push unless the token may update
workflows: the `workflow` scope for a classic PAT, "Workflows: read and write" for a fine-grained
one. Without it such a merge round escalates with "could not be pushed".

## Manual run and first live test

```sh
gh workflow run fix.yml -f pr_number=<n>
```

A manual run behaves like a finished Review or CI run for the PR's current head: it merges the base
when the PR conflicts, fixes when the review and CI have finished and at least one is red, escalates
`ci_infra` when only CI is red for infrastructure reasons, labels `merge-ready` when review and CI
are green, and does nothing otherwise. `-f conflicts_only=true` restricts it to the merge.

Safe first live test after merging: pick one open PR of a trusted author with a red `review` status
whose findings are small, put `no-autofix` on every other open PR with a red review, run the
command above for that PR and watch the run. Expected: one commit by the bot account with the round
trailer, a comment, and a new Review and CI run on the new head. Remove `no-autofix` from the other
PRs afterwards.

## Tests

`pnpm test:fixer` (part of `pnpm test`) covers trust checks, round counting, routing (including red
CI with a green review, both red, `ci_infra`, conflicting PRs, the conflict scan and the round-limit
text), the merge mode against real git repositories (conflict classification, the `package.json`
union, the accepted merge-commit shape and the rejected ones: wrong or extra parents, extra commits,
left markers, protected-path conflicts, unexplained or oversized edits outside the conflict), the
gate repair pass (when it runs, files named in gate output, the repair policy, repair paths in the
merge verification, the re-run gates, commit message and comment), workflow aggregation, CI failure classification,
log excerpt slicing, ANSI stripping, command defusing, redaction and capping, finding selection, the tool allow list, the path and content policy against a real
git repository, the push decision, the commit message, the bundle verification and the PR comment
and label plan.
