#!/usr/bin/env python3
"""Selected calculator mutation checks in a temporary copy, never the live source/server."""
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
# name, target, exact old, exact new, suite, identifying test prefix
mutants = [
    ("OR accidentally becomes AND", "programmer.ts", "this.wrap(value | this.xor())", "this.wrap(value & this.xor())", "tt96-programmer", "bitwise AND"),
    ("XOR accidentally becomes OR", "programmer.ts", "this.wrap(value ^ this.and())", "this.wrap(value | this.and())", "tt96-programmer", "bitwise AND"),
    ("unary NOT omitted", "programmer.ts", "this.wrap(~this.unary())", "this.wrap(this.unary())", "tt96-programmer", "bitwise AND"),
    ("word wrap incorrectly limited to 32 bits", "programmer.ts", "BigInt.asUintN(this.width, value)", "BigInt.asUintN(Math.min(this.width, 32), value)", "tt96-programmer", "word arithmetic"),
    ("signed arithmetic treated as unsigned", "programmer.ts", "this.signed ? BigInt.asIntN(this.width, value) : value", "value", "tt96-programmer", "signed division"),
    ("signed right shift becomes logical", "programmer.ts", "this.numeric(value) >> count", "value >> count", "tt96-programmer", "signed division"),
    ("divide by zero returns zero", "programmer.ts", "if (divisor === BigInt(0)) throw new Error(\"Division by zero\");\n        value = this.wrap(this.numeric(value) / divisor);", "if (divisor === BigInt(0)) { value = BigInt(0); continue; }\n        value = this.wrap(this.numeric(value) / divisor);", "tt96-programmer", "invalid or resource"),
    ("shift limit omitted", "programmer.ts", "if (count < BigInt(0) || count >= BigInt(this.width)) throw new Error(`Shift count must be between 0 and ${this.width - 1}`);", "/* injected missing count check */", "tt96-programmer", "invalid or resource"),
    ("length limit omitted", "programmer.ts", "if (input.length > MAX_LENGTH)", "if (false && input.length > MAX_LENGTH)", "tt96-programmer", "invalid or resource"),
    ("nesting limit weakened", "programmer.ts", "if (++this.depth > MAX_NESTING)", "if (++this.depth > 500)", "tt96-programmer", "invalid or resource"),
    ("shift precedence changed", "programmer.ts", "private shift(): bigint {\n    let value = this.add();", "private shift(): bigint {\n    let value = this.multiply();", "tt96-programmer", "operator precedence"),
    ("binary output loses leading zeroes", "programmer.ts", "value.toString(2).padStart(width, \"0\")", "value.toString(2)", "tt96-programmer", "64-bit values"),
    ("scientific radix silently rounds", "calc.ts", "if (exact > BigInt(Number.MAX_SAFE_INTEGER))", "if (false && exact > BigInt(Number.MAX_SAFE_INTEGER))", "tt96-programmer", "the original scientific"),
    ("history collision overwrites", "calc-history.ts", "if (storage.getItem(key) !== null) throw new Error(\"Calculator history id collision\");", "/* injected collision overwrite */", "tt96-calc-history", "duplicate ids"),
    ("append mutates before checking corruption", "calc-history.ts", "readCalculatorHistory(storage); // fail closed on corruption before mutating anything", "/* injected missing preflight */", "tt96-calc-history", "malformed, mismatched"),
    ("clear deletes unrelated origin storage", "calc-history.ts", "for (const key of keys(storage, false)) storage.removeItem(key);", "storage.clear();", "tt96-calc-history", "explicit deletion"),
    ("history cap leaves 41 records", "calc-history.ts", ".slice(CALC_HISTORY_LIMIT))", ".slice(CALC_HISTORY_LIMIT + 1))", "tt96-calc-history", "bounded independent"),
    ("storage quota error is swallowed", "calc-history.ts", "storage.setItem(key, JSON.stringify(entry));", "try { storage.setItem(key, JSON.stringify(entry)); } catch {}", "tt96-calc-history", "write refusal"),
    ("oversized expressions are accepted", "calc-history.ts", "x.expr.length <= 512", "x.expr.length <= 4096", "tt96-calc-history", "excessive or invalid"),
]

def run(folder, suite, prefix):
    env = dict(os.environ, HARNESS_ONLY=prefix)
    p = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", f"scripts/{suite}.mts"], cwd=folder, env=env, capture_output=True, text=True, timeout=45)
    return p.returncode, p.stdout + p.stderr

results = []
with TemporaryDirectory(prefix="tt96-calculator-mutants-") as tmp:
    folder = Path(tmp)
    for sub in ("src/lib", "scripts/oracle", "docs/test-results"):
        (folder / sub).mkdir(parents=True, exist_ok=True)
    for path in ("src/lib/programmer.ts", "src/lib/calc.ts", "src/lib/calc-history.ts", "scripts/harness.mts", "scripts/tt96-programmer.mts", "scripts/tt96-calc-history.mts", "scripts/oracle/tt96-programmer.py"):
        shutil.copy2(root / path, folder / path)
    for name, target, old, new, suite, prefix in mutants:
        t0 = time.monotonic(); state = "crashed"; detail = ""
        path = folder / "src/lib" / target; original = path.read_text()
        try:
            code, baseline = run(folder, suite, prefix)
            if code or "1 passed, 0 failed" not in baseline: raise ValueError("selected baseline was not a pass: " + baseline[-1500:])
            if original.count(old) != 1: raise ValueError(f"mutation anchor matches {original.count(old)} times")
            path.write_text(original.replace(old, new, 1))
            code, output = run(folder, suite, prefix)
            if code and "0 passed, 1 failed" in output and "FAILED:" in output and re.search(r"Expected|Assertion|!==|Missing expected", output, re.I):
                state, detail = "killed", output[-2500:]
            elif code == 0 and "1 passed, 0 failed" in output: state, detail = "survived", output[-2500:]
            else: detail = output[-2500:]
        except (ValueError, subprocess.TimeoutExpired) as exc: detail = str(exc)
        finally: path.write_text(original)
        print(f"{state.upper()}: {name}" + (f"\n{detail}" if state != "killed" else ""), flush=True)
        results.append({"suite": "tt96-calculator-mutants", "name": name, "covers": {"PR-09": "partial"}, "pass": state == "killed", "error": None if state == "killed" else detail or state, "detection": detail if state == "killed" else None, "ms": round((time.monotonic() - t0) * 1000)})

out = root / "docs/test-results/tt96-calculator-mutants.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({"suite": "tt96-calculator-mutants", "at": datetime.now(timezone.utc).isoformat(), "results": results}, indent=2) + "\n")
killed = sum(r["pass"] for r in results)
print(f"Mutants: {killed}/{len(mutants)} killed")
sys.exit(0 if killed == len(mutants) and len(results) == len(mutants) else 1)
