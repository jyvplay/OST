#!/usr/bin/env bash
# Run a suite under the Linux process-group supervisor. exec keeps the PID
# receiving the gate's cancellation signal identical to the supervisor PID.
set -u
if [ "$#" -lt 2 ]; then echo "Usage: gate-child.sh SECONDS COMMAND [ARG...]" >&2; exit 2; fi
if ! command -v python3 >/dev/null; then echo "REFUSED: python3 is required for safe process-group supervision" >&2; exit 2; fi
exec python3 "$(dirname "$0")/gate-child-supervisor.py" "$@"
