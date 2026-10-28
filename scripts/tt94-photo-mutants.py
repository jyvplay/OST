#!/usr/bin/env python3
"""Photo guard/UI source mutants against an exclusive disposable DB and source-watching dev server."""
from datetime import datetime, timezone
from pathlib import Path
import json, os, re, subprocess, sys, time

if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT91_DEV_MUTATIONS") != "1" or not os.environ.get("DATABASE_URL") or not os.environ.get("BASE"):
    raise SystemExit("Refusing mutations: require explicit disposable DB/dev-server opt-ins and matching DATABASE_URL/BASE.")
ROOT = Path(__file__).resolve().parent.parent
VFS = ROOT / "src/lib/server/vfs.ts"
UI = ROOT / "src/components/modules/Photos.tsx"
LAYER = ROOT / "src/lib/privacy/layer.ts"
API = ROOT / "src/lib/api.ts"
original = {p: p.read_text() for p in (VFS, UI, LAYER, API)}

def one(s, old, new):
    if s.count(old) != 1: raise ValueError(f"expected one match, found {s.count(old)} for {old!r}")
    return s.replace(old, new, 1)

def section(s, start, end):
    a = s.index(start); b = s.index(end, a); return a, b, s[a:b]

def mutation(which):
    if which in ("write-check", "purge-check"):
        p = VFS; s = original[p]
        start, end = ("export async function writeFile(", "export async function transferNode(") if which == "write-check" else ("export async function purgeNode(", "export async function mkdir(")
        a, b, block = section(s, start, end)
        block = one(block, "if (expectedPhoto) await checkExpectedPhoto(tx, expectedPhoto);", "/* injected missing photo guard */")
    elif which in ("id", "version", "digest"):
        p = VFS; s = original[p]; a, b, block = section(s, "async function checkExpectedPhoto(", "export interface WriteArgs")
        target = {"id": " || owner.id !== expected.id", "version": "owner.version !== expected.version || ", "digest": " || sha256(owner.content) !== expected.sha256"}[which]
        block = one(block, target, "")
    elif which == "ui-owner":
        p = UI; s = original[p]; a, b, block = section(s, "  const persistRecipe = async", "  const saveFlags = async")
        if block.count("expectedPhoto, ...precondition") != 2: raise ValueError("expected two guarded UI operations")
        block = block.replace("expectedPhoto, ...precondition", "...precondition")
    elif which == "swallow-clear":
        p = UI; s = original[p]; a, b, block = section(s, "  const persistRecipe = async", "  const saveFlags = async")
        old = 'await post<{ id?: unknown; version?: unknown; sha256?: unknown }>("/api/fs", { op: "purge", path: sidecarPath(item.path), expectedPhoto, ...precondition })'
        block = one(block, old, old + '.catch(() => ({} as { id?: unknown; version?: unknown; sha256?: unknown }))')
    elif which == "privacy-drop":
        p = LAYER; s = original[p]; a, b, block = section(s, '        case "write": {', '        case "upload":')
        block = one(block, 'if (body?.expectedPhoto !== undefined && !this.amnesic && this.storeOf(path) === "host")', 'if (false && body?.expectedPhoto !== undefined && !this.amnesic && this.storeOf(path) === "host")')
    elif which in ("queue-quota", "queue-dequeue", "queue-owner", "queue-replay-lock", "queue-merge", "queue-corrupt", "queue-head"):
        p = API; s = original[p]; a, b, block = 0, len(s), s
        if which == "queue-quota":
            block = one(block, 'const writeQueue = (q: Queued[]) => { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); };', 'const writeQueue = (q: Queued[]) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {} };')
        elif which == "queue-dequeue":
            block = one(block, 'latest.shift(); writeQueue(latest); return latest;', 'latest.shift(); try { writeQueue(latest); } catch {} return latest;')
        elif which == "queue-owner":
            block = one(block, 'q.push({ path, body, at: Date.now(), id: queueId() });', 'q.push({ path, body: { ...b, expectedPhoto: undefined }, at: Date.now(), id: queueId() });')
        elif which == "queue-replay-lock":
            block = one(block, 'withQueueLock(REPLAY_LOCK, replayOnce).finally', 'replayOnce().finally')
        elif which == "queue-merge":
            block = one(block, 'const latest = readQueueStrict();', 'const latest = q.slice();')
        elif which == "queue-head":
            block = one(block, 'if (!latest.length || !sameQueued(latest[0], head)) throw new Error("Offline queue changed during replay");', '/* injected missing current-head check */')
        else:
            block = one(block, 'const value: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");', 'let value: unknown; try { value = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]"); } catch { value = []; }')
    else: raise ValueError(which)
    return p, s[:a] + block + s[b:]

