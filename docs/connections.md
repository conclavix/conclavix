# Connections

A connection links Conclavix to an external system: a name, a type, a scope, a non-secret config
(validated by the type's schema), credentials kept in the vault and the agents that may use it.
Owners and admins manage instance-wide connections under **Administration → Connections** and a
project's own connections on the project page (tab **Secrets**, section **Connections**).

The first and so far only type is the **external MCP server** (`mcp_http`): agents allowed to use
it get the server in their run's MCP config and its tools on their allowlist.

## Model

| Field                 | Meaning                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                | `[a-z][a-z0-9-]*`, at most 40 characters, unique on the instance, not `conclavix`. For an MCP server it is the server name: its tools are `mcp__<name>__...`. |
| `type`                | One of the registered types; cannot change later.                                                                                                             |
| `scope`               | `instance` (runs on every project) or `project` (runs on that project's issues only).                                                                         |
| `config`              | Non-secret settings, parsed with the type's Zod schema on every save and before every use.                                                                    |
| credentials           | Write-only values by key, sealed in the vault like project secrets ([secrets.md](secrets.md)): `secrets` entries with `connectionId`, no variable name.       |
| `agentIds`            | The agents that may use it, in read-only and coding runs.                                                                                                     |
| `allowPrivateNetwork` | Owners only. Without it, URLs must be https and public (see below).                                                                                           |
| `lastTest`            | The outcome of the last **Test connection** (ok, summary, time), never a credential.                                                                          |

A stored credential never follows a changed URL: changing the URL removes the stored values that
are not entered again in the same change, and keys the config no longer names are removed.

## Network rules (SSRF)

The API calls the URL itself (the test), and agents' claude processes call it during runs. Like
skill directories, a connection must use https and a public host: IP literals and DNS answers in
private, loopback, link-local, shared, reserved, documentation and multicast ranges are refused,
also names like `localhost`, `*.local`, `*.internal`, single labels. The test checks every DNS
answer for the actual connection (rebinding); the runner resolves the host again before each run
and leaves out a public-only connection that now resolves to a private address.

Many self-hosted MCP servers live on a private network. An **owner** can tick **Allow private
networks** for a connection; then http and private addresses are accepted for it. Admins can no
longer change such a connection's config or credentials (only its agents), so nobody below owner
can point it elsewhere inside the network.

Coding runs need one more step for private servers: the sandbox unit denies private ranges to the
claude process (`IPAddressDeny`). The runner passes the server's private addresses to the root
helper (`--allow-address`), which opens them with `IPAddressAllow=` only if they lie inside
`mcpAllowedAddresses` in `/etc/conclavix/agent-sandbox.json` (CIDR list, default empty), root's
decision on the runner host. Addresses outside it are dropped and named in the run log
(`sandbox prepared: {... "refusedAddresses": [...]}`); the server then fails to connect in that
run. Bash never reaches these servers: it has its own network namespace and only the proxy with
the domain allowlist.

## MCP servers in runs

For each run the runner loads the connections that list the run's agent: instance connections and
those of the issue's project. A connection that cannot be used (a credential missing or not
decryptable, URL refused, DNS failure) is left out with a run event
(`connection <name> left out: ...`); the run goes on. The run log names the connections it got
(`connections: docs github`), and the audit log gets `connection.used` with run and agent id.

How the header values travel:

- The MCP config passed to claude contains only references: `"headers": {"Authorization":
"${CONCLAVIX_MCP_HEADER_1}"}`. claude expands them from its environment, so no credential is in
  argv (sudo logs the command line) or in a file.
- **Read-only runs:** the variables are in claude's environment. Through sudo they need
  `CONCLAVIX_MCP_HEADER_*` in `env_keep` (`deploy/sudoers/conclavix-runner`).
- **Coding runs:** they travel in the helper's stdin environment block like the run bearer;
  `agent-exec.sh` accepts `CONCLAVIX_MCP_HEADER_1` to `_32`, and the managed settings deny all 32
  to sandboxed commands (`sandbox.credentials`), so Bash cannot read them. The unit runs with
  `systemd-run --expand-environment=no`, so the references reach claude unchanged.
- The names avoid the words Claude Code's subprocess scrub treats as credentials (TOKEN, KEY,
  AUTH, SECRET, PASSWORD, ...): under `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` such names expand to an
  empty string in MCP headers, the same reason the run token is `CONCLAVIX_RUN_BEARER` there.
  `sandbox-acceptance.sh --with-claude` connects a second MCP server whose header comes from
  `CONCLAVIX_MCP_HEADER_1` and checks it is `connected`.
- The root helper accepts a connection server only as `type: "http"` with an http(s) URL without
  credentials and header values that are exactly `${CONCLAVIX_MCP_HEADER_<n>}`; at most 8 servers
  plus `conclavix`, 8 headers each, 32 values per run.

Tool permissions: read-only runs add `mcp__<name>` to `--allowedTools`; in coding runs the helper
adds `mcp__<name>` to the managed `permissions.allow` for every server of the run's MCP config.

Redaction: every header value (and the token of a `Bearer`/`Basic`/`Token` value) joins the run
log redactor as `[redacted:<connection>:<header>]`. Test results are redacted with the
connection's values before they are stored or shown.

## Test connection

`POST /api/connections/:id/test` runs the type's test with the stored credentials and stores the
outcome. For an MCP server: `initialize`, `notifications/initialized` and `tools/list` (all pages,
up to 10) over streamable HTTP (JSON or SSE answers), 15 seconds, no redirects, at most 2 MiB per
answer, the SSRF guard on every DNS lookup. The board shows e.g. `Connected to docs-server: 12
tools`, or why it failed (`the server refused the credentials (HTTP 401)`).

## Permissions and audit

All routes need the settings capability (owners and admins). Allowing private networks, and
changing a connection that allows them, is owner-only. Audit actions: `connection.created`,
`connection.updated` (changed fields, credential keys written, agents), `connection.deleted`,
`connection.tested` (ok or not) and `connection.used` (per run). Never a credential value.

## Adding a type

A type is one module in `apps/api/src/modules/connections/types/` implementing `ConnectionType`
(`types/types.ts`), registered in `types/index.ts`:

```ts
export const exampleType: ConnectionType<ExampleConfig> = {
  id: 'example',
  label: 'Example service',
  description: 'What it connects and what agents get from it.',
  configSchema: z.strictObject({ url: z.url().meta({ title: 'API URL' }) }),
  credentialsField: null, // or the name of a string-array config field naming the credentials
  credentialKeys: () => ['apiKey'],
  credentialLabel: 'API key',
  urls: (config) => [config.url], // checked by the SSRF guard
  async test(context) {
    // call the service with context.credentials; return { ok, summary, details? }
  },
  // optional: mcpServer(context) => ({ url, headers }) to give allowed agents tools
};
```

The board renders the form from the JSON Schema of `configSchema` (`title` and `description`
from `.meta()`): strings, URLs (`format: uri`), numbers, booleans, enums, and the credentials
field as one write-only value per entry. Types without `mcpServer` are stored and tested but give
agents nothing yet; agent tools of other kinds (for example tools on the conclavix MCP server)
would be a further hook in the same interface.
