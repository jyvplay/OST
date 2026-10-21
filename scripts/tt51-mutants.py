#!/usr/bin/env python3
"""TT51 mutation check for the lossless PowerPoint engine: each mutant re-introduces one plausible bug in the reader /
text engine / slide operations / writer / undo / colour maths; scripts/tt51-slides.mts (python-pptx + validator oracles)
must FAIL for every mutant. Files are restored byte-for-byte afterwards (verified), and so is
docs/test-results/tt51-slides.json.  Run from the repository root:  python3 scripts/tt51-mutants.py  (MUT=<substring>)
Equivalent mutants found and replaced (documented in docs/DESIGN-TT51.md): restore() never shrinks `dirty`, so dropping
its re-add is a no-op; writePptxDoc's early "unedited → original bytes" return is backed by the later `!changed` check;
pml's part-count guard equals zipkit's MAX_ENTRIES (20,000), so zipkit always refuses first. The two-spellings repair has
two independent layers (the claim rule in canonicalNames and realKey for slide paths), so its mutant removes both.
"""
import os, subprocess, sys, pathlib
PML, VIEW = "src/lib/office/pml.ts", "src/lib/office/pmlview.ts"
MUTANTS = [
    ("absolute relationship targets resolved relative to the part", PML,
     'if (target.startsWith("/")) return target.slice(1);', "", "reader vs python-pptx"),
    ("part names not canonicalised (an edited mixed-case deck writes the slide twice)", PML,
     "  canonicalNames(zip, order);\n", "", "reader vs python-pptx"),
    ("two spellings of one part: neither the claim rule nor the real-key slide lookup (slide written twice)", PML,
     [("const lw = want.toLowerCase(); if (claimed.has(lw)) return; claimed.add(lw);", "const lw = want.toLowerCase();"),
      ("const path = realKey(zip, resolveTarget(presPath, r.target));", "const path = resolveTarget(presPath, r.target);")], None, "reader vs python-pptx"),
    ("typed text no longer slides to a run end (joins the wrong run's formatting)", PML,
     "if (ends.has(k) && k !== pre) { suf += pre - k; pre = k; }", "", "setParaText unit cases"),
    ("range formatting runs to the end of the last paragraph instead of the selection end", PML,
     "e = whole || i < b.p ? len : Math.min(len, b.o);", "e = len;", "range formatting"),
    ("duplicated chart shares its embedded workbook / style parts (nested parts not deep-copied)", PML,
     "const nt = SHARED_TYPES.has(typ) ? t : deepCopyPart(d, t, seen);", "const nt = t;", "duplicated slide with a chart"),
    ("deleting a slide leaves its notes slide behind", PML,
     "if (notes && partExists(d, notes)) { removePart(d, notes); d.notes.delete(notes); }", "", "slide operations"),
    ("hide writes show=\"1\" (slide stays visible)", PML,
     'setAttr(s.xml.root, "show", hidden ? "0" : undefined);', 'setAttr(s.xml.root, "show", hidden ? "1" : undefined);', "slide operations"),
    ("new slide id reuses the current maximum (duplicate sldId)", PML,
     "...d.slides.map((s) => Number(s.sldId) || 0)) + 1); }", "...d.slides.map((s) => Number(s.sldId) || 0))); }", "slide operations"),
    ("removed parts keep their [Content_Types] Override", PML,
     "d.cache.delete(path); dropCtOverride(d, path);", "d.cache.delete(path);", "slide operations"),
    ("media no longer garbage-collected after deleting a slide", PML,
     "holder.selfClose = holder.kids.length === 0; }\n  });\n  gcMedia(d);", "holder.selfClose = holder.kids.length === 0; }\n  });", "duplicated slide with a chart"),
    ("bring-to-front lands one below the top", PML,
     "hit.parent.kids.splice(to > at ? ti + 1 : ti, 0, hit.el);", "hit.parent.kids.splice(ti, 0, hit.el);", "shape operations"),
    ("undo keeps the edited part map (added pictures survive undo)", PML,
     "  d.zip = new Map(s.zip); d.order", "  d.order", "undo is exact"),
    ("dirty-but-unchanged parts re-serialised (untouched parts lose their bytes)", PML,
     "if (same) { out.set(p, orig); return; }", "", "text edits keep formatting|undo is exact"),
    ("rels Default not added for old decks that list rels parts one by one", PML,
     'if (ext === "rels") { ensureCt(d, "Default", "rels", "application/vnd.openxmlformats-package.relationships+xml"); defaults.add("rels"); }', 'if (ext === "rels") { /* forgotten */ }', "slide operations|shape operations|speaker notes"),
    ("64 MiB size guard removed", PML,
     'if (bytes.length > MAX_PPTX) throw new Error("pptx: file exceeds the 64 MiB guard");', "", "hostile input"),
    ("lumMod treated as an offset (lumOff)", VIEW,
     "[r, g, b] = hslToRgb(h, s, Math.min(1, l * v)); break; }", "[r, g, b] = hslToRgb(h, s, Math.min(1, l + v)); break; }", "colour maths"),
    ("edits that cancel out re-zip instead of returning the original bytes", PML,
     "  if (!changed && d.orig) return d.orig;", "", "undo is exact"),
]
RESULTS = pathlib.Path("docs/test-results/tt51-slides.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
# `old` is one anchor, or a list of (anchor, replacement) pairs for a mutant that must break two redundant protections at once
edits = lambda old, new: old if isinstance(old, list) else [(old, new)]
for name, path, old, new, _ in SELECTED:
    for o, _n in edits(old, new): assert pathlib.Path(path).read_text().count(o) == 1, f"{name}: anchor not unique"
try:
    for name, path, old, new, only in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        mutated = text
        for o, n in edits(old, new): assert mutated.count(o) == 1, f"{name}: anchor found {mutated.count(o)}×"; mutated = mutated.replace(o, n)
        try:
            p.write_text(mutated)
            r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt51-slides.mts"],
                               env={**os.environ, "ONLY": only}, capture_output=True, text=True, timeout=1200)
            out = r.stdout + r.stderr
            dead = "FAILED:" in out or r.returncode != 0
            failed = [l.strip()[2:70] for l in out.splitlines() if l.strip().startswith("✗")]
            print(f"{'KILLED ' if dead else 'SURVIVED'} {name}  ← {', '.join(failed) or out[-300:]}", flush=True)
            killed += dead
        finally:
            p.write_bytes(orig)
            assert p.read_bytes() == orig, f"{path} not restored"
finally:
    if saved is not None: RESULTS.write_bytes(saved)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
