#!/usr/bin/env python3
"""TT71 mutation check: each mutant re-introduces one plausible bug in the NC-02 focus-rule engine
(src/lib/focus-rules.ts) or its setting validation (src/lib/settings-validate.ts); scripts/tt71-focus.mts must FAIL for
every mutant. The route / UI wiring (api/alerts, Alerts, ShellDaemons) is covered by e2e-tt71-focus against the
production build and is not mutated here (each would need a rebuild). Files are restored afterwards (also on Ctrl+C).
Run from the repository root:  python3 scripts/tt71-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

R, V = "src/lib/focus-rules.ts", "src/lib/settings-validate.ts"
MUTANTS = [
    ("an overnight window belongs to the END day", "F", R, "s.days.includes((day + 6) % 7) && minute < t", "s.days.includes(day) && minute < t"),
    ("the end minute is inclusive", "F", R, "minute >= f && minute < t", "minute >= f && minute <= t"),
    ("disabled rules still hold", "F", R, "rules.filter((r) => r.enabled\n", "rules.filter((r) => true\n"),
    ("the allow list is case-sensitive", "F", R, "r.allowApps.some((a) => a.toLowerCase() === app)", "r.allowApps.some((a) => a === alert.app.trim())"),
    ("only the first active rule is consulted", "F", R, "for (const r of act) {", "for (const r of act.slice(0, 1)) {"),
    ("an unknown priority counts as high", "F", R, 'alert.priority as Priority : "normal";', 'alert.priority as Priority : "high";'),
    ("from = to accepted (zero-length / ambiguous window)", "F", R, "      if (s.from === s.to) return", "      if (false) return"),
    ("nothing breaks through by default", "F", R, 'allowApps: [], allowPriorities: ["high"] };', 'allowApps: [], allowPriorities: [] };'),
    ("the time zone is ignored (always UTC)", "F", R, 'let zone = timeZone || "UTC";', 'let zone = "UTC";'),
    ("the workspace condition is ignored", "F", R, "(!r.workspaces || r.workspaces.includes(ctx.activeWorkspace))", "true"),
    ("the focus-mode condition is ignored", "F", R, "(r.focusMode === undefined || r.focusMode === ctx.focusMode)", "true"),
    ("duplicate rule ids accepted", "F", R, "if (ids.has(r.id)) return { error: `${at}: duplicate id ${r.id}` }; ", ""),
    ("day 7 accepted", "F", R, "(d as number) > 6)", "(d as number) > 7)"),
    ("an empty workspace list means 'no workspace' (never active)", "F", R, "if (r.workspaces.length) rule.workspaces =", "rule.workspaces ="),
    ("the setting is not validated", "F", V, '  if (key === "alerts.focusRules") { const r = parseRules(value); return "error" in r ? r.error : null; }\n', ""),
    ("unknown time zones are accepted", "F", V, "    try { new Intl.DateTimeFormat(\"en-US\", { timeZone: value }); } catch { return `unknown time zone ${value}`; }\n", ""),
    ("the reason omits the alert's priority", "F", R, " (this alert is ${pr}).`", ".`"),
    ("repair reverted: non-enum priority accepted", "F", R, "|| !(PRIORITIES as readonly string[]).includes(p)) return", ") return"),
    ("repair reverted: non-string app accepted", "F", R, '    if (typeof v !== "string") return null;\n', ""),
]
SUITE = {"F": "scripts/tt71-focus.mts"}
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
