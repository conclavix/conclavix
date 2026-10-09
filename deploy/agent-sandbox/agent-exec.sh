#!/bin/bash
# Started by agent-run inside the transient unit as the agent user. Reads the environment for
# claude from the first stdin lines (NAME=base64 value, ended by an empty line), sets a fresh HOME
# and package caches on the unit's private /tmp, then execs the program named in $1 with the rest
# of the arguments. The remaining stdin (the stream-json prompt) stays for that program, always as a
# pipe. Besides claude's own variables, the block may carry the project secrets the board gave the
# agent (docs/secrets.md): any upper-case name that is not reserved below. Keep `reserved` in step
# with RESERVED_SECRET_ENV_NAMES and RESERVED_SECRET_ENV_PREFIXES in packages/core.
set -euo pipefail
umask 077

readonly allowed='^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_[A-Z0-9_]+|CONCLAVIX_RUN_BEARER|ENABLE_TOOL_SEARCH|LANG|LC_[A-Z]+|TZ)$'
readonly project_secret='^[A-Z][A-Z0-9_]{0,63}$'
readonly reserved='^(PATH|HOME|SHELL|USER|LOGNAME|PWD|OLDPWD|TMPDIR|TMP|TEMP|TERM|IFS|ENV|CDPATH|GLOBIGNORE|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|HOSTNAME|MAIL|LANG|LANGUAGE|TZ|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|FTP_PROXY|COREPACK_HOME|UV_CACHE_DIR|PIP_CACHE_DIR|SSL_CERT_FILE|SSL_CERT_DIR|LOCPATH|NLSPATH|HOSTALIASES|RES_OPTIONS|LOCALDOMAIN|TMOUT|PS1|PS2|PS3|PS4|UID|EUID|PPID|SHLVL|RANDOM|SRANDOM|SECONDS|LINENO|GROUPS|PIPESTATUS|FUNCNAME|DIRSTACK|EPOCHSECONDS|EPOCHREALTIME|OPTIND|OPTARG|OPTERR|HOSTTYPE|OSTYPE|MACHTYPE|MAILPATH|MAILCHECK|POSIXLY_CORRECT|IGNOREEOF|INPUTRC|TIMEFORMAT|FCEDIT|PS0|(CLAUDE|ANTHROPIC|CONCLAVIX|CVX_|ENABLE_|DISABLE_|LD_|DYLD_|BASH|NODE_|NPM_CONFIG_|XDG_|LC_|SUDO_|SYSTEMD_|DBUS_|GIT_|SSH_|OTEL_|BUN_|PYTHON|PERL|RUBY|GCONV_|GLIBC_|MALLOC_|HIST|COMP_|READLINE_).*)$'
readonly base64_value='^[A-Za-z0-9+/]*={0,2}$'
readonly max_lines=128

if [[ $# -lt 1 || ${1:0:1} != / ]]; then
  echo 'agent-exec: the first argument must be an absolute program path' >&2
  exit 64
fi

env_count=0
while IFS= read -r line; do
  [[ -z $line ]] && break
  env_count=$((env_count + 1))
  if ((env_count > max_lines)); then
    echo 'agent-exec: too many environment lines' >&2
    exit 64
  fi
  name=${line%%=*}
  encoded=${line#*=}
  if [[ $name =~ $allowed ]]; then
    :
  elif [[ ! $name =~ $project_secret || $name =~ $reserved ]]; then
    echo 'agent-exec: refusing an environment line' >&2
    exit 64
  fi
  if [[ $line != *=* || ! $encoded =~ $base64_value ]]; then
    echo 'agent-exec: refusing an environment line' >&2
    exit 64
  fi
  value=$(printf '%s' "$encoded" | base64 -d) || exit 64
  export "$name=$value"
done
unset line name encoded value

# Anything that reopens stdin by path (/dev/stdin) starts a regular file again at offset 0, which
# replays the environment lines read above, and cannot open the socket node's spawn passes. A
# fresh pipe holds only the rest of the input.
if [[ ! -p /dev/stdin ]]; then
  exec 0< <(exec env -i /bin/cat)
fi

export HOME=/tmp/cvx-home
export XDG_CACHE_HOME=/tmp/cvx-cache
export npm_config_cache=/tmp/cvx-cache/npm
export COREPACK_HOME=/tmp/cvx-cache/corepack
export UV_CACHE_DIR=/tmp/cvx-cache/uv
export PIP_CACHE_DIR=/tmp/cvx-cache/pip
export PATH=/usr/local/bin:/usr/bin:/bin
export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1
export DISABLE_AUTOUPDATER=1
unset CLAUDE_CONFIG_DIR
mkdir -p -m 0700 "$HOME" "$XDG_CACHE_HOME"

exec "$@"
