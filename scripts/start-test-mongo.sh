#!/usr/bin/env bash
# Starts (or reuses) a disposable single-node MongoDB replica set on a RAM disk and waits until it is primary.
set -euo pipefail

name="${1:-conclavix-test-mongo}"
port="${2:-27088}"

mongosh_eval() {
  docker exec "$name" mongosh --quiet --eval "$1"
}

wait_for() {
  local description="$1" check="$2"
  for _ in $(seq 1 30); do
    if [ "$(mongosh_eval "$check" 2>/dev/null)" = "true" ]; then
      return 0
    fi
    sleep 1
  done
  echo "MongoDB ($name): $description within 30 s failed" >&2
  exit 1
}

state="$(docker inspect --format '{{.State.Status}} {{.Config.Image}}' "$name" 2>/dev/null || true)"
if [ -n "$state" ]; then
  bound="$(docker inspect --format '{{range (index .HostConfig.PortBindings "27017/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}' "$name" 2>/dev/null || true)"
  if [ "$bound" != "127.0.0.1:${port}" ]; then
    echo "Container $name is bound to '${bound}', not 127.0.0.1:${port}; pick another name or port." >&2
    exit 1
  fi
fi
case "$state" in
  '')
    docker run -d --name "$name" -p "127.0.0.1:${port}:27017" \
      --ulimit nofile=64000:64000 \
      --tmpfs /data/db --tmpfs /data/configdb \
      mongo:8 --replSet rs0 --bind_ip_all >/dev/null
    ;;
  'running mongo:8') ;;
  'exited mongo:8' | 'created mongo:8') docker start "$name" >/dev/null ;;
  *)
    echo "Container $name exists but is not a MongoDB test container ($state); pick another name." >&2
    exit 1
    ;;
esac

wait_for 'accepting connections' 'db.runCommand({ping: 1}).ok === 1'
mongosh_eval 'try { rs.status().ok } catch (e) {
  rs.initiate({_id: "rs0", members: [{_id: 0, host: "127.0.0.1:27017"}]}).ok
}' >/dev/null
wait_for 'electing a primary' 'db.hello().isWritablePrimary'

echo "MongoDB replica set ready: mongodb://127.0.0.1:${port}/?directConnection=true"
