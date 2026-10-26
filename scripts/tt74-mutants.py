#!/usr/bin/env python3
"""TT74 mutation check (second-order adversary). Each mutant re-introduces one plausible bug in a TT74 change;
scripts/tt74-office.mts (only the tests aimed at the mutated code — TT74_ONLY) must FAIL for every mutant.
 · H*: hide / AutoFilter / SUBTOTAL (model, reader, writer, in-place patch, JSON, insert/delete, keyboard)
 · F*: Excel function semantics fixed in TT74
 · C*: CSV / Markdown conversion guards
Files and the result JSON are restored afterwards.
Run from the repository root:  /home/user/tools/venv/bin/python scripts/tt74-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

XP, XL, EN, SF, SO, SL = "src/lib/formula/xlsx-patch.ts", "src/lib/formula/xlsx.ts", "src/lib/formula/engine.ts", "src/lib/formula/sheetfilter.ts", "src/lib/formula/sheetops.ts", "src/lib/formula/sheetlayout.ts"
WJ, FN, OF, CSV, MD = "src/lib/formula/workbook-json.ts", "src/lib/formula/functions.ts", "src/lib/formula/ext/officeFunctions.ts", "src/lib/formula/csv.ts", "src/lib/office/md2docx.ts"
MUTANTS = [
    # (name, TT74_ONLY, path, old, new)
    ("H1 patch: the no-edit shortcut ignores hidden rows (a hide-only save returns the original bytes)", "U6", XP,
     "&& eqJ([...m.sheet.hiddenRows].sort((x, y) => x[0] - y[0]), [...o.hiddenRows].sort((x, y) => x[0] - y[0])) ", ""),
    ("H2 patch: the row hidden attribute is never written", "U6", XP, 'setAttr(r, "hidden", isHidden ? "1" : undefined); hiddenChanged = true;', "hiddenChanged = true;"),
    ("H3 reader: a criteria-less table AutoFilter marks hand-hidden rows as filtered", "U6", XL, '/<(?:\\w+:)?filterColumn\\b/.test(tafm![2] ?? "")', "true"),
    ("H4 SUBTOTAL 1-11 skip every hidden row", "U3", EN, '(kOrig > 100 || why === "filter")', "true"),
    ("H5 AGGREGATE ignores the hidden-row options", "U3", EN, ': [1, 3, 5, 7].includes(opts);', ": false;"),
    ("H6 criteria compared case-sensitively", "U4", SF, 'const fold = (s: string) => s.toLocaleLowerCase("en-US");', "const fold = (s: string) => s;"),
    ("H7 Unhide also shows filtered rows", "U4", SF, 'if (r >= r0 && r <= r1 && why === "manual")', "if (r >= r0 && r <= r1)"),
    ("H8 filter values written unescaped", "U4", SF, '<filter val="${esc(x)}"/>', '<filter val="${x}"/>'),
    ("H9 blank criterion dropped on read", "U4", SF, 'if (bl === "1" || bl === "true") vals.push("");', ""),
    # TT74-I: attacks on the TT74 repairs themselves
    ("P1 xmlAttr reads only double-quoted attributes (the S1 bug comes back)", "N17", SF, '''(?:"([^"]*)"|'([^']*)')''', '''"([^"]*)"'''),
    ("P3 uriTarget stops percent-encoding (raw spaces / non-ASCII in targets)", "N18", MD, "  let s = h.replace(", "  let s = h; if (0) s = h.replace("),
    ("P2 uriTarget drops the ./ prefix (a relative target like '(https:…' is not a valid anyURI)", "M2", MD, 'includes(":")) s = `./${s}`;', 'includes(":")) s = s;'),
    ("H10 writer drops hidden=\"1\" on rows with cells", "U5", XL, """`<row r="${r + 1}"${sheet.hiddenRows.has(r) ? ' hidden="1"' : ""}>""", '`<row r="${r + 1}">'),
    ("H11 JSON: manual hidden rows not restored", "U7", WJ, 'for (const r of rowsOf(hr.manual, 1048576)) sheet.hiddenRows.set(r, "manual");', ""),
    ("H12 JSON: no bound on hidden rows", "N11", WJ, ".slice(0, 200_000).filter((n): n is number", ".filter((n): n is number"),
    ("H13 insert/delete does not shift hidden rows", "U8", SO,
     'if (axis === "row") { const m = new Map<number, "manual" | "filter">(); for (const [r, why] of sheet.hiddenRows) { const n = shift(r); if (n >= 0) m.set(n, why); } sheet.hiddenRows = m; }', 'if (axis === "row") { /* not shifted */ }'),
    ("H14 deleting the whole filter range leaves the filter", "U8", SO, "if (!parseA1Range(next)) { sheet.autoFilter = null;", "if (false) { sheet.autoFilter = null;"),
    ("H15 arrow keys land on hidden rows", "U9", SL, "while (dRow && hr?.has(row) && row > 0 && row < maxRow) row += Math.sign(dRow);", ""),
    ("F1 DAY/MONTH/YEAR of a negative serial is not #NUM!", "U2", FN, 'function serialArg(x: Arg): number { const n = numArg(x); return n < 0 ? raise(err("#NUM!")) : n; }', "function serialArg(x: Arg): number { return numArg(x); }"),
    ("F2 SUBSTITUTE instance 0 accepted", "U2", FN, 'const nth = Math.trunc(numArg(a[3])); if (nth < 1) return raise(err("#VALUE!"));', "const nth = Math.trunc(numArg(a[3]));"),
    ("F3 SUMPRODUCT treats errors as 0", "U2", OF, "for (const l of lists) for (const v of l) if (isErr(v)) throw ERR(v as string);", ""),
    ("F4 DATE does not truncate its arguments", "U2", FN, "dateToSerial(Math.trunc(numArg(a[0])), Math.trunc(numArg(a[1])), Math.trunc(numArg(a[2])))", "dateToSerial(numArg(a[0]), numArg(a[1]), numArg(a[2]))"),
    ("F5 CSE does not repeat a single row", "U2", EN, "(R === 1 || r < R) && (C === 1 || c < C)", "(r < R) && (c < C)"),
    ("F6 REPLACE does not truncate / check start", "U2", FN, 'const start = Math.trunc(numArg(a[1])); const len = cnt(a[2]); if (start < 1) return raise(err("#VALUE!")); const rep', "const start = numArg(a[1]); const len = numArg(a[2]); const rep"),
    ("C1 CSV formula guard off", "N1", CSV, 'if (/^[=+\\-@]/.test(s) && !RE_NUM.test(s)', 'if (false && !RE_NUM.test(s)'),
    ("C2 CSV cell cap not enforced", "N3", CSV, "if (++cells > max) {", "if (++cells > max * 1000) {"),
    ("C3 Markdown unsafe link targets written", "N6", MD, "const href = safeHref(x.href);", "const href = x.href;"),
    ("C4 literal raw HTML not reported as a loss", "N7", MD, "else if (doc.rawLiteral) w.loss.set(", "else if (false) w.loss.set("),
]
SUITE = "scripts/tt74-office.mts"
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]

def mutate(text, old, new):
    assert text.count(old) == 1, f"anchor found {text.count(old)}x: {old[:60]}"
    return text.replace(old, new, 1)

orig = {p: pathlib.Path(p).read_text() for p in {m[2] for m in SELECTED}}
for name, _o, path, old, new in SELECTED: mutate(orig[path], old, new)
res = pathlib.Path("docs/test-results/tt74-office.json")
saved = res.read_bytes() if res.exists() else None
killed = 0
try:
    for name, only, path, old, new in SELECTED:
        pathlib.Path(path).write_text(mutate(orig[path], old, new))
        try:
            r = subprocess.run(["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", SUITE],
                               capture_output=True, text=True, timeout=1500, env={**os.environ, "TT74_ONLY": only})
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
        print(f"{'KILLED' if ok else 'SURVIVED'}  {name}  [{only}]  {'crash' if crashed and not failed else (failed[0] if failed else '')}", flush=True)
finally:
    for p, t in orig.items(): pathlib.Path(p).write_text(t)
    if saved is not None: res.write_bytes(saved)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
