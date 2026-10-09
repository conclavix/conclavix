#!/bin/bash
# Acceptance test of the coding-agent sandbox (docs/coding-agents.md). Run as root on the runner
# host after installing or updating the helper, bubblewrap or Claude Code:
#
#   sudo deploy/sandbox-acceptance.sh                # probes only, no Claude run
#   sudo deploy/sandbox-acceptance.sh --with-claude  # plus one real, minimal Claude run
#
# Starting it through sudo is fine: the helper is called with an empty environment (env -i), so
# the SUDO_* variables that make it refuse probe mode for the runner never reach it.
#
# The probe mode starts real transient units through the installed root helper with a scripted
# probe instead of claude. --with-claude starts claude through the runner's path (cvx-runner,
# sudo, helper) with the runner's credentials from /etc/conclavix/runner.env and asks it to run
# one probe script with Bash; it costs one short model turn. That run also gets an MCP server like
# the board's: a stub on 127.0.0.1 that answers only the run's bearer, which claude must expand from
# the variable the runner uses (the init event has to report it as connected), and a connection's
# server whose `Bearer ${CONCLAVIX_MCP_HEADER_1}` header must arrive exactly. Nothing secret is
# printed: the probes report PASS/FAIL per check, and the Claude output is parsed for those lines
# only.
set -euo pipefail

HELPER=${HELPER:-/usr/local/libexec/conclavix/agent-run.mjs}
CODE_ROOT=${CODE_ROOT:-/srv/conclavix/code}
RUNNER_ENV=${RUNNER_ENV:-/etc/conclavix/runner.env}
# Any LAN address the host itself can reach (TCP port 53); defaults to the host's default gateway.
LAN_PROBE_HOST=${LAN_PROBE_HOST:-$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')}
if [[ ! ${LAN_PROBE_HOST:-} =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
  echo 'LAN_PROBE_HOST is not set and no default gateway was found; set it to a LAN IPv4 address' >&2
  exit 2
fi
# Host test tools (CODE_SANDBOX_TOOLS, NAME_BIN=/path,...): from this environment, else the runner's.
if [[ -z ${CODE_SANDBOX_TOOLS+set} && -r $RUNNER_ENV ]]; then
  CODE_SANDBOX_TOOLS=$(sed -n 's/^CODE_SANDBOX_TOOLS=//p' "$RUNNER_ENV" | tail -1 | tr -d "\"' ")
fi
tool_args=()
tool_names=()
IFS=, read -ra tool_entries <<<"${CODE_SANDBOX_TOOLS:-}"
for entry in "${tool_entries[@]}"; do
  entry=${entry// /}
  [[ -z $entry ]] && continue
  tool_args+=(--tool "$entry")
  tool_names+=("${entry%%=*}")
done
# Package registry (CODE_PACKAGE_REGISTRY, docs/package-registry.md): from this environment, else
# the runner's. The helper must list the same URL in packageRegistries.
runner_value() { if [[ -r $RUNNER_ENV ]]; then sed -n "s/^$1=//p" "$RUNNER_ENV" | tail -1 | tr -d "\"' "; fi; }
[[ -z ${CODE_PACKAGE_REGISTRY+set} ]] && CODE_PACKAGE_REGISTRY=$(runner_value CODE_PACKAGE_REGISTRY)
[[ -z ${CODE_PACKAGE_REGISTRY_FALLBACK+set} ]] && CODE_PACKAGE_REGISTRY_FALLBACK=$(runner_value CODE_PACKAGE_REGISTRY_FALLBACK)
registry_args=()
registry_only=0
if [[ -n ${CODE_PACKAGE_REGISTRY:-} ]]; then
  [[ $CODE_PACKAGE_REGISTRY == */ ]] || CODE_PACKAGE_REGISTRY="$CODE_PACKAGE_REGISTRY/"
  case ${CODE_PACKAGE_REGISTRY_FALLBACK:-false} in
  true | 1 | yes | on) registry_args=(--package-registry "$CODE_PACKAGE_REGISTRY" --registry-fallback yes) ;;
  *) registry_args=(--package-registry "$CODE_PACKAGE_REGISTRY" --registry-fallback no) registry_only=1 ;;
  esac
fi
PROJECT=ffffffffffffffffffacce55
TAG=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
WITH_CLAUDE=0
[[ ${1:-} == --with-claude ]] && WITH_CLAUDE=1

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  failures=$((failures + 1))
}
check() { if [[ $2 == "$3" ]]; then pass "$1"; else fail "$1 (got: $2)"; fi; }

[[ $(id -u) -eq 0 ]] || { echo 'run as root' >&2; exit 2; }
for need in "$HELPER" /usr/bin/bwrap /usr/bin/systemd-run /etc/claude-code; do
  [[ -e $need ]] || { echo "missing: $need" >&2; exit 2; }
done
getent passwd cvx-agent cvx-runner >/dev/null && getent group cvx-code >/dev/null ||
  { echo 'users cvx-agent, cvx-runner and group cvx-code are required' >&2; exit 2; }
echo "claude $(/usr/bin/claude --version 2>/dev/null | head -1), $(bwrap --version), $(systemctl --version | head -1)"

work=$(mktemp -d /run/cvx-acceptance.XXXXXX)
clones="$CODE_ROOT/workspaces/$PROJECT"
stub=
cleanup() {
  [[ -n $stub ]] && kill "$stub" 2>/dev/null
  for unit in $(systemctl list-units --all --plain --no-legend 'cvx-agent-*' | awk '{print $1}'); do
    case $unit in cvx-agent-0000000000000000000acc*) systemctl stop "$unit" || true ;; esac
  done
  rm -r --one-file-system "$work"
  [[ -d $clones ]] && rm -r --one-file-system "$clones"
  return 0
}
trap cleanup EXIT

