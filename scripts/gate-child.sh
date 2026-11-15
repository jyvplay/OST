#!/usr/bin/env bash
# Run one gate suite in a separate Linux process group. Cancellation kills the
# group; children which create their own sessions are outside this guarantee.
set -u
if [ "$#" -lt 2 ]; then echo "Usage: gate-child.sh SECONDS COMMAND [ARG...]" >&2; exit 2; fi
if ! command -v setsid >/dev/null; then echo "REFUSED: setsid is required for browser-suite cancellation isolation" >&2; exit 2; fi
duration=$1; shift
stop_group() {
  trap '' INT TERM
  for pid in $(jobs -p); do
    kill -KILL -- "-$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit "$1"
}
trap 'stop_group 130' INT
trap 'stop_group 143' TERM
setsid timeout --kill-after=5 "$duration" "$@" &
pid=$!
status=0
wait "$pid" || status=$?
exit "$status"
