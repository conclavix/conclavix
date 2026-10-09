# Package registry for coding runs

Coding agents install dependencies in a sandbox whose package cache lives on the run's private
`/tmp` and is thrown away with the run ([Coding agents](coding-agents.md)). Without a registry
every `npm ci` downloads everything from the public registry again. Modules of a product that
depend on an internal package (`@<scope>/core`) cannot install it at all, so agents end up copying
it around inside the clone.

An optional [Verdaccio](https://verdaccio.org) in the compose stack solves both:

- it caches the public npm registry (the uplink), so repeated installs come from the host;
- it serves internal packages under scopes that are **never** looked up on npmjs (no dependency
  confusion), published by users the operator creates;
- coding runs are pointed at it (`npm_config_registry`, `YARN_REGISTRY`,
  `YARN_NPM_REGISTRY_SERVER`) and, by default, cannot reach the public npm registry directly.

One registry serves the whole instance. Nothing changes while `CODE_PACKAGE_REGISTRY` is unset.

## How the sandbox reaches it

The sandbox deliberately reaches no host or LAN service: the unit denies private addresses
(`IPAddressDeny=`), and Bash connects only through Claude Code's proxy with a domain allowlist.
For the registry the root helper opens exactly one address:

1. the runner passes `--package-registry <url>` (and `--registry-fallback yes|no`);
2. the helper refuses the run unless `packageRegistries` in `/etc/conclavix/agent-sandbox.json`
   lists exactly that URL (normalised: scheme, host, port, path ending in `/`; no wildcard, no
   credentials, no query);
3. for an IPv4 address it adds `IPAddressAllow=<address>` to the unit, puts the host into the
   run's `sandbox.network.allowedDomains` and sets the variables above as `Environment=`
   properties of the unit (like the [host test tools](coding-agents.md#host-test-tools); they
   are not secret);
4. without fallback `registry.npmjs.org` is removed from the run's domains, even when
   `CODE_SANDBOX_DOMAINS` names it. PyPI stays as it is.

The domain allowlist has no ports, so the address must belong to the registry alone. The compose
service therefore gets a fixed address on a bridge network of its own (`REGISTRY_SUBNET`, default
`172.31.250.0/28`, `REGISTRY_ADDRESS`, default `172.31.250.10`). The host routes to it directly,
and only Verdaccio listens there (port 4873). Do not use the host's own address, the docker
gateway or `127.0.0.1`: every other service listening there would become reachable from Bash.

A registry on another machine works the same way: by IPv4 address when it is on a private
network (the helper does not resolve names, so `IPAddressAllow=` needs the address), or by host
name when it is public and needs no exception. IPv6 addresses are not supported.

Registry-only is the default (`CODE_PACKAGE_REGISTRY_FALLBACK=false`): agents then always use the
cache and cannot bypass the internal scopes. `npm ci` rewrites `resolved` URLs of
`registry.npmjs.org` in `package-lock.json` to the configured registry (npm's default
`replace-registry-host=npmjs`); pnpm lockfiles carry no tarball URLs. Yarn 1 lockfiles with
`registry.yarnpkg.com` URLs and projects whose `.npmrc` names another registry for a scope need
that host in `CODE_SANDBOX_DOMAINS` or a fallback.

## Setup

On a single-host docker deployment, in `deploy/`:

```sh
# 1. Configuration: replace @internal with the scope(s) of your internal packages.
cp verdaccio/config.yaml.example verdaccio/config.yaml
$EDITOR verdaccio/config.yaml

# 2. Users that may publish (one per publisher, for example the CI that builds the core package).
#    htpasswd from apache2-utils prompts for the password; bcrypt only.
htpasswd -B -c verdaccio/htpasswd ci-publisher       # -c only for the first user
chmod 0644 verdaccio/htpasswd                         # the container user (uid 10001) reads it

# 3. Optional: other address or subnet in deploy/.env if 172.31.250.0/28 is taken.
#    REGISTRY_SUBNET=10.250.0.0/28
#    REGISTRY_ADDRESS=10.250.0.10
#    REGISTRY_PORT=4873                               # host port on 127.0.0.1 for publishing

# 4. Start it and check it.
docker compose --profile registry up -d registry
docker compose ps registry                            # healthy
npm view is-number version --registry http://172.31.250.10:4873/
```

Without `htpasswd` on the host:
`docker run --rm -it httpd:2.4-alpine htpasswd -nB ci-publisher >> verdaccio/htpasswd`.

Then the runner host, as root:

```sh
# 5. Helper configuration: allow exactly this registry.
#    /etc/conclavix/agent-sandbox.json: "packageRegistries": ["http://172.31.250.10:4873/"]
# 6. Runner configuration, /etc/conclavix/runner.env:
#    CODE_PACKAGE_REGISTRY=http://172.31.250.10:4873/
#    CODE_PACKAGE_REGISTRY_SCOPES=@internal
systemctl restart conclavix-runner
# 7. Acceptance (reads CODE_PACKAGE_REGISTRY from runner.env).
sudo deploy/sandbox-acceptance.sh
sudo deploy/sandbox-acceptance.sh --with-claude
```

The runner logs `coding agents enabled` with `packageRegistry`. Coding runs mention the registry
and the internal scopes in their prompt.

Verdaccio's settings in `config.yaml.example`:

| Setting                        | Value                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `web.enable`                   | `false`: no web UI, API only                                                 |
| `auth.htpasswd.max_users`      | `-1`: no self-registration (`npm adduser` fails)                             |
| internal scope (`@internal/*`) | `access: $all`, `publish`/`unpublish: $authenticated`, **no** `proxy`        |
| `@*/*` and `**`                | `access: $all`, `proxy: npmjs`, publish only for a group nobody has          |
| `uplinks.npmjs`                | `cache: true` (tarballs kept), metadata `maxage: 10m`                        |
| `log.level`                    | `warn`; `http` logs one line per request                                     |
| container                      | read-only root, `cap_drop: ALL`, `no-new-privileges`, health check `/-/ping` |

Reading needs no login: every client that can reach the address may install. The address is
reachable from the host and from containers routed to it, not from the LAN (the port on the host
is published on `127.0.0.1` only).

## Publishing internal packages

With `max_users: -1` Verdaccio 6 refuses `npm login` (it treats it as a registration), so
publishers authenticate with the htpasswd user directly. In the publisher's own npm configuration
(never in a repository):

```ini
; ~/.npmrc of the CI user, mode 0600
//127.0.0.1:4873/:_auth=<base64 of user:password>
```

```sh
npm publish --registry http://127.0.0.1:4873/
```

Only names under the internal scopes can be published; anything else is refused with 403, so an
upload cannot shadow a public package. Agents get no credentials and cannot publish: a missing
internal package is a task for whoever owns the publisher.

A product's packages then simply depend on `"@internal/core": "^1.2.0"`, and coding runs install
it like any other dependency.

## Backup, upgrade, removal

- **Backup.** The volume `conclavix_registry-storage` holds the internal packages
  (`/verdaccio/storage/data`) and Verdaccio's token secret; the cached public packages can be
  downloaded again. Back up at least the internal scope directories, for example
  `docker run --rm -v conclavix_registry-storage:/s:ro -v "$PWD":/b alpine tar -C /s -czf
/b/registry-$(date +%F).tgz data`, together with `verdaccio/config.yaml` and
  `verdaccio/htpasswd`.
- **Upgrade.** The image is pinned by tag and digest in `compose.yaml` (6.x is the maintained
  stable line; 7 is in pre-release). Change both, read the release notes, then
  `docker compose --profile registry up -d registry`. Runs that install during the restart fail
  their install; schedule it outside busy hours.
- **Users.** Add or change users with `htpasswd -B verdaccio/htpasswd <user>`, remove one by
  deleting its line, then `docker compose --profile registry restart registry` (the file is a
  single-file bind mount; a tool that replaces it leaves the container on the old copy).
- **Turning it off.** Remove `CODE_PACKAGE_REGISTRY` from `runner.env`, restart the runner, then
  `docker compose --profile registry stop registry`. Keep or remove the entry in
  `packageRegistries`; without the runner setting it is unused.
