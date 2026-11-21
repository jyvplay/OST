#!/usr/bin/env python3
"""Linux gate supervisor: never signal a group after reaping its leader."""
import os
import re
import shutil
import signal
import subprocess
import sys
import time


def main():
    if not all(hasattr(os, name) for name in ("waitid", "P_PID", "WEXITED", "WNOHANG", "WNOWAIT")):
        print("REFUSED: waitid with WNOWAIT is required", file=sys.stderr)
        return 2
    if not shutil.which("ps") or not shutil.which("timeout"):
        print("REFUSED: ps and timeout are required", file=sys.stderr)
        return 2
    cancelled = 0

    def on_signal(signum, _frame):
        nonlocal cancelled
        if not cancelled:
            cancelled = signum

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    try:
        child = subprocess.Popen(["timeout", "--kill-after=5", *sys.argv[1:]], start_new_session=True)
    except OSError as exc:
        print(f"FAILED: could not start suite: {exc}", file=sys.stderr)
        return 2

    # Popen's start_new_session setup completes before it returns. Crucially,
    # waitid WNOWAIT observes exit without reaping: even an exited leader pins
    # the numeric PID/PGID until our final waitpid. Do not call Popen.poll/wait.
    term_sent = False
    term_at = 0.0
    killed = False
    try:
        while True:
            if cancelled and not term_sent:
                os.killpg(child.pid, signal.SIGTERM)
                term_sent = True
                term_at = time.monotonic()
            info = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if info is not None:
                break
            if term_sent and not killed and time.monotonic() - term_at >= 3:
                os.killpg(child.pid, signal.SIGKILL)
                killed = True
            time.sleep(0.02)

        # Leader is still waitable here. Signal once before reaping, then
        # inspect while it still pins the identity; zombies do not execute.
        os.killpg(child.pid, signal.SIGKILL)
        clean = False
        for _ in range(50):
            try:
                p = subprocess.run(["ps", "-eo", "pid=,pgid=,stat="], capture_output=True, text=True, timeout=2, check=True)
                rows = []
                for line in p.stdout.splitlines():
                    cols = line.split()
                    if len(cols) != 3 or not cols[0].isdigit() or not cols[1].isdigit() or not re.fullmatch(r"[A-Za-z][A-Za-z0-9+<>-]*", cols[2]):
                        raise ValueError("malformed process table")
                    rows.append((int(cols[0]), int(cols[1]), cols[2]))
                if sum(pid == os.getpid() and not state.startswith("Z") for pid, _, state in rows) != 1:
                    raise ValueError("process table does not identify this helper")
                if not any(group == child.pid and not state.startswith("Z") for _, group, state in rows):
                    clean = True
                    break
            except (OSError, subprocess.SubprocessError, ValueError) as exc:
                print(f"FAILED: could not inspect process groups: {exc}", file=sys.stderr)
                break
            time.sleep(0.02)
        if not clean:
            print(f"FAILED: process group {child.pid} cleanup unconfirmed", file=sys.stderr)
        _, status = os.waitpid(child.pid, 0)
        child.returncode = os.waitstatus_to_exitcode(status)
        if cancelled:
            return 128 + cancelled
        result = child.returncode if child.returncode >= 0 else 128 - child.returncode
        return result if result or clean else 1
    except (OSError, ChildProcessError) as exc:
        # No further signals after an unexpected identity/wait failure.
        print(f"FAILED: process supervision error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
