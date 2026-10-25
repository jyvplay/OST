#!/usr/bin/env python3
"""TT75 mutation check (second-order adversary). Each mutant re-introduces one plausible bug in a TT75 change; the
suite aimed at the mutated code must FAIL for every mutant.
 · T*: Excel tables (structural model, refusals, #REF!, ST_Xstring, names, filter sanitiser) → scripts/tt75-office.mts
 · R*: recalculation range memo + ROWS / COLUMNS error propagation                       → scripts/tt75-office.mts
 · E*: EPUB core + content sanitiser (OCF guard, scripts, handlers, URLs, links, CSP, spreads) → scripts/tt75-epub.mts
Files and the result JSONs are restored afterwards.
Run from the repository root:  /home/user/tools/venv/bin/python scripts/tt75-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

ST, EN, OF3, WJ, SF = "src/lib/formula/sheettables.ts", "src/lib/formula/engine.ts", "src/lib/formula/ext/officeFunctions3.ts", "src/lib/formula/workbook-json.ts", "src/lib/formula/sheetfilter.ts"
EC, ET = "src/lib/epub/epub-core.ts", "src/lib/epub/epub-content.ts"
OFFICE, EPUB = "scripts/tt75-office.mts", "scripts/tt75-epub.mts"
FAST = "T3 T4 T5 N1 N2 N3 N4 N5 N6 N7 N8 N9 N10 N11 N12"
MUTANTS = [
    # (name, suite, ONLY, path, old, new)
    ("T1 insertDelete no longer refuses (header-only delete / two tables go through)", OFFICE, FAST, "src/lib/formula/sheetops.ts",
     "if (refusal) throw new TableEditError(refusal);", "if (refusal && false) throw new TableEditError(refusal);"),
    ("T1b the table model's own refusal is gone (defence in depth)", OFFICE, "N12", ST,
     "if (why) throw new TableEditError(why); }", "if (why && false) throw new TableEditError(why); }"),
    ("T2 deleting the totals row keeps totalsRows", OFFICE, FAST, ST,
     "if (t.totalsRows && t.r1 >= at && t.r1 < end) t.totalsRows = 0;", ""),
    ("T3 references to a removed table / column are not turned into #REF!", OFFICE, FAST, ST,
     'out += kill ? "#REF!" : text;', "out += text;"),
    ("T4 a literal _xHHHH_ in a column name is not escaped (ST_Xstring)", OFFICE, FAST, ST,
     '.replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1")', ""),
    ("T5 default column names start at the wrong number", OFFICE, "T2 T3", ST,
     "return `Column${k}`;", "return `Column${k + 1}`;"),
    ("T6 table names that look like R1C1 references are accepted", OFFICE, "N11", WJ,
     "if (/^[A-Za-z]{1,3}\\d+$/.test(n) || /^R\\d*C\\d*$/i.test(n)) return false;", ""),
    ("T7 the foreign-filter allowlist accepts any child element", OFFICE, FAST, SF,
     "if (parent ? !FILTER_SCHEMA[parent].kids.includes(name) : name !== \"filterColumn\" || roots++ > 0) return null;",
     "if (!parent && (name !== \"filterColumn\" || roots++ > 0)) return null;"),
    # TT75-I: attacks on the TT75 repairs themselves (the memo is new code with the most global blast radius)
    ("R1 range memo caches a read that met an in-progress cell (cycle)", OFFICE, "N9", EN,
     "if (memoOn && circHits === before && n >= 64", "if (memoOn && n >= 64"),
    ("R2 blank-mask memo key ignores the column", OFFICE, "N9", EN,
     "const key = ctx.maskMemo ? `${n.v.from.sheet ?? home}\\u0000${c0},${r0}", "const key = ctx.maskMemo ? `${n.v.from.sheet ?? home}\\u0000${0},${r0}"),
    ("R3 ROWS of a non-reference error returns 1 again", OFFICE, "N10", OF3,
     "ROWS: (a) => { const g = a[0].grid(); if (g.length === 1 && g[0]?.length === 1 && isErr(g[0][0])) throw ERR(String(g[0][0])); return g.length; },",
     "ROWS: (a) => a[0].grid().length,"),
    ("E1 the OCF compression-method guard is gone", EPUB, "C1", EC,
     "const odd = zip.entries.find((e) => e.method !== 0 && e.method !== 8);", "const odd = zip.entries.find((e) => e.method !== 0 && e.method !== 8 && false);"),
    ("E2 <script> is no longer dropped", EPUB, "", ET,
     'const DROP = new Set(["script", "base",', 'const DROP = new Set(["base",'),
    ("E3 on* event-handler attributes are kept", EPUB, "", ET,
     'if (lname.startsWith("on") || lname === "srcdoc"', 'if (lname === "srcdoc"'),
    ("E4 javascript: URLs pass the URL filter", EPUB, "", ET,
     "const BAD_URL = /^\\s*(javascript|vbscript|livescript|file):", "const BAD_URL = /^\\s*(vbscript|livescript|file):"),
    ("E5 external links keep a live href (the frame could navigate if the click handler were missing)", EPUB, "", ET,
     'setA(k, "data-epub-ext", v); setA(k, hrefAttr, "#");', 'setA(k, "data-epub-ext", v); setA(k, hrefAttr, v);'),
    ("E6 the frame CSP allows everything", EPUB, "N21", ET,
     "export const READER_CSP = \"default-src 'none';", "export const READER_CSP = \"default-src *;"),
    ("E7 <meta http-equiv=refresh> survives", EPUB, "", ET,
     '(name === "meta" && /\\S/.test(', '(name === "meta" && /^never$/.test('),
    ("E8 right-to-left spreads put the first page on the left", EPUB, "N22", EC,
     'const firstSide = rtl ? "right" : "left", secondSide = rtl ? "left" : "right";', 'const firstSide = "left", secondSide = "right";'),
]
SEL = os.environ.get("MUT", "")
SELECTED = [m for m in MUTANTS if SEL in m[0]]

def mutate(text, old, new):
    assert text.count(old) == 1, f"anchor found {text.count(old)}x: {old[:70]}"
    return text.replace(old, new, 1)

orig = {p: pathlib.Path(p).read_text() for p in {m[3] for m in SELECTED}}
for name, _s, _o, path, old, new in SELECTED: mutate(orig[path], old, new)
results = [pathlib.Path("docs/test-results/tt75-office.json"), pathlib.Path("docs/test-results/tt75-epub.json")]
saved = {r: r.read_bytes() for r in results if r.exists()}
killed = 0
try:
    for name, suite, only, path, old, new in SELECTED:
        pathlib.Path(path).write_text(mutate(orig[path], old, new))
        env = {**os.environ}
        if suite == OFFICE: env["TT75_ONLY"] = only
        elif only: env["TT75E_ONLY"] = only
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
