#!/usr/bin/env python3
"""Source mutants: only an explicitly opted-in exclusive disposable DB and source-watching dev server."""
from datetime import datetime, timezone
from pathlib import Path
import json, os, re, subprocess, sys, time

if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT91_DEV_MUTATIONS") != "1" or not os.environ.get("DATABASE_URL") or not os.environ.get("BASE"):
    raise SystemExit("Refusing mutations: use explicit disposable DB/dev-server opt-ins and matching DATABASE_URL/BASE.")
ROOT = Path(__file__).resolve().parent.parent
VFS = ROOT / "src/lib/server/vfs.ts"
RESTORE = ROOT / "src/lib/server/backup-restore.ts"
ROUTE = ROOT / "src/app/api/fs/route.ts"
original = {p: p.read_text() for p in (VFS, RESTORE, ROUTE)}

def one(s, old, new):
    if s.count(old) != 1: raise ValueError(f"expected one match, found {s.count(old)} for {old!r}")
    return s.replace(old, new, 1)

def section(s, start, end):
    a = s.index(start); b = s.index(end, a); return a, b, s[a:b]

def mutation(which):
    if which.startswith("restore-"):
        p = RESTORE; s = original[p]; a, b, block = section(s, "export async function restoreBackup(", "\n}")
        if which == "restore-gate": block = one(block, "      await lockVfsPurge(tx);", "      /* injected missing restore tree gate */")
        elif which == "restore-cache": block = one(block, '      if (payload.entries.some(({ path }) => path === cache || cache.startsWith(`${path}/`) || isThumbnailCacheEntry(path))) await lockThumbnailCache(tx);', '      /* injected missing restore cache gate */')
        else: raise ValueError(which)
    elif which == "sidecar":
        p = VFS; s = original[p]; a, b, block = section(s, "export async function transferNode(", "/** Reversible tree trash.")
        block = one(block, '        if (sideDestNode || sideDestVersion || sideDestIndex)', '        if (false)')
    elif which.startswith("metadata-"):
        p = VFS; s = original[p]
        if which == "metadata-tag-gate":
            a, b, block = section(s, "export async function setTags(", "export async function versionsOf(")
            block = one(block, "    await lockVfsWriter(tx);", "    /* injected missing tag gate */")
        else:
            a, b, block = section(s, "export async function dropVersions(", "/** Tagging")
            if which == "metadata-history-gate": block = one(block, "    await lockVfsWriter(tx);", "    /* injected missing history gate */")
            elif which == "metadata-history-transaction":
                block = one(block, "  const dropped = await safeTransaction(async (tx) => {", "  const dropped = await (async (tx: typeof db) => {")
                block = one(block, "  });\n  return { ok: true, path: p, dropped };", "  })(db);\n  return { ok: true, path: p, dropped };")
            else: raise ValueError(which)
    else:
        p = VFS; s = original[p]; a, b, block = section(s, "export async function transferNode(", "/** Reversible tree trash.")
        if which == "tree-gate": block = one(block, "      await lockVfsPurge(tx);", "      /* injected missing tree gate */")
        elif which == "cache-gate": block = one(block, "      if (touchesCache(from) || touchesCache(to)) await lockThumbnailCache(tx);", "      /* injected missing cache gate */")
        elif which == "trash":
            block = one(block, '      if (root.trashed) throw new Error(`This source is in Trash: ${from}. Restore it before transferring.`);', "      /* injected trash-root resurrection */")
            block = one(block, '        if (row.trashed) throw new Error("The source tree contains a separately trashed item. Restore or permanently delete it before transferring the folder.");', "        /* injected trash-child resurrection */")
        elif which == "digest": block = one(block, '        if (row.kind === "file" && row.actual !== row.sha256) throw new Error(`Source checksum mismatch: ${row.path}`);', "        /* injected checksum omission */")
        elif which == "history":
            block = one(block, '''        await tx.execute(sql`
          UPDATE vfs_versions SET path = ${to} || substring(path FROM char_length(${from}) + 1)
          WHERE path = ${from} OR path LIKE ${sourcePattern}
        `);''', "        /* injected missing history move */")
        elif which == "index": block = one(block, '        await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), or(eq(indexDocs.ref, from), like(indexDocs.ref, sourcePattern))));', '        /* injected stale search rows */')
        elif which == "destination-version": block = one(block, "      if (destNode || destVersion || destIndex)", "      if (destNode || destIndex)")
        elif which == "destination-index": block = one(block, "      if (destNode || destVersion || destIndex)", "      if (destNode || destVersion)")
        elif which == "parent": block = one(block, "      await writableDirectories(tx, parentOf(to), true);", "      /* injected missing parent validation */")
        elif which == "transaction":
            block = one(block, "    const followedSidecar = await safeTransaction(async (tx) => {", "    const followedSidecar = await (async (tx: typeof db) => {")
            block = one(block, "      return hasSidecar;\n    });", "      return hasSidecar;\n    })(db);")
        else: raise ValueError(which)
    return p, s[:a] + block + s[b:]

