#!/usr/bin/env bash
# Usage: START_ERROR_FILE=<file> sandbox.sh
# Installs bubblewrap and socat, grants user namespaces to the bwrap binary only (AppArmor profile
# fixer-bwrap on Ubuntu 24.04) and runs a self-test. On failure the first error line is written to
# START_ERROR_FILE and the script exits 1.
set -uo pipefail
mkdir -p "$(dirname "$START_ERROR_FILE")"
fail() {
  printf '%s\n' "$1" > "$START_ERROR_FILE"
  echo "::error::$1"
  exit 1
}
installed=false
for attempt in 1 2 3; do
  if sudo apt-get update -qq &&
    sudo apt-get install -y -qq --no-install-recommends bubblewrap socat; then
    installed=true
    break
  fi
  echo "apt-get attempt $attempt failed, retrying"
  sleep 5
done
[ "$installed" = true ] || fail "bubblewrap could not be installed with apt-get"
bwrap_bin="$(command -v bwrap)" || fail "bwrap is not on PATH after the install"
restrict="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
echo "kernel.apparmor_restrict_unprivileged_userns=$restrict"
if [ "$restrict" = 1 ]; then
  printf 'abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile fixer-bwrap %s flags=(unconfined) {\n  userns,\n}\n' \
    "$bwrap_bin" | sudo tee /etc/apparmor.d/fixer-bwrap > /dev/null
  sudo apparmor_parser -r /etc/apparmor.d/fixer-bwrap ||
    fail "the AppArmor profile for bwrap could not be loaded"
fi
if ! out="$(bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent --new-session true 2>&1)"; then
  fail "bubblewrap self-test failed: $(printf '%s\n' "$out" | grep -m 1 . || echo 'no output')"
fi
echo "$(bwrap --version) opens a sandbox on this runner."
