#!/usr/bin/env python3
"""Mutation tests against an EXCLUSIVE disposable DB and a development server watching these sources.
Every mutant removes one cooperating lock. The race harness rolls back and settles requests before cleanup.
Do not use a production server: its bundle does not observe these edits. Sources restore in finally.
"""
from datetime import datetime, timezone
from pathlib import Path
import json, os, re, subprocess, sys, time

if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT91_DEV_MUTATIONS") != "1":
    raise SystemExit("Refusing mutations: set TT89_DISPOSABLE_DATABASE=1 and TT91_DEV_MUTATIONS=1 only for an exclusive disposable database and development server.")
if not os.environ.get("DATABASE_URL") or not os.environ.get("BASE"):
    raise SystemExit("DATABASE_URL and BASE must point to the same disposable database and development server.")
ROOT = Path(__file__).resolve().parent.parent
NODE = ["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt91-thumbnail-cleanup-race.mts"]
R = "src/app/api/privacy/thumbnail-cache/route.ts"
V = "src/lib/server/vfs.ts"
C = "src/lib/server/conditional-write.ts"
MUTANTS = [
    ("cleanup does not take the advisory lock", R, "      await lockThumbnailCache(tx);", "      /* injected lock omission */", "an already-running cache write"),
    ("ordinary cache write does not take the lock", V, "      if (isThumbnailCacheEntry(path)) await lockThumbnailCache(tx);", "      /* injected lock omission */", "an already-running cache write"),
    ("conditional cache overwrite does not take the lock", C, "    if (isThumbnailCacheEntry(path)) await lockThumbnailCache(tx);", "    /* injected lock omission */", "conditional overwrite followed"),
    ("cache purge does not take the lock", V, "    if (p === cache || cache.startsWith(`${p}/`) || isThumbnailCacheEntry(p)) await lockThumbnailCache(tx);", "    /* injected lock omission */", "cache purge cooperates"),
]
originals = {str(ROOT / m[1]): (ROOT / m[1]).read_text() for m in MUTANTS}
results = []

def run(prefix):
    env = dict(os.environ); env["HARNESS_ONLY"] = prefix
    r = subprocess.run(NODE, cwd=ROOT, env=env, text=True, capture_output=True, timeout=100)
    return r.returncode, r.stdout + r.stderr

try:
    # Each baseline verifies that the server is ready and the selected test is meaningful.
    for i, (name, rel, old, new, prefix) in enumerate(MUTANTS, 1):
        start = time.monotonic(); path = ROOT / rel; original = originals[str(path)]
        state, detail = "crashed", ""
        try:
            if original.count(old) != 1: raise ValueError(f"expected one source match, found {original.count(old)}")
            code, baseline = run(prefix)
            if code or "1 passed, 0 failed" not in baseline: raise ValueError("baseline failed: " + baseline[-1000:])
            path.write_text(original.replace(old, new, 1))
            code, output = run(prefix)
            # A crashed server, missing selector, compiler error, or timeout is NOT a killed mutant.
            if code != 0 and "0 passed, 1 failed" in output and re.search(r"Cache entry changed|No lock wait observed|Expected values to be strictly equal|inconsistent cache state", output):
                state, detail = "killed", output[-1200:]
            elif code == 0 and "1 passed, 0 failed" in output: state, detail = "survived", output[-1200:]
            else: detail = output[-1500:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally: path.write_text(original)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt91-race-mutants", "name": name, "covers": {"SC-10": "partial", "FF-13": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - start) * 1000)})
finally:
    for path, text in originals.items(): Path(path).write_text(text)
    dest = ROOT / "docs/test-results/tt91-race-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt91-race-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
killed = sum(r["pass"] for r in results)
print(f"Mutants: {killed}/{len(MUTANTS)} killed")
sys.exit(0 if len(results) == len(MUTANTS) and killed == len(MUTANTS) else 1)
