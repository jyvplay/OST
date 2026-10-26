#!/usr/bin/env python3
"""TT49 mutation check for Writer header/footer editing: each mutant re-introduces one plausible bug in
src/lib/office/hdrftr.ts or wordml.ts; scripts/tt49-writer.mts (python-docx oracle) must FAIL for every mutant.
Files are restored byte-for-byte afterwards (verified), and so is docs/test-results/tt49-writer.json.
Run from the repository root:  python3 scripts/tt49-writer-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

H, W = "src/lib/office/hdrftr.ts", "src/lib/office/wordml.ts"
MUTANTS = [
    ("PAGE field written with the wrong instruction", H, '`<w:instrText xml:space="preserve"> ${f} </w:instrText>`', '`<w:instrText xml:space="preserve"> ${f}X </w:instrText>`', "edit the existing|add a header"),
    ("alignment never written (jc dropped)", H, 'put(pPr, ORDER, "w:jc", align === "left" ? null : el("w:jc", { "w:val": align }));', 'put(pPr, ORDER, "w:jc", null);', "edit the existing|add a header"),
    ("r: namespace not declared when the document lacks it", H, 'if (rid && !attr(doc.docXml.root, "xmlns:r") && !(doc.finalSect && attr(doc.finalSect, "xmlns:r"))) setAttr(doc.docXml.root, "xmlns:r", R_NS);', '', "add a header"),
    ("edited paragraphs forced onto the Header style (styles.xml churn)", H, "  if (!old) { const style =", "  if (true) { const style =", "edit the existing"),
    ("positional tabs replaced by plain tabs", H, 'runXml(rPr, ptabs[tabN++] ?? "<w:tab/>")', 'runXml(rPr, "<w:tab/>")', "three-column"),
    ("invalid XML characters not stripped", H, '.replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/g, "")', '', "hostile"),
    ("other fields (DATE/STYLEREF…) no longer lock their line", H, 'else locked ||= `field ${field || "?"}`; }', '}', "other fields"),
    ("titlePg not written", H, 'put(s, SECT_ORDER, "w:titlePg", on ? el("w:titlePg") : null);', '', "different first"),
    ("styles Override only added on the save that created styles.xml", W, 'if (!doc.zip.has(doc.stylesPath!)) { ensureContentType(', 'if (false) { ensureContentType(', "add a header"),
    ("line cap removed", H, ".slice(0, MAX_LINES)", "", "hostile"),
    ("final sectPr mutated in place (undo cannot restore references)", H, 'const s: XEl = old ? { ...old, kids: old.kids.slice() } : el("w:sectPr");', 'const s: XEl = old ?? el("w:sectPr");', "undo"),
    ("a header created then undone is not written (dangling relationship)", W, "const blocks = doc.parts.get(rid) ?? (doc.hf.created.has(rid) ?", "const blocks = doc.parts.get(rid) ?? (false ?", "undo"),
]

RESULTS = pathlib.Path("docs/test-results/tt49-writer.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
# anchors are checked up front, and the results file is restored even if a run aborts
for name, path, old, *_ in SELECTED: assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor not unique"
try:
    for name, path, old, new, only in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        assert text.count(old) == 1, f"{name}: anchor found {text.count(old)}×"
        try:
            p.write_text(text.replace(old, new))
            r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt49-writer.mts"],
                               env={**os.environ, "ONLY": only}, capture_output=True, text=True, timeout=900)
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
