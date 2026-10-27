#!/usr/bin/env python3
"""Trash/write source mutations. Only run against an exclusive disposable DB and source-watching dev server."""
from datetime import datetime, timezone
from pathlib import Path
import json, os, re, subprocess, sys, time
if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT91_DEV_MUTATIONS") != "1" or not os.environ.get("DATABASE_URL") or not os.environ.get("BASE"):
    raise SystemExit("Refusing mutations: use explicit disposable DB/dev-server opt-ins and matching DATABASE_URL/BASE.")
ROOT = Path(__file__).resolve().parent.parent; path = ROOT / "src/lib/server/vfs.ts"; original = path.read_text()
def section(s, start, end):
    a, b = s.index(start), s.index(end, s.index(start)); return a, b, s[a:b]
def replace_one(s, old, new):
    if s.count(old) != 1: raise ValueError(f"expected one match, found {s.count(old)} for {old!r}")
    return s.replace(old, new, 1)
def mutate(which):
    if which in ("ancestor", "file"):
        a, b, text = section(original, "export class InvalidVfsDirectory", "/**\n * Database-local move/copy.")
    elif which.startswith("restore"):
        a, b, text = section(original, "export async function restoreNode(", "export async function purgeNode(")
    else:
        a, b, text = section(original, "export async function trashNode(", "/** Restore only nodes")
    if which == "index": text = replace_one(text, 'or(eq(indexDocs.ref, p), like(indexDocs.ref, pattern))', 'eq(indexDocs.ref, p)')
    elif which == "group": text = replace_one(text, '.where(and(eq(vfsNodes.trashed, false), or(eq(vfsNodes.path, p), like(vfsNodes.path, pattern))));', '.where(or(eq(vfsNodes.path, p), like(vfsNodes.path, pattern)));')
    elif which == "ancestor": text = replace_one(text, '!row || row.kind !== "dir" || row.trashed', '!row || row.kind !== "dir"')
    elif which == "file": text = replace_one(text, '        if (prev.trashed) throw new Error(`This path is in Trash: ${path}. Restore or permanently delete it before writing here.`);', '        /* injected unsafe resurrection */')
    elif which == "restore-group": text = replace_one(text, '          AND (path = ${p} OR (trashed_from = ${node.trashedFrom} AND ${node.trashedFrom}::text IS NOT NULL))', '          /* injected group omission */')
    elif which == "restore-null": text = replace_one(text, '          AND (path = ${p} OR (trashed_from = ${node.trashedFrom} AND ${node.trashedFrom}::text IS NOT NULL))', '          AND trashed_from IS NOT DISTINCT FROM ${node.trashedFrom}')
    elif which == "restore-parent": text = replace_one(text, '    await writableDirectories(tx, parentOf(p), false);', '    /* injected parent omission */')
    elif which == "root": text = replace_one(text, '  if (p === "/") throw new Error("Refusing to trash the VFS root");', '  /* injected root guard omission */')
    elif which in ("trash-gate", "restore-gate"): text = replace_one(text, '    await lockVfsPurge(tx);', '    /* injected lock omission */')
    elif which == "cache": text = replace_one(text, '    if (p === thumbnailRoot || thumbnailRoot.startsWith(`${p}/`) || isThumbnailCacheEntry(p)) await lockThumbnailCache(tx);', '    /* injected cache lock omission */')
    elif which in ("trash-transaction", "restore-transaction"):
        text = replace_one(text, '  await safeTransaction(async (tx) => {', '  await (async (tx: typeof db) => {')
        text = replace_one(text, '  });\n  return { ok: true };', '  })(db);\n  return { ok: true };')
    else: raise ValueError(which)
    return original[:a] + text + original[b:]
M = [
 ("leave descendant search rows", "index", "tt92-trash.mts", "trashing a directory"),
 ("merge separately trashed child groups", "group", "tt92-trash.mts", "trashing a directory"),
 ("allow new files inside trashed folders", "ancestor", "tt92-trash.mts", "ordinary and conditional writes cannot"),
 ("allow overwriting a trashed file", "file", "tt92-trash.mts", "a trashed file reserves"),
 ("restore independent trash groups together", "restore-group", "tt92-trash.mts", "trashing a directory"),
 ("merge ambiguous legacy null groups", "restore-null", "tt92-trash.mts", "legacy rows"),
 ("restore inside a trashed parent", "restore-parent", "tt92-trash.mts", "a child cannot be restored"),
 ("omit the root guard", "root", "tt92-trash.mts", "trashing the virtual root"),
 ("omit the trash transaction", "trash-transaction", "tt92-trash.mts", "a failed search-index deletion"),
 ("omit the restore transaction", "restore-transaction", "tt92-trash.mts", "a failed restore journal"),
 ("omit trash's tree gate", "trash-gate", "tt92-trash-race.mts", "tree trash holds"),
 ("omit restore's tree gate", "restore-gate", "tt92-trash-race.mts", "restore-first"),
 ("omit cache lock for trash", "cache", "tt92-trash-race.mts", "thumbnail cleanup and cache-item trash"),
]
def run(script, prefix):
    env = dict(os.environ); env["HARNESS_ONLY"] = prefix
    cmd = ["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", f"scripts/{script}"]
    p = subprocess.run(cmd, cwd=ROOT, env=env, text=True, capture_output=True, timeout=100)
    return p.returncode, p.stdout + p.stderr
results = []
try:
    for i, (name, which, script, prefix) in enumerate(M, 1):
        t = time.monotonic(); state, detail = "crashed", ""
        try:
            code, baseline = run(script, prefix)
            if code or "1 passed, 0 failed" not in baseline: raise ValueError("baseline failed: " + baseline[-1200:])
            path.write_text(mutate(which)); time.sleep(1); code, output = run(script, prefix)
            if code != 0 and "0 passed, 1 failed" in output and re.search(r"Expected values|Expected \"actual\"|does not match|did not match|trashed item|folder created|ambiguous legacy child|No lock wait observed|should not|must not|must be", output, re.I): state, detail = "killed", output[-1200:]
            elif code == 0 and "1 passed, 0 failed" in output: state, detail = "survived", output[-1200:]
            else: detail = output[-1500:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally: path.write_text(original); time.sleep(0.3)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt92-trash-mutants", "name": name, "covers": {"FM-11": "partial", "SC-10": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - t) * 1000)})
finally:
    path.write_text(original); dest = ROOT / "docs/test-results/tt92-trash-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt92-trash-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
n = sum(r["pass"] for r in results); print(f"Mutants: {n}/{len(M)} killed")
sys.exit(0 if n == len(M) and len(results) == len(M) else 1)
