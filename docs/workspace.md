# Project workspaces

Every project has its own git repository on the server. Agents will write code there (from the
coding-agent package on); the board shows branches, commits, diffs and files in the project's
**Code** tab and offers the code as a ZIP download. A remote (GitHub, GitLab) is optional and
comes later; the local repository is complete on its own.

## Layout

```
${WORKSPACE_ROOT}/
  repos/<projectId>.git                 bare repository of the project
  workspaces/<projectId>/<ISSUE-KEY>/   separate clone for one issue, branch cvx/<ISSUE-KEY>
```

- **Bare repository.** Created when the project is created, or on first access if that failed
  (and for projects that existed before this feature). It starts with an empty commit
  "Initialize repository" on `main` and has no remote. Creation happens in a temporary directory
  that is renamed into place, so a half-created repository is never visible.
- **Issue workspace.** A separate clone (`git clone --no-hardlinks --single-branch`) of the
  issue branch `cvx/<ISSUE-KEY>`, which is cut from `main` in the bare repository when it does not
  exist yet. The clone has **no remote** and shares no files with the bare repository: no
  hardlinks (a hardlinked object file would be the same inode), no alternates, no `git worktree`
  (a worktree shares the bare repository's git directory, so a sandboxed agent that may write in
  its worktree could rewrite other issues' branches).
- **Getting results back.** The server fetches the issue branch from the clone into the bare
  repository (`syncIssueBranch`). Only `refs/heads/cvx/<ISSUE-KEY>` is fetched, no tags, no other
  branches. Updates are fast-forward only; a rewritten branch is refused with 409 unless an admin
  forces it.
- **The Code tab reads only the bare repository.** What an agent has not synced is not shown.

The issue records its branch (`issue.branch`) once its workspace exists. The issue page links the
branch into the Code tab.

## Configuration

| Variable         | Meaning                                           | Default            |
| ---------------- | ------------------------------------------------- | ------------------ |
| `WORKSPACE_ROOT` | Directory for repositories and issue clones (API) | `./data/workspace` |
| `GIT_BIN`        | git executable; 2.41 or newer (`%(ahead-behind)`) | `git`              |

`WORKSPACE_ROOT` is validated at startup (non-empty, no control characters) and resolved to an
absolute path. The API logs the git version and the root after it starts, and warns if git is
missing or too old. Without git every code route fails, the rest of the board keeps working.

Not to be confused with `WORKSPACES_ROOT`, the runner's per-agent run directories.

## Docker and the runner host

The API image installs git (Debian trixie: 2.47) and sets
`WORKSPACE_ROOT=/var/lib/conclavix/workspace`, owned by the image's `node` user (uid 1000).
`deploy/compose.yaml` mounts a volume there:

```yaml
volumes:
  - ${WORKSPACE_DIR:-workspace-data}:/var/lib/conclavix/workspace
```

Without `WORKSPACE_DIR` this is the named volume `conclavix_workspace-data`. On the runner host a
host directory is the better choice, because the runner on the host will need the issue clones once
agents write code:

```sh
sudo install -d -o 1000 -g 1000 -m 0750 /srv/conclavix/code
echo 'WORKSPACE_DIR=/srv/conclavix/code' | sudo tee -a /opt/conclavix/src/deploy/.env
sudo docker compose up -d api      # in /opt/conclavix/src/deploy, after the image is rebuilt
```

Back the directory up together with MongoDB: the repositories are the only copy of the code
until a remote is attached.

## API

Reading needs the `read` capability (every role, including viewers). Workspaces are admin and
owner only (`agents` capability).

| Route                                          | What                                                          |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `GET /api/projects/:id/branches`               | Branches with ahead/behind against `main` and the last commit |
| `GET /api/projects/:id/commits?ref&limit&skip` | History of a ref, newest first, `nextSkip` for the next page  |
| `GET /api/projects/:id/commits/:sha`           | Commit with message body and diff against its first parent    |
| `GET /api/projects/:id/tree?ref&path`          | Directory entries at a ref                                    |
| `GET /api/projects/:id/file?ref&path`          | File content at a ref (`binary`, `tooLarge` flags)            |
| `GET /api/projects/:id/raw?ref&path`           | An image at a ref, raw (see [Images](#images))                |
| `GET /api/projects/:id/compare?branch`         | Branch against `main`: merge base, commits, diff              |
| `GET /api/projects/:id/archive?ref=main`       | ZIP from `git archive`, `<KEY>-<ref>-<shortsha>.zip`          |
| `POST /api/issues/:ref/workspace`              | Create (201) or return (200) the issue's clone and branch     |
| `POST /api/issues/:ref/workspace/sync`         | Fetch the issue branch into the bare repository (`{force}`)   |
| `DELETE /api/issues/:ref/workspace?force`      | Remove the clone; the branch stays                            |

Removing a workspace is refused (409) while any ref of the clone (HEAD, any branch, tag or stash)
holds commits the project repository lacks, or the clone no longer has its issue branch;
`force=true` discards them. Uncommitted files in the clone are not inspected (that would mean
running git inside the clone) and are always discarded.

Audit log entries: `project.archive_downloaded`, `issue.workspace_created` (exactly one per
clone: the issue stores the id of the clone it was audited for, so concurrent requests, the runner
and retries do not repeat it),
`issue.branch_synced` (with before/after and `forced`) and `issue.workspace_removed`.

### Limits

| What                     | Limit                                          |
| ------------------------ | ---------------------------------------------- |
| File shown in the viewer | 1 MiB (larger: `tooLarge`, no content)         |
| Image served raw         | 10 MiB (larger: 413 `file_too_large`)          |
| Binary detection         | NUL byte in the first 8000 bytes (as git)      |
| Patch text of one diff   | 2 MiB, then `truncated`                        |
| Patch text of one file   | 256 KiB, then `truncated`                      |
| Files in one diff        | 1000                                           |
| File list of one diff    | 4 MiB of `--raw`/`--numstat`, then `truncated` |
| Branches listed          | 200                                            |
| Commits in a comparison  | 250                                            |
| One git call             | 15 s                                           |
| ZIP download             | 5 min, 1 GiB                                   |

### Images

`GET /api/projects/:id/raw?ref&path` serves images from the bare repository so the Code tab and
Markdown can show them. `ref` and `path` are validated exactly like the file route.

- Types by file extension: `png`, `jpg`/`jpeg`, `gif`, `webp`, `svg` with the matching
  `Content-Type`. Any other file answers 415, a missing one 404, one above 10 MiB 413 (checked
  from the tree entry before any content is read).
- `ETag` is the blob id, so an unchanged image answers 304 on every branch and commit.
  `Cache-Control` is `private, no-cache` for branch refs (revalidate every time) and
  `private, max-age=31536000, immutable` when `ref` is a full commit id; the Code tab addresses
  images by commit id.
- `X-Content-Type-Options: nosniff` and a `sandbox` CSP, so an SVG opened on its own cannot run
  scripts.
- Same capability as every other read route (`read`), by session cookie or token.

**Screenshots in issue documents and comments.** Agents commit screenshots under
`docs/screenshots/<module>/` and embed them in documents, comments and run results with a
`repo:` path:

```markdown
![list view](repo:docs/screenshots/feedback/list.png)
```

`repo:` resolves against the issue's branch (`cvx/<KEY>`) once its workspace exists, otherwise
against `main`; the web UI rewrites it to the raw route. Paths with spaces need angle brackets:
`![x](<repo:docs/a b.png>)`. Besides `repo:`, Markdown images load from `https://` URLs of other
origins and from this origin's raw and avatar routes only (an image must never trigger another
GET such as the audited archive); `http:`, `data:`, protocol-relative, relative and other
same-origin URLs show the alt text instead. Clicking an image opens it enlarged. Coding agents get these instructions in their
run prompt.

## Agent access (read-only MCP tools)

Every agent can read its project's code through the agent API (`POST /mcp`), with or without
`codeAccess` and without a sandbox. This is how reviewing roles (CTO, Security Auditor, PR
Reviewer) see a branch instead of relying on a builder's handover excerpts. The tools read the
bare repository through the same reader as the Code tab, so they show what has been synced into
the server repository (a coding run's commits are synced after the run), not work in progress.

| Tool              | What                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `list_branches`   | Branches, main first then newest: ahead/behind `main`, last commit; `offset`/`limit`                           |
| `get_branch_diff` | `branch` against its merge base with `base` (default `main`), like a pull request: per-file unified diff hunks |
| `read_file`       | A file at a ref, from `startLine`, at most `maxLines` lines; continue with `nextStartLine`                     |
| `list_files`      | One directory at a ref (root by default): path, type (`blob`/`tree`/`commit`), size; `offset`/`limit`          |
| `get_commit_log`  | History of a ref, newest first; `skip`/`limit`, `nextSkip` for the next page                                   |

`get_branch_diff` takes `paths` (up to 20 files or directories, literal pathspecs) and
`withPatch: false` for a cheap list of every changed file with status and line counts. Binary
files are reported with `binary: true` and no patch. Each answer names `base`, `branch`, both
commit ids, the merge base, ahead/behind and the first 20 commits of the branch.

**Scope.** The project is always the project of the run's issue; there is no project parameter.
Every call checks that the agent is enabled in that project (the project-agent resolver: project
override, else the agent's default; the lead is always enabled) and is refused with
`agent_disabled_in_project` otherwise, also when access changes while the run is going. The tools
are served only when the API has a workspace configured.

**Validation.** Refs and paths go through the same checks as the Code tab (see Security notes):
the ref pattern (no leading `-`, no `..`), `git check-ref-format --branch`, resolution to a full
commit id; repository-relative paths only, looked up in the commit's tree. Git failures reach the
agent as `repository_unavailable` without git's own message.

**Limits.** Tighter than the Code tab's, so one call cannot flood a run's context
(`CODE_TOOL_LIMITS` in `apps/api/src/modules/agent-api/code-tools.ts`). The Code tab limits below
still apply underneath (1 MiB per file, 2 MiB per diff, 15 s per git call).

| What                              | Limit                                                             |
| --------------------------------- | ----------------------------------------------------------------- |
| Branches per page                 | 30 by default, 100 at most (200 newest branches overall)          |
| Diff files per page               | 20 by default; 50 with patches, 300 with `withPatch: false`       |
| Patch text of one file            | 20,000 bytes, then cut with a `[conclavix: patch cut ...]` marker |
| Patch text of one page            | 60,000 bytes; the page ends early, `nextOffset` continues         |
| Commits listed with a diff        | 20 (`moreCommits` counts the rest)                                |
| Lines of one `read_file`          | 400 by default, 2000 at most, and 60,000 bytes                    |
| Entries per `list_files` page     | 200 by default, 500 at most                                       |
| Commits per `get_commit_log` page | 20 by default, 50 at most                                         |
| Commit subjects                   | 200 characters                                                    |

`patchTruncated: true` marks a file whose patch was cut (by these limits or the diff size limit);
`diffIncomplete: true` means the server-side diff itself was cut (more than 1000 files or 2 MiB
of patch text), so narrow it with `paths`.

**Logging.** There is no separate audit entry: like every agent tool call, each call and its
result appear in the run log (tool name, arguments, result), which goes through the run-log
secret redaction. The tools never write.

**Permissions in the runner.** Agents without code access run claude with `--permission-mode
dontAsk` and pre-approve the whole `conclavix` MCP server (`mcp__conclavix`, the rule the coding
sandbox uses as well). The server decides per run which tools exist, so new tools need no change
in the runner.

## Security notes

- **No shell, no options from requests.** git runs through `execFile`/`spawn` with fixed argument
  arrays. Refs must match a strict pattern (no leading `-`, no `..`), pass
  `git check-ref-format --branch` and are resolved to a full commit id before any other command
  sees them. Commit ids must be hex. Paths must be repository-relative (no leading `/` or `-`, no
  `.`/`..`/empty segments, no control characters) and are looked up with `git ls-tree` in the
  commit's tree; content is read by object id with `git cat-file blob`. Nothing is read from the
  file system by path, so `../` cannot leave the repository.
- **Literal pathspecs.** `GIT_LITERAL_PATHSPECS=1`, so `:(glob)`, `*` and friends are plain
  names.
- **Minimal environment.** git gets `PATH`, `LC_ALL=C` and git variables only, never the API's
  secrets. System and user git configuration are ignored (`GIT_CONFIG_NOSYSTEM`,
  `GIT_CONFIG_GLOBAL=/dev/null`), prompts are off.
- **Nothing in a repository can start a program in the server process.** Every call sets
  `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `protocol.allow=never`, an empty
  `diff.external`, `--no-replace-objects`; diffs use `--no-ext-diff --no-textconv`. Command-line
  configuration overrides repository configuration.
- **Issue clones are untrusted.** The server never runs git inside a clone. A sync runs from the
  bare repository: `git fetch <clone>/.git refs/heads/cvx/<KEY>:refs/heads/cvx/<KEY>` with
  `protocol.file.allow=always` for that call only, `transfer.fsckObjects=true`, `--no-tags`,
  `--no-recurse-submodules`, `--no-write-fetch-head`. Before that, `<clone>/.git` must be a real
  directory (not a symlink, not a gitfile) without `commondir` or `objects/info/alternates`, and
  everything inside it must be a directory or a regular file with a single link: a symlinked
  `objects/` or loose ref, a hardlink, a FIFO or a device fails the request with 422 (also a
  non-forced removal). The check is a snapshot; the sync must run while no agent writes in the
  clone (after the run), which package 3 has to guarantee. The other side of the fetch is `git upload-pack` running
  on the clone; git does not pass command-line configuration to it, so it reads the clone's
  configuration. upload-pack runs no hooks and honours `uploadpack.packObjectsHook` only from
  protected (system/global) configuration, which the server controls. Tests set hooks,
  `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `uploadpack.packObjectsHook` and
  `core.pager` in a clone and check that none of them runs.
- **`safe.directory`.** Once agents write in their clone as `cvx-agent`, the clone belongs to
  another user than the API, and git refuses it ("dubious ownership"). `-c safe.directory` does
  not reach upload-pack, so a sync writes a temporary global configuration file (0600, removed
  afterwards) that contains exactly one entry, `safe.directory = <clone>/.git`, and points
  `GIT_CONFIG_GLOBAL` at it for that call. Nothing else is marked safe; the bare repositories
  always belong to the API user. A test syncs a clone owned by another uid (runs as root only).
- **Output limits and timeouts** on every call (see Limits). A ZIP that grows past the cap or
  runs too long is aborted; running downloads are cut off when the API shuts down.
- **Downloads** carry `Content-Disposition: attachment` with a file name built only from
  `[A-Za-z0-9._-]`, `nosniff` and `no-store`. Every download is audited.
- **Syntax highlighting** uses highlight.js, which escapes the source; its output is additionally
  reduced to `<span class>` by DOMPurify. Unknown languages are shown as escaped text.

## Sharing with the runner (coding agents)

The API (container, uid 1000) and the runner (`cvx-runner` on the host) both work on
`WORKSPACE_ROOT`: the runner creates clones before coding runs, commits in them afterwards and
syncs the branch. They share the group `cvx-code` (`group_add` with `WORKSPACE_GID` in
`deploy/compose.yaml`, `SupplementaryGroups=` in the runner unit):

- temporary directories of a clone or repository being created are cleaned up only after an
  hour, since the other process may still be writing them;
- directories below the root are `2770` (setgid keeps the group), clone files `0660`/`0770`;
- bare repositories are created with `core.sharedRepository=0660`, and the runner writes the same
  value into a clone's configuration before it commits;
- while a coding run is active, its clone belongs to `cvx-agent`; the root helper hands it back to
  `cvx-runner:cvx-code` afterwards. The agent user is not in `cvx-code` and never sees the
  repositories or other clones.

See [Coding agents](coding-agents.md) for the sandbox and the installation steps.