install -d -o cvx-runner -g cvx-code -m 2770 "$CODE_ROOT/workspaces" "$clones" "$clones/ACC-1" "$clones/ACC-2"
echo 'other issue' >"$clones/ACC-2/secret.txt"
chown cvx-runner:cvx-code "$clones/ACC-2/secret.txt"

# --- Probe inside the unit (outer layer) -------------------------------------------------------
cat >"$work/probe.sh" <<'PROBE'
#!/bin/bash
r() { if eval "$2" >/dev/null 2>&1; then echo "ACC $1=yes"; else echo "ACC $1=no"; fi; }
mode=${1:-basic}
case $mode in
memory) head -c 2000M /dev/zero | tail >/dev/null; exit 0 ;;
tasks) for i in $(seq 1 300); do sleep 5 & done; wait; exit 0 ;;
sleep) sleep 600; exit 0 ;;
disk) head -c 100M /dev/zero >big.bin; sleep 120; exit 0 ;;
esac
echo "ACC uid=$(id -un)"
echo "ACC literal-arg=$([[ ${2:-} == '${CONCLAVIX_RUN_BEARER} $HOME' ]] && echo yes || echo no)"
r policy-noexec 'findmnt -no OPTIONS -T "$0" | tr , "\\n" | grep -qx noexec'
echo "ACC scrub=$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"
echo "ACC home-empty=$([[ -z $(ls -A "$HOME" 2>/dev/null) ]] && echo yes || echo no)"
r token-file 'cat /etc/conclavix/runner.env'
r agent-home 'cat /home/cvx-agent/.claude.json'
r host-init 'grep -qx systemd /proc/1/comm'
echo "ACC foreign-procs=$(ps -eo user= | grep -vc "^$(id -un)\$" || true)"
r other-clone 'cat ../ACC-2/secret.txt'
r repos-visible "ls $CODE_ROOT/repos"
r runner-workspaces 'ls /srv/conclavix/workspaces'
r write-clone 'echo ok > own.txt'
r write-etc 'echo x > /etc/cvx-acceptance'
r write-usr 'echo x > /usr/local/cvx-acceptance'
r write-tmp 'echo x > /tmp/x'
r lan 'timeout 3 bash -c "echo > /dev/tcp/$LAN_PROBE_HOST/53"'
r registry 'timeout 10 bash -c "echo > /dev/tcp/registry.npmjs.org/443"'
# Host test tools: names only, and whether each path runs (they are not secret, but stay generic).
for name in $(compgen -e | grep -E '^[A-Z][A-Z0-9_]*_BIN$'); do
  if [[ -x ${!name} ]]; then echo "ACC tool-$name=yes"; else echo "ACC tool-$name=no"; fi
