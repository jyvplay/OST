#!/usr/bin/env python3
"""Alternating full-ESLint trials; validate diagnostics, exit status and dirty
content invalidation. Run alone on the measured machine (not beside a build or
browser suite). JSON scratch outputs/cache stay outside deliverable artifacts.
No third-party Python packages or /usr/bin/time required.
"""
import hashlib
import json
import os
import pathlib
import resource
import statistics
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRATCH = ROOT / ".cache/tt132-lint-benchmark"
OUT = ROOT / "docs/evidence/tt132-lint-performance.json"
SCRATCH.mkdir(parents=True, exist_ok=True)
CLEAN = ["node", "node_modules/eslint/bin/eslint.js", ".", "--format", "json"]
CACHED = ["node", "scripts/lint.mjs", "--format", "json"]
KEY = subprocess.check_output(["node", "--input-type=module", "-e", "import {lintCacheKey} from './scripts/lint.mjs'; console.log(lintCacheKey(process.cwd()))"], cwd=ROOT, text=True).strip()
CACHE = ROOT / ".cache/eslint" / KEY

def sum_tree_rss(pid):
    """Sample summed resident pages of the launcher + its live descendants.
    Shared mappings are double-counted; this is not PSS or physical allocation.
    """
    todo, seen, total = [pid], set(), 0
    while todo:
        current = todo.pop()
        if current in seen:
            continue
        seen.add(current)
        try:
            total += int(pathlib.Path(f"/proc/{current}/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")
            todo.extend(map(int, pathlib.Path(f"/proc/{current}/task/{current}/children").read_text().split()))
        except (FileNotFoundError, ProcessLookupError, IndexError):
            pass  # the child can exit between the two proc reads
    return total

def fingerprint(path):
    rows = json.loads(path.read_text())
    keys = ("filePath", "messages", "suppressedMessages", "errorCount", "warningCount", "fatalErrorCount", "fixableErrorCount", "fixableWarningCount")
    canonical = [{key: row.get(key) for key in keys} for row in rows]
    canonical.sort(key=lambda r: r["filePath"])
    digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return digest, sum(r["errorCount"] for r in rows), sum(r["warningCount"] for r in rows), len(rows), rows

trials = []
def run(name, command):
    output, errors = SCRATCH / f"{name}.json", SCRATCH / f"{name}.stderr"
    own_before = resource.getrusage(resource.RUSAGE_SELF)
    begin, peak = time.perf_counter(), 0
    with output.open("wb") as stdout, errors.open("wb") as stderr:
        child = subprocess.Popen(command, cwd=ROOT, stdout=stdout, stderr=stderr)
        while True:
            peak = max(peak, sum_tree_rss(child.pid))
            pid, status, usage = os.wait4(child.pid, os.WNOHANG)
            if pid:
                child.returncode = os.waitstatus_to_exitcode(status)
                break
            time.sleep(0.05)
    wall = time.perf_counter() - begin
    own_after = resource.getrusage(resource.RUSAGE_SELF)
    monitor_cpu = (own_after.ru_utime + own_after.ru_stime) - (own_before.ru_utime + own_before.ru_stime)
    digest, ec, wc, files, rows = fingerprint(output)
    trial = {"name": name, "exit": child.returncode, "wall_seconds": round(wall, 6), "child_cpu_seconds": round(usage.ru_utime + usage.ru_stime, 6), "monitor_cpu_seconds": round(monitor_cpu, 6), "peak_summed_rss_bytes_50ms": peak, "wait4_maxrss_kib": usage.ru_maxrss, "diagnostic_sha256": digest, "errors": ec, "warnings": wc, "files": files}
    trials.append(trial)
    print(json.dumps(trial), flush=True)
    assert child.returncode in (0, 1), f"ESLint did not complete normally: {errors.read_text()}"
    return trial, rows

# Cold cache uses a fresh key's cache file; do not clear node_modules or OS caches.
CACHE.unlink(missing_ok=True)
cold, _ = run("cache-cold", CACHED)
reference = None
for name, command in [("clean-1", CLEAN), ("warm-1", CACHED), ("warm-2", CACHED), ("clean-2", CLEAN), ("clean-3", CLEAN), ("warm-3", CACHED)]:
    trial, _ = run(name, command)
    if reference is None:
        reference = trial
    for key in ("exit", "diagnostic_sha256", "errors", "warnings", "files"):
        assert trial[key] == reference[key], f"lost fidelity: {name} differs in {key}"
for key in ("exit", "diagnostic_sha256", "errors", "warnings", "files"):
    assert cold[key] == reference[key], f"cold cache differs in {key}"

# Attack unchanged metadata: same path, mtime AND length, different source.
witness = ROOT / f"src/tt132-lint-cache-witness-{os.getpid()}.tsx"
assert not witness.exists()
try:
    good = 'export default function CacheWitness() { return <div>Plain text</div>; }\n'
    bad = good.replace("Plain text", "Can't read")
    assert len(good.encode()) == len(bad.encode())
    witness.write_text(good)
    run("witness-prime", CACHED)
    saved = witness.stat()
    witness.write_text(bad)
    os.utime(witness, ns=(saved.st_atime_ns, saved.st_mtime_ns))
    assert witness.stat().st_mtime_ns == saved.st_mtime_ns
    dirty, rows = run("witness-dirty-cached", CACHED)
    row = next(row for row in rows if row["filePath"] == str(witness))
    assert any(m["ruleId"] == "react/no-unescaped-entities" for m in row["messages"]), "stale cache hid the deliberately introduced diagnostic"
    actual, _ = run("witness-dirty-clean", CLEAN)
    assert dirty["diagnostic_sha256"] == actual["diagnostic_sha256"] and dirty["exit"] == actual["exit"]
finally:
    witness.unlink(missing_ok=True)
restored, _ = run("witness-removed", CACHED)
assert restored["diagnostic_sha256"] == reference["diagnostic_sha256"]

clean = [t for t in trials if t["name"].startswith("clean-")]
warm = [t for t in trials if t["name"].startswith("warm-")]
metrics = ("wall_seconds", "child_cpu_seconds", "peak_summed_rss_bytes_50ms")
medians = {kind: {metric: statistics.median(t[metric] for t in data) for metric in metrics} for kind, data in [("clean", clean), ("warm", warm)]}
result = {"cpu_count": os.cpu_count(), "node": subprocess.check_output(["node", "--version"], text=True).strip(), "order": "cold; AB BA AB; witness prime, same-metadata edit, cached-vs-clean, removal", "cache_strategy": "content", "cache_key": KEY, "cache_bytes": CACHE.stat().st_size, "diagnostics_identical": True, "same_mtime_and_length_attack": "passed", "medians": medians, "reductions_percent": {metric: round(100 * (1 - medians["warm"][metric] / medians["clean"][metric]), 3) for metric in metrics}, "measured_warm_median_dominates": all(medians["warm"][metric] <= medians["clean"][metric] for metric in metrics) and any(medians["warm"][metric] < medians["clean"][metric] for metric in metrics), "limitations": "Local alternating observations, not a universal Pareto proof. Peak sum-RSS sampled at 50ms, double-counts shared mappings and can miss shorter peaks; wait4 maxrss is not aggregate memory. OS page caches were not cleared. Monitor CPU is recorded separately; diagnostics intentionally remain nonzero if repository errors exist.", "trials": trials}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(result, indent=2) + "\n")
print(f"Verified diagnostics and content attack. Report: {OUT}", flush=True)
