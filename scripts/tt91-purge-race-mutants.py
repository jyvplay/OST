#!/usr/bin/env python3
"""Remove one cooperative purge/write lock at a time on an EXCLUSIVE disposable DB and dev server."""
from datetime import datetime, timezone
from pathlib import Path
import json, os, re, subprocess, sys, time
if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT91_DEV_MUTATIONS") != "1":
    raise SystemExit("Refusing mutations: set TT89_DISPOSABLE_DATABASE=1 and TT91_DEV_MUTATIONS=1 only for an exclusive disposable database and development server.")
if not os.environ.get("DATABASE_URL") or not os.environ.get("BASE"):
    raise SystemExit("DATABASE_URL and BASE must point to the same disposable database and development server.")
ROOT = Path(__file__).resolve().parent.parent
V = "src/lib/server/vfs.ts"; C = "src/lib/server/conditional-write.ts"
M = [("purge omits exclusive lock", V, "    await lockVfsPurge(tx);", "write-first ordinary"),
     ("ordinary writer omits shared lock", V, "      await lockVfsWriter(tx);", "write-first ordinary"),
     ("conditional writer omits shared lock", C, "    await lockVfsWriter(tx);", "conditional overwrite followed")]
originals = {str(ROOT / m[1]): (ROOT / m[1]).read_text() for m in M}
NODE = ["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt91-purge-race.mts"]
results = []
def run(prefix):
    env = dict(os.environ); env["HARNESS_ONLY"] = prefix
    p = subprocess.run(NODE, cwd=ROOT, env=env, text=True, capture_output=True, timeout=100)
    return p.returncode, p.stdout + p.stderr
try:
    for i, (name, rel, old, prefix) in enumerate(M, 1):
        started = time.monotonic(); path = ROOT / rel; original = originals[str(path)]; state, detail = "crashed", ""
        try:
            # Restrict the purge mutant to purgeNode: TT92 also uses the same
            # exclusive gate for reversible trash and restore.
            offset = original.index("export async function purgeNode(") if name == "purge omits exclusive lock" else 0
            prefix_source, target = original[:offset], original[offset:]
            if target.count(old) != 1: raise ValueError(f"expected one source match, found {target.count(old)}")
            code, baseline = run(prefix)
            if code or "1 passed, 0 failed" not in baseline: raise ValueError("baseline failed: " + baseline[-1200:])
            path.write_text(prefix_source + target.replace(old, "    /* injected lock omission */", 1)); code, output = run(prefix)
            if code != 0 and "0 passed, 1 failed" in output and re.search(r"Expected values|No lock wait observed", output): state, detail = "killed", output[-1200:]
            elif code == 0 and "1 passed, 0 failed" in output: state, detail = "survived", output[-1200:]
            else: detail = output[-1500:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally: path.write_text(original)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt91-purge-race-mutants", "name": name, "covers": {"FM-11": "partial", "SC-10": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - started) * 1000)})
finally:
    for p, text in originals.items(): Path(p).write_text(text)
    dest = ROOT / "docs/test-results/tt91-purge-race-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt91-purge-race-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
n = sum(r["pass"] for r in results); print(f"Mutants: {n}/{len(M)} killed")
sys.exit(0 if len(results) == len(M) and n == len(M) else 1)