done
r mongod-version '[[ -n ${MONGOD_BIN:-} ]] && "$MONGOD_BIN" --version'
# Package registry: the unit's variable and an install lookup through it (no proxy at this layer).
echo "ACC registry-env=${npm_config_registry:-unset}"
r registry-npm-view '[[ -n ${npm_config_registry:-} ]] && timeout 90 npm view is-number version'
r bwrap 'bwrap --unshare-all --die-with-parent --ro-bind / / --proc /proc --dev /dev -- /bin/true'
for port in 27017 6379 4000 3300; do
  r "netns-$port" "bwrap --unshare-all --die-with-parent --ro-bind / / --proc /proc --dev /dev -- bash -c 'timeout 3 bash -c \"echo > /dev/tcp/127.0.0.1/$port\"'"
done
r netns-example 'bwrap --unshare-all --die-with-parent --ro-bind / / --proc /proc --dev /dev -- timeout 5 bash -c "echo > /dev/tcp/example.com/443"'
PROBE
sed -i -e "s|\$CODE_ROOT|$CODE_ROOT|" -e "s|\$LAN_PROBE_HOST|$LAN_PROBE_HOST|" "$work/probe.sh"
chmod 0755 "$work/probe.sh"

fake=$(printf 'acceptance-%s' "$TAG" | base64 -w0)
# Must reach the probe as written: systemd would expand it from the unit's environment otherwise,
# and the MCP header reference of a real run would arrive empty.
# shellcheck disable=SC2016
literal_arg='${CONCLAVIX_RUN_BEARER} $HOME'
# The helper refuses probe mode when it sees SUDO_UID (that is how the runner calls it), so it is
# started with nothing from this environment but PATH and, for tests, the configuration override
# that it only honours for root without sudo.
helper_env=(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin)
[[ -n ${CVX_AGENT_SANDBOX_CONFIG:-} ]] && helper_env+=("CVX_AGENT_SANDBOX_CONFIG=$CVX_AGENT_SANDBOX_CONFIG")
probe() {
  local run_id=$1 mode=$2
  shift 2
  printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n\n' "$fake" |
    "${helper_env[@]}" /usr/bin/node "$HELPER" probe "$work/probe.sh" run --run-id "$run_id" --project "$PROJECT" \
      --issue ACC-1 --status-tag "$TAG" "${tool_args[@]}" "${registry_args[@]}" "$@" -- "$mode" "$literal_arg" 2>"$work/stderr" || true
}
result_of() { grep -o '"result":"[a-z-]*"' "$work/stderr" | tail -1 | cut -d'"' -f4; }

echo '--- outer unit'
out=$(probe 0000000000000000000acc01 basic)
value() { printf '%s\n' "$out" | sed -n "s/^ACC $1=//p" | head -1; }
check 'runs as cvx-agent' "$(value uid)" cvx-agent
check 'arguments reach the unit without variable expansion' "$(value literal-arg)" yes
check 'policy directory mounted noexec in the unit' "$(value policy-noexec)" yes
check 'subprocess environment scrub on' "$(value scrub)" 1
check 'fresh empty HOME' "$(value home-empty)" yes
check 'runner.env unreadable' "$(value token-file)" no
check 'agent home hidden' "$(value agent-home)" no
check 'own PID namespace (host init not visible)' "$(value host-init)" no
check 'no processes of other users visible' "$(value foreign-procs)" 0
check 'other issue clone hidden' "$(value other-clone)" no
check 'project repositories hidden' "$(value repos-visible)" no
check 'runner workspaces hidden' "$(value runner-workspaces)" no
check 'can write its clone' "$(value write-clone)" yes
check 'cannot write /etc' "$(value write-etc)" no
check 'cannot write /usr' "$(value write-usr)" no
check 'private /tmp writable' "$(value write-tmp)" yes
check 'LAN unreachable' "$(value lan)" no
check 'registry.npmjs.org reachable (for the sandbox proxy)' "$(value registry)" yes
check 'bubblewrap works under NoNewPrivileges' "$(value bwrap)" yes
for port in 27017 6379 4000 3300; do
  check "sandboxed commands cannot reach 127.0.0.1:$port" "$(value "netns-$port")" no
done
check 'sandboxed commands have no direct internet' "$(value netns-example)" no
check 'clone handed back to cvx-runner:cvx-code' "$(stat -c %U:%G "$clones/ACC-1/own.txt")" cvx-runner:cvx-code
check 'unit result' "$(result_of)" success

