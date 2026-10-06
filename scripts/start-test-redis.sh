#!/usr/bin/env bash
# Starts (or reuses) a disposable Redis on a RAM disk and waits until it answers.
set -euo pipefail

name="${1:-conclavix-test-redis}"
port="${2:-6390}"

state="$(docker inspect --format '{{.State.Status}} {{.Config.Image}}' "$name" 2>/dev/null || true)"
if [ -n "$state" ]; then
  bound="$(docker inspect --format '{{range (index .HostConfig.PortBindings "6379/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}' "$name" 2>/dev/null || true)"
  if [ "$bound" != "127.0.0.1:${port}" ]; then
    echo "Container $name is bound to '${bound}', not 127.0.0.1:${port}; pick another name or port." >&2
    exit 1
  fi
fi
case "$state" in
  '')
    docker run -d --name "$name" -p "127.0.0.1:${port}:6379" --tmpfs /data \
      redis:8-alpine redis-server --save '' --appendonly no >/dev/null
    ;;
  'running redis:8-alpine') ;;
  'exited redis:8-alpine' | 'created redis:8-alpine') docker start "$name" >/dev/null ;;
  *)
    echo "Container $name exists but is not a Redis test container ($state); pick another name." >&2
    exit 1
    ;;
esac

for _ in $(seq 1 30); do
  if [ "$(docker exec "$name" redis-cli ping 2>/dev/null)" = "PONG" ]; then
    echo "Redis ready: redis://127.0.0.1:${port}"
    exit 0
  fi
  sleep 1
done
echo "Redis ($name) did not answer within 30 s" >&2
exit 1
