#!/usr/bin/env python3
"""TT66 mutation check for x14 conditional formatting on save (FF-50): each mutant re-introduces one plausible bug in
src/lib/formula/{xlsx-patch,xlsx}.ts; scripts/tt66-sheet-x14-patch.mts (MS-XLSX schema + structural oracle xlsx_x14.py,
ECMA XSDs, openpyxl, reader round trip) must FAIL for every mutant. Files and the results file are restored afterwards.
Run from the repository root:  python3 scripts/tt66-sheet-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

P, X = "src/lib/formula/xlsx-patch.ts", "src/lib/formula/xlsx.ts"
MUTANTS = [
    ("patch: x14 half never emitted (pre-TT66 behaviour)", P, "let x = X.cfX14Xml(rr, prio, `${sheet.name}|patch|${prio}|${sq}`);", "let x = null as ReturnType<typeof X.cfX14Xml>;"),
    ("patch: x14-only rules also written as 2007 rules", P, "            if (!x.linked) continue;\n", "\n"),
    ("patch: linked bar loses its <x14:id> link", P, "          if (x) m = m.replace(", "          if (false) m = m.replace("),
    ("patch: existing CF ext not reused (second ext appended)", P, '.find((k) => (attr(k, "uri") ?? "").toUpperCase() === "{78C0D931-6437-407D-A8EE-F0AAD7539E65}");', '.find(() => false);'),
    ("patch: URI compared case-sensitively", P, '(attr(k, "uri") ?? "").toUpperCase() === "{78C0D931-6437-407D-A8EE-F0AAD7539E65}"', '(attr(k, "uri") ?? "") === "{78C0D931-6437-407D-A8EE-F0AAD7539E65}"'),
    ("patch: extLst inserted before the CF elements (not last)", P, "if (!lst) { lst = el(SP + \"extLst\"); doc.root.kids.push(lst); }", "if (!lst) { lst = el(SP + \"extLst\"); doc.root.kids.unshift(lst); }"),
    ("patch: duplicated rule shares a used x14 id", P, "const rr: CondRule = r.x14 && usedIds.has(r.x14.toUpperCase()) ? { ...r, x14: undefined } : r;", "const rr: CondRule = r;"),
    ("patch: priorities not advanced for x14 rules", P, "          pr = prio;\n", "\n"),
    ("patch: strip renames x14 elements into the main namespace", P, "if (!e.name.includes(\":\")) { const keep", "if (true) { const keep"),
    ("patch: prefixed sheet — new elements left unprefixed", P, "e.name = SP + e.name; }", "}"),
    ("patch: CF container matched by literal x14 prefix (second-order finding)", P, 'let cfs = kidL(ex, "conditionalFormattings");', 'let cfs = kids(ex, "x14:conditionalFormattings")[0];'),
    ("writer: cross-sheet thresholds stay in the 2007 schema", X, "(r.cfvo ?? []).some((c) => c.v !== undefined && crossSheet(c.v));", "false;"),
    ("writer: x14-only bar has no fillColor", X, 'const fill = xcv ? `<x14:fillColor rgb="${argb(r.barColor ?? "#638ec6")}"/>` : "";', 'const fill = "";'),
    ("writer: x14-only bar written as linked", X, "    if (xcv) return { xml:", "    if (false) return { xml:"),
    ("writer: fillColor after borderColor (schema order)", X, "${cv.map((c) => cfvo(c, false)).join(\"\")}${fill}${r.barBorder ? `<x14:borderColor rgb=\"${argb(r.barBorder)}\"/>` : \"\"}", "${cv.map((c) => cfvo(c, false)).join(\"\")}${r.barBorder ? `<x14:borderColor rgb=\"${argb(r.barBorder)}\"/>` : \"\"}${fill}"),
    ("reader: x14-only data bars ignored", X, '    if (x.at.type !== "dataBar" || (x.at.id && linked.has(x.at.id))) continue;', '    if (true) continue;'),
    ("reader: x14-only bar colour ignored", X, 'r.barColor = b.fill ?? "#638ec6";', 'r.barColor = "#638ec6";'),
    ("writer: icon gte=0 dropped in x14 cfvo", X, '${icon && c.gt ? \' gte="0"\' : ""}${c.v !== undefined', '${c.v !== undefined'),
]

RESULTS = pathlib.Path("docs/test-results/tt66-sheet-x14-patch.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
for name, path, old, *_ in SELECTED: assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor found {pathlib.Path(path).read_text().count(old)}x"
try:
    for name, path, old, new in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        try:
            p.write_text(text.replace(old, new))
            r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt66-sheet-x14-patch.mts"],
                               capture_output=True, text=True, timeout=900)
            out = r.stdout + r.stderr
            dead = "FAILED:" in out or r.returncode != 0
            failed = [l.strip()[2:60] for l in out.splitlines() if l.strip().startswith("✗")]
            print(f"{'KILLED ' if dead else 'SURVIVED'} {name}  ← {len(failed)} test(s): {' | '.join(failed) or out[-300:]}", flush=True)
            killed += dead
        finally:
            p.write_bytes(orig)
            assert p.read_bytes() == orig, f"{path} not restored"
finally:
    if saved is not None: RESULTS.write_bytes(saved)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