M = [
    ("skip write owner guard", "write-check", "tt94-photo-guard.mts", "a recipe save from a stale editor"),
    ("skip purge owner guard", "purge-check", "tt94-photo-guard.mts", "a stale clear cannot purge"),
    ("ignore photo identity", "id", "tt94-photo-guard.mts", "recreating an identical photo"),
    ("ignore photo version", "version", "tt94-photo-guard.mts", "even a byte-identical overwrite"),
    ("trust an unverified stored digest", "digest", "tt94-photo-guard.mts", "a corrupt photo whose stored digest"),
    ("browser omits owner guard", "ui-owner", "e2e-tt94-photo-stale.mts", "a stale editor cannot attach"),
    ("silence a failed recipe clear", "swallow-clear", "e2e-tt93-photos-clear.mts", "a failed identity-edit purge"),
    ("unlocked privacy layer strips guard", "privacy-drop", "privacy-layer.mts", "TT94 photo guards preserve"),
    ("hide a queue quota failure", "queue-quota", "e2e-tt94-photos-offline.mts", "storage quota denial cannot"),
    ("misreport a failed dequeue as completed", "queue-dequeue", "e2e-tt94-photos-offline.mts", "a dequeue storage failure"),
    ("strip the owner during offline queueing", "queue-owner", "e2e-tt94-photos-offline.mts", "a stale offline edit is rejected"),
    ("allow two tabs to replay the same queue", "queue-replay-lock", "e2e-tt94-offline-race.mts", "two online tabs do not replay"),
    ("drop writes queued during replay", "queue-merge", "e2e-tt94-offline-race.mts", "a later queued Files write is not lost"),
    ("replace a corrupt queue with an empty one", "queue-corrupt", "e2e-tt94-photos-offline.mts", "a corrupt persisted queue"),
    ("remove a newly changed head after replay", "queue-head", "e2e-tt94-offline-race.mts", "a noncooperating queue change"),
]

def run(script, prefix):
    env = dict(os.environ); env["HARNESS_ONLY"] = prefix
    cmd = ["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", f"scripts/{script}"]
    p = subprocess.run(cmd, cwd=ROOT, env=env, text=True, capture_output=True, timeout=160)
    return p.returncode, p.stdout + p.stderr

results = []
try:
    for i, (name, which, script, prefix) in enumerate(M, 1):
        started = time.monotonic(); state, detail = "crashed", ""; changed = None
        try:
            time.sleep(1.5)  # let the source watcher observe restoration before measuring the baseline
            code, baseline = run(script, prefix)
            if code or "1 passed, 0 failed" not in baseline: raise ValueError("baseline failed: " + baseline[-1800:])
            changed, content = mutation(which); changed.write_text(content); time.sleep(1.5)
            code, output = run(script, prefix)
            # A compiler crash, no selected test or arbitrary failure is never a kill.
            expected = "0 passed, 1 failed" in output and "FAILED:" in output
            assertion = re.search(r'Expected values|Expected "actual"|locator\.waitFor: Timeout|did not match|\d+ !== \d+|later queued Files write was lost', output, re.I)
            if code and expected and assertion: state, detail = "killed", output[-1800:]
            elif code == 0 and "1 passed, 0 failed" in output: state, detail = "survived", output[-1800:]
            else: detail = output[-2200:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally:
            if changed is not None: changed.write_text(original[changed]); time.sleep(1.5)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt94-photo-mutants", "name": name, "covers": {"MD-03": "partial", "FM-03": "partial", "SC-10": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - started) * 1000)})
finally:
    for p, content in original.items():
        if p.read_text() != content: p.write_text(content)
    dest = ROOT / "docs/test-results/tt94-photo-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt94-photo-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
n = sum(r["pass"] for r in results); print(f"Mutants: {n}/{len(M)} killed")
sys.exit(0 if n == len(M) and len(results) == len(M) else 1)
