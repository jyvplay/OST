#!/usr/bin/env python3
"""Recipe precondition source mutations: EXCLUSIVE disposable DB + source-watching server only."""
from datetime import datetime, timezone
from pathlib import Path
import json, os, re, subprocess, sys, time

if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT91_DEV_MUTATIONS") != "1" or not os.environ.get("DATABASE_URL") or not os.environ.get("BASE"):
    raise SystemExit("Refusing mutations: require disposable DB/dev-server opt-ins and matching DATABASE_URL/BASE.")
ROOT = Path(__file__).resolve().parent.parent
VFS = ROOT / "src/lib/server/vfs.ts"
UI = ROOT / "src/components/modules/Photos.tsx"
SERVICE = ROOT / "src/lib/thumbs/service.ts"
LAYER = ROOT / "src/lib/privacy/layer.ts"
API = ROOT / "src/lib/api.ts"
original = {p: p.read_text() for p in (VFS, UI, SERVICE, LAYER, API)}

def one(s, old, new):
    if s.count(old) != 1: raise ValueError(f"expected one match, found {s.count(old)} for {old!r}")
    return s.replace(old, new, 1)

def section(s, start, end):
    a = s.index(start); b = s.index(end, a); return a, b, s[a:b]

def mutation(which):
    if which in ("write-check", "purge-check", "id", "version", "digest", "absent-create"):
        p = VFS; s = original[p]
        if which == "write-check":
            a, b, block = section(s, "export async function writeFile(", "export async function transferNode(")
            block = one(block, "if (expectedRecipe !== undefined) checkExpectedRecipe(prev, expectedRecipe);", "/* injected missing recipe check */")
        elif which == "purge-check":
            a, b, block = section(s, "export async function purgeNode(", "export async function mkdir(")
            block = one(block, "checkExpectedRecipe(current, expectedRecipe);", "/* injected missing clear check */")
        elif which == "absent-create":
            a, b, block = section(s, "export async function writeFile(", "export async function transferNode(")
            block = one(block, ".onConflictDoNothing({ target: vfsNodes.path })", "")
        else:
            a, b, block = section(s, "function checkExpectedRecipe(", "async function checkExpectedPhoto(")
            target = {"id": " || node.id !== expected.id", "version": " || node.version !== expected.version", "digest": " || sha256(node.content) !== expected.sha256"}[which]
            block = one(block, target, "")
    elif which in ("ui-precondition", "ui-advance"):
        p = UI; s = original[p]; a, b, block = section(s, "  const persistRecipe = async", "  const saveFlags = async")
        if which == "ui-precondition": block = one(block, 'const precondition = loaded.store === "host" ? { expectedRecipe: loaded.expected } : {};', 'const precondition = {};')
        else: block = one(block, 'loaded.expected = { id: Number(result.id), version: Number(result.version), sha256: result.sha256 };', '/* injected stale token */')
    elif which in ("corrupt-read", "failed-read"):
        p = SERVICE; s = original[p]; a, b, block = section(s, "export async function readRecipeForEditing(", "// ---- worker plumbing")
        if which == "corrupt-read": block = one(block, 'try { parsed = JSON.parse(n.content); } catch { throw invalid(); }', 'try { parsed = JSON.parse(n.content); } catch { return { recipe: null, expected: null }; }')
        else: block = one(block, 'if (!r.ok) throw new Error("Photo recipe could not be read; it was not opened for editing.");', 'if (!r.ok) return { recipe: null, expected: null };')
    elif which == "privacy-drop":
        p = LAYER; s = original[p]; a, b, block = section(s, '        case "write": {', '        case "upload":')
        block = one(block, 'if (body?.expectedPhoto !== undefined && !this.amnesic && this.storeOf(path) === "host")', 'if (false && body?.expectedPhoto !== undefined && !this.amnesic && this.storeOf(path) === "host")')
    elif which == "queue-drop":
        p = API; s = original[p]; a, b, block = 0, len(s), s
        block = one(block, 'q.push({ path, body, at: Date.now(), id: queueId() });', 'q.push({ path, body: { ...b, expectedRecipe: undefined }, at: Date.now(), id: queueId() });')
    else: raise ValueError(which)
    return p, s[:a] + block + s[b:]

M = [
    ("omit recipe update check", "write-check", "tt95-photo-concurrency.mts", "a stale update refuses"),
    ("omit recipe clear check", "purge-check", "tt95-photo-concurrency.mts", "a stale clear cannot"),
    ("ignore recipe identity", "id", "tt95-photo-concurrency.mts", "a recreated recipe with identical bytes"),
    ("ignore recipe version", "version", "tt95-photo-concurrency.mts", "a same-byte rewrite"),
    ("trust the stored recipe digest", "digest", "tt95-photo-concurrency.mts", "a corrupt sidecar digest"),
    ("remove atomic absent creation", "absent-create", "tt95-photo-race.mts", "an uncommitted competing insert"),
    ("browser omits recipe precondition", "ui-precondition", "e2e-tt95-photo-concurrency.mts", "two open editors"),
    ("browser fails to advance its token", "ui-advance", "e2e-tt95-photo-concurrency.mts", "one editor can save successive"),
    ("treat corrupt recipe as absent", "corrupt-read", "e2e-tt95-photo-concurrency.mts", "a corrupt recipe is reported"),
    ("treat a failed recipe read as absent", "failed-read", "e2e-tt95-photo-concurrency.mts", "an injected read failure"),
    ("privacy wrapper drops the host guard", "privacy-drop", "privacy-layer.mts", "TT94 photo guards preserve"),
    ("offline queue drops the recipe guard", "queue-drop", "e2e-tt95-photo-concurrency.mts", "a queued stale recipe"),
]

def run(script, prefix):
    env = dict(os.environ); env["HARNESS_ONLY"] = prefix
    cmd = ["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", f"scripts/{script}"]
    p = subprocess.run(cmd, cwd=ROOT, env=env, text=True, capture_output=True, timeout=180)
    return p.returncode, p.stdout + p.stderr

results = []
try:
    for i, (name, which, script, prefix) in enumerate(M, 1):
        started = time.monotonic(); state, detail = "crashed", ""; changed = None
        try:
            time.sleep(1.5)
            code, baseline = run(script, prefix)
            if code or "1 passed, 0 failed" not in baseline: raise ValueError("baseline failed: " + baseline[-2000:])
            changed, content = mutation(which); changed.write_text(content); time.sleep(1.5)
            code, output = run(script, prefix)
            expected = "0 passed, 1 failed" in output and "FAILED:" in output
            assertion = re.search(r'Expected values|Expected "actual"|locator\.waitFor: Timeout|\d+ !== \d+|strictly equal', output, re.I)
            if code and expected and assertion: state, detail = "killed", output[-2000:]
            elif code == 0 and "1 passed, 0 failed" in output: state, detail = "survived", output[-2000:]
            else: detail = output[-2400:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally:
            if changed is not None: changed.write_text(original[changed]); time.sleep(1.5)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt95-photo-mutants", "name": name, "covers": {"MD-03": "partial", "FM-03": "partial", "SC-10": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - started) * 1000)})
finally:
    for p, content in original.items():
        if p.read_text() != content: p.write_text(content)
    dest = ROOT / "docs/test-results/tt95-photo-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt95-photo-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
n = sum(r["pass"] for r in results); print(f"Mutants: {n}/{len(M)} killed")
sys.exit(0 if n == len(M) and len(results) == len(M) else 1)