M = [
    ("omit transfer tree gate", "tree-gate", "tt93-transfer-race.mts", "move waits behind"),
    ("omit transfer cache gate", "cache-gate", "tt93-transfer-race.mts", "a cache transfer waits"),
    ("resurrect trashed source", "trash", "tt93-transfer.mts", "a trashed source is reserved"),
    ("skip descendant digest verification", "digest", "tt93-transfer.mts", "a corrupt descendant"),
    ("leave versions at old path", "history", "tt93-transfer.mts", "moving a nested tree"),
    ("leave descendant search rows", "index", "tt93-transfer.mts", "a public tree moved beneath Private"),
    ("ignore retained destination history", "destination-version", "tt93-transfer.mts", "an orphaned destination version"),
    ("overwrite retained destination search", "destination-index", "tt93-transfer.mts", "an orphaned destination search"),
    ("skip destination parent validation", "parent", "tt93-transfer.mts", "destination ancestors"),
    ("publish outside a transaction", "transaction", "tt93-transfer.mts", "an index publication fault"),
    ("attach an unrelated orphan destination sidecar", "sidecar", "tt93-transfer.mts", "an orphan destination sidecar"),
    ("omit backup restore tree gate", "restore-gate", "tt93-restore-race.mts", "commit of a backup restore waits"),
    ("omit backup restore cache gate", "restore-cache", "tt93-restore-race.mts", "cache cleanup before a waiting restore"),
    ("delete history outside its audit transaction", "metadata-history-transaction", "tt93-metadata-race.mts", "history removal and its audit are atomic"),
    ("omit history-removal tree gate", "metadata-history-gate", "tt93-metadata-race.mts", "a move already in progress"),
    ("omit tag tree gate", "metadata-tag-gate", "tt93-metadata-race.mts", "a tag update queued behind"),
]

def run(script, prefix):
    env = dict(os.environ); env["HARNESS_ONLY"] = prefix
    cmd = ["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", f"scripts/{script}"]
    p = subprocess.run(cmd, cwd=ROOT, env=env, text=True, capture_output=True, timeout=100)
    return p.returncode, p.stdout + p.stderr

results = []
try:
    for i, (name, which, script, prefix) in enumerate(M, 1):
        started = time.monotonic(); state, detail = "crashed", ""
        try:
            code, baseline = run(script, prefix)
            if code or "1 passed, 0 failed" not in baseline: raise ValueError("baseline failed: " + baseline[-1500:])
            p, content = mutation(which); p.write_text(content)
            code, output = run(script, prefix)
            # A syntax error, crash, timeout or zero selected tests is NOT a kill.
            if code and "0 passed, 1 failed" in output and re.search(r'Expected values|Expected "actual"|did not match|No database lock wait observed|Cannot read properties', output, re.I):
                state, detail = "killed", output[-1500:]
            elif code == 0 and "1 passed, 0 failed" in output: state, detail = "survived", output[-1500:]
            else: detail = output[-1800:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally:
            for p, content in original.items(): p.write_text(content)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt93-transfer-mutants", "name": name, "covers": {"FM-03": "partial", "BK-01": "partial", "SC-10": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - started) * 1000)})
finally:
    for p, content in original.items(): p.write_text(content)
    dest = ROOT / "docs/test-results/tt93-transfer-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt93-transfer-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
n = sum(r["pass"] for r in results); print(f"Mutants: {n}/{len(M)} killed")
sys.exit(0 if n == len(M) and len(results) == len(M) else 1)
