#!/usr/bin/env python3
"""Prove the real Slides Save-as test detects editor and shell shortcut failures.
Disposable DB and development server only; restores the source even on failure.
"""
from pathlib import Path
from datetime import datetime, timezone
import json, os, re, subprocess, sys, time
if os.environ.get("TT89_DISPOSABLE_DATABASE") != "1" or os.environ.get("TT90_DEV_MUTATIONS") != "1":
    raise SystemExit("Refusing mutation outside an explicitly disposable database and development server.")
root = Path(__file__).resolve().parent.parent; path = root / "src/components/modules/Slides.tsx"; original = path.read_text()
mutants = [
    ("remove editor shortcut guard", 'if (present !== null || pop || isAskOpen()) return; // a modal owns the keyboard', 'if (present !== null) return; // injected: no modal shortcut guard in the editor', 'Ctrl+F opened behind Save-as after focus escape'),
    ("drop shell modal hold", 'const release = holdModal(); // stop shell-wide shortcuts even if focus leaves this dialog', 'const release = () => {}; // injected: no shell modal hold', 'global palette opened behind Save-as after focus escape'),
]
results = []
try:
    for name, old, new, detection in mutants:
        state = "crashed"; detail = ""; started = time.monotonic()
        try:
            if original.count(old) != 1: raise ValueError(f"expected one match, got {original.count(old)}")
            path.write_text(original.replace(old, new, 1))
            env = os.environ.copy(); env["HARNESS_ONLY"] = "E3 Slides"
            run = subprocess.run(["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/e2e-tt81.mts"], cwd=root, env=env, text=True, capture_output=True, timeout=150)
            out = run.stdout + run.stderr
            if run.returncode != 0 and re.search(r'\b[1-9][0-9]* failed\b', out) and detection in out: state = "killed"
            elif run.returncode == 0: state = "survived"
            detail = out[-1500:]
        except (ValueError, subprocess.TimeoutExpired) as e: detail = str(e)
        finally: path.write_text(original)
        print(f"{state.upper()}: {name}\n{detail}", flush=True)
        results.append({"suite":"tt90-modal-mutant", "name":name, "covers":{"FF-80":"partial"}, "pass":state == "killed", "error":None if state == "killed" else detail or state, "detection":detail, "ms":round((time.monotonic()-started)*1000)})
finally:
    path.write_text(original)
    dest=root / "docs/test-results/tt90-modal-mutant.json"; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_text(json.dumps({"suite":"tt90-modal-mutant", "at":datetime.now(timezone.utc).isoformat(), "results":results}, indent=2)+"\n")
killed = sum(r["pass"] for r in results)
print(f"Modal mutants: {killed}/{len(mutants)} killed")
sys.exit(0 if killed == len(mutants) and len(results) == len(mutants) else 1)
