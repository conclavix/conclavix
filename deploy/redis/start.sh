#!/bin/sh
# Builds the Redis config on a tmpfs so the password is neither on the command line nor on disk.
# The default user is disabled; the application user may run everything except admin commands
# and flushing the data set.
set -eu
: "${REDIS_PASSWORD:?REDIS_PASSWORD must be set in redis.env}"
conf=/run/redis-conf/redis.conf
umask 077
cat > "$conf" <<CONF
appendonly yes
user default off
user ${REDIS_USERNAME:-conclavix} on >${REDIS_PASSWORD} ~* &* +@all -@admin -flushall -flushdb
CONF
chown redis:redis "$(dirname "$conf")" "$conf"
unset REDIS_PASSWORD
exec docker-entrypoint.sh redis-server "$conf"