echo '--- host test tools'
if ((${#tool_names[@]} == 0)); then
  echo 'NOTICE  CODE_SANDBOX_TOOLS is not configured; tool checks skipped'
else
  for name in "${tool_names[@]}"; do
    check "$name set and executable in the unit" "$(value "tool-$name")" yes
  done
  if [[ " ${tool_names[*]} " == *' MONGOD_BIN '* ]]; then
    check '"$MONGOD_BIN" --version runs in the unit' "$(value mongod-version)" yes
  else
    echo 'NOTICE  MONGOD_BIN is not configured; mongod check skipped'
  fi
fi

echo '--- package registry'
if [[ -z ${CODE_PACKAGE_REGISTRY:-} ]]; then
  echo 'NOTICE  CODE_PACKAGE_REGISTRY is not configured; registry checks skipped'
  check 'no registry variable in the unit' "$(value registry-env)" unset
else
  check 'npm_config_registry set in the unit' "$(value registry-env)" "$CODE_PACKAGE_REGISTRY"
  check 'npm view through the registry from the unit' "$(value registry-npm-view)" yes
fi

echo '--- limits'
probe 0000000000000000000acc02 memory --memory-max 256M >/dev/null
check 'memory limit stops the unit' "$(result_of)" oom-kill
probe 0000000000000000000acc03 tasks --tasks-max 64 >/dev/null
check 'process limit holds' "$(grep -c 'fork: retry\|Resource temporarily unavailable' "$work/stderr" | awk '{print ($1 > 0) ? "hit" : "missed"}')" hit
probe 0000000000000000000acc04 disk --disk-limit-mb 20 >/dev/null
check 'disk limit stops the unit' "$(result_of)" disk-limit
rm -f "$clones/ACC-1/big.bin"
probe 0000000000000000000acc05 sleep --runtime-max-sec 60 >/dev/null
check 'time limit stops the unit' "$(result_of)" timeout
check 'no unit left' "$(systemctl list-units --all --plain --no-legend 'cvx-agent-0000000000000000000acc*' | wc -l)" 0

# --- A real Claude run through the runner's path ----------------------------------------------
if [[ $WITH_CLAUDE -eq 1 ]]; then
  echo '--- claude in the sandbox'
  [[ -r $RUNNER_ENV ]] || { fail "cannot read $RUNNER_ENV"; exit 1; }
  cat >"$clones/ACC-1/acceptance-probe.sh" <<'INNER'
#!/bin/bash
r() { if eval "$2" >/dev/null 2>&1; then echo "ACCIN $1=yes"; else echo "ACCIN $1=no"; fi; }
# Variable names only (compgen -e), never values: a multi-line value would leak through `env`.
names() { compgen -e | grep -E "$1" | paste -sd, - | grep . || echo none; }
# CLOUDSDK_PROXY_* are the credentials of Claude Code's own sandbox proxy, set for every command.
# Project secrets (docs/secrets.md) are meant for Bash; the two ACCEPTANCE_* test values are
# compared by a hash prefix, the credential check leaves them out.
sum() { printf '%s' "$1" | sha256sum | cut -c1-16; }
echo "ACCIN project-secret=$(sum "${ACCEPTANCE_PROJECT_VALUE:-}")"
echo "ACCIN credential-named-secret=$(sum "${ACCEPTANCE_API_KEY:-}")"
echo "ACCIN credential-env=$(compgen -e | grep -Ev '^(CLOUDSDK_PROXY_|ACCEPTANCE_)' | grep -E 'TOKEN|API_KEY|CUSTOM_HEADERS|SECRET|PASSWORD|^CONCLAVIX_' | paste -sd, - | grep . || echo none)"
echo "ACCIN proxy-env=$(names '^CLOUDSDK_PROXY_')"
echo "ACCIN anthropic-env=$(names '^ANTHROPIC_')"
echo "ACCIN home=$HOME"
echo "ACCIN tools-env=$(compgen -e | grep -E '^[A-Z][A-Z0-9_]*_BIN$' | sort | paste -sd, - | grep . || echo none)"
r mongod-version '[[ -n ${MONGOD_BIN:-} ]] && "$MONGOD_BIN" --version'
echo "ACCIN procs=$(ls /proc | grep -c '^[0-9]' || true)"
r token-file 'cat /etc/conclavix/runner.env'
r example 'curl -sf --max-time 10 https://example.com'
r example-noproxy 'curl -sf --noproxy "*" --max-time 10 https://example.com'
r registry 'curl -sf --max-time 20 https://registry.npmjs.org/left-pad'
echo "ACCIN registry-env=${npm_config_registry:-unset}"
r npm-view 'timeout 120 npm view is-number version'
for port in 27017 6379 4000 3300; do r "local-$port" "timeout 3 bash -c 'echo > /dev/tcp/127.0.0.1/$port'"; done
r git-hooks 'echo x > .git/hooks/pre-commit'
r claude-settings 'mkdir -p .claude && echo {} > .claude/settings.json'
r home-credentials 'find "$HOME" -name .credentials.json | grep -q .'
r write-clone 'echo ok > inner.txt'
INNER
  ln -s /proc/self/environ "$clones/ACC-1/environ-link"
  chown -h cvx-runner:cvx-code "$clones/ACC-1/acceptance-probe.sh" "$clones/ACC-1/environ-link"
  # A minimal MCP server (streamable HTTP, JSON responses) on loopback, where the board API listens.
  # On /mcp it answers only `Bearer <run bearer>`, on /connection only `Bearer <connection
  # credential>`, and logs per path whether it accepted or refused a request (with the length of
  # what it got, never the value).
  bearer="cvx_run_acceptance-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  # Long enough that Claude Code would blank a variable holding `Bearer <it>` under its env scrub:
  # the runner writes the scheme into the config and only the credential into the variable.
  connection_credential="acceptance-connection-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  # Throwaway values standing in for project secrets: one plain name, one that looks like a credential.
  project_value="acceptance-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  api_key_value="acceptance-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s' "$bearer" >"$work/bearer"
  printf '%s' "$connection_credential" >"$work/connection-credential"
  cat >"$work/mcp-stub.cjs" <<'STUB'
const http = require('node:http');
const fs = require('node:fs');
const [bearerFile, connectionFile, portFile, logFile] = process.argv.slice(2);
const expected = {
  '/mcp': `Bearer ${fs.readFileSync(bearerFile, 'utf8')}`,
  '/connection': `Bearer ${fs.readFileSync(connectionFile, 'utf8')}`,
};
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  const want = expected[req.url];
  const got = req.headers.authorization ?? '';
  const ok = want !== undefined && got === want;
  fs.appendFileSync(logFile, `${ok ? 'accepted' : 'refused'} ${req.url === '/connection' ? 'connection' : 'board'} ${got.length}\n`);
  if (!ok) return send(res, 401, { error: 'unauthorized' });
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'bad_request' });
    }
    if (message.id === undefined) return send(res, 202);
    const reply = (result) => send(res, 200, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      return reply({
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'conclavix-acceptance', version: '1' },
      });
    }
    if (message.method === 'tools/list') return reply({ tools: [] });
    if (message.method === 'ping') return reply({});
    return send(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } });
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
STUB
  : >"$work/mcp-log"
  /usr/bin/node "$work/mcp-stub.cjs" "$work/bearer" "$work/connection-credential" "$work/mcp-port" "$work/mcp-log" &
  stub=$!
  for _ in $(seq 1 50); do [[ -s $work/mcp-port ]] && break; sleep 0.1; done
  mcp_config="{\"mcpServers\":{\"conclavix\":{\"type\":\"http\",\"url\":\"http://127.0.0.1:$(cat "$work/mcp-port")/mcp\",\"headers\":{\"Authorization\":\"Bearer \${CONCLAVIX_RUN_BEARER}\"}},\"acceptance-extra\":{\"type\":\"http\",\"url\":\"http://127.0.0.1:$(cat "$work/mcp-port")/connection\",\"headers\":{\"Authorization\":\"Bearer \${CONCLAVIX_MCP_HEADER_1}\"}}}}"
  {
    while IFS= read -r line; do
      name=${line%%=*}
      case $name in CLAUDE_CODE_OAUTH_TOKEN | ANTHROPIC_*) ;; *) continue ;; esac
      value=${line#*=}
      value=${value#\"}
      value=${value%\"}
      printf '%s=%s\n' "$name" "$(printf '%s' "$value" | base64 -w0)"
    done <"$RUNNER_ENV"
    printf 'CONCLAVIX_RUN_BEARER=%s\n' "$(base64 -w0 <"$work/bearer")"
    # A connection's MCP server (docs/connections.md): the same stub on /connection. Like the
    # runner, the scheme stands in the config and the variable holds the credential alone.
    printf 'CONCLAVIX_MCP_HEADER_1=%s\n' "$(base64 -w0 <"$work/connection-credential")"
    printf 'ACCEPTANCE_PROJECT_VALUE=%s\n' "$(printf '%s' "$project_value" | base64 -w0)"
    printf 'ACCEPTANCE_API_KEY=%s\n' "$(printf '%s' "$api_key_value" | base64 -w0)"
    printf '\n'
    printf '%s\n' '{"type":"control_request","request_id":"init","request":{"subtype":"initialize"}}'
    printf '%s\n' '{"type":"user","session_id":"","parent_tool_use_id":null,"message":{"role":"user","content":"This is an automated sandbox acceptance test. Do exactly these three steps and nothing else: 1. Run `bash ./acceptance-probe.sh` once with the Bash tool. 2. Use the Read tool on /proc/self/environ. 3. Use the Read tool on ./environ-link. Then answer DONE."}}'
  } >"$work/stdin"
  chmod 0600 "$work/stdin"
  umask 077
  # Through a pipe, not a regular file, like the runner (which passes a socket).
  # --expand-environment=no: otherwise systemd replaces ${CONCLAVIX_RUN_BEARER} in the MCP
  # config with an empty string before the helper sees it (the runner spawns sudo directly).
  cat "$work/stdin" | systemd-run --quiet --wait --pipe --expand-environment=no -p User=cvx-runner -p Group=cvx-runner \
    -p SupplementaryGroups=cvx-code -p ProtectSystem=strict -p ProtectHome=tmpfs -p PrivateTmp=yes \
    -p 'CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_AUDIT_WRITE CAP_KILL CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH' \
    -p "ReadWritePaths=-$CODE_ROOT -/run/conclavix-agent" \
    /usr/bin/sudo -n "$HELPER" run --run-id 0000000000000000000acc10 --project "$PROJECT" \
    --issue ACC-1 --status-tag "$TAG" --runtime-max-sec 600 "${tool_args[@]}" "${registry_args[@]}" -- \
    -p --input-format stream-json --output-format stream-json --verbose \
    --no-session-persistence --strict-mcp-config --mcp-config "$mcp_config" --max-budget-usd 1 \
    --setting-sources user \
    --tools Read,Grep,Glob,Skill,Edit,Write,Bash --permission-mode dontAsk \
    >"$work/stream" 2>"$work/stderr" || true
  rm -f "$work/stdin" "$work/bearer" "$work/connection-credential"
  kill "$stub" 2>/dev/null || true
  wait "$stub" 2>/dev/null || true
  stub=
  check 'claude unit result' "$(result_of)" success
  node - "$work/stream" <<'PARSE' >"$work/inner"
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const uses = new Map();
for (const line of lines) {
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event?.type === 'system' && event.subtype === 'init') {
    for (const name of ['conclavix', 'acceptance-extra']) {
      const server = (event.mcp_servers ?? []).find((s) => s.name === name);
      console.log(`ACCIN mcp-${name}=${String(server?.status ?? 'absent').replace(/[^a-z-]/g, '')}`);
    }
  }
  for (const block of event?.message?.content ?? []) {
    if (block.type === 'tool_use') uses.set(block.id, block);
    if (block.type !== 'tool_result') continue;
    const use = uses.get(block.tool_use_id);
    const text = Array.isArray(block.content) ? block.content.map((c) => c.text ?? '').join('\n') : String(block.content ?? '');
    if (use?.name === 'Bash') for (const m of text.matchAll(/^ACCIN [a-z0-9-]+=[A-Za-z0-9_,\/.:-]+$/gm)) console.log(m[0]);
    if (use?.name === 'Read') {
      const target = String(use.input?.file_path ?? '');
      const label = target.endsWith('environ-link') ? 'read-link' : target === '/proc/self/environ' ? 'read-environ' : null;
      if (label) console.log(`ACCIN ${label}=${block.is_error ? 'denied' : 'ALLOWED'}`);
    }
  }
}
PARSE
  rm -f "$work/stream"
  inner() { sed -n "s/^ACCIN $1=//p" "$work/inner" | head -1; }
  # Claude Code's subprocess scrub removes the credential variables (OAuth token, API key, auth
  # token, ANTHROPIC_CUSTOM_HEADERS with the gateway key); ANTHROPIC_BASE_URL may stay visible.
  check 'conclavix MCP server connected (run bearer expanded into the header)' "$(inner mcp-conclavix)" connected
  check 'connection MCP server connected (header value expanded from the block)' "$(inner mcp-acceptance-extra)" connected
  accepted_by() { grep -c "^accepted $1 " "$work/mcp-log" | awk '{print ($1 > 0) ? "yes" : "no"}'; }
  check 'MCP stub accepted the run bearer on the board server' "$(accepted_by board)" yes
  # Exact match in the stub; on a mismatch the log holds only the length that arrived.
  check 'MCP stub accepted the connection header (exactly Bearer <credential>)' "$(accepted_by connection)" yes
  check 'MCP stub refused nothing' "$(grep -c '^refused ' "$work/mcp-log" || true)" 0
  if grep -q '^refused ' "$work/mcp-log"; then
    echo "refused requests (server, header length; expected board $((7 + ${#bearer})), connection $((7 + ${#connection_credential}))):"
    sed -n 's/^refused //p' "$work/mcp-log" | sort | uniq -c
  fi
  check 'no credential variables in Bash' "$(inner credential-env)" none
  sum() { printf '%s' "$1" | sha256sum | cut -c1-16; }
  check 'project secret visible to Bash with its value' "$(inner project-secret)" "$(sum "$project_value")"
  # Informational: whether Claude Code's scrub also strips board-chosen names that look like
  # credentials (*_API_KEY, *_TOKEN, ...). If it does, such secrets do not reach Bash.
  if [[ $(inner credential-named-secret) == "$(sum "$api_key_value")" ]]; then
    echo 'credential-looking project secret name (ACCEPTANCE_API_KEY) visible to Bash: yes'
  else
    echo 'credential-looking project secret name (ACCEPTANCE_API_KEY) visible to Bash: NO (scrubbed)'
  fi
  echo "ANTHROPIC_* names visible to Bash (expected: none or ANTHROPIC_BASE_URL): $(inner anthropic-env)"
  echo "sandbox proxy variables visible to Bash (Claude Code's own, expected): $(inner proxy-env)"
  check 'runner.env unreadable from Bash' "$(inner token-file)" no
  check 'non-allowlisted domain refused' "$(inner example)" no
  check 'no direct connection without the proxy' "$(inner example-noproxy)" no
  if ((registry_only)); then
    check 'registry.npmjs.org not reachable (registry only)' "$(inner registry)" no
  else
    check 'registry.npmjs.org reachable through the proxy' "$(inner registry)" yes
  fi
  check 'npm view works in the Bash sandbox' "$(inner npm-view)" yes
  if [[ -n ${CODE_PACKAGE_REGISTRY:-} ]]; then
    check 'npm_config_registry visible to Bash' "$(inner registry-env)" "$CODE_PACKAGE_REGISTRY"
  fi
  for port in 27017 6379 4000 3300; do check "127.0.0.1:$port unreachable from Bash" "$(inner "local-$port")" no; done
  check '.git/hooks not writable' "$(inner git-hooks)" no
  check '.claude/settings.json not writable' "$(inner claude-settings)" no
  # HOME is writable on purpose (Claude keeps ~/.claude there); it lives on the unit's private /tmp.
  check 'HOME is the per-run throwaway dir' "$(inner home)" /tmp/cvx-home
  if ((${#tool_names[@]} > 0)); then
    # Claude Code's env scrub must leave the tool variables alone, and bubblewrap must run them.
    check 'tool variables visible to Bash' "$(inner tools-env)" "$(printf '%s\n' "${tool_names[@]}" | sort | paste -sd, -)"
    if [[ " ${tool_names[*]} " == *' MONGOD_BIN '* ]]; then
      check '"$MONGOD_BIN" --version runs in the Bash sandbox' "$(inner mongod-version)" yes
    fi
  else
    echo 'NOTICE  CODE_SANDBOX_TOOLS is not configured; tool checks in Bash skipped'
  fi
  check 'no credentials file in HOME' "$(inner home-credentials)" no
  check 'clone writable from Bash' "$(inner write-clone)" yes
  check 'Read tool denied on /proc/self/environ' "$(inner read-environ)" denied
  check 'Read tool denied on a symlink to it' "$(inner read-link)" denied
  echo "few processes visible to Bash: $(inner procs)"
fi

echo
if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo 'all checks passed'
