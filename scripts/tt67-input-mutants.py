#!/usr/bin/env python3
"""TT67 mutation check for input handling: IN-01 wheel normalisation, IN-02 "Learn my mouse", IN-03 layout-aware
shortcuts, SH-06 hot corner. Each mutant re-introduces one plausible bug in src/lib/{input,shortcuts,settings-validate}.ts;
scripts/tt67-input.mts + scripts/tt66-input.mts must FAIL for every mutant. Files and results are restored afterwards.
Run from the repository root:  python3 scripts/tt67-input-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

I, S, V, H = "src/lib/input.ts", "src/lib/shortcuts.ts", "src/lib/settings-validate.ts", "src/lib/hot-corner.ts"
MUTANTS = [
    # IN-01 wheel
    ("wheel: line = 1 px (deltaMode ignored)", I, "export const PX_PER_LINE = 100 / 3;", "export const PX_PER_LINE = 1;"),
    ("wheel: deltas read before deltaMode", I,
     "  const mode = e.deltaMode; // read before the deltas (see above)\n  const f = mode === 1 ? PX_PER_LINE : mode === 2 ? Math.max(1, pageHeight) : 1;\n  return { dx: e.deltaX * f, dy: e.deltaY * f };",
     "  const dx = e.deltaX, dy = e.deltaY;\n  const mode = e.deltaMode;\n  const f = mode === 1 ? PX_PER_LINE : mode === 2 ? Math.max(1, pageHeight) : 1;\n  return { dx: dx * f, dy: dy * f };"),
    ("wheel: page mode = a fixed 800 px", I, "mode === 2 ? Math.max(1, pageHeight) : 1;", "mode === 2 ? 800 : 1;"),
    # IN-02 config / learning / guard
    ("learn: main button 0 learnable", I, "  if (button === 0) return { ok: false,", "  if (button === -99) return { ok: false,"),
    ("learn: secondary button 2 learnable", I, "  if (button === 2) return { ok: false,", "  if (button === -98) return { ok: false,"),
    ("learn: no swap (Back may equal Forward)", I, "  if (cfg[other] === button && cfg[which] !== button) { next[other] = cfg[which]; swapped = true; }\n", ""),
    ("guard: browser 3/4 not guarded once other buttons are learned", I, "[...new Set([3, 4, cfg.back, cfg.forward])]", "[...new Set([cfg.back, cfg.forward])]"),
    ("config: Back = Forward pair accepted", I, "  if (back === forward) return { ...DEFAULT_MOUSE };\n", ""),
    ("config: client accepts a leading zero (\\d{1,2})", I, r"return /^(?:1|[3-9]|[12][0-9]|3[01])$/.test(v) && LEARNABLE", r"return /^\d{1,2}$/.test(v) && LEARNABLE"),
    ("server: validator accepts a leading zero (\\d{1,2})", V, r'!/^(?:1|[3-9]|[12][0-9]|3[01])$/.test(value)', r'!/^\d{1,2}$/.test(value)'),
    ("capture: no trailing swallow (context menu / click after the learning press)", I,
     "    startTrail(); // even a refused press", "    // even a refused press"),
    ("capture: Escape does not cancel", I, '    if (e.key === "Escape") { finish(); onCancel(); }', '    if (e.key === "Esc") { finish(); onCancel(); }'),
    ("capture: pointerdown+mousedown of one press counted twice", I,
     '    if (e.type === "mousedown" && lastDown === me.button) { lastDown = -1; return; }\n', ''),
    # IN-03 matcher / labels / learner
    ("match: code OR key (TT66 matcher)", S, "    if (e.code) return e.code === codeOfToken(key);\n    return e.key.toUpperCase() === key.toUpperCase();",
     "    return e.code === codeOfToken(key) || e.key.toUpperCase() === key.toUpperCase();"),
    ("match: produced character preferred over the physical key", S, "    if (e.code) return e.code === codeOfToken(key);\n", "    if (e.key && e.key.length === 1) return e.key.toUpperCase() === key.toUpperCase();\n    if (e.code) return e.code === codeOfToken(key);\n"),
    ("label: '+' not spelled Plus", S, 'parts[parts.length - 1] = ch === "+" ? "Plus" : ch.toUpperCase();', 'parts[parts.length - 1] = ch.toUpperCase();'),
    ("label: dead / multi-char values shown", S, "  if (!ch || [...ch].length !== 1 || /\\s/.test(ch)) return chord;", "  if (!ch) return chord;"),
    ("learner: learns in secret fields", S, "  if (secret || e.ctrlKey", "  if (e.ctrlKey"),
    ("learner: learns shifted symbols", S, "  if (e.shiftKey && !cased) return null; // a shifted symbol", "  // a shifted symbol"),
    ("learner: learns while modifiers are held", S, "  if (secret || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return null;", "  if (secret || e.isComposing) return null;"),
    # SH-06 hot corner
    ("hot corner: fires on every move inside", H, "    const fire = now && !inside;", "    const fire = now;"),
    ("hot corner: never re-arms after leaving", H, "    inside = now;", "    inside = inside || now;"),
    ("hot corner: zone edge inclusive (x = 6 fires)", H, "x < zone.w && y < zone.h", "x <= zone.w && y < zone.h"),
    ("layout: stale key typing the same character not evicted", S, "  for (const [c, v] of table) if (c !== code && v === ch) { table.delete(c); changed = true; }\n", ""),
]

SUITES = ["scripts/tt67-input.mts", "scripts/tt66-input.mts"]
RESULTS = [pathlib.Path(f"docs/test-results/{pathlib.Path(s).stem}.json") for s in SUITES]
saved = {r: r.read_bytes() for r in RESULTS if r.exists()}
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
for name, path, old, *_ in SELECTED: assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor found {pathlib.Path(path).read_text().count(old)}x"
try:
    for name, path, old, new in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        try:
            p.write_text(text.replace(old, new))
            failed, dead = [], False
            for s in SUITES:
                r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", s], capture_output=True, text=True, timeout=300)
                out = r.stdout + r.stderr
                if "FAILED:" in out or r.returncode != 0:
                    dead = True
                    failed += [l.strip()[2:60] for l in out.splitlines() if l.strip().startswith("✗")] or [out[-200:]]
            print(f"{'KILLED ' if dead else 'SURVIVED'} {name}  ← {len(failed)} test(s): {' | '.join(failed)}", flush=True)
            killed += dead
        finally:
            p.write_bytes(orig)
            assert p.read_bytes() == orig, f"{path} not restored"
finally:
    for r, b in saved.items(): r.write_bytes(b)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
