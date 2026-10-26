#!/usr/bin/env python3
"""TT68 mutation check for FF-52 (empty cells vs empty text, error constants, *IF criteria, empty-text cells in the
reader / writer / lossless patcher): each mutant re-introduces one plausible bug in src/lib/formula/{functions,engine,
xlsx,xlsx-patch}.ts; scripts/tt68-blank.mts (Microsoft-documented table, criteria table, lxml empty-text oracle,
openpyxl) must FAIL for every mutant. Runs the suite with TT68_FAST=1 (the held-out corpus test is skipped: it is a
measurement, not a guard). Files and the results file are restored afterwards. ~12 s per mutant.
Run from the repository root:  python3 scripts/tt68-blank-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

F, E, X, P = "src/lib/formula/functions.ts", "src/lib/formula/engine.ts", "src/lib/formula/xlsx.ts", "src/lib/formula/xlsx-patch.ts"
MUTANTS = [
    ("blank mask ignored (TT67 \"\" guess)", F, 'a.kind === "matrix" ? (a.blank ? a.blank[i]?.[j] === true : a.value[i]?.[j] === "") : false;', 'a.kind === "matrix" ? a.value[i]?.[j] === "" : false;'),
    ("ISBLANK(\"\") literal is TRUE", F, 'return x.kind === "matrix" ? blankAt(x, 0, 0) : false; },', 'return x.kind === "matrix" ? blankAt(x, 0, 0) : x.value === ""; },'),
    ("ISTEXT of an empty cell is TRUE", F, 'if (x && blankAt(x, 0, 0)) return false; ', ''),
    ("reference-form arguments (OFFSET/INDEX) not resolved to references", E, '  if (argNodes.some((n) => n.t === "call" && REF_FORMS.has(n.name) && n.name !== "__MISSING")) argNodes = argNodes.map((n) => resolveRefNode(n, ctx));\n', ''),
    ("computed arrays fall back to the \"\" guess", E, 'blank: ctx.isBlank ? value.map((r) => r.map(() => false)) : undefined', 'blank: undefined'),
    ("range mask ignores the grid (\"\" = blank)", E, 'row.map((x, j) => x === "" && ctx.isBlank!(n.v.from.sheet, c0 + j, r0 + i, home)));', 'row.map((x, j) => x === ""));'),
    ("range mask transposed", E, 'row.map((x, j) => x === "" && ctx.isBlank!(n.v.from.sheet, c0 + j, r0 + i, home)));', 'row.map((x, j) => x === "" && ctx.isBlank!(n.v.from.sheet, c0 + i, r0 + j, home)));'),
    ("extension functions see every \"\" as empty (TYPE/ISNONTEXT)", E, 'return b ? (b[i]?.[j] ? null : "") : toExt(x, true);', 'return toExt(x, true);'),
    ("error literals stay text", E, '  if (CONST_ERRORS.has(e)) return err(e as ErrorCode);\n', ''),
    ("error literals case-sensitive", E, 'const e = input.trim().toUpperCase();', 'const e = input.trim();'),
    ("#SPILL! accepted as a constant", E, '"#NUM!", "#N/A"]);', '"#NUM!", "#N/A", "#SPILL!"]);'),
    ("error criterion propagates", F, 'if (isError(raw)) return (v) => isError(v) && v.error === raw.error;', 'if (isError(raw)) return raise(raw);'),
    ("error literal criteria not recognised", F, 'if (CRIT_ERRORS.has(tok) && (op === "" || op === "=" || op === "<>")) {', 'if (false) {'),
    ("error cells never match \"<>x\"", F, 'return (v) => (isError(v) ? op === "<>" : inner(v));', 'return (v) => (isError(v) ? false : inner(v));'),
    ("\"=\" also matches empty text", F, 'if (rest === "" && op === "=") return (_v, blank) => blank;', 'if (rest === "" && op === "=") return (v) => v === "";'),
    ("\"<>\" judged by value (formula \"\" not counted)", F, 'if (rest === "" && op === "<>") return (_v, blank) => !blank;', 'if (rest === "" && op === "<>") return (v) => v !== "";'),
    ("wildcards match numbers", F, 'typeof v === "string" && !blank && re.test(v)', '!blank && re.test(String(v))'),
    ("wildcards match empty cells", F, 'typeof v === "string" && !blank && re.test(v)', 'typeof v === "string" && re.test(v)'),
    ("numeric criteria see an empty cell as 0", F, 'typeof v === "string" && v.trim() !== "" ? Number(v) : NaN', 'typeof v === "string" ? Number(v) : NaN'),
    ("\"<>n\" FALSE for text", F, 'if (Number.isNaN(c)) return op === "<>";', 'if (Number.isNaN(c)) return false;'),
    ("*IFS criteria size mismatch ignored", F, 'if (mask && mask.length !== m.length) raise(err("#VALUE!"));', ''),
    ("*IFS target size mismatch ignored", F, 'if (mask.length !== t.length) raise(err("#VALUE!"));', ''),
    ("writer drops constant empty text", X, '(v === "" && !formula && !hasInput)', '(v === "" && !formula)'),
    ("reader drops constant empty text (TT67)", X, 'const keepText = (text: string) => text === "" ? "\'" : textInput(text);', 'const keepText = (text: string) => textInput(text);'),
    ("reader: inlineStr without <is> becomes empty text", X, '      if (!/<is[\\s>/]/.test(inner)) { applyStyle(); continue; }', '      if (false) { applyStyle(); continue; }'),
    ("reader: shared-string index not validated", X, '/^\\s*\\d+\\s*$/.test(v) ? sst[Number(v)] : undefined', 'sst[Number(v)]'),
    ("patcher drops an edited empty-text cell", P, 'if (cell && cell.input !== "" && !cell.formula && v === "") {', 'if (false) {'),
    ("criterion referring to an empty cell read as \"\" (not 0)", F, '&& blankAt(a, 0, 0) && a.blank ? 0 : scalar(a));', '&& false ? 0 : scalar(a));'),
    ("COUNTA counts by value", F, 'a.value.forEach((row, i) => row.forEach((_v, j) => { if (!blankAt(a, i, j)) n++; }));', 'a.value.forEach((row) => row.forEach((v) => { if (v !== "") n++; }));'),
]

RESULTS = pathlib.Path("docs/test-results/tt68-blank.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
for name, path, old, *_ in SELECTED: assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor found {pathlib.Path(path).read_text().count(old)}x"
try:
    for name, path, old, new in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        try:
            p.write_text(text.replace(old, new))
            r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt68-blank.mts"],
                               capture_output=True, text=True, timeout=900, env={**os.environ, "TT68_FAST": "1"})
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
