#!/usr/bin/env python3
"""One defect at a time. ONLY a disposable DB and dev server; all sources restored in finally.
Browser mutants use a real Chromium and test-only fault injection, not physical devices.
"""
from pathlib import Path
from datetime import datetime, timezone
import json, os, re, subprocess, sys, time

if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT90_DEV_MUTATIONS") != "1":
    raise SystemExit("Refusing mutations: set TT89_DISPOSABLE_DATABASE=1 and TT90_DEV_MUTATIONS=1 only for a disposable database and development server.")
ROOT = Path(__file__).resolve().parent.parent
NODE = ["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"]
P = "src/lib/thumbs/worker-pool.ts"; C = "src/lib/context-profiles.ts"; S = "src/lib/thumbs/service.ts"; R = "src/app/api/privacy/thumbnail-cache/route.ts"
U = "tt90-worker-pool.mts"; CU = "tt90-context-unit.mts"; EP = "e2e-tt90-private-thumbnails.mts"; PATH = "tt90-private-thumb-path.mts"
MUTANTS = [
 ("exceed the bounded worker limit", P, 'Math.min(2, Math.floor(cores) - 1)', 'Math.min(5, Math.floor(cores) - 1)', U, 'CPU and low-memory', 'FF-13'),
 ("schedule newest before oldest", P, 'const job = this.pending.shift()!', 'const job = this.pending.pop()!', U, 'lazy pool bounds', 'FF-13'),
 ("accept a stale or wrong worker reply", P, '!e.data || e.data.id !== job.id', '!e.data', U, 'lazy pool bounds', 'FF-13'),
 ("never retire an idle worker", P, 'if (!slot.job) this.remove(slot); }, this.idleMs)', 'if (false && !slot.job) this.remove(slot); }, this.idleMs)', U, 'completed workers', 'FF-13'),
 ("forget to terminate a removed worker", P, 'slot.worker.terminate();', '/* injected omission */', U, 'completed workers', 'FF-13'),
 ("lose surviving capacity on partial startup failure", P, 'this.capacity = this.slots.length;', 'this.capacity = 0;', U, 'worker startup failure', 'FF-13'),
 ("make context profiles opt-out instead of opt-in", C, 'version: 1, enabled: false, profiles:', 'version: 1, enabled: true, profiles:', CU, 'default is opt-out', 'ST-09'),
 ("prefer touch over extended-display context", C, 'extended === true ? "extended" : primaryCoarse ? "single-touch" : "single-pointer"', 'primaryCoarse ? "single-touch" : extended === true ? "extended" : "single-pointer"', CU, 'multiple screens', 'ST-09'),
 ("allow text scales above the documented maximum", C, 'p.textScale <= 300', 'p.textScale <= 3000', CU, 'round trip', 'ST-09'),
 ("fail to normalize private path aliases", S, 'return isPrivatePath(`/${parts.join("/")}`);', 'return isPrivatePath(path);', PATH, 'private thumbnail routing', 'SC-10'),
 ("persist private thumbnails to the host cache", S, 'if (!sensitive) void diskPut(key, blob).catch(() => {});', 'if (true) void diskPut(key, blob).catch(() => {});', EP, 'encrypted private image', 'SC-10'),
 ("trust an old shared cache for private images", S, 'const cached = sensitive ? null : await diskGet(key).catch(() => null);', 'const cached = await diskGet(key).catch(() => null);', EP, 'locking removes,private requests', 'SC-10'),
 ("leave private blob URLs valid after lock", S, 'mem.delete(key); p.then((t) => { if (t.url) URL.revokeObjectURL(t.url); }).catch(() => {});', 'mem.delete(key);', EP, 'locking removes', 'SC-10'),
 ("do not cancel an in-flight private worker", S, 'p.run({ bytes, name, max, recipe }, signal)', 'p.run({ bytes, name, max, recipe })', EP, 'locking removes,private requests,locking while', 'SC-10'),
 ("clear cache without the required confirmation", R, '(body as { confirm?: unknown }).confirm !== "CLEAR THUMBNAIL CACHE"', 'false', EP, 'cleanup needs', 'SC-10'),
]
originals = {str(ROOT / path): (ROOT / path).read_text() for _, path, *_ in MUTANTS}
results = []
try:
    for i, (name, rel, old, new, script, only, feature) in enumerate(MUTANTS, 1):
        start = time.monotonic(); path = ROOT / rel; original = originals[str(path)]; state = "crashed"; detail = ""
        try:
            if original.count(old) != 1: raise ValueError(f"expected one source match, found {original.count(old)}")
            path.write_text(original.replace(old, new, 1))
            env = os.environ.copy(); env["HARNESS_ONLY"] = only
            env.setdefault("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:5432/app_db")
            env.setdefault("BASE", "http://localhost:3001")
            r = subprocess.run(NODE + [f"scripts/{script}"], cwd=ROOT, env=env, text=True, capture_output=True, timeout=160)
            out = r.stdout + r.stderr
            if re.search(r"\b0 passed, 0 failed\b", out): detail = "No tests selected"
            elif r.returncode != 0 and re.search(r"\b[1-9][0-9]* failed\b", out): state, detail = "killed", out[-1000:]
            elif r.returncode == 0: state, detail = "survived", out[-1000:]
            else: detail = out[-1500:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally: path.write_text(original)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" and detail else ""), flush=True)
        results.append({"suite": "tt90-mutants", "name": name, "covers": {feature: "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - start) * 1000)})
finally:
    for path, text in originals.items(): Path(path).write_text(text)
    dest = ROOT / "docs/test-results/tt90-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt90-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
killed = sum(r["pass"] for r in results)
print(f"Mutants: {killed}/{len(MUTANTS)} killed")
sys.exit(0 if killed == len(MUTANTS) and len(results) == len(MUTANTS) else 1)
