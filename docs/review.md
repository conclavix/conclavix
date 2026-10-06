# Automated review

Every pull request from a branch of this repository gets an independent review by Claude. The
workflow is `.github/workflows/review.yml`; the reviewer itself (prompt, rules, output schema and
helper scripts) lives in `.github/review/`.

## How it works

```text
pull_request (opened, synchronize, reopened, ready_for_review)
  review job   contents: read, pull-requests: read
    1. check out the PR head (full history, no persisted credentials)
    2. load .github/review from the PR's base commit (trusted copy)
    3. prepare.mjs: diff against the merge base, changed files, untrusted author claims, prompt
    4. claude-code-action: Claude with Read, Grep and Glob only, structured output (schema.json)
    5. finalize.mjs: validate output, anchor findings on diff lines, metrics, job summary, artifact
  publish job  pull-requests: write, statuses: write   (never runs Claude or PR code)
    6. publish.mjs: one PR review with inline comments and a summary, commit status "review"
    7. on any other outcome (failed, cancelled, timed out, publish failed): status "review" = error
```

- **Independence.** Claude sees the diff, the repository at the PR head, the rules and the PR title,
  description and commit messages, which are marked as untrusted claims of the author. It never sees
  PR comments, earlier reviews or CI output. The prompt asks it to attack the change, not to explain
  it, and to report only findings it can back with code references.
- **Read-only.** Claude gets `--tools Read,Grep,Glob` (no Bash, no Edit/Write, no web, no MCP),
  `--permission-mode dontAsk` (anything else is denied, including reads outside the checkout and the
  input directory), `--disallowedTools "Read(./.git/**)"`, `--setting-sources user` (no project
  settings from the PR) and `--strict-mcp-config`. Its job token can only read the repository.
- **Trusted reviewer.** The prompt, rules and scripts are taken from the base commit of the PR, so a
  PR cannot weaken its own review. Only when the base has no `.github/review` yet (the PR that
  introduces it) the PR's own copy is used, with a warning in the run.
- **Result.** Findings are `blocking` or `non-blocking` (rules: `.github/review/rules.md`).
  A blocking finding with a confidence below `REVIEW_MIN_BLOCKING_CONFIDENCE` is shown as
  non-blocking. The commit status `review` is `failure` when blocking findings remain, `success`
  otherwise, and `error` when the review did not complete: the review job failed, timed out or was
  cancelled, or publishing the review or its status failed. The `error` is not set when the run was
  superseded: if the PR's head has moved on, the newer run owns the new head's status, and if a
  newer run already set the status for the same head, it is not overwritten. A newer run for the
  same head that is still running replaces the `error` when it finishes. Findings on lines outside the diff are
  anchored on the nearest changed line of the same file or listed in the review body.
- **Re-review.** Each push starts a new review (a running one for the same PR is cancelled). The
  review body carries a hidden marker with the findings, always as its last part; the next round
  lists findings of the previous round that are gone as resolved (same file, within 10 lines or a
  similar title counts as still present). Model text is sanitised before it is posted (HTML comments
  and mentions are neutralised; a suggestion containing an HTML comment is dropped), so it cannot
  forge a marker. If GitHub rejects an inline comment, all inline comments are moved into the body
  before the marker, as many as fit GitHub's body size limit.
- **Metrics.** Cost, duration, turns and token usage from the Claude run are written to the job
  summary, the review body and `metrics.json` in the `review-pr-<n>` artifact.

Drafts are skipped; marking a PR ready for review triggers the review.

## Configuration

| Name                             | Kind                | Default           | Purpose                                        |
| -------------------------------- | ------------------- | ----------------- | ---------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`        | repository secret   | (required)        | Claude Code OAuth token (`claude setup-token`) |
| `REVIEW_MODEL`                   | repository variable | `claude-opus-5-5` | Model for the review                           |
| `REVIEW_MAX_BUDGET_USD`          | repository variable | `30`              | Abort a runaway review                         |
| `REVIEW_MIN_BLOCKING_CONFIDENCE` | repository variable | `0.6`             | Below this, blocking becomes advisory          |

Without the secret the review job ends with a notice and nothing is posted. To make the review
mandatory, require the status check `review` in the branch protection of `main`.

## Fork pull requests

Fork pull requests are **not reviewed automatically**. GitHub does not pass secrets to
`pull_request` runs from forks, and the workflow skips them with a notice (job `fork-notice`).

A maintainer-triggered path (for example a `safe-to-review` label on a `pull_request_target`
workflow) is deferred on purpose:

- `pull_request_target` runs with the repository's secrets and a write token. The review would have
  to keep the checkout of the fork's code strictly as data (never install, build or run it), keep
  the write permissions in a separate job, and re-check that the labelled head is the reviewed head.
- Claude would read attacker-written code and text with the OAuth token in its process
  environment. With only Read, Grep and Glob and `dontAsk` it cannot run commands or read outside
  the checkout, but this has not yet been tested against prompt injection in this setup.
- Until it is, a maintainer reviews fork PRs manually, or pushes the fork's commits to a branch in
  this repository after reading them, which triggers the normal review.

## Blind evaluation (eval mode)

Run the workflow manually to review a historical PR without touching it:

```sh
gh workflow run review.yml -f pr_number=7
gh workflow run review.yml -f pr_number=7 -f head_sha=<older head commit>
```

The run checks out the PR's head (`refs/pull/<n>/head` or `head_sha`), diffs it against the merge
base with the branch it was merged into (first parent of the merge commit, else the recorded base),
reads only the PR's title and description through the API, and never reads comments or reviews.
Nothing is posted to the PR. The result is in the job summary and in the `review-pr-<n>` artifact
(`findings.json`, `summary.md`, `review-payload.json`, `metrics.json`, `diff.patch`).

## Changing the reviewer

Edit `.github/review/` in a normal PR; the change takes effect for PRs opened against the new base.
Run the helper tests with `pnpm test:review` (part of `pnpm test`).
