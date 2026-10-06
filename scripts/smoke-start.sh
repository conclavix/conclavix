#!/usr/bin/env bash
# Starts each built entry point (api, scheduler, runner) against a throwaway database, waits until it
# is up, stops it with SIGTERM and fails unless it exits cleanly in time. Run after `pnpm build`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="$root/apps/api"

mongo_base="${SMOKE_MONGO_URI:-mongodb://127.0.0.1:27088/?directConnection=true}"
redis_url="${SMOKE_REDIS_URL:-redis://127.0.0.1:6390/15}"
api_port="${SMOKE_API_PORT:-3430}"
start_timeout="${SMOKE_START_TIMEOUT_SECONDS:-30}"
alive_seconds="${SMOKE_ALIVE_SECONDS:-3}"
stop_timeout="${SMOKE_STOP_TIMEOUT_SECONDS:-15}"

db_name="conclavix_smoke_$$_$(date +%s)"
pid=''
log_file=''

if [ "$(id -u)" = "0" ]; then
  echo "smoke: run as a non-root user; the runner refuses to start as root" >&2
  exit 1
fi
for entry in server scheduler-main runner-main; do
  if [ ! -f "$api_dir/dist/$entry.js" ]; then
    echo "smoke: $api_dir/dist/$entry.js is missing; run pnpm build first" >&2
    exit 1
  fi
done

mongo_uri="$(MONGO_BASE="$mongo_base" DB_NAME="$db_name" node -e '
  const url = new URL(process.env.MONGO_BASE);
  url.pathname = "/" + process.env.DB_NAME;
  process.stdout.write(url.toString());
')"

drop_database() {
  (cd "$api_dir" && MONGO_URI="$mongo_uri" node --input-type=module -e '
    import { MongoClient } from "mongodb";
    const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    try {
      await client.db().dropDatabase();
    } finally {
      await client.close();
    }
  ')
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if ! drop_database; then
    echo "smoke: could not drop database $db_name" >&2
    if [ "$code" -eq 0 ]; then code=1; fi
  fi
  rm -rf "$work_dir" || { if [ "$code" -eq 0 ]; then code=1; fi; }
  exit "$code"
}
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/conclavix-smoke.XXXXXX")"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "smoke: FAIL $1" >&2
  if [ -n "$log_file" ] && [ -f "$log_file" ]; then
    echo "--- last log lines of $(basename "$log_file" .log) ---" >&2
    tail -n 40 "$log_file" >&2
    echo "---" >&2
  fi
  exit 1
}

board_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
auth_secret="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
web_root="$root/apps/web/dist"
mkdir -p "$work_dir/workspaces"

start() {
  local name="$1" entry="$2"
  log_file="$work_dir/$name.log"
  (
    cd "$api_dir"
    export NODE_ENV=production LOG_LEVEL=info
    export BOARD_TOKEN="$board_token" AUTH_SECRET="$auth_secret"
    export MONGO_URI="$mongo_uri" REDIS_URL="$redis_url"
    export HOST=127.0.0.1 PORT="$api_port" PUBLIC_API_URL="http://127.0.0.1:$api_port"
    export WORKSPACES_ROOT="$work_dir/workspaces" STARTUP_WAIT_SECONDS=5
    if [ -d "$web_root" ]; then export WEB_ROOT="$web_root"; fi
    exec node "dist/$entry.js"
  ) >"$log_file" 2>&1 &
  pid=$!
}

exited_early() {
  if kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  local code=0
  wait "$pid" || code=$?
  pid=''
  fail "$1 exited during startup with code $code"
}

wait_until_up() {
  local name="$1" deadline=$((SECONDS + start_timeout))
  shift
  until "$@"; do
    exited_early "$name" || true
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "$name not up within ${start_timeout}s"
    fi
    sleep 0.5
  done
}

api_healthy() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$api_port/api/health" || true)" = "200" ]
}

logged() {
  grep -qF "\"msg\":\"$1\"" "$log_file"
}

stop() {
  local name="$1" deadline=$((SECONDS + stop_timeout)) code=0
  kill -TERM "$pid"
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "$name did not exit within ${stop_timeout}s after SIGTERM"
    fi
    sleep 0.5
  done
  wait "$pid" || code=$?
  pid=''
  if [ "$code" -ne 0 ]; then
    fail "$name exited with code $code after SIGTERM"
  fi
}

check() {
  local name="$1" entry="$2"
  shift 2
  start "$name" "$entry"
  wait_until_up "$name" "$@"
  sleep "$alive_seconds"
  exited_early "$name" || true
  stop "$name"
  echo "smoke: ok $name (dist/$entry.js)"
}

check api server api_healthy
check scheduler scheduler-main logged 'scheduler started'
check runner runner-main logged 'runner started'
echo "smoke: all entry points started and stopped cleanly"
