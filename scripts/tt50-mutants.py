#!/usr/bin/env python3
"""TT50 mutation check for spreadsheet charts: each mutant re-introduces one plausible bug in the chart reader / writer /
patch writer / renderer / trendline fitter; scripts/tt50-charts.mts (openpyxl + numpy oracles) must FAIL for every mutant.
Files are restored byte-for-byte afterwards (verified), and so is docs/test-results/tt50-charts.json.
Run from the repository root:  python3 scripts/tt50-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

CX, CP, SM, TR, XL = ("src/lib/formula/chartxml.ts", "src/lib/formula/xlsx-chartpatch.ts", "src/lib/formula/sheetmeta.ts",
                      "src/lib/formula/trend.ts", "src/lib/formula/xlsx.ts")
MUTANTS = [
    ("cached numbers written with 6 significant digits (precision loss)", CX,
     "const numStr = (v: number) => String(v);", "const numStr = (v: number) => String(Number(v.toPrecision(6)));", "new-workbook writer"),
    ("100 % stacking normalised by the signed sum instead of the sum of |v|", SM,
     "const tot = series.reduce((a, s) => a + Math.abs(s.values[i] ?? 0), 0);", "const tot = series.reduce((a, s) => a + (s.values[i] ?? 0), 0);", "renderer"),
    ("hbar draws the first category at the top", SM,
     "const catY = (i: number) => top + ph - i * slot - slot / 2;", "const catY = (i: number) => top + i * slot + slot / 2;", "renderer"),
    ("trendlines allowed on stacked charts", SM,
     'const trendOk = grouping === "clustered";', "const trendOk = true;", "renderer"),
    ("legend never written for new charts", CX,
     "+ (legend ? `<c:legend>", "+ (false ? `<c:legend>", "new charts made"),
    ("R² computed against the uncentred total for ordinary fits", TR,
     "const m = sxy / sxx, b = my - m * mx;\n  const ssr = sum(ys.map((y, i) => (y - (m * xs[i] + b)) ** 2)), sst = sum(ys.map((y) => (y - my) ** 2));", "const m = sxy / sxx, b = my - m * mx;\n  const ssr = sum(ys.map((y, i) => (y - (m * xs[i] + b)) ** 2)), sst = sum(ys.map((y) => y * y));", "trendlines"),
    ("deleted chart keeps its [Content_Types] Override", CP,
     "io.remove(b.src); io.override(b.src, null);", "io.remove(b.src);", "delete a chart"),
    ("over-long series refs truncated instead of dropped", SM,
     'if (typeof r.val === "string" && r.val.length > REF_MAX) return [];', 'if (typeof r.val === "string" && r.val.length > REF_MAX) r.val = r.val.slice(0, REF_MAX);', "persistence"),
    ("ptCount not clamped (huge allocations from hostile files)", CX,
     'const count = Math.min(MAX_PTS, Math.max(0, numAttr(kidL(e, "ptCount")) ?? 0));', 'const count = Math.max(0, numAttr(kidL(e, "ptCount")) ?? 0);', "hostile"),
    ("zip part lookup case-sensitive (123233-style mixed-case rels lose their charts)", XL,
     "const e = entries.find((x) => x.name === n) ?? entries.find((x) => x.name.toLowerCase() === n.toLowerCase());", "const e = entries.find((x) => x.name === n);", "reader semantics"),
    ("autoTitleDeleted not flipped when a title is set/cleared by the patch writer", CP,
     'setVal(chart, "autoTitleDeleted", a.title ? "0" : "1", ["title"], make);', "", "delete a chart"),
    ("absolute relationship targets resolved relative to the part", CX,
     'if (target.startsWith("/")) return target.slice(1);', "", "reader semantics"),
]

RESULTS = pathlib.Path("docs/test-results/tt50-charts.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
# anchors are checked up front, and the results file is restored even if a run aborts
for name, path, old, *_ in SELECTED: assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor not unique"
try:
    for name, path, old, new, only in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        assert text.count(old) == 1, f"{name}: anchor found {text.count(old)}×"
        try:
            p.write_text(text.replace(old, new))
            r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt50-charts.mts"],
                               env={**os.environ, "ONLY": only}, capture_output=True, text=True, timeout=900)
            out = r.stdout + r.stderr
            dead = "FAILED:" in out or r.returncode != 0
            failed = [l.strip()[2:70] for l in out.splitlines() if l.strip().startswith("✗")]
            print(f"{'KILLED ' if dead else 'SURVIVED'} {name}  ← {', '.join(failed) or out[-300:]}", flush=True)
            killed += dead
        finally:
            p.write_bytes(orig)
            assert p.read_bytes() == orig, f"{path} not restored"
finally:
    if saved is not None: RESULTS.write_bytes(saved)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
