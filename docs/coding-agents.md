# Coding agents

An agent with code access `write` works in the git clone of its issue: it edits files and runs
commands (installs, tests, builds) with Claude Code's Edit, Write and Bash tools. Every run happens
in a sandbox that is created for the run and thrown away afterwards. The runner commits what the
agent left behind on the issue branch `cvx/<KEY>` and fetches the branch into the project
repository, where the board's **Code** tab shows it.

Code access is off by default. Only admins and owners can change it (agent settings, "May write
and run code"); every change is audited as `agent.code_access_changed`. Only the `claude_cli`
adapter supports it. Agents without code access keep the read-only path described in
[Deploying Conclavix](deploy.md#what-agents-can-do).

## Threat model

The model's output is untrusted: a prompt injection in an issue, a document, a dependency or a web
page an earlier run fetched can steer the agent. The sandbox assumes the agent tries to:

- read the Claude Code OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`), the gateway key, the run token or
  the runner's secrets (`/etc/conclavix/*.env`: database passwords, board token);
- reach MongoDB, Redis, LiteLLM, the API or other services on the host or in the LAN;
- read or change other projects, other issues' clones or the project repositories directly;
- exfiltrate code or data to the internet;
- keep processes running, fill memory, CPU, process table or disk;
- persist something that runs later with more rights (hooks, settings, git configuration).

Trusted: the runner (`cvx-runner`), the root helper, systemd, the kernel, Claude Code itself.

## Layers

```
runner (cvx-runner, hardened unit)
  └─ sudo -n agent-run.mjs run ...            root helper: validates, prepares, waits, releases
       └─ systemd-run → transient unit cvx-agent-<runId>.service   (outer shell, PID 1's child)
            user cvx-agent, sees only its clone, limits, no capabilities
            └─ /usr/local/libexec/conclavix/agent-exec.sh → claude (managed settings of this run)
                 ├─ Read/Edit/Write/Grep/Glob: permission rules, working directory = clone
                 └─ Bash → bubblewrap (inner sandbox): own network namespace, PID namespace,
                           read-block outside the clone, writes only in the clone,
                           network only through Claude Code's proxy with a domain allowlist
```

### 1. Root helper (`deploy/agent-sandbox/agent-run.mjs`)

Installed root-owned in `/usr/local/libexec/conclavix/`; the runner may call it through one sudoers
rule (`deploy/sudoers/conclavix-runner`) and sudo gives it no environment. It accepts ids and limits
only and builds every path itself:

- run id and project id: 24 hex characters; issue key: the core pattern (`ABC-12`); the clone is
  `<codeRoot>/workspaces/<projectId>/<KEY>`, every component checked with `lstat` (no symlink, real
  path below the code root); the skills directory must be a real directory below the runner's
  workspaces; extra domains must be host names; limits must stay below the maxima in
  `/etc/conclavix/agent-sandbox.json` (optional, root-owned, not writable by others).
- claude flags: an allowlist (`-p`, stream-json, `--permission-mode dontAsk`,
  `--setting-sources user`, `--strict-mcp-config`, an MCP config with HTTP servers on loopback
  only, `--tools` from Read/Grep/Glob/Skill/Edit/Write/Bash, `--disallowedTools`, `--model`,
  `--max-budget-usd`). `--add-dir`, `--settings`, `--dangerously-skip-permissions`, plugins and
  every other flag are refused.

It checks that the wrapper `agent-exec.sh` (`execWrapper`, by default
`/usr/local/libexec/conclavix/agent-exec.sh`) can only be changed by root (regular root-owned file,
no symlink, no directory above it writable by others except sticky ones) and may be executed there,
which also fails on a filesystem mounted `noexec`. It then writes the per-run policy directory
`/run/conclavix-agent/<runId>/` (root-owned, world-readable, nothing secret, never executed from:
Debian mounts `/run` `noexec`, and the unit mounts the directory `noexec` in any case), gives the clone to `cvx-agent` (the walk changes into each directory and checks its inode,
then works on single names with `lchown` or an `O_NOFOLLOW` descriptor, so neither the agent nor
the shared group can redirect it through a symlink), starts the unit and waits. SIGTERM from the runner stops the unit. Every 30 seconds it
measures the clone and stops the unit past the disk limit or when it cannot measure it. When the unit has ended it gives the
clone back to `cvx-runner:cvx-code` (directories 2770, files 0660/0770, no setuid), removes the
policy directory and reports one status line (`cvx-agent-run:<tag> {...}`, the tag is random per
run so the agent cannot imitate it).

### 2. Outer shell: the transient unit

Properties (see `unitProperties` in `deploy/agent-sandbox/policy.mjs`):

| Property                                                                                                                                                                                                                                                                                                                                                                 | Effect                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User=`/`Group=` cvx-agent, `SupplementaryGroups=`                                                                                                                                                                                                                                                                                                                       | not in `cvx-code`, `docker` or any other group                                                                                                                                                                                                                                                              |
| `TemporaryFileSystem=/srv:ro` (+ `/opt`, `/var/lib/docker`, ...) and `BindPaths=<clone>`                                                                                                                                                                                                                                                                                 | other clones, the project repositories and the runner's workspaces do not exist in the unit, also not for Read/Edit                                                                                                                                                                                         |
| `InaccessiblePaths=-/etc/conclavix -/run/docker.sock -/var/log ...`                                                                                                                                                                                                                                                                                                      | runner secrets, Docker                                                                                                                                                                                                                                                                                      |
| `ProtectSystem=strict`, `ProtectHome=tmpfs`, `PrivateTmp=yes`                                                                                                                                                                                                                                                                                                            | the clone and the private `/tmp` (fresh HOME and package caches) are the only writable places                                                                                                                                                                                                               |
| `BindReadOnlyPaths=<policy>:/etc/claude-code`                                                                                                                                                                                                                                                                                                                            | the run's managed settings and skills                                                                                                                                                                                                                                                                       |
| `NoExecPaths=<policy>`, `BindReadOnlyPaths=<execWrapper>`                                                                                                                                                                                                                                                                                                                | the unit starts the installed wrapper (bound read-only, so hidden or private paths cannot shadow it); the policy directory is mounted `noexec` at its own path (its second view at `/etc/claude-code` is `noexec` where `/run` is); the probe of the acceptance test is read by `/bin/bash`, never executed |
| `NoNewPrivileges=yes`, `CapabilityBoundingSet=`, `PrivatePIDs=yes`, `ProtectProc=invisible`, `PrivateIPC`, `PrivateDevices`, `ProtectClock`, `ProtectKernelModules`, `ProtectControlGroups`, `LockPersonality`, `RestrictRealtime`, `SystemCallArchitectures=native`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`, `KeyringMode=private`, `UMask=0077` | no privilege gain; own PID namespace, so neither other runs' claude processes (same uid) nor processes of other users are visible in `/proc`                                                                                                                                                                |
| `IPAddressDeny=` RFC 1918, link-local, CGNAT, ULA                                                                                                                                                                                                                                                                                                                        | the claude process reaches loopback (LiteLLM, MCP) and the internet, not the LAN                                                                                                                                                                                                                            |
| `MemoryMax`, `MemorySwapMax=0`, `CPUQuota`, `TasksMax`, `RuntimeMaxSec`, `KillMode=control-group`                                                                                                                                                                                                                                                                        | limits; nothing survives the unit                                                                                                                                                                                                                                                                           |

Not set, because bubblewrap cannot start under them (tested on Debian 13, systemd 257, bubblewrap
0.12): `ProtectKernelTunables` and `ProtectKernelLogs` (bwrap cannot mount a fresh `/proc` over a
partly read-only one), `ProtectHostname` (same error in combination with the other properties),
`ProcSubset=pid`, `RestrictSUIDSGID` (its seccomp filter breaks bwrap's mount calls),
`RestrictNamespaces`, `SystemCallFilter`, `PrivateUsers`. `NoNewPrivileges=yes` works with
bubblewrap; the acceptance test checks it.

### 3. Claude Code: managed settings per run

The helper writes `managed-settings.json` into the policy directory and the unit mounts it at
`/etc/claude-code`. Managed settings outrank `--settings` and every settings file, so a run
cannot change them, and the runner never has to pass them on the command line. The host's own
`/etc/claude-code/managed-settings.json` and `managed-settings.d/*.json` are merged in underneath
(scalars and allow lists from the run win; other lists are combined), so host-wide keys such as
`env.DISABLE_AUTOUPDATER` still apply. Mounting the file only inside the unit leaves Claude Code
sessions outside the sandbox (read-only agents, people on the host) untouched.

Key settings (names checked against the Claude Code settings reference for 2.1.285):

| Setting                                                                                                                                             | Value                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`                                                                                  | `true`, `true`, `false`: Bash runs in bubblewrap or Claude Code does not start; no unsandboxed retry                                                         |
| `sandbox.excludedCommands`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `network.allowLocalBinding`, `network.allowAllUnixSockets` | empty / `false`                                                                                                                                              |
| `sandbox.network.allowManagedDomainsOnly`, `strictAllowlist`, `allowedDomains`                                                                      | only `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` plus `CODE_SANDBOX_DOMAINS`                                                                  |
| `sandbox.filesystem.allowWrite`                                                                                                                     | `/tmp/cvx-cache` (package caches on the unit's private `/tmp`)                                                                                               |
| `sandbox.credentials.envVars`                                                                                                                       | `deny` for the OAuth token, API key/auth token, gateway headers and run token                                                                                |
| `permissions.blockReadsOutsideWorkingDirectories`                                                                                                   | `true`: file tools refuse reads outside the clone; Bash loses `/home`, `/root`, `/srv`, `/mnt`, ...                                                          |
| `permissions.allow`                                                                                                                                 | `Bash`, `Edit(//<clone>/**)`, `Skill`, `mcp__conclavix`                                                                                                      |
| `permissions.deny`                                                                                                                                  | `Read(//proc/**)`, `Read(//sys/**)`, `Read(//run/**)`, `Read(//etc/conclavix/**)`, `Edit(//<clone>/.git/**)`, WebFetch, WebSearch, Agent, Task, NotebookEdit |
| `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`, `disableAllHooks`, `permissions.disableBypassPermissionsMode`                           | rules come from this file only, no hooks, no bypass mode                                                                                                     |

`allowManagedReadPathsOnly` is deliberately not set: with it, the read block would no longer
apply to sandboxed commands. The exec wrapper sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which on
Linux strips credentials from every subprocess and runs Bash in its own PID namespace (no
`/proc/<claude>/environ`). With the scrub set, Claude Code forces the permission mode to `default`
and prints `Permission mode forced to default ... Declare allowedTools explicitly`; that notice is
expected. In `-p` mode `default` behaves like `dontAsk` (a call no rule allows is denied, nothing
prompts), and the managed `permissions.allow` above carries the coding tools. `--allowedTools` would
not help: under `allowManagedPermissionRulesOnly` Claude Code ignores it, so the helper keeps
refusing the flag. Skills of the agent are mounted read-only at
`/etc/claude-code/.claude/skills` (managed skills), so they never enter the clone or a commit.

### 4. Secrets

The OAuth token, the gateway key and the run token never appear in argv, unit properties or
files: `systemctl show` would print unit properties (`-E`/`Environment=`) to every user, and a
file would have to be readable by the unit. The runner writes them to sudo's stdin as
`NAME=<base64>` lines followed by an empty line, ahead of the stream-json prompt.
`systemd-run --pipe` hands the same pipe to the unit, where `agent-exec.sh` reads exactly these
lines (bash reads a pipe byte by byte, so nothing of the prompt is consumed), accepts only
`CLAUDE_CODE_*`, `ANTHROPIC_*`, `CONCLAVIX_RUN_BEARER` and locale variables, exports them and
`exec`s claude. The values then live where they lived before this feature: in the claude
process's environment, which Bash cannot read (scrub, PID namespace, `credentials` deny) and the
file tools may not read (`Read(//proc/**)` deny, read block).

The run token travels as `CONCLAVIX_RUN_BEARER` here, not as `CONCLAVIX_RUN_TOKEN` like in
read-only runs: with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set, Claude Code expands variables whose
names look like credentials (`TOKEN`, `KEY`, `AUTH`, `SECRET`, ...) to an empty string in MCP
headers, so the conclavix MCP server would receive `Authorization: Bearer ` and refuse the run
(`mcp: conclavix=failed` in the init event). Because the scrub does not match that name, the
managed `sandbox.credentials.envVars` deny entry is what keeps it away from Bash;
`sandbox-acceptance.sh --with-claude` checks both (MCP `connected`, no `CONCLAVIX_*` in Bash).

The helper starts the unit with `systemd-run --expand-environment=no` (systemd 254 or later). By
default the service manager expands `${NAME}` and `$NAME` in the command line from the unit's own
environment, which holds none of the run's variables, so the MCP config's
`Bearer ${CONCLAVIX_RUN_BEARER}` would reach claude as `Bearer ` before claude could expand it.
The probe mode of the acceptance script checks that such a reference reaches the unit unchanged.

### 5. Git and the clone

- The agent may use git in the clone (the inner sandbox protects `.git/hooks` and `.git/config`).
- After the unit has ended and the helper has handed the clone back, the runner (not the agent)
  commits: first the entries Claude Code's Bash sandbox leaves in `.git` (it creates
  `config.worktree` and `commondir` to mount them read-only, bubblewrap leaves the mount points
  of `worktrees/`, `modules/`, `glab-cli/`) are removed, but only in their harmless shapes: an
  empty directory, or a regular single-link file that is empty (or `.` for `commondir`); then the
  clone's `.git` is checked like before a sync (no symlinks, hardlinks, alternates,
  `commondir`), its `.git/config` is replaced by a fixed template (no filters, includes,
  fsmonitor, hooks path), git runs with `core.hooksPath=/dev/null` and a fresh index built from
  the branch tip, `git add -A` skips `node_modules/`, `.venv/` and other caches, and
  `commit-tree` writes one commit with the author `Conclavix <agent name>`
  (`agent-<id>@<AGENT_EMAIL_DOMAIN>`, default `conclavix.invalid`). The message is the agent's result, redacted like the run log,
  with `Conclavix-Issue/Run/Agent` trailers. Commits the agent made itself stay below it. If the
  agent reset or rebased the branch so that it no longer contains the server tip the run started
  from, the runner commits the work tree on top of that server tip instead (the rewritten commits
  are dropped, their content is in the work tree) and records a run event; the server branch is
  never rewritten by a run.
- If `cvx/<KEY>` moved on the server during the run (an agent with git integration merged into
  it, see [Workspace](workspace.md#git-integration-merge-tools)), the runner reconciles before
  the sync: it fetches the clone's tip into the project repository (with `fsckObjects`), merges
  it with the server tip there (`git merge-tree`, no-ff, first parent: the run's work, by the
  run's agent), moves the server branch with compare-and-swap and fast-forwards the clone to the
  merge. If that merge conflicts, the run's tip is kept as the branch `conflict/<KEY>/<sha>`, the
  clone is reset to the server tip and the run records the conflicting files; nothing is lost and
  the issue continues from the server branch.
- Then `syncIssueBranch` fetches `cvx/<KEY>` into the project repository (fast-forward only; a
  rewritten branch is not forced and the run records the refusal). A clone that is removed and
  created again starts from the server's `cvx/<KEY>`, not from `main`.
- Before a run in an existing clone, the runner does the same reconciliation: a clone behind the
  server branch is fast-forwarded (git's two-tree checkout with a fresh index; it refuses to
  overwrite uncommitted changes, which fails the run with an explanation), a diverged one is
  merged as above. The run then starts from the server tip. Inside the clone git runs only after
  its configuration was replaced, with hooks off, and the project repository is marked as a safe
  directory for the fetch from it.
- The run stores `code` (branch, base, head, commit, agent commits, files, insertions,
  deletions, synced, error); the run view shows it with a link to the Code tab.
- Two runs never share a clone at the same time: the runner locks the issue clone, and while a
  unit runs the clone belongs to `cvx-agent` with mode 0700/0600, so the API cannot sync or remove
  it either.

## What is protected and what is not

Protected (and checked by the acceptance test):

- Token and secrets: not in Bash's environment, not readable through `/proc`, `/etc/conclavix`
  or the agent's home; the file tools are denied on `/proc`, `/run`, `/etc/conclavix` and
  anything outside the clone.
- Other projects and issues: not present in the unit's file system.
- Local services: Bash has no route to `127.0.0.1` of the host (own network namespace); the claude
  process itself reaches only loopback and the internet, not the LAN.
- Exfiltration: Bash reaches only the allowlisted registries through Claude Code's proxy.
- Persistence: no hooks, no settings from the clone, `.git/config` reset by the runner, nothing
  survives the unit.
- Resources: memory, CPU, processes, run time; disk is checked before, every 30 s and after.

Not protected (known limits):

- **Domain fronting** through the allowed registries' CDNs (Fastly, Cloudflare) can carry data
  out; the proxy does not inspect TLS. Keep the allowlist short.
- **The file tools run in the claude process**, which holds the token; only Claude Code's
  permission checks stand between `Read` and `/proc/self/environ`. A bug there would expose the
  token. The acceptance test's Claude mode checks both a direct read and a symlink.
- **The kernel is shared** (user namespaces, bubblewrap). The runner host (ideally a dedicated VM)
  is the outer boundary.
- **Disk usage between checks**: a run can write up to 30 seconds' worth past the limit; `/tmp`
  is a tmpfs bounded by `MemoryMax`.
- **Toolchains are the host's** (Node 24, npm, Python without pip). Docker, databases or
  non-HTTP network access in tests do not work in this sandbox.
- **Model use**: coding runs cost more tokens; `RUNNER_CONCURRENCY` and the per-run budget still
  apply.

## Configuration

Runner (`/etc/conclavix/runner.env`):

| Variable                 | Default            | Meaning                                                                     |
| ------------------------ | ------------------ | --------------------------------------------------------------------------- |
| `AGENT_SANDBOX_HELPER`   | unset (off)        | `/usr/local/libexec/conclavix/agent-run.mjs`; needs `AGENT_USER`            |
| `WORKSPACE_ROOT`         | `./data/workspace` | the same directory the API mounts, `/srv/conclavix/code` on the runner host |
| `CODE_RUN_MEMORY_MAX`    | `4G`               | `MemoryMax` of the unit                                                     |
| `CODE_RUN_CPU_QUOTA`     | `200`              | `CPUQuota` in percent of one CPU                                            |
| `CODE_RUN_TASKS_MAX`     | `512`              | `TasksMax`                                                                  |
| `CODE_RUN_DISK_LIMIT_MB` | `4096`             | size of the clone before, during and after a run                            |
| `CODE_SANDBOX_DOMAINS`   | empty              | extra hosts for sandboxed commands, comma-separated                         |

The extra domains are host configuration, not a board setting: they widen the egress of every
coding run, so changing them needs root on the runner host, like the rest of the sandbox.

Time: claude gets `RUN_TIMEOUT_MINUTES` minus 3 minutes (at most half the timeout), the unit 30
seconds more (`RuntimeMaxSec`), and the helper 90 seconds after SIGTERM to stop the unit and hand
the clone back. The reserve and the scheduler's recovery window (`RUN_TIMEOUT_MINUTES` + 5 minutes) leave room for
the commit and the sync in the usual case; each git call after a run is capped at one minute. The
run's cost is stored before committing, so even a run the scheduler closes in that phase keeps it.

Helper (`/etc/conclavix/agent-sandbox.json`, optional, root:root 0644): paths, user and group
names, the base domain allowlist, hidden paths and the maximum limits; see
`deploy/agent-sandbox/agent-sandbox.json.example` and `DEFAULTS` in `config.mjs`.

## Installation

On the runner host, as root (tested with Debian 13, systemd 257, bubblewrap 0.12, Claude Code >=
2.1.285; systemd 254 or later is required for `systemd-run --expand-environment`):

```sh
# 1. Shared group for the API container and the runner; the agent user is not a member.
groupadd --system cvx-code
chgrp -R cvx-code /srv/conclavix/code
chmod 2770 /srv/conclavix/code
find /srv/conclavix/code -type d -exec chmod g+rwxs,o-rwx {} +
find /srv/conclavix/code -type f -exec chmod g+rw,o-rwx {} +
for repo in /srv/conclavix/code/repos/*.git; do
  [ -d "$repo" ] && git --git-dir="$repo" config core.sharedRepository 0660
done
echo "WORKSPACE_GID=$(getent group cvx-code | cut -d: -f3)" >> /opt/conclavix/src/deploy/.env

# 2. Helper, wrapper, policy directory, mount point for managed settings.
install -d -o root -g root -m 0755 /usr/local/libexec/conclavix
install -o root -g root -m 0755 deploy/agent-sandbox/agent-run.mjs deploy/agent-sandbox/args.mjs \
  deploy/agent-sandbox/config.mjs deploy/agent-sandbox/policy.mjs deploy/agent-sandbox/tree.mjs \
  deploy/agent-sandbox/agent-exec.sh /usr/local/libexec/conclavix/
install -o root -g root -m 0644 deploy/tmpfiles.d/conclavix-agent.conf /etc/tmpfiles.d/
systemd-tmpfiles --create /etc/tmpfiles.d/conclavix-agent.conf
install -d -o root -g root -m 0755 /etc/claude-code

# 3. sudoers and runner unit.
visudo -cf deploy/sudoers/conclavix-runner &&
  install -o root -g root -m 0440 deploy/sudoers/conclavix-runner /etc/sudoers.d/conclavix-runner
install -o root -g root -m 0644 deploy/systemd/conclavix-runner.service /etc/systemd/system/
systemctl daemon-reload

# 4. runner.env: AGENT_SANDBOX_HELPER and WORKSPACE_ROOT (see Configuration), then
systemctl restart conclavix-runner
docker compose up -d api        # in /opt/conclavix/src/deploy, picks up group_add

# 5. Acceptance test (and again after every Claude Code, bubblewrap or helper update).
sudo deploy/sandbox-acceptance.sh
```

## Acceptance test

`deploy/sandbox-acceptance.sh` runs as root on the runner host against the installed helper:
`sudo deploy/sandbox-acceptance.sh` (probe mode) and `sudo deploy/sandbox-acceptance.sh
--with-claude`. The helper refuses probe mode whenever `SUDO_UID` is set, which is how the runner
calls it, so the script starts the helper with an empty environment (`env -i`, only `PATH`); a
root login shell works the same way. It creates a throwaway project below `WORKSPACE_ROOT/workspaces/ffffffffffffffffffacce55`, starts
real units and prints one PASS/FAIL line per check:

- probe mode (default, no Claude run): inside the unit a script checks the user, that a
  `${...}` reference in the arguments arrives unexpanded, that the policy directory is mounted
  `noexec`, the scrub flag,
  the empty HOME, that `runner.env`, the agent's home, `/proc/1/environ`, other clones, the
  project repositories and the runner's workspaces are out of reach, that only the clone and
  `/tmp` are writable, that the LAN is blocked (a TCP probe to port 53 of `LAN_PROBE_HOST`,
  default: the host's default gateway) and the registry reachable, that bubblewrap starts
  under `NoNewPrivileges`, and that a network-namespaced command (as Claude's Bash gets) reaches
  neither MongoDB, Redis, LiteLLM, the API nor the internet. Then the memory, process, disk and
  time limits are triggered, and no unit may be left over.
- `--with-claude`: one real, minimal Claude run through the runner's path (a transient unit as
  `cvx-runner` with the runner's capabilities, sudo, helper) with the credentials from
  `runner.env`. Claude runs a probe script with Bash and two Read calls; the script checks that
  no credential variable is visible (names containing `TOKEN`, `API_KEY`, `CUSTOM_HEADERS`,
  `SECRET` or `PASSWORD`, and `CONCLAVIX_*`; a failure prints the names, never values),
  `runner.env` is unreadable,
  a non-allowlisted domain is refused with and without the proxy, the registry works,
  `127.0.0.1` ports are closed, `.git/hooks` and `.claude/settings.json` are not writable, HOME
  is the per-run `/tmp/cvx-home` without a `.credentials.json`, and the Read tool is denied on
  `/proc/self/environ` and on a symlink to it. The visible `ANTHROPIC_*` names are printed for
  information; `ANTHROPIC_BASE_URL` (the LiteLLM URL) is expected there and is not a secret.
  `CLOUDSDK_PROXY_*` are left out of the credential check and printed for information: Claude
  Code sets them for every sandboxed command as the credentials of its own local sandbox proxy;
  they carry none of the run's secrets.
  HOME is writable on purpose: Claude keeps `~/.claude` there, and it is the unit's private
  `/tmp`, discarded with the unit. The stream is parsed for these results only and deleted;
  nothing secret is printed.

  The credential variables reach claude but not its subprocesses because the wrapper sets
  `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`: Claude Code then removes its credential variables
  (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_CUSTOM_HEADERS` and other providers' keys) from the Bash tool, hooks and MCP servers
  (checked in the scrub list of Claude Code 2.1.285). If an update drops a name from that list,
  this check fails.

Run the probe mode after every update of Claude Code, bubblewrap, systemd or the helper; run the
Claude mode before enabling the first coding agent and after Claude Code updates.

The helper's own tests run with `pnpm test:sandbox`; `CVX_SANDBOX_INTEGRATION=1` as root adds
tests that start real units with a probe, one of them with the policy root on a tmpfs mounted
`noexec` (as `/run` is on Debian).

## Operations

- A run that ends abnormally shows the helper's status lines in the run log (`sandbox prepared`,
  `sandbox finished: {"result":"oom-kill", ...}`) and the run error names the limit.
- If the helper itself dies (SIGKILL), the unit runs until `RuntimeMaxSec` and the clone stays
  with `cvx-agent`; the runner then records "the sandbox did not report its end" and does not
  commit. The next coding run of the issue asks the helper to hand the clone back
  (`agent-run.mjs release --project <id> --issue <KEY>`, refused while a unit still works in it)
  and continues. Root can run the same command by hand.
- Code access revoked while a run waits for its locks makes that run read-only; access granted
  while it waits fails the run (the next one gets it).
- Clones that existed before this change have no recorded clone id; their next workspace call
  writes one more `issue.workspace_created` entry, once.
- The runner's clone lock is per process. Between the helper handing the clone back and the
  runner's commit (seconds), an admin removing the workspace through the API (`DELETE
/api/issues/:ref/workspace?force=true`) would discard the run's uncommitted work; non-forced
  removal refuses unsynced commits, but uncommitted files are never inspected. Remove workspaces
  only while no run of the issue is active.
- Leftover units: `systemctl list-units 'cvx-agent-*'`; policy directories:
  `/run/conclavix-agent/`.
- Logs of a unit: `journalctl -u cvx-agent-<runId>`.
