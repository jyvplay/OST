#!/usr/bin/env python3
"""Test permanent-delete faults against a source-watching dev server and EXCLUSIVE disposable DB.
The root test installs BEFORE DELETE seatbelts on every affected table; do not run on user data.
"""
from datetime import datetime, timezone
from pathlib import Path
import json, os, re, subprocess, sys, time
if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT91_DEV_MUTATIONS") != "1":
    raise SystemExit("Refusing mutations: set TT89_DISPOSABLE_DATABASE=1 and TT91_DEV_MUTATIONS=1 only for an exclusive disposable database and development server.")
if not os.environ.get("DATABASE_URL") or not os.environ.get("BASE"):
    raise SystemExit("DATABASE_URL and BASE must point to the same disposable database and development server.")
ROOT = Path(__file__).resolve().parent.parent
path = ROOT / "src/lib/server/vfs.ts"; original = path.read_text()
NODE = ["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt91-purge.mts"]
start = original.index("export async function purgeNode("); end = original.index("\nexport async function mkdir(", start)
block = original[start:end]

def replace_one(s, old, new):
    if s.count(old) != 1: raise ValueError(f"expected one match for {old!r}, found {s.count(old)}")
    return s.replace(old, new, 1)

def mutant(kind):
    x = block
    if kind == "history": x = replace_one(x, "    await tx.delete(vfsVersions).where(or(eq(vfsVersions.path, p), like(vfsVersions.path, pattern)));", "    /* injected missing history deletion */")
    elif kind == "index": x = replace_one(x, '    await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), or(eq(indexDocs.ref, p), like(indexDocs.ref, pattern))));', "    /* injected missing index deletion */")
    elif kind == "root": x = replace_one(x, '  if (p === "/") throw new Error("Refusing to purge the VFS root");', "  /* injected missing root guard */")
    elif kind == "transaction":
        x = replace_one(x, "  await safeTransaction(async (tx) => {", "  await (async (tx: typeof db) => {")
        x = replace_one(x, "  });\n  return { ok: true };", "  })(db);\n  return { ok: true };")
    return original[:start] + x + original[end:]

def run(prefix):
    env = dict(os.environ); env["HARNESS_ONLY"] = prefix
    p = subprocess.run(NODE, cwd=ROOT, env=env, text=True, capture_output=True, timeout=100)
    return p.returncode, p.stdout + p.stderr

M = [("leave saved versions behind", "history", "file purge"), ("leave search text behind", "index", "file purge"),
     ("allow root deletion", "root", "purging root"), ("remove the transaction", "transaction", "a real SQL failure")]
results = []
try:
    for i, (name, kind, prefix) in enumerate(M, 1):
        t = time.monotonic(); state = "crashed"; detail = ""
        try:
            code, base = run(prefix)
            if code or "1 passed, 0 failed" not in base: raise ValueError("baseline failed: " + base[-1200:])
            path.write_text(mutant(kind)); code, out = run(prefix)
            if code != 0 and "0 passed, 1 failed" in out and re.search(r"Expected values|seatbelt|must not match|did not match the regular expression", out): state, detail = "killed", out[-1200:]
            elif code == 0 and "1 passed, 0 failed" in out: state, detail = "survived", out[-1200:]
            else: detail = out[-1500:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally: path.write_text(original)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt91-purge-mutants", "name": name, "covers": {"FM-11": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - t) * 1000)})
finally:
    path.write_text(original)
    dest = ROOT / "docs/test-results/tt91-purge-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt91-purge-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
n = sum(r["pass"] for r in results); print(f"Mutants: {n}/{len(M)} killed")
sys.exit(0 if len(results) == len(M) and n == len(M) else 1)
