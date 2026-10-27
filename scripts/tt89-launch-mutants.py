#!/usr/bin/env python3
"""One-at-a-time PWA mutations. Disposable test database and development server ONLY.
Sources are restored after each mutant and again in the outer finally block.
Launch-event browser tests use explicitly synthetic delivery and real OPFS handles.
"""
from pathlib import Path
from datetime import datetime, timezone
import json, os, re, subprocess, sys, time

if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1":
    raise SystemExit("Refusing mutations: set TT89_DISPOSABLE_DATABASE=1 only for a disposable test database and development server.")
ROOT = Path(__file__).resolve().parent.parent
NODE = ["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"]
UNIT = "tt89-launch-unit.mts"
E2E = "e2e-tt89-launch.mts"
MUTANTS = [
    ("allow unknown protocol module", "src/lib/pwa-launch.ts", 'const app = u.searchParams.get("app");\n    return app && allowed.includes(app) ? app : null;', 'const app = u.searchParams.get("app");\n    return app || null;', UNIT, "protocol accepts"),
    ("allow arbitrary protocol action", "src/lib/pwa-launch.ts", 'u.hostname !== "open"', 'false', UNIT, "protocol accepts"),
    ("allow extra protocol parameters", "src/lib/pwa-launch.ts", 'keys.length !== 1 || keys[0] !== "app"', 'keys.length < 1 || keys[0] !== "app"', UNIT, "protocol accepts"),
    ("accept cross-origin launch target", "src/lib/pwa-launch.ts", 'u.origin !== origin || u.username', 'false || u.username', UNIT, "existing-window URL"),
    ("replace malformed UTF-8 instead of rejecting", "src/lib/pwa-file-import.ts", 'fatal: true, ignoreBOM: true', 'fatal: false, ignoreBOM: true', UNIT, "malformed UTF-8"),
    ("drop UTF-8 BOM", "src/lib/pwa-file-import.ts", 'fatal: true, ignoreBOM: true', 'fatal: true, ignoreBOM: false', UNIT, "strict UTF-8"),
    ("accept unsupported/prototype file extensions", "src/lib/pwa-file-import.ts", '!Object.hasOwn(MIMES, ext)', 'false', UNIT, "invalid filenames"),
    ("ignore launch file size bound", "src/lib/pwa-file-import.ts", 'if (file.size > MAX_LAUNCH_FILE_BYTES)', 'if (false && file.size > MAX_LAUNCH_FILE_BYTES)', UNIT, "malformed UTF-8"),
    ("bypass user consent", "src/components/Shell.tsx", 'const consent = await askConfirm({ title: "Copy local files into Fusion?", okLabel: "Copy and open", detail: `${files.length} selected file(s): UTF-8 .txt, .log, .md, .csv or .json, at most 1 MiB each. Fusion sends a plaintext copy to its server in /Documents. Edits affect that copy, not the original file. Unsupported files are skipped.` });', 'const consent = true;', E2E, "cold browser navigation,modal cancellation"),
    ("replace compare-and-create with a blind write", "src/lib/pwa-file-import.ts", 'op: "writeIfUnchanged"', 'op: "write"', E2E, "cold browser navigation,selected UTF-8"),
    ("remove amnesic-session refusal", "src/components/Shell.tsx", 'if (!privacy.status().installed || privacy.status().amnesic) { toast("Local file launch import is unavailable in an amnesic session; nothing was copied.", "warn"); return; }', 'if (false) { toast("Local file launch import is unavailable in an amnesic session; nothing was copied.", "warn"); return; }', E2E, "amnesic session"),
    ("dispatch a cold-start intent twice", "src/components/Shell.tsx", 'if (target && target === initialLaunchUrl.current)', 'if (false && target && target === initialLaunchUrl.current)', E2E, "cold browser navigation"),
]
originals = {str(ROOT / path): (ROOT / path).read_text() for _, path, *_ in MUTANTS}
results = []
try:
    for i, (name, rel, old, new, script, only) in enumerate(MUTANTS, 1):
        start = time.monotonic(); path = ROOT / rel; original = originals[str(path)]
        state, detail = "crashed", ""
        try:
            if original.count(old) != 1:
                raise ValueError(f"expected one source match, found {original.count(old)}")
            path.write_text(original.replace(old, new, 1))
            env = os.environ.copy(); env["HARNESS_ONLY"] = only
            env.setdefault("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:5432/app_db")
            env.setdefault("BASE", "http://localhost:3000")
            r = subprocess.run(NODE + [f"scripts/{script}"], cwd=ROOT, env=env, text=True, capture_output=True, timeout=120)
            output = r.stdout + r.stderr
            if re.search(r"\b0 passed, 0 failed\b", output): detail = "No tests selected"
            elif r.returncode != 0 and re.search(r"\b[1-9][0-9]* failed\b", output): state, detail = "killed", output[-800:]
            elif r.returncode == 0: state, detail = "survived", output[-800:]
            else: detail = output[-1200:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally: path.write_text(original)
        print(f"{state.upper()} M{i}: {name}" + (f"\n{detail}" if state != "killed" and detail else ""), flush=True)
        results.append({"suite": "tt89-launch-mutants", "name": name, "covers": {"SH-13": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - start) * 1000)})
finally:
    for path, text in originals.items(): Path(path).write_text(text)
    dest = ROOT / "docs/test-results/tt89-launch-mutants.json"; dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps({"suite": "tt89-launch-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
killed = sum(r["pass"] for r in results)
print(f"Mutants: {killed}/{len(MUTANTS)} killed")
sys.exit(0 if killed == len(MUTANTS) and len(results) == len(MUTANTS) else 1)
