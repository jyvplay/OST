#!/usr/bin/env python3
"""TT76 mutation check (second-order adversary). Each mutant re-introduces one plausible bug in a TT76 change; the
suite aimed at the mutated code must FAIL for every mutant.
 · F*: AutoFilter evaluation (And / Or, Top N %, ties, averages, dynamic ranges)          → scripts/tt76-sheet.mts
 · P*: slide transitions / animations engine (p14 duration, ids, groups, pruning, escaping) → scripts/tt76-slides.mts
 · C*: show CSS playback + presenter ↔ audience protocol validation                         → scripts/tt76-slides.mts
Files and the result JSONs are restored afterwards.
Run from the repository root:  /home/user/tools/venv/bin/python scripts/tt76-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

FE, PA, PP, SL = "src/lib/formula/filtereval.ts", "src/lib/office/pmlanim.ts", "src/lib/office/pmlplay.ts", "src/lib/office/showlink.ts"
SHEET, SLIDES = "scripts/tt76-sheet.mts", "scripts/tt76-slides.mts"
MUTANTS = [
    # (name, suite, ONLY, path, old, new)
    ("F1 custom And is evaluated as Or", SHEET, "S1 S2 S3 S4 O1", FE,
     "return (i) => (crit.and ? tests.every((t) => t(cells[i])) : tests.some((t) => t(cells[i])));", "return (i) => tests.some((t) => t(cells[i]));"),
    ("F2 Top N % rounds up instead of down", SHEET, "S1 S2 S3 S4 O1", FE,
     "Math.max(1, Math.floor((nums.length * crit.val) / 100))", "Math.max(1, Math.ceil((nums.length * crit.val) / 100))"),
    ("F3 Top N drops ties (strict comparison)", SHEET, "S1 S2 S3 S4 O1", FE,
     "(cells[i].v as number) >= cut : (cells[i].v as number) <= cut", "(cells[i].v as number) > cut : (cells[i].v as number) < cut"),
    ("F4 above average is inclusive", SHEET, "S1 S2 S3 S4 D1 O1", FE,
     "(cells[i].v as number) > avg : (cells[i].v as number) < avg", "(cells[i].v as number) >= avg : (cells[i].v as number) <= avg"),
    ("F5 dynamic date ranges are closed [val, maxVal]", SHEET, "D1 O1", FE,
     "(cells[i].v as number) >= lo && (cells[i].v as number) < hi", "(cells[i].v as number) >= lo && (cells[i].v as number) <= hi"),
    ("P1 the p14:dur duration is ignored (spd bucket wins)", SLIDES, "M1 M3", PA,
     "const p14dur = t.choice ? numMs(attr(t.choice, \"p14:dur\")) : undefined;", "const p14dur = undefined as number | undefined;"),
    ("P2 foreign effects keep their original cTn ids (duplicates after re-emit)", SLIDES, "M2", PA,
     "const r = clone(e.raw!); for (const c of findAll(r, (x) => x.name === \"p:cTn\")) setAttr(c, \"id\", String(next()));", "const r = clone(e.raw!);"),
    ("P3 'with previous' starts a new click group", SLIDES, "M3 M4", PA,
     "if (n === 0 || e.trigger === \"click\") groups.push(", "if (n === 0 || e.trigger !== \"after\") groups.push("),
    ("P4 deleteShape no longer prunes the timeline", SLIDES, "M5 N15 N16 N17 N", "src/lib/office/pml.ts",
     "pruneTiming(s.xml)", "void 0"),
    ("P5 spids are written unescaped", SLIDES, "N", PA,
     "const q = (s: string) => s.replace(/&/g, \"&amp;\").replace(/\"/g, \"&quot;\").replace(/</g, \"&lt;\");", "const q = (s: string) => s;"),
    ("P6 effects for missing shapes are kept (dangling)", SLIDES, "N", PA,
     "const clean = effects.filter((e) => ids.has(e.spid)).map(", "const clean = effects.map("),
    ("P7 an AlternateContent timeline is treated as absent (a second p:timing gets added)", SLIDES, "N", PA,
     "if (altTimings(x.root).length) return { effects: [], readOnly: true, extra: [], bld: [] };", ""),
    ("C1 wipe keyframes animate to `none` (not interpolable → 50 % cut)", SLIDES, "M6", PP,
     "@keyframes fstr-clip-in { from { clip-path: var(--tr-clip) } to { clip-path: inset(0 0 0 0) } }", "@keyframes fstr-clip-in { from { clip-path: var(--tr-clip) } }"),
    ("C2 shapes waiting for an entrance are not hidden", SLIDES, "M6", PP,
     "if (a !== undefined && !playingAddr.has(a)) out[a] = { visibility: \"hidden\" };", ""),
    ("C3 the audience accepts a state with an out-of-range slide index", SLIDES, "L1", SL,
     "if (!nat(s.i, MAX_SLIDES - 1) ||", "if ("),
    ("C4 a deck that is not a ZIP package is accepted", SLIDES, "L1", SL,
     "if (b[0] !== 0x50 || b[1] !== 0x4b) return null;", ""),
]
SEL = os.environ.get("MUT", "")
SELECTED = [m for m in MUTANTS if SEL in m[0]]

def mutate(text, old, new):
    assert text.count(old) == 1, f"anchor found {text.count(old)}x: {old[:70]}"
    return text.replace(old, new, 1)

orig = {p: pathlib.Path(p).read_text() for p in {m[3] for m in SELECTED}}
for name, _s, _o, path, old, new in SELECTED: mutate(orig[path], old, new)
results = [pathlib.Path("docs/test-results/tt76-sheet.json"), pathlib.Path("docs/test-results/tt76-slides.json")]
saved = {r: r.read_bytes() for r in results if r.exists()}
killed = 0
try:
    for name, suite, only, path, old, new in SELECTED:
        pathlib.Path(path).write_text(mutate(orig[path], old, new))
        env = {**os.environ, "TT76_ONLY": only}
        try:
            r = subprocess.run(["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", suite],
                               capture_output=True, text=True, timeout=1500, env=env)
            out = r.stdout + r.stderr
        except subprocess.TimeoutExpired:
            out = "✗ timeout"
        finally:
            pathlib.Path(path).write_text(orig[path])
        failed = [l.strip()[2:90] for l in out.splitlines() if l.strip().startswith("✗")]
        crashed = "passed," not in out
        ran = "0 passed, 0 failed" not in out
        ok = (bool(failed) or crashed) and ran
        killed += ok
        print(f"{'KILLED' if ok else 'SURVIVED'}  {name}  [{os.path.basename(suite)} {only or 'all'}]  {'crash' if crashed and not failed else (failed[0] if failed else '')}", flush=True)
finally:
    for p, t in orig.items(): pathlib.Path(p).write_text(t)
    for r, b in saved.items(): r.write_bytes(b)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
