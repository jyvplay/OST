#!/usr/bin/env python3
"""Measure one real command without changing its work or masking its exit code.

Standard library only. Child rusage excludes a separately running server/DB;
Linux cgroup CPU (when readable) includes the whole shared sandbox and any
concurrent work. ru_maxrss is a largest-child high-water mark, NOT simultaneous
process-tree peak memory. The receipt makes those scopes explicit.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time


def sandbox_cpu_usec():
    try:
        stats = dict(line.split() for line in Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())
        return int(stats['usage_usec'])
    except (OSError, KeyError, ValueError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--log', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a real command is required after --')
    receipt_path, log_path = Path(args.receipt), Path(args.log)
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_before = sandbox_cpu_usec()
    started = time.perf_counter()
    error = None
    with log_path.open('w') as output:
        try:
            result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, check=False)
            raw_code = result.returncode
        except OSError as exc:
            raw_code = 127
            error = str(exc)
            output.write(error + '\n')
    wall = time.perf_counter() - started
    cpu_after = sandbox_cpu_usec()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    exit_code = raw_code if raw_code >= 0 else 128 - raw_code
    receipt = {
        'label': args.label,
        'startedAt': started_at,
        'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'command': command,
        'cwd': str(Path.cwd()),
        'log': str(log_path),
        'rawReturnCode': raw_code,
        'exitCode': exit_code,
        'wallSeconds': wall,
        'childUserSeconds': after.ru_utime - before.ru_utime,
        'childSystemSeconds': after.ru_stime - before.ru_stime,
        'childCpuSeconds': after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime,
        'largestChildMaxRssKiB': after.ru_maxrss,
        'sandboxCpuSeconds': (cpu_after - cpu_before) / 1_000_000 if cpu_before is not None and cpu_after is not None else None,
        'cpuAffinity': sorted(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else None,
        'scope': {
            'childCpu': 'Waited command children/descendants; excludes independently started web server and database',
            'sandboxCpu': 'Whole readable Linux cgroup; includes server/database and any concurrent sandbox work; not command-exclusive',
            'memory': 'Largest waited-child high-water RSS on Linux; NOT summed or simultaneous process-tree peak',
            'fidelity': 'No scheduling, assertion, workload or return-code substitution; all stdout/stderr retained in log',
        },
        'spawnError': error,
    }
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2), flush=True)
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
