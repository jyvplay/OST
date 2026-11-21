#!/usr/bin/env bash
# Run one gate suite in a separate Linux process group. Give the suite a
# bounded chance to close detached children, then kill the remaining group.
set -u
if [ "$#" -lt 2 ]; then echo "Usage: gate-child.sh SECONDS COMMAND [ARG...]" >&2; exit 2; fi
if ! command -v setsid >/dev/null; then echo "REFUSED: setsid is required for browser-suite cancellation isolation" >&2; exit 2; fi
if ! command -v ps >/dev/null; then echo "REFUSED: ps is required to check process-group cleanup" >&2; exit 2; fi
duration=$1; shift
# timeout may exit as soon as its immediate child exits, even if another
# member of its group ignored TERM. Signal the remaining group and give the
# kernel a bounded interval to finish terminating it. Zombies are not running.
drain_group() {
  local group=$1 snapshot attempt pgid state live signalled=0
  # kill -0 can fail on either absence or permission denial. Check the
  # process table before accepting absence rather than treating both as clean.
  if kill -0 -- "-$group" 2>/dev/null; then
    kill -KILL -- "-$group" 2>/dev/null || { echo "FAILED: could not kill process group $group" >&2; return 1; }
    signalled=1
  fi
  for ((attempt=0; attempt<50; attempt++)); do
    snapshot=$(ps -eo pgid=,stat=) || { echo "FAILED: could not inspect process groups" >&2; return 1; }
    live=0
    while read -r pgid state; do
      if [[ "$pgid" == "$group" && "$state" != Z* ]]; then live=1; break; fi
    done <<< "$snapshot"
    if [ "$live" -eq 0 ]; then return 0; fi
    if [ "$signalled" -eq 0 ]; then echo "FAILED: cannot signal process group $group" >&2; return 1; fi
    sleep 0.02
  done
  echo "FAILED: process group $group still has non-zombie members after SIGKILL" >&2
  return 1
}
stop_group() {
  trap '' INT TERM
  for pid in $(jobs -p); do
    if ! kill -TERM -- "-$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null || true; fi
    # Do not wait indefinitely for a suite that ignores TERM. The watchdog is
    # canceled immediately when its child exits; it never targets other groups.
    ( sleep 3; kill -KILL -- "-$pid" 2>/dev/null || true ) &
    watchdog=$!
    wait "$pid" 2>/dev/null || true
    # A leader can exit before a same-group child; do not leave it executing.
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
    drain_group "$pid" || true
  done
  exit "$1"
}
trap 'stop_group 130' INT
trap 'stop_group 143' TERM
setsid timeout --kill-after=5 "$duration" "$@" &
pid=$!
status=0
wait "$pid" || status=$?
# The timeout wrapper's status alone says nothing about surviving descendants.
if ! drain_group "$pid"; then
  # Preserve already-failing/timeout statuses; never report a clean success.
  if [ "$status" -eq 0 ]; then status=1; fi
fi
exit "$status"
