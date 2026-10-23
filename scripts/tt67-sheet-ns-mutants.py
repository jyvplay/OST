#!/usr/bin/env python3
"""TT67 mutation check for SpreadsheetML namespace canonicalisation + numeric character references (FF-21): each mutant
re-introduces one plausible bug in src/lib/office/xml-ns.ts or src/lib/formula/xlsx.ts; scripts/tt67-sheet-ns.mts (lxml
equivalence oracle, lxml + openpyxl cell verifiers, whole-corpus differential vs TT66) must FAIL for every mutant.
Files and the results file are restored afterwards. ~90 s per mutant.
Run from the repository root:  python3 scripts/tt67-sheet-ns-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

N, X, P = "src/lib/office/xml-ns.ts", "src/lib/formula/xlsx.ts", "src/lib/formula/xlsx-patch.ts"
MUTANTS = [
    ("reader: canonicalisation not wired (TT66 behaviour)", X,
     '? canonicalizeNs(raw, SML_CANON, { knownRoot: true }) : raw;', '? raw : raw;'),
    ("reader: knownRoot guard dropped (unknown dialects aliased away)", X,
     'canonicalizeNs(raw, SML_CANON, { knownRoot: true })', 'canonicalizeNs(raw, SML_CANON)'),
    ("map: Excel 2007 beta namespace not SpreadsheetML", N, '[NS.smlBeta]: "", ', ''),
    ("map: strict SpreadsheetML namespace not canonical", N, '[NS.smlStrict]: "", ', ''),
    ("canon: MCE prefix lists not renamed", N,
     '        if (!MCE_PREFIX_LISTS.has(local) && !MCE_QNAME_LISTS.has(local)) return val;', '        return val;'),
    ("canon: foreign default under canonical \"\" not given an alias declaration", N,
     '          if (u !== "" && !(u in canon) && prefixes.has("")) outAttrs +=', '          if (false) outAttrs +='),
    ("canon: no xmlns=\"\" undeclaration (outDef never reset to none)", N,
     '      if (need !== outDef) {', '      if (need !== outDef && need !== "") {'),
    ("canon: output default not restored after a self-closing element", N,
     '    if (selfClose) { outDef = parentOutDef; return', '    if (selfClose) { return'),
    ("canon: fast path trusts the global regex (declarations inside attribute values)", N,
     '  if (!suspect) return true;\n  for (const [p, uri] of declarations(xml))', '  return !suspect;\n  for (const [p, uri] of declarations(xml))'),
    ("canon: alias may reuse a prefix already in the source", N,
     'while (xml.includes(`ns${k}:`) || xml.includes(`xmlns:ns${k}`) || prefixes.has(`ns${k}`)) k++;', 'while (prefixes.has(`ns${k}`)) k++;'),
    ("canon: attribute prefixes not renamed", N,
     '      const op = ap === "xml" ? "xml" : outPrefix(au, ap);', '      const op = ap;'),
    ("patch: styles read from the raw (prefixed) styles.xml (TT67 gate finding)", P,
     "X.readStyles(canonView(stylesXml) as string, colorContext(canonView(stylesXml) as string, canonView(themeXml)))", "X.readStyles(stylesXml, colorContext(stylesXml, themeXml))"),
    ("dec: numeric references not decoded (TT66 behaviour)", X,
     '  if (n) return NAMED[n];\n', '  if (n) return NAMED[n];\n  if (n === undefined) return m;\n'),
    ("dec: two passes (&amp;lt; decoded to <)", X,
     'const dec = (s: string) => (s.indexOf', 'const dec = (s: string): string => dec1(dec1(s));\nconst dec1 = (s: string) => (s.indexOf'),
    ("dec: astral hex references not matched", X, '|#x([0-9a-fA-F]{1,6})|', '|#x([0-9a-fA-F]{1,4})|'),
    ("dec: lone surrogates decoded", X, ' && !(cp >= 0xd800 && cp <= 0xdfff) ?', ' ?'),
]

RESULTS = pathlib.Path("docs/test-results/tt67-sheet-ns.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
for name, path, old, *_ in SELECTED: assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor found {pathlib.Path(path).read_text().count(old)}x"
try:
    for name, path, old, new in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        try:
            p.write_text(text.replace(old, new))
            r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt67-sheet-ns.mts"],
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
