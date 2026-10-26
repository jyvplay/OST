#!/usr/bin/env python3
"""TT73 mutation check. Each mutant re-introduces one plausible bug in a TT73 change; scripts/tt73-office.mts (only the
tests aimed at the mutated code — TT73_ONLY) must FAIL for every mutant.
 · U*: Unicode sheet / table / defined names (lexer, parser, name validation)
 · W*: Writer header / footer pictures (own-part relationships, declared r:, re-read media) and legacy w:type="odd"
 · X*: the PresentationML schema oracle, external links, Excel numeric-argument rule, chart scatter x values
A "strip" mutant removes the Unicode letter ranges from the ONE line containing its marker (the ASCII class remains).
Files and the result JSON are restored afterwards.
Run from the repository root:  /home/user/tools/venv/bin/python scripts/tt73-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

U = r"\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u03FF\u0400-\u052F\u0531-\u0587\u05D0-\u05EA\u0620-\u064A\u0E01-\u0E30\u1E00-\u1FFF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF"
LX, PA, NM = "src/lib/formula/lexer.ts", "src/lib/formula/parser.ts", "src/lib/formula/names.ts"
WM, HF, XL, OF, CX = "src/lib/office/wordml.ts", "src/lib/office/hdrftr.ts", "src/lib/formula/xlsx.ts", "src/lib/formula/ext/officeFunctions.ts", "src/lib/formula/chartxml.ts"
XSD = "scripts/oracle/ooxml_xsd.py"
STRIP = object()
MUTANTS = [
    # (name, TT73_ONLY, path, old (or marker for STRIP), new (or STRIP))
    ("U1 lexer: table names ASCII-only (Таблица1[Col])", "S4", LX, "  const m = /^[A-Za-z_\\\\" + U, STRIP),
    ("U2 lexer: unquoted sheet names ASCII-only (Лист2!A1)", "S4", LX, "const SHEET_RE = ", STRIP),
    ("U3 parser: reference sheet names ASCII-only", "S4", PA, "  const m = /^(?:('(?:[^']|'')+'|[A-Za-z_", STRIP),
    ("U4 defined names ASCII-only (Налог refused)", "S4", NM, "  if (!/^[A-Za-z_", STRIP),
    ("W1 header picture relationship not recorded for the part's .rels", "W1", HF, "h.relsAdded = [...(h.relsAdded ?? []), rel];", "h.relsAdded = h.relsAdded ?? [];"),
    ("W2 header / footer .rels never written", "W1", WM, "    if (!h.relsAdded?.length) continue;\n", "    continue;\n"),
    ("W3 r: not declared on the picture (a header root without xmlns:r)", "W1", HF, '<a:blip r:embed="${rel.id}" xmlns:r="${R_NS}"/>', '<a:blip r:embed="${rel.id}"/>'),
    ("W4 a picture added this session is not found on re-parse", "W1", WM, " ?? ctx.doc.added.media.find((m) => m.path === path)?.data;", ";"),
    ("W5 legacy w:type=\"odd\" not the default header (a 7th reference is added)", "W2", WM, 'return t === "odd" ? "default" : t; };', "return t; };"),
    ("W6 an edited legacy \"odd\" header keeps its odd reference", "W2", HF, '  if (type !== "default") return;\n  const name = kind', "  return;\n  const name = kind"),
    ("W7 NaN / infinite picture sizes reach the XML", "N1", HF, "(Number.isFinite(v) ? Math.min(2000, Math.max(1, v)) : 1)", "Math.max(1, v)"),
    ("X1 schema oracle skips slides", "P1", XSD, '"presentationml.slide+xml", ', ""),
    ("X2 external links not read", "S3", XL, "  wb.externals = readExternalLinks(workbookXml, rels, get);", "  wb.externals = [];"),
    ("X3 literal text in a statistics argument ignored instead of #VALUE!", "S5", OF,
     'if (literalTextIsError || t === "" || Number.isNaN(Number(t))) throw ERR("#VALUE!"); out.push(Number(t));',
     'if (literalTextIsError) throw ERR("#VALUE!"); if (t !== "" && !Number.isNaN(Number(t))) out.push(Number(t));'),
    ("X4 scatter series lose their own x values", "C1", CX, "values: s.values, xs: s.xs,", "values: s.values, xs: undefined,"),
]
SUITE = "scripts/tt73-office.mts"
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]

def mutate(text, old, new):
    if new is STRIP:
        lines = text.split("\n"); hit = [i for i, l in enumerate(lines) if old in l]
        assert len(hit) == 1 and U in lines[hit[0]], f"strip marker found {len(hit)}x"
        lines[hit[0]] = lines[hit[0]].replace(U, ""); return "\n".join(lines)
    assert text.count(old) == 1, f"anchor found {text.count(old)}x"
    return text.replace(old, new, 1)

for name, _o, path, old, new in SELECTED: mutate(pathlib.Path(path).read_text(), old, new)
orig = {p: pathlib.Path(p).read_text() for p in {m[2] for m in SELECTED}}
res = pathlib.Path("docs/test-results/tt73-office.json")
saved = res.read_bytes() if res.exists() else None
killed = 0
try:
    for name, only, path, old, new in SELECTED:
        pathlib.Path(path).write_text(mutate(orig[path], old, new))
        try:
            r = subprocess.run(["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", SUITE],
                               capture_output=True, text=True, timeout=1500, env={**os.environ, "TT73_ONLY": only})
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
