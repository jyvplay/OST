#!/usr/bin/env python3
"""Selected TT97 mutation checks in a temporary copy, never the live source or server."""
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import os
import re
import shutil
import subprocess
import sys
import time

root = Path(__file__).resolve().parent.parent
mutants = [
    # equivalent=True marks a deliberately redundant guard: the mutant must survive
    # while the selected behavior test still passes, and is reported, never "killed".
    ("unit conversion claims a non-finite success", "calc.ts",
     "if (!Number.isFinite(value)) return { ok: false, text: \"not a finite number\" };",
     "/* injected missing finite check */", "tt96-scientific-units", "unit conversion never claims"),
    ("unit conversion multiplies before dividing", "calc.ts",
     "const value = n * (a.f / b.f);", "const value = (n * a.f) / b.f;", "tt96-scientific-units", "large identity"),
    ("unit conversion accepts a non-finite input", "calc.ts",
     "if (!Number.isFinite(n)) return { ok: false, text: \"not a finite number\" };",
     "/* injected missing input finite check */", "tt96-scientific-units", "selected physical", True),
    ("note command drops its word boundary", "palette-actions.ts",
     "const note = /^note(?:\\s+([\\s\\S]*))?$/i.exec(s);", "const note = /^note([\\s\\S]*)$/i.exec(s);",
     "tt97-palette-commands", "notes require an explicit"),
    ("focus accepts an arbitrary argument", "palette-actions.ts",
     "const focus = /^focus(?:\\s+(on|off))?$/i.exec(s);", "const focus = /^focus(?:\\s+([\\s\\S]*))?$/i.exec(s);",
     "tt97-palette-commands", "focus actions accept"),
    ("command length limit removed", "palette-actions.ts",
     "if (input.length > PALETTE_ACTION_LIMIT) return null;", "/* injected missing limit */",
     "tt97-palette-commands", "4096-code-unit limit"),
    ("setting filter length limit removed", "palette-actions.ts",
     "if (setting && setting[1].trim().length <= 200)", "if (setting)",
     "tt97-palette-commands", "settings and routine filters"),
    ("routine filter length limit removed", "palette-actions.ts",
     "if (routine && (routine[1] ?? \"\").trim().length <= 200)", "if (routine)",
     "tt97-palette-commands", "settings and routine filters"),
]

def run(folder, suite, prefix):
    env = dict(os.environ, HARNESS_ONLY=prefix)
    p = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", f"scripts/{suite}.mts"],
                       cwd=folder, env=env, capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout + p.stderr

results = []
with TemporaryDirectory(prefix="tt97-palette-mutants-") as tmp:
    folder = Path(tmp)
    for sub in ("src/lib", "scripts/oracle", "docs/test-results"):
        (folder / sub).mkdir(parents=True, exist_ok=True)
    for path in ("src/lib/calc.ts", "src/lib/palette-actions.ts", "scripts/register-hook.mjs", "scripts/ts-loader-hook.mjs", "scripts/harness.mts",
                 "scripts/tt96-scientific-units.mts", "scripts/tt97-palette-commands.mts", "scripts/oracle/tt97-unit-conversions.py"):
        shutil.copy2(root / path, folder / path)
    for mutant in mutants:
        name, target, old, new, suite, prefix = mutant[:6]
        equivalent = len(mutant) > 6 and mutant[6] is True
        t0 = time.monotonic(); state = "crashed"; detail = ""
        path = folder / "src/lib" / target; original = path.read_text()
        try:
            code, baseline = run(folder, suite, prefix)
            if code or "1 passed, 0 failed" not in baseline: raise ValueError("selected baseline was not a pass: " + baseline[-1500:])
            if original.count(old) != 1: raise ValueError(f"mutation anchor matches {original.count(old)} times")
            path.write_text(original.replace(old, new, 1))
            code, output = run(folder, suite, prefix)
            if code and "0 passed, 1 failed" in output and "FAILED:" in output and re.search(r"Expected|Assertion|!==|missing expected", output, re.I):
                state, detail = "killed", output[-2500:]
            elif code == 0 and "1 passed, 0 failed" in output: state, detail = ("equivalent" if equivalent else "survived"), output[-2500:]
            else: detail = output[-2500:]
        except (ValueError, subprocess.TimeoutExpired) as exc: detail = str(exc)
        finally: path.write_text(original)
        print(f"{state.upper()}: {name}" + (f"\n{detail}" if state not in ("killed", "equivalent") else ""), flush=True)
        results.append({"suite": "tt97-palette-mutants", "name": name, "covers": {"SR-06": "partial", "PR-09": "partial"},
                        "pass": state in ("killed", "equivalent"), "state": state,
                        "error": None if state in ("killed", "equivalent") else detail or state,
                        "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - t0) * 1000)})

out = root / "docs/test-results/tt97-palette-mutants.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"suite": "tt97-palette-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
killed = sum(r["state"] == "killed" for r in results)
equivalent = sum(r["state"] == "equivalent" for r in results)
print(f"Mutants: {killed}/{len(mutants) - equivalent} killed; {equivalent} documented equivalent (survived, behavior test still passes)")
sys.exit(0 if killed + equivalent == len(mutants) == len(results) else 1)
