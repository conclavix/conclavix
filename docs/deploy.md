# Deploying Conclavix

Conclavix runs as four processes:

| Process                                           | Runs in                       | Why                                                                     |
| ------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| MongoDB (replica set), Redis                      | Docker                        | stateful services                                                       |
| `api` (board API, agent API at `/mcp`)            | Docker                        | stateless                                                               |
| `scheduler` (wakes to runs, heartbeats, recovery) | Docker                        | stateless                                                               |
| `runner` (starts `claude` for each run)           | host, systemd, dedicated user | needs the `claude` CLI and its login, and agents must never run as root |

## 1. Services in Docker

MongoDB and Redis require authentication. Each has its own environment file with its secrets;
api, scheduler and runner only get the application user's connection URLs.

```sh
cd deploy
cp mongo.env.example mongo.env              # root and app passwords, replica set key
cp redis.env.example redis.env              # Redis password
cp conclavix.env.example conclavix.env      # AUTH_SECRET, BOARD_URL, MONGO_URI and REDIS_URL
chmod 600 mongo.env redis.env conclavix.env
docker compose up -d --build
curl -s http://127.0.0.1:3300/api/health
docker compose exec api node dist/cli.js create-owner --email you@example.com --name "Your Name"
```

`create-owner` only works while the instance has no owner and prints a generated password once
(or reads one with `--password-stdin`). Further users are invited by an admin in the board.

Generate passwords with `openssl rand -hex 32` (hex needs no escaping inside a URL) and the
replica set key with `openssl rand -base64 756 | tr -d '\n'`.

- **MongoDB** runs with `--keyFile`, which a replica set needs once authentication is on, even
  with a single member. The key is written from `MONGO_KEYFILE` to a tmpfs at start. On the first
  start with an empty volume the image creates the root user, and `mongo/initdb` creates the
  application user `conclavix`, which may only read and write the `conclavix` database. That
  covers transactions, index builds and change streams. The health check logs in as root and
  initiates the replica set.
- **Redis** gets its configuration on a tmpfs: the default user is disabled, and the application
  user `conclavix` may run everything except admin commands (`CONFIG`, `ACL`, `SHUTDOWN`, ...) and
  `FLUSHALL`/`FLUSHDB`. The password is neither on a command line nor on disk.
- api, scheduler and runner warn at startup if `MONGO_URI` or `REDIS_URL` has no credentials.
  Connection URLs are never logged, and Redis login failures are logged without the command
  arguments, which would contain the password.

Ports are published on `127.0.0.1` only. Override them with `API_PORT`, `MONGO_PORT` and
`REDIS_PORT` if they are taken.

