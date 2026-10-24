#!/usr/bin/env python3
"""TT70 mutation check: each mutant re-introduces one plausible bug in the sealed-draft core (src/lib/office/draft-seal.ts)
or the draft codec's "sealed" handling (src/lib/doc-lifecycle.ts); scripts/tt70-seal.mts must FAIL for every mutant.
UI wiring (Writer/Spreadsheet makeDraft/restore) is covered by e2e-tt70-seal against the production build and is not
mutated here (each UI mutant would need a rebuild). Files are restored afterwards (also on Ctrl+C).
Run from the repository root:  python3 scripts/tt70-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

D, S = "src/lib/doc-lifecycle.ts", "src/lib/office/draft-seal.ts"
E, F = "src/lib/formula/engine.ts", "src/lib/formula/functions.ts"
MUTANTS = [
    ("a wrong password is reported as damage", "S", S, 'return { ok: false, reason: "password", message: "the password does not open this draft" };', 'return { ok: false, reason: "corrupt", message: "x" };'),
    ("a plaintext payload is accepted as a sealed draft", "S", S, 'if (!isEncryptedOffice(buf)) return { ok: false, reason: "corrupt", message: "the draft is not an encrypted container" };', 'if (!isEncryptedOffice(buf)) return { ok: true, bytes: buf };'),
    ("damage is reported as a wrong password", "S", S, 'return { ok: false, reason: "corrupt", message: (e as Error).message };', 'return { ok: false, reason: "password", message: (e as Error).message };'),
    ("the draft's password overrides the file's current one", "S", S, '  if (prev?.password) return prev;\n', ''),
    ("a plain draft drops the protection", "S", S, '  return prev;\n}', '  return null;\n}'),
    ("an adopted protection keeps removed=true", "S", S, 'password: draftPassword, key: null, removed: false }', 'password: draftPassword, key: null }'),
    ("the key derivation is not cached", "S", S, '  k.key ??= deriveAgileKey(k.password);\n  return toB64(encryptOffice(plain, k.password, { key: k.key }));', '  return toB64(encryptOffice(plain, k.password, {}));'),
    ("unpack accepts a ZIP without the draft entry", "S", S, '  if (t === null) throw new Error(`the draft has no ${DRAFT_ENTRY}`);\n  return t;', '  return t ?? "";'),
    ("the codec refuses sealed drafts", "S", D, ' && r.encoding !== "sealed") return null;', ') return null;'),
    ("the codec does not validate a sealed payload", "S", D, '(r.encoding === "base64" || r.encoding === "sealed") && ', 'r.encoding === "base64" && '),
    ("sparse rows ignore spill child rows", "R", E, 'if (cell.spill) for (let i = 0; i < cell.spill.rows; i++) rows.add(r + i); else rows.add(r);', 'rows.add(r);'),
    ("whole columns clamped per sheet (TT69 cross-sheet #VALUE!)", "R", E, 'for (const sh of this.sheets.values()) for (const [k, cell] of sh.grid) {', 'for (const sh of [...this.sheets.values()].slice(0, 1)) for (const [k, cell] of sh.grid) {'),
    ("COUNTBLANK ignores the blank tail", "R", F, ' + a.reduce((n, x) => n + tailBlanks(x), 0),', ','),
    ("COUNTIF adds the tail whatever the criterion", "R", F, 'return tail > 0 && crit("", true) ? n + tail : n;', 'return tail > 0 ? n + tail : n;'),
    ("COUNTIFS ignores the blank tail", "R", F, 'return mask.filter(Boolean).length + (tailMatches ? tail : 0);', 'return mask.filter(Boolean).length;'),
    ("COUNTIFS compares shown sizes only", "R", F, 'if (mask && (mask.length !== m.length || f !== full)) raise(err("#VALUE!"));', 'if (mask && mask.length !== m.length) raise(err("#VALUE!"));'),
    ("SUMIFS compares shown sizes only", "R", F, 'if (mask.length !== t.length || full !== fullCells(target)) raise(err("#VALUE!"));', 'if (mask.length !== t.length) raise(err("#VALUE!"));'),
    ("sparse area cap removed (17 columns evaluate)", "R", E, 'if (w * h > MAX_SPARSE_AREA) throw NUM();', ''),
    ("large ranges evaluated densely (TT69: #NUM! at 3 columns)", "R", E, 'const occ = occupied && w * h > 200_000 ? occupied(sheetName) : null;', 'const occ = null as Set<number> | null;'),
]
SUITE = {"S": "scripts/tt70-seal.mts", "R": "scripts/tt70-range.mts"}
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
for name, _, path, old, _n in SELECTED: assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor found {pathlib.Path(path).read_text().count(old)}x"
orig = {p: pathlib.Path(p).read_text() for p in {m[2] for m in SELECTED}}
results = {s: pathlib.Path(f"docs/test-results/{pathlib.Path(f).stem}.json").read_bytes() for s, f in SUITE.items() if pathlib.Path(f"docs/test-results/{pathlib.Path(f).stem}.json").exists()}
killed = 0
try:
    for name, suite, path, old, new in SELECTED:
        pathlib.Path(path).write_text(orig[path].replace(old, new, 1))
        try:
            r = subprocess.run(["node", "--use-system-ca", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", SUITE[suite]],
                               capture_output=True, text=True, timeout=600, env={**os.environ, "BASE": os.environ.get("BASE", "http://localhost:3999")})
            out = r.stdout + r.stderr
        except subprocess.TimeoutExpired:
            out = "✗ timeout"
        finally:
            pathlib.Path(path).write_text(orig[path])
        failed = [l.strip()[2:70] for l in out.splitlines() if l.strip().startswith("✗")]
        crashed = "passed," not in out
        ok = bool(failed) or crashed
        killed += ok
        print(f"{'KILLED' if ok else 'SURVIVED'}  {name}  [{suite}]  {'crash' if crashed and not failed else (failed[0] if failed else '')}", flush=True)
finally:
    for p, t in orig.items(): pathlib.Path(p).write_text(t)
    for s, b in results.items(): pathlib.Path(f"docs/test-results/{pathlib.Path(SUITE[s]).stem}.json").write_bytes(b)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
