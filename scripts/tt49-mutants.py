#!/usr/bin/env python3
"""TT49 mutation check for conditional formatting: each mutant re-introduces one plausible semantic bug; the
tt49-sheet suite (restricted with ONLY to the tests that should notice) must FAIL for every mutant.
Every file is restored byte-for-byte afterwards (verified). Run from the repository root:
    python3 scripts/tt49-mutants.py
"""
import subprocess, sys, pathlib

FAST = "documented|priority|adversarial|JSON boundary"
MUTANTS = [
    ("blank cells no longer count as 0 in cellIs", "src/lib/formula/engine.ts",
     'return evalBinary(op, blank ? BLANK : (cell ?? ""), operand) === true;', 'return evalBinary(op, (cell ?? ""), operand) === true;', FAST),
    ("icon threshold gte/gt swapped", "src/lib/formula/sheetmeta.ts", "(cv[i].gt ? x.v > t : x.v >= t)", "(cv[i].gt ? x.v >= t : x.v > t)", FAST),
    ("top N% rounds up", "src/lib/formula/sheetmeta.ts", "Math.max(1, Math.floor((nums.length * Math.min(rank, 100)) / 100))", "Math.max(1, Math.ceil((nums.length * Math.min(rank, 100)) / 100))", FAST),
    ("population instead of sample standard deviation", "src/lib/formula/sheetmeta.ts", "/ (xs.length - 1)); };", "/ xs.length); };", FAST),
    ("data bar default min length 0 % instead of 10 %", "src/lib/formula/sheetmeta.ts", "rule.barMinLen ?? 10", "rule.barMinLen ?? 0", FAST),
    ("stopIfTrue ignored", "src/lib/formula/sheetmeta.ts", "if (rule.stop) stopped.add(x.k);", "", FAST),
    ("extLst cut ignores cfRule depth (the TT49 greedy-extLst bug)", "src/lib/formula/xlsx.ts", "if (!m[1] && depth <= 0) { cut = m.index!; break; }", "if (!m[1]) { cut = m.index!; break; }", "corpus differential|known answers"),
    ("A0 accepted as a reference", "src/lib/formula/sheetops.ts",
     'if (unit.some((p) => p.col < 0 || p.row < 0 || p.col > MAX_COL || p.row > MAX_ROW)) return text();', "", FAST),
    ("icon-set table with an inherited prototype", "src/lib/formula/cficons.ts",
     "Object.assign(Object.create(null) as Record<string, IconGlyph[]>, {", "Object.assign({} as Record<string, IconGlyph[]>, {", FAST),
]

killed = 0
RESULTS = pathlib.Path("docs/test-results/tt49-sheet.json"); saved_results = RESULTS.read_bytes() if RESULTS.exists() else None  # ONLY runs must not replace the full record
SELECTED = [m for m in MUTANTS if __import__("os").environ.get("MUT", "") in m[0]]  # MUT=<substring> runs a subset
for name, path, old, new, only in SELECTED:
    p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
    assert text.count(old) == 1, f"{name}: anchor found {text.count(old)}×"
    try:
        p.write_text(text.replace(old, new))
        r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt49-sheet.mts"],
                           env={**__import__("os").environ, "ONLY": only}, capture_output=True, text=True, timeout=900)
        out = r.stdout + r.stderr
        dead = "FAILED:" in out or r.returncode != 0
        failed = [l.strip()[2:70] for l in out.splitlines() if l.strip().startswith("✗")]
        print(f"{'KILLED ' if dead else 'SURVIVED'} {name}  ← {', '.join(failed) or out[-300:]}", flush=True)
        killed += dead
    finally:
        p.write_bytes(orig)
        assert p.read_bytes() == orig, f"{path} not restored"
if saved_results is not None: RESULTS.write_bytes(saved_results)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
