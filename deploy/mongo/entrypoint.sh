#!/bin/bash
# Writes the replica set key from MONGO_KEYFILE to a tmpfs, then hands over to the image entrypoint.
# With authentication on, a replica set member needs a key file even when it is the only member.
set -euo pipefail
: "${MONGO_KEYFILE:?MONGO_KEYFILE must be set in mongo.env}"
: "${MONGO_INITDB_ROOT_PASSWORD:?MONGO_INITDB_ROOT_PASSWORD must be set in mongo.env}"
: "${MONGO_APP_PASSWORD:?MONGO_APP_PASSWORD must be set in mongo.env}"
key=/run/mongo-key/keyfile
chown mongodb:mongodb "$(dirname "$key")"
printf '%s' "$MONGO_KEYFILE" > "$key"
chown mongodb:mongodb "$key"
chmod 0400 "$key"
unset MONGO_KEYFILE
exec docker-entrypoint.sh "$@" --keyFile "$key"