Optional services behind compose profiles: `hindsight` ([Memory backend](#memory-backend)) and
`registry`, a Verdaccio that caches npm and serves internal packages to coding runs
([Package registry](package-registry.md)).

The api container keeps the project git repositories in `/var/lib/conclavix/workspace`, a named
volume unless `WORKSPACE_DIR` (in `deploy/.env`) names a host directory owned by uid 1000. See
[Project workspaces](workspace.md) for layout, backup and the host directory on a production VM.

### Turning on authentication for an existing installation

`mongo.env` creates users only on an empty volume. For a volume from before authentication:

```sh
docker compose stop api scheduler && sudo systemctl stop conclavix-runner
# write mongo.env, redis.env and the new MONGO_URI/REDIS_URL in conclavix.env and runner.env
docker compose up -d mongo redis              # now with --auth; mongo stays unhealthy until users exist
docker compose exec -T mongo mongosh --quiet --file /conclavix/migrate-auth.js
docker compose up -d                           # api and scheduler wait for mongo to become healthy
sudo systemctl start conclavix-runner
```

`migrate-auth.js` creates the root user through MongoDB's localhost exception and then the
application user; it fails if users already exist.

## 2. Runner on the host

The runner and the agents it starts are two OS users:

- `cvx-runner` runs the runner. It holds `BOARD_TOKEN`, the database URLs and the gateway keys.
- `cvx-agent` runs `claude` for each run. It owns the `claude` login and nothing else.

The runner starts `claude` as `cvx-agent` through one sudoers rule that allows exactly
`/usr/bin/claude` and keeps only the variables claude needs (`ANTHROPIC_*`, `CLAUDE_CODE_*`, the
run token). So an agent cannot read the runner's environment file, its `/proc/<pid>/environ`
(another user's process).

```sh
sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin cvx-runner
sudo useradd --system --create-home --home-dir /home/cvx-agent --shell /usr/sbin/nologin cvx-agent
sudo chmod 0750 /home/cvx-agent
# Workspaces: written by the runner, readable (not writable) by the agent group, setgid so new
# directories inherit the group.
sudo install -d -o cvx-runner -g cvx-agent -m 2750 /srv/conclavix/workspaces
sudo install -d -m 0755 /etc/conclavix

# Runner code from the image (Node.js 24 must be installed on the host)
sudo rm -r /opt/conclavix/runner 2>/dev/null || true
sudo install -d /opt/conclavix
id=$(docker create conclavix:local) && sudo docker cp "$id":/app /opt/conclavix/runner && docker rm "$id"

# systemd reads the environment files as root; no other user needs them.
sudo install -m 0600 -o root -g root deploy/conclavix.env /etc/conclavix/conclavix.env
sudo install -m 0600 -o root -g root deploy/runner.env.example /etc/conclavix/runner.env   # then edit
sudo install -m 0644 deploy/systemd/conclavix-runner.service /etc/systemd/system/
sudo visudo -cf deploy/sudoers/conclavix-runner &&
  sudo install -m 0440 -o root -g root deploy/sudoers/conclavix-runner /etc/sudoers.d/conclavix-runner
```

`AGENT_USER=cvx-agent` in `runner.env` turns the user switch on; without it the runner logs a
warning and starts agents as itself. The runner refuses `AGENT_USER` equal to its own user or
`root`. If `claude` is not `/usr/bin/claude`, change `CLAUDE_BIN` and the sudoers rule together.

**Log `claude` in as `cvx-agent`** (or point it at your LLM gateway in `runner.env`), then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now conclavix-runner
journalctl -u conclavix-runner -f
```

Check the separation once: `sudo -u cvx-agent cat /etc/conclavix/runner.env` and
`sudo -u cvx-agent cat /proc/$(systemctl show -p MainPID --value conclavix-runner)/environ` must
both fail with `Permission denied`.

The runner refuses to start as root. The unit gives it write access only to its workspaces and
the agent home, and limits its capabilities to what sudo needs to switch to `cvx-agent`. The run
token is passed to claude in an environment variable that the MCP config references, so it is
never on a command line or in a file. A run that ignores SIGTERM is killed by sudo at the run
time limit plus 10 seconds.

After a reboot systemd starts the runner as soon as Docker is up, usually before MongoDB and Redis
accept connections. The runner retries both with exponential backoff (logging
`dependency not reachable yet, retrying`) for up to `STARTUP_WAIT_SECONDS` (default 120) and only
then exits with `<dependency> not reachable after ...`; systemd restarts it after that.

### What agents can do

The runner starts `claude` with an explicit tool list: the Conclavix MCP tools, `Skill`, and
`Read`, `Grep` and `Glob`. It uses `--permission-mode dontAsk`, so the file tools work only
inside the run workspace and anything outside it is denied. Bash, Write, Edit, WebFetch and
WebSearch are neither loaded nor allowed. Only the workspace's project settings are read, and
the runner deletes `.claude/settings.json` and `.claude/settings.local.json` there before every
run, so neither stored allow rules nor hooks take effect.

This is the default (`codeAccess: none`). Agents with code access `write` (coding agents) get
Edit, Write and Bash, but only inside a per-run sandbox started by a root helper. They need the
extra setup in [Coding agents](coding-agents.md#installation) (optionally with a
[package registry](package-registry.md) that caches npm and serves internal packages); without it their runs fail with
an explanation and read-only agents are not affected.

Independently of code access, agents with the git integration permission (off by default) may
merge branches into issue branches and fast-forward `main` of their project's repository through
the agent API; see [Workspace](workspace.md#git-integration-merge-tools). Set
`AGENT_EMAIL_DOMAIN` to the same value in `conclavix.env` and `runner.env` if agent commits should
carry another no-reply domain than `conclavix.invalid`.

### Per-agent keys for an LLM gateway

If claude reaches the model through a gateway such as LiteLLM, give each agent its own key so the
gateway can attribute and limit spend per agent. Put the key into `/etc/conclavix/runner.env` as
`CVX_SECRET_<NAME>=…` and set the agent's `adapter.gatewayKeySecret` to `<NAME>`. The runner then
sends that key instead of the shared one. Agents can only reference variables with the
`CVX_SECRET_` prefix, and a missing secret fails the run instead of silently using the shared key.

### Model suggestions

`CONCLAVIX_MODELS` in `conclavix.env` lists the model names the board offers when you create or
edit an agent, comma-separated, for example
`CONCLAVIX_MODELS=claude-opus-5-5,claude-sonnet-5,claude-haiku-4-5`. With a gateway such as LiteLLM,
use the gateway's model names. Without it the board suggests `opus,sonnet,haiku`. The list is only
a suggestion: the model field still accepts any name, and the API serves the list at
`GET /api/models`. Admins can override it in the instance settings (`models`), which takes effect
without a restart; changing the variable needs an api restart.

### Secrets in the run log

The runner redacts every run event before it is stored, and the run error before the run is
closed. It replaces the values of the secrets in its own environment (`CVX_SECRET_*`, the run
token, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*` keys and headers, `BOARD_TOKEN`,
`HINDSIGHT_API_KEY` and variables matched by the runner's case-insensitive secret-name filter:
`CVX_SECRET_` prefix; names containing `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `APIKEY`,
`API_KEY`, `ACCESS_KEY`, `KEY_ID`, `CUSTOM_HEADERS` or `CREDENTIAL`; names ending in `_KEY`;
or an `AUTH` or `PASS` segment delimited by underscores or the name's edges, e.g. `SMTP_PASS`), also URL- and base64-encoded,
with `[redacted:<NAME>]`, and common credential formats (API keys,
tokens, JWTs, private keys, `Authorization` headers, `user:password@` URLs, `KEY=value`
assignments with a secret-looking name) with `[redacted:<kind>]`. If redaction fails, the event
is stored as a placeholder instead.

Logs stored before this existed are cleaned once when the API starts (pattern-based plus the
secrets in the API's environment; progress in the API log as `stored run log redaction`). To also
scrub the values only the runner knows, run the rescan once on the runner host as the runner user
with the runner's environment (never as `cvx-agent`, which could read its secrets):

```sh
sudo systemd-run --wait --pipe --uid=cvx-runner \
  -p EnvironmentFile=/etc/conclavix/conclavix.env -p EnvironmentFile=/etc/conclavix/runner.env \
  /usr/bin/node /opt/conclavix/runner/dist/redact-main.js
```

The rescan is idempotent and can be repeated at any time.

## Memory backend

Agents remember at three levels (global, project, agent); Conclavix decides who may read and
write which. The storage is pluggable:

- `MEMORY_BACKEND=builtin` (default): MongoDB with a weighted text index. Nothing else to run.
- `MEMORY_BACKEND=hindsight`: [Hindsight](https://github.com/vectorize-io/hindsight) extracts facts
  from every saved memory and searches semantically, by keyword, graph and time. Start it with
  `docker compose --profile hindsight up -d`, fill in `hindsight.env`, and set
  `HINDSIGHT_URL=http://hindsight:8888` in `conclavix.env`. Each save costs one LLM call; if
  Hindsight or its LLM is unavailable (including rate limits), memory calls answer
  503 `memory_unavailable` and the rest of Conclavix keeps working.

## Users, roles and two-factor authentication

People sign in with e-mail and password; there is no open sign-up. Every user has one role:

| Role     | May                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------- |
| `viewer` | read everything, manage the own profile and API tokens                                         |
| `member` | plus projects, issues, comments, documents, memories, waking agents                            |
| `admin`  | plus agents, skills and the org chart, users, instance settings (except owner-only), audit log |
| `owner`  | everything; only owners grant or change the owner role, the MFA policy and SMTP                |

At least one active owner always remains. `MFA_POLICY` (or the `mfaPolicy` setting) decides who
needs TOTP; it is enforced on every request, so an existing session is held at the enrolment
step as soon as the policy demands it. Lost authenticator and recovery codes: an admin resets the
user's 2FA in the board, or on the host `docker compose exec api node dist/cli.js reset-2fa
--email ...`.

Owners and admins manage all of this in the board under **Administration**: users (invite,
role, ban, password and 2FA resets, delete), the read-only role matrix (`GET /api/roles`), the
instance settings and the audit log (`GET /api/audit`, filterable by `action` (comma separated),
`actor` (a user id, `board` or `system`), `from` and `to`).

Instance settings (`GET/PATCH /api/settings`) override `INSTANCE_NAME`, `MFA_POLICY`,
`CONCLAVIX_MODELS` and `SMTP_*`; clearing a value (`null`) falls back to the environment. The SMTP
password is write-only: an empty `smtp.pass` keeps the stored one, `smtp.pass: null` removes it
(without falling back to `SMTP_PASS`). Only owners change
the MFA policy and SMTP: whoever controls SMTP receives every password-reset link, including the
owners'. Every settings change commits together with its audit entry, or not at all.

Owners can send a test mail (`POST /api/settings/smtp/test { to?, smtp? }`, the "Send test mail"
button in the SMTP section). `smtp` takes unsaved values with the same rules as the PATCH (an
empty password uses the stored one) and is not saved; `to` defaults to the owner's own address.
The answer says whether the server accepted the mail and otherwise why not (`connection`, `tls`,
`auth`, `sender`, `recipient`, `message`), with the server's reply, never the password. Test
mails are limited to five per user and minute and audited as `settings.smtp_tested`.
The TOTP issuer is the startup `INSTANCE_NAME` value and does not follow later settings changes.
Changing password-reset mail content does not change the issuer in generated TOTP URIs.

Without SMTP configured, self-service password reset emails are not sent, a warning is logged,
and no temporary password is returned. Admin user creation and password resets without a supplied
password instead return a temporary password, without sending mail or logging that warning.
Admins must deliver this temporary password securely.

An admin password reset ends all of the user's sessions and revokes their personal API tokens in
the same transaction as its audit entry; open event streams of that user close at once. A reset
mail is only sent after that has committed. If the mail cannot be sent, the response returns a
temporary password instead (`reason: "mail_failed"`, audited as `user.password_reset_mail_failed`).
Banning a user also ends their sessions and revokes their tokens. Open event streams re-check
their access every minute and immediately after sign-out, session or token revocation, ban,
delete, role change or 2FA reset.

Signed-in users keep their theme (`preferences.theme`, `{ template, mode }`) in their profile;
the board saves every choice there and applies it on each device they sign in on. The same
goes for the sidebar (`preferences.sidebar`, `rail` or `pinned`): a rail that expands on hover, or
pinned open via the pin at the bottom of the drawer. Screens narrower than 960px always get the
rail.

Scripts use personal API tokens (`POST /api/me/tokens`, shown once; creating and revoking one is
audited in the same transaction). `BOARD_TOKEN` still works as
a deprecated owner credential and logs a warning; unset it once every script has moved.

## Skills

Skills are Markdown instructions (plus optional supporting files) kept in a library at
`/api/skills` and assigned per agent via `PATCH /api/agents/:id {"skillIds": [...]}`. Before every
run the runner rewrites `<workspace>/.claude/skills/` to hold exactly the agent's skills, each as
`<name>/SKILL.md` with generated `name`/`description` frontmatter, so `claude -p` discovers them
like project skills. Anything else in that directory is removed; the rest of `.claude/` is kept.
A skill that is still assigned cannot be deleted (409 with the agents' names).

`claude` also loads personal skills from `~/.claude/skills` of the runner user; keep
`/home/cvx-agent/.claude/skills` empty unless every agent should see them. The runner must not
pass `--bare`, which skips skill discovery. Other adapters ignore the directory.

Owners and admins can also import skills from external directories; see
[Skill directories](skill-directories.md).

## Avatars

Agent avatars live in MongoDB (`avatars` collection), so a database backup includes them and no
object storage is needed. Uploads (`PUT /api/avatars/agent/:id`, multipart, one PNG, JPEG, WebP
or GIF up to 5 MB) are re-encoded by sharp into a 256x256 WebP without metadata; SVG is refused.
User avatars (`/api/avatars/user/:id`) answer 404 `avatar_owner_disabled` until user accounts
register an owner handler.

## 3. First run

Create a project, an agent and an issue assigned to that agent through the board API. The
scheduler picks the assignment up within seconds; follow the run with
`GET /api/runs?agentId=<id>` and `GET /api/runs/<runId>/events`.
