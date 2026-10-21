#!/usr/bin/env python3
"""TT55 mutation check for the Files models (src/lib/files/model.ts) and WM-08 remembered geometry
(src/lib/windowing/state.ts): each mutant re-introduces one plausible bug; scripts/tt55-files-unit.mts (independent
reference models + random sequences) must FAIL for every mutant. Files and docs/test-results/tt55-files-unit.json are
restored byte-for-byte. Run from the repository root:  python3 scripts/tt55-mutants.py  (MUT=<substring>)
"""
import os, subprocess, sys, pathlib
M, S = "src/lib/files/model.ts", "src/lib/windowing/state.ts"
MUTANTS = [
    ("Shift-range excludes the clicked row", M, "order.slice(Math.min(a, b), Math.max(a, b) + 1)", "order.slice(Math.min(a, b), Math.max(a, b))", "FM-15"),
    ("Ctrl+Shift replaces instead of adding the range", M, "const paths = mods.ctrl ? [...new Set([...s.paths, ...range])] : range;", "const paths = range;", "FM-15"),
    ("Ctrl-click never deselects", M, "paths: has ? s.paths.filter((p) => p !== path) : [...s.paths, path]", "paths: [...new Set([...s.paths, path])]", "FM-15"),
    ("Ctrl+arrow changes the selection", M, "if (mods.ctrl && !mods.shift) return { ...s, focus: to };", "", "FM-15"),
    ("navigation keeps the forward stack", M, "cur: to, fwd: [] }", "cur: to, fwd: h.fwd }", "SH-09"),
    ("navigating to the current folder adds a history entry", M, "(to === h.cur ? h :", "(false ? h :", "SH-09"),
    ("history cap drops the newest entry", M, "back: [...h.back, h.cur].slice(-50)", "back: [...h.back, h.cur].slice(0, 50)", "SH-09"),
    ("copies of copies grow 'copy copy'", M, '.replace(/ copy(?: \\d+)?$/, "")', '.replace(/$^/, "")', "conflict-free"),
    ("first copy is named 'copy 1'", M, 'copy${n === 1 ? "" : ` ${n}`}${ext}', 'copy ${n}${ext}', "conflict-free"),
    ("names with a slash accepted", M, "if (/[/\\\\\\u0000]/.test(name))", "if (/[\\u0000]/.test(name))", "conflict-free"),
    ("type-to-search matches ANY word", M, "return words.every((w) => hay.includes(w));", "return words.some((w) => hay.includes(w));", "FM-06"),
    ("type-to-search not accent-folded", M, 'const fold = (s: string) => s.normalize("NFD").replace(/\\p{M}/gu, "").toLowerCase();', "const fold = (s: string) => s.toLowerCase();", "FM-06"),
    ("descending sort puts files before folders", M, 'if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;', 'if ((a.kind === "dir") !== (b.kind === "dir")) return (a.kind === "dir" ? -1 : 1) * (desc ? -1 : 1);', "FM-01 sort"),
    ("name sort not numeric-aware", M, "{ numeric: true, sensitivity: \"base\" }", "{ sensitivity: \"base\" }", "FM-01 sort"),
    ("parent of a top-level path is empty", M, 'p.slice(0, p.lastIndexOf("/")) || "/")', 'p.slice(0, p.lastIndexOf("/")))', "FM-01 paths"),
    ("WM-08 remembers the maximized rect", S, "const r = w.maximized && w.restore ? w.restore :", "const r = false ? w.restore :", "WM-08"),
    ("WM-08 stacks a second window exactly", S, "while (remembered && state.windows.some", "while (false && state.windows.some", "WM-08"),
    ("WM-08 overrides an explicit rect", S, "const remembered = cmd.rect ? undefined :", "const remembered =", "WM-08"),
    ("WM-08 memory unbounded", S, "keys.length > MAX_GEOMETRY ?", "false ?", "WM-08"),
]
RESULTS = pathlib.Path("docs/test-results/tt55-files-unit.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
for name, path, old, new, _ in SELECTED:
    n = pathlib.Path(path).read_text().count(old); assert n == 1, f"anchor for '{name}' found {n} times"
try:
    for name, path, old, new, only in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        try:
            p.write_text(text.replace(old, new))
            try:
                r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt55-files-unit.mts"],
                                   env={**os.environ, "ONLY": only}, capture_output=True, text=True, timeout=600)
                out = r.stdout + r.stderr; dead = "FAILED:" in out or r.returncode != 0 or " 0 failed" not in out and "failed" in out
            except subprocess.TimeoutExpired:
                out = "timeout"; dead = True
            failed = [l.strip()[2:70] for l in out.splitlines() if l.strip().startswith("✗")]
            print(f"{'KILLED ' if dead else 'SURVIVED'} {name}  ← {', '.join(failed) or out[-200:]}", flush=True)
            killed += dead
        finally:
            p.write_bytes(orig)
            assert p.read_bytes() == orig, f"{path} not restored"
finally:
    if saved is not None: RESULTS.write_bytes(saved)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
