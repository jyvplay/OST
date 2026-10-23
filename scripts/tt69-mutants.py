#!/usr/bin/env python3
"""TT69 mutation check: each mutant re-introduces one plausible bug in the FF-15 lifecycle core (src/lib/doc-lifecycle.ts)
or in this tier's Spreadsheet fixes (engine.ts sum_range resize / range cap, sheetops.ts Paste Values empty text); the
named suite must FAIL for every mutant. L = scripts/tt69-lifecycle.mts (needs the server on BASE for its server tests),
M = scripts/tt69-sheet-misc.mts. Files are restored afterwards (also on Ctrl+C).
Run from the repository root:  BASE=http://localhost:3999 python3 scripts/tt69-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

D, E, S = "src/lib/doc-lifecycle.ts", "src/lib/formula/engine.ts", "src/lib/formula/sheetops.ts"
MUTANTS = [
    ("force close still asks", "L", D, '  if (cmd.force) return { closeNow: named, ask: [] };\n', ''),
    ("close of an unknown window id closes it anyway", "L", D, '(windowIds.includes(cmd.id) ? [cmd.id] : [])', '[cmd.id]'),
    ("dirty windows close without asking", "L", D, 'for (const id of named) (dirty(id) ? ask : closeNow).push(id);', 'for (const id of named) closeNow.push(id);'),
    ("ask queue keeps duplicates", "L", D, 'for (const id of more) if (!out.includes(id)) out.push(id);', 'for (const id of more) out.push(id);'),
    ("a throwing guard counts as clean", "L", D, 'try { return g.dirty(); } catch { return true; }', 'try { return g.dirty(); } catch { return false; }'),
    ("unregister removes a newer guard of the same window", "L", D, 'if (guards.get(g.winId) === g) guards.delete(g.winId);', 'guards.delete(g.winId);'),
    ("readable draft key (TT68-style / → _ collides)", "L", D, '  return encodeURIComponent(docPath);', '  return docPath.replace(/\\//g, "_");'),
    ("private documents draft to /System/Recovery", "L", D, 'return docPath && isPrivatePath(docPath) ? `${PRIVATE_ROOT}/.Recovery` : "/System/Recovery";', 'return "/System/Recovery";'),
    ("untitled draft id not validated", "L", D, '  if (!docPath && !/^[A-Za-z0-9-]{4,64}$/.test(untitledId)) throw new Error("an untitled draft needs an id");\n', ''),
    ("draft of another kind accepted", "L", D, 'if (r.v !== 1 || r.kind !== kind) return null;', 'if (r.v !== 1) return null;'),
    ("bad baseSha accepted", "L", D, 'if (r.baseSha !== null && (typeof r.baseSha !== "string" || !/^[0-9a-f]{64}$/.test(r.baseSha))) return null;', ''),
    ("draft for another path offered", "L", D, 'if (!d || d.path !== docPath) return { offer: false };', 'if (!d) return { offer: false };'),
    ("staleness never reported", "L", D, 'stale: d.baseSha !== null && fileSha !== null && d.baseSha !== fileSha', 'stale: false'),
    ("no max wait (a steady typist never gets a draft)", "L", D, 'const wait = Math.max(0, Math.min(this.idleMs, this.firstAt + this.maxWaitMs - t));', 'const wait = this.idleMs;'),
    ("clear does not cancel the in-flight draft (it is written after Save)", "L", D, 'if (!d || epoch !== this.epoch) return;', 'if (!d) return;'),
    ("oversized drafts written", "L", D, 'if (d.text.length > MAX_DRAFT_CHARS) {', 'if (false) {'),
    ("sum_range paired by flat index (TT68)", "M", E, '  if ((name === "SUMIF" || name === "AVERAGEIF") && argNodes.length === 3) {', '  if (false) {'),
    ("sum_range resized from the wrong corner", "M", E, 'mkRef(sr.from.sheet, S.c0, S.r0, c1, r1)', 'mkRef(sr.from.sheet, S.c0, S.r0 + 1, c1, r1 + 1)'),
    ("range cap back to 1 000 000", "M", E, '> 2_097_152) throw', '> 1_000_000) throw'),
    ("Paste Values of empty text pastes blank (TT68)", "M", S, '      if (out === "" && input !== "" && (v === "" || (v === undefined && !input.startsWith("=")))) out = "\'";\n', ''),
    ("Paste Values pastes a blank source as empty text", "M", S, 'if (out === "" && input !== "" && (v === ""', 'if (out === "" && (v === ""'),
]
SUITE = {"L": "scripts/tt69-lifecycle.mts", "M": "scripts/tt69-sheet-misc.mts"}
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
