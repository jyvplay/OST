#!/usr/bin/env python3
"""Write transaction and row-lock mutants; exclusive disposable DB and source-watching dev server only."""
from datetime import datetime, timezone
from pathlib import Path
import json, os, re, subprocess, sys, time
if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT91_DEV_MUTATIONS") != "1" or not os.environ.get("DATABASE_URL") or not os.environ.get("BASE"):
    raise SystemExit("Refusing mutations: use TT89_DISPOSABLE_DATABASE=1, TT91_DEV_MUTATIONS=1, and an exclusive matching disposable DATABASE_URL/dev server.")
ROOT = Path(__file__).resolve().parent.parent; path = ROOT / "src/lib/server/vfs.ts"; original = path.read_text()
start = original.index("export async function writeFile("); end = original.index("/**\n * Database-local move/copy.", start); block = original[start:end]
NODE = ["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt91-write-atomic.mts"]
def sub(s, old, new):
    if s.count(old) != 1: raise ValueError(f"expected one match, got {s.count(old)} for {old!r}")
    return s.replace(old, new, 1)
def mutant(kind):
    x = block
    if kind == "transaction":
        x = sub(x, "    await safeTransaction(async (tx) => {", "    await (async (tx: typeof db) => {")
        x = sub(x, "    });\n    return { ok: true, path, size, sha256: digest, opId: op.id };", "    })(db);\n    return { ok: true, path, size, sha256: digest, opId: op.id };")
    elif kind == "row": x = sub(x, '.limit(1).for("update");', '.limit(1);')
    return original[:start] + x + original[end:]
def run(prefix):
    env = dict(os.environ); env["HARNESS_ONLY"] = prefix
    p = subprocess.run(NODE, cwd=ROOT, env=env, text=True, capture_output=True, timeout=100); return p.returncode, p.stdout + p.stderr
M = [("publish without a data transaction", "transaction", "failed index update"), ("read previous version without a row lock", "row", "two simultaneous overwrites")]
results = []
try:
    for i, (name, kind, prefix) in enumerate(M, 1):
        t = time.monotonic(); state, detail = "crashed", ""
        try:
            code, base = run(prefix)
            if code or "1 passed, 0 failed" not in base: raise ValueError("baseline failed: " + base[-1200:])
            # Let the source-watching server observe the changed file before
            # issuing the mutant request; otherwise a stale build can appear to survive.
            path.write_text(mutant(kind)); time.sleep(1); code, out = run(prefix)
            if code != 0 and "0 passed, 1 failed" in out and re.search(r"Expected values|strictly|index failure", out): state, detail = "killed", out[-1200:]
            elif code == 0 and "1 passed, 0 failed" in out: state, detail = "survived", out[-1200:]
            else: detail = out[-1500:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally: path.write_text(original); time.sleep(0.3)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt91-write-mutants", "name": name, "covers": {"FM-18": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - t) * 1000)})
finally:
    path.write_text(original)
    dest = ROOT / "docs/test-results/tt91-write-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt91-write-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
n = sum(r["pass"] for r in results); print(f"Mutants: {n}/{len(M)} killed")
sys.exit(0 if n == len(M) and len(results) == len(M) else 1)
