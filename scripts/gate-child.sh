#!/usr/bin/env bash
# Run one gate suite in a separate Linux process group. Give the suite a
# bounded chance to close detached children, then kill the remaining group.
set -u
if [ "$#" -lt 2 ]; then echo "Usage: gate-child.sh SECONDS COMMAND [ARG...]" >&2; exit 2; fi
if ! command -v setsid >/dev/null; then echo "REFUSED: setsid is required for browser-suite cancellation isolation" >&2; exit 2; fi
duration=$1; shift
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
    kill -KILL -- "-$pid" 2>/dev/null || true
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  done
  exit "$1"
}
trap 'stop_group 130' INT
trap 'stop_group 143' TERM
setsid timeout --kill-after=5 "$duration" "$@" &
pid=$!
status=0
wait "$pid" || status=$?
exit "$status"
