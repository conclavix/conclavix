# Project secrets

A project can hold secrets, for example an API key that a coding agent needs to run the project's
tests. Each secret has a display name, the name of the environment variable it becomes, an
encrypted value and the agents that receive it. Manage them on the project page, tab **Secrets**
(owners and admins).

## Who receives a secret

- **Only selected agents, only in their runs.** The runner looks up the secrets of the issue's
  project that list the run's agent and passes exactly those to the run. Other agents, runs on
  other projects' issues and the board never get them.
- **Only coding agents** (code access `write`, see [coding-agents.md](coding-agents.md)). A secret
  reaches the agent as an environment variable inside its sandboxed run, where its Bash commands
  can use it. Read-only agents have no Bash, so they never receive secrets, even when they are
  selected; the dialog says so when such an agent is picked.
- The secrets are passed when the run starts. A change applies to the next run.

## How the value travels

1. At rest the value is sealed with AES-256-GCM. The key is derived from `AUTH_SECRET` (HKDF,
   separate from the key of the instance settings), and the secret's id is bound to the
   ciphertext as additional data, so a value copied to another record does not decrypt.
2. The runner decrypts the secrets of a coding run (it reads `AUTH_SECRET` from
   `/etc/conclavix/conclavix.env` like the API). If it cannot, the run fails with an explanation
   instead of starting without them.
3. They go into the run's environment block on the helper's stdin, ahead of the variables the
   run needs itself (those win), never into argv, unit properties or files. The exec wrapper
   (`agent-exec.sh`) exports them; it accepts any upper-case name except the reserved ones.
4. They are not on the sandbox's `sandbox.credentials` deny list, so Bash sees them. That is the
   point of the feature; it also means an agent can print or send a secret anywhere its sandbox
   lets it (the network allowlist still applies).

The run log shows which variables a run received (`project secrets in the environment: NAME`),
never their values.

## Names

`[A-Z][A-Z0-9_]*`, at most 64 characters, unique per project. Reserved, because the run needs them
or because they change how the shell, the loader, Node, git or Claude Code behave: `PATH`,
`HOME`, `SHELL`, `USER`, `TMPDIR`, `LANG`, `TZ`, the proxy variables, bash's own variables (`UID`,
`PPID`, `RANDOM`, ...) and everything starting with `CLAUDE`, `ANTHROPIC`, `CONCLAVIX`, `CVX_`,
`ENABLE_`, `DISABLE_`, `LD_`, `DYLD_`, `BASH`, `NODE_`, `NPM_CONFIG_`, `XDG_`, `LC_`, `SUDO_`,
`SYSTEMD_`, `DBUS_`, `GIT_`, `SSH_`, `OTEL_`, `BUN_`, `PYTHON`, `PERL`, `RUBY`, `GCONV_`,
`GLIBC_`, `MALLOC_`, `HIST`, `COMP_`, `READLINE_`. The API and the wrapper check the same list
(`packages/core/src/domain/secret.ts`, `deploy/agent-sandbox/agent-exec.sh`; a test keeps them in
step), and the adapter checks again before writing the block.

Claude Code's subprocess scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`) removes its own and the
cloud providers' credential variables from Bash. Names of that kind are reserved above or are
unlikely project names; `sandbox-acceptance.sh --with-claude` passes two test secrets, one with a
credential-looking name (`ACCEPTANCE_API_KEY`), and reports whether each reached Bash. Run it after
Claude Code updates.

## Values

8 to 16384 characters, no NUL, no leading or trailing whitespace (the wrapper's command
substitution would drop trailing newlines). Values shorter than 8 characters are refused because
they could not be removed from run logs without mangling ordinary text.

## Redaction

The values of a run's secrets join the run log redactor before the first event is recorded, next
to the runner's own secrets and the run token. They are replaced by `[redacted:<VARIABLE>]` in
run events (also URL-, JSON- and base64-encoded and when cut at the log's length cap), in the run
error and in the commit message the runner writes. The forced rescan (`dist/redact-main.js`, see
[deploy.md](deploy.md)) also searches stored logs for the current values of all project secrets
when `AUTH_SECRET` is set.

Not covered: what the agent writes into files of the clone (and so into commits), comments,
documents or memories through the MCP tools, or anything it sends over the network. Treat a
secret given to an agent as known to that agent.

## Storage shared with connections

Connection credentials ([connections.md](connections.md)) are kept in the same `secrets`
collection and sealed the same way, with `connectionId` and `credentialKey` set and no variable
name; instance connections have no project. They never appear on the Secrets tab and never
become environment variables of their own.

## Permissions and audit

| Action                                    | Owner                            | Admin | Member, viewer |
| ----------------------------------------- | -------------------------------- | ----- | -------------- |
| List (name, variable, agents, last used)  | yes                              | yes   | no             |
| Create, replace the value, assign, delete | yes                              | yes   | no             |
| Show the value                            | yes, after entering the password | no    | no             |

Revealing needs a signed-in owner (not the board token) who enters the own password again; five
wrong passwords pause reveals for that user for ten minutes. The response is marked `no-store`.

Audit log actions (details hold ids, names and changed fields, never a value): `secret.created`,
`secret.updated` (`value: replaced`, `agentsAdded`, `agentsRemoved`, `envName`, `name`),
`secret.deleted`, `secret.revealed`, `secret.reveal_failed` and `secret.used` (one per secret and
run, with the run id and agent id; the secret also shows the last use).

If `AUTH_SECRET` changes, stored values can no longer be decrypted: runs of agents with secrets
fail with an explanation and showing a value reports it; replace the values to fix it.
