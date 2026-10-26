"""TT78 second-order adversary: plausible wrong implementations of the outline / calculated-column models. Each mutant
is applied to the source, the named tt78-sheet tests run (TT78_ONLY), and the mutant must be KILLED (a test fails).
Run: /home/user/tools/venv/bin/python scripts/tt78-mutants.py   (restores every file afterwards)"""
import subprocess, sys
R = "/home/user/OST/"
M = [
  ("expand shows nested collapsed groups", "src/lib/formula/sheetoutline.ts", "&& K.has(n.summary));", "&& false);", "M1"),
  ("expand shows AutoFilter rows", "src/lib/formula/sheetoutline.ts", 'if (s.hiddenRows.get(i) === "manual") s.hiddenRows.delete(i); } else', 's.hiddenRows.delete(i); } else', "M1,N"),
  ("inserted lines take the MAX neighbouring level", "src/lib/formula/sheetoutline.ts", "Math.min(m.get(at - 1) ?? 0, m.get(at) ?? 0)", "Math.max(m.get(at - 1) ?? 0, m.get(at) ?? 0)", "N"),
  ("group allows an 8th level", "src/lib/formula/sheetoutline.ts", "if (levelOf(s, a, i) >= MAX_OUTLINE) return", "if (levelOf(s, a, i) > MAX_OUTLINE) return", "N"),
  ("summary placed at the group's first line", "src/lib/formula/sheetoutline.ts", "const summary = aft ? prev + 1 : start - 1;", "const summary = aft ? start - 1 : prev + 1;", "M1,O3"),
  ("Subtotal compares keys case-sensitively", "src/lib/formula/sheetoutline.ts", "g.k.toLowerCase() === k.toLowerCase()", "g.k === k", "M2"),
  ("grand total uses SUM (counts nested subtotals)", "src/lib/formula/sheetoutline.ts", "s.setCell(c, grand, `=SUBTOTAL(${fn},", "s.setCell(c, grand, `=SUM(${fn},", "M2"),
  ("calc anchored at the typed row", "src/lib/formula/sheettablecalc.ts", "[k]: shiftFormula(input, 0, fb - row).slice(1)", "[k]: input.slice(1)", "M3"),
  ("constant in a calc column drops calc", "src/lib/formula/sheettablecalc.ts", 'if (input !== "") return { changed: grown, note: `exception', 'if (input !== "") return delete t.calc[k], { changed: grown, note: `exception', "M3"),
  ("grow below ignores totals row", "src/lib/formula/sheettablecalc.ts", "if (u.sheet !== sheet || u.totalsRows || row !== u.r1 + 1", "if (u.sheet !== sheet || row !== u.r1 + 1", "N"),
  ("structural edits do not re-anchor calc", "src/lib/formula/sheetops.ts", "  adjustCalcForStructure(wb, sheetName, axis, at, count, anchors);", "  void anchors;", "M3,N"),
  ("reader ignores collapsed", "src/lib/formula/xlsx.ts", 'if ((ra.collapsed === "1" || ra.collapsed === "true") && rowCursor < 1048576)', "if (false)", "O1,O3"),
  ("writer omits row outlineLevel", "src/lib/formula/xlsx.ts", '${sheet.rowLevels.get(r) ? ` outlineLevel="${sheet.rowLevels.get(r)}"` : ""}', "", "R1"),
  ("patcher ignores calc changes", "src/lib/formula/xlsx-patch.ts", "t.filter ?? null, t.calc ?? null])", "t.filter ?? null])", "R2"),
  ("patcher never writes row outline", "src/lib/formula/xlsx-patch.ts", 'if (wasLvl !== isLvl) { setAttr(r, "outlineLevel", isLvl ? String(isLvl) : undefined); rowOutlineChanged = true; }', "", "R2,O3"),
  ("JSON drops the outline", "src/lib/formula/workbook-json.ts", "pairs(ol.rows, 1048576, sheet.rowLevels);", "", "R3"),
  ("JSON accepts level 8", "src/lib/formula/workbook-json.ts", "p[1] >= 1 && p[1] <= 7) m.set", "p[1] >= 1 && p[1] <= 8) m.set", "N"),
  # FF-08 / FF-31 PSD (suite oracle-psd, psd-tools' compositor as the oracle)
  ("clipped layers ignored by the compositor", "src/lib/image/doc.ts", "const clips = l.clip ? [] : L.slice(i + 1, j).filter(live);", "const clips: Layer[] = [];", "A/rle,B/groups", "oracle-psd"),
  ("clipped layer painted unclipped", "src/lib/image/doc.ts", "if (l.clip && L.slice(0, i).some((b) => !b.clip)) continue;", "if (false) continue;", "A/rle,B/groups", "oracle-psd"),
  ("clip seeded with a transparent base", "src/lib/image/doc.ts", "sub[3] = a0;", "sub[3] = 0;", "A/rle,B/groups", "oracle-psd"),
  ("group opacity ignored (pass-through)", "src/lib/image/doc.ts", "const o = g.opacity; for", "const o = 1; for", "A/rle,B/groups", "oracle-psd"),
  ("isolated group treated as pass-through", "src/lib/image/doc.ts", 'if (g.blend === "pass-through") {', "if (true) {", "A/rle,B/groups", "oracle-psd"),
  ("hidden group shown", "src/lib/image/doc.ts", "if (!g.visible || g.opacity <= 0) continue;", "if (g.opacity <= 0) continue;", "A/rle,B/groups", "oracle-psd"),
  ("hue and saturation swapped", "src/lib/image/doc.ts", "hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),", "hue: (b, s) => setLum(setSat(b, sat(s)), lum(b)),", "A/rle,B/groups", "oracle-psd"),
  ("Lum weights wrong (Rec.709)", "src/lib/image/doc.ts", "const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];", "const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];", "A/rle,B/groups", "oracle-psd"),
  ("ClipColor drops the low branch", "src/lib/image/doc.ts", "if (n < 0) o[k] = l + (o[k] - l) * l / (l - n);", "", "A/rle,B/groups", "oracle-psd"),
  ("writer omits the clipping byte", "src/lib/image/psd.ts", "li.u8(l.clip ? 1 : 0);", "li.u8(0);", "A/rle", "oracle-psd"),
  ("writer writes pass-through as normal", "src/lib/image/psd.ts", '(group.blend === "pass-through" ? "pass" :', '(group.blend === "pass-through" ? "norm" :', "A/rle", "oracle-psd"),
  ("reader ignores the lsct blend key", "src/lib/image/psd.ts", "const k = r.sectionBlend ?? r.blendKey;", "const k = r.blendKey === \"pass\" ? \"norm\" : r.blendKey;", "B/groups", "oracle-psd"),
  ("vivid light uses the backdrop extremes (colour burn/dodge rules)", "src/lib/image/doc.ts", '"vivid-light": (b, s) => (s <= 0 ? 0 : s >= 1 ? 1 :', '"vivid-light": (b, s) => (b >= 1 ? 1 : b <= 0 ? 0 :', "W3C separable,A/rle,B/groups", "image-engine"),
  ("darker colour picks the lighter pixel", "src/lib/image/doc.ts", '"darker-color": (b, s) => (lum(s) < lum(b)', '"darker-color": (b, s) => (lum(s) > lum(b)', "TT78 non-separable,A/rle", "image-engine"),
  ("linear light without the 2× source", "src/lib/image/doc.ts", '"linear-light": (b, s) => (s > 0.5 ? Math.min(1, b + 2 * s - 1) : Math.max(0, b + 2 * s - 1)),', '"linear-light": (b, s) => (s > 0.5 ? Math.min(1, b + s) : Math.max(0, b + s - 1)),', "A/rle,B/groups", "oracle-psd"),
  ("reader loses nesting", "src/lib/image/psd.ts", "if (stack.length) layer.groups = [...new Set(stack)];", "if (stack.length) layer.groups = [stack[stack.length - 1]];", "B/groups", "oracle-psd"),
]
killed = 0
for name, f, a, b, only, *rest in M:
    suite = rest[0] if rest else "tt78-sheet"
    src = open(R + f).read()
    if a not in src: print(f"!! anchor missing: {name}"); sys.exit(2)
    open(R + f, "w").write(src.replace(a, b, 1))
    try:
        out = subprocess.run(["node", "--import", "./scripts/register-hook.mjs", f"scripts/{suite}.mts"], cwd=R, env={**__import__("os").environ, "TT78_ONLY": only, "HARNESS_ONLY": only}, capture_output=True, text=True, timeout=600).stdout
    finally:
        open(R + f, "w").write(src)
    if not __import__("re").search(r"\d+ passed, \d+ failed", out):
        print(f"INVALID  {name} (suite crashed — fix the mutant)"); continue
    dead = "✗" in out or "FAILED" in out
    killed += dead
    print(("KILLED  " if dead else "SURVIVED") + f" {name} [{only}]")
print(f"{killed}/{len(M)} mutants killed")
