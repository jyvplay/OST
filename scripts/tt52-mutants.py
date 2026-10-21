#!/usr/bin/env python3
"""TT52 mutation check for the first-party PDF engine: each mutant re-introduces one plausible bug in the CCITT decoder,
the editor (incremental save, encryption, page/form guards), name serialisation, synthesised appearances, shading
validation or the CID FontMatrix fold; scripts/tt52-pdf.mts (libtiff / PDFium / qpdf / pypdf oracles + unit cases)
must FAIL for every mutant. Files are restored byte-for-byte afterwards (verified), and so is
docs/test-results/tt52-pdf.json.  Run from the repository root:  python3 scripts/tt52-mutants.py  (MUT=<substring>)
Not mutated here (browser-only, covered by scripts/e2e-tt52-pdf.mts and the render differential instead): the canvas
shading-matrix fix in pdfcanvas.ts and the PDF app's modal keyboard scoping.
"""
import os, subprocess, sys, pathlib
CC, ED, OBJ, AP, IN, GL = ("src/lib/pdf/" + f for f in ("pdfccitt.ts", "pdfedit.ts", "pdfobj.ts", "pdfappear.ts", "pdfinterp.ts", "pdfglyph.ts"))
MUTANTS = [
    ("CCITT vertical offsets mirrored (VR/VL swapped)", CC, '(m[1] === "R" ? 1 : -1)', '(m[1] === "R" ? -1 : 1)', "CCITT oracle"),
    ("CCITT black runs lose the extended make-up codes (>1728)", CC, "TB = table([...BLACK, ...EXT])", "TB = table(BLACK)", "CCITT oracle"),
    ("CCITT pass mode stops at b1 instead of b2", CC, 'if (m === "P") { a0 = b2; continue; }', 'if (m === "P") { a0 = b1; continue; }', "CCITT oracle"),
    ("CCITT horizontal mode starts the second run in the same colour", CC, "r2 = r1 < 0 ? -1 : run(b, !white)", "r2 = r1 < 0 ? -1 : run(b, white)", "CCITT oracle"),
    ("CCITT padding ignores the row cap (memory blow-up on absurd /Rows)", CC, "while (out.length < maxRows) out.push", "while (out.length < p.Rows) out.push", "NEG CCITT"),
    ("CCITT filter not wired into image loading", IN, 'if (r.image?.name === "CCITTFaxDecode") {', "if (false) {", "CCITT in a page"),
    ("read-only form fields accept new values", ED, "if (f.flags & 1) return false; // ReadOnly", "", "NEG forms"),
    ("deleting every page allowed", ED, 'if (del.size >= this.pageOrder!.length) throw new Error("a PDF must keep at least one page");', "", "NEG page ops"),
    ("duplicate indices accepted as a page order", ED, "new Set(order).size !== order.length || ", "", "NEG page ops"),
    ("incremental save chains onto a damaged xref", ED, "if (this.doc.recovered || this.doc.startxref < 0 || !this.xrefExact()) return this.saveClean();", "if (this.doc.recovered || this.doc.startxref < 0) return this.saveClean();", "damaged xref"),
    ("incremental trailer without /Prev", ED, '.set("Prev", this.doc.startxref)', "", "incremental save"),
    ("strings in an encrypted file's update written in clear", ED, "if (o instanceof PStr) return new PStr(sec.encryptString(num, gen, o.b), o.hex);", "if (o instanceof PStr) return o;", "encrypted files"),
    ("names UTF-8 encoded on write (GBK font names corrupted)", OBJ, "const b = /[^\\x00-\\xff]/.test(n) ? new TextEncoder().encode(n) : latin1ToBytes(n);", "const b = new TextEncoder().encode(n);", "names round-trip"),
    ("square/circle without colours gets a synthesised appearance", AP, "if (!C.length && !IC.length) return null; if (!C.length) w = 0;", "if (!C.length) w = 0;", "synthesised appearances"),
    ("shading function arity not validated", IN, "if (!fd || dm.length !== want) return null;", "if (!fd) return null;", "NEG shading"),
    ("end of a nested stream unwinds the caller's saved states", IN, "while (this.stack.length > this.floor) this.restore();", "while (this.stack.length) this.restore();", "nested content keeps"),
    ("Q in a nested stream pops below its floor", IN, 'case "Q": if (this.stack.length > this.floor) this.restore(); break;', 'case "Q": this.restore(); break;', "nested content keeps"),
    ("CID-keyed CFF FD matrix scaled ×1000 even with an explicit top FontMatrix", GL, "s = topExplicit ? 1 : 1000", "s = 1000", "CID-keyed CFF"),
    ("embedded-file-only encryption still demands the password", "src/lib/pdf/pdfdoc.ts", 'if (isNum(vNum) && vNum >= 4 && nm("StmF") === "Identity" && nm("StrF") === "Identity") {', "if (false) {", "embedded-file-only"),
]
RESULTS = pathlib.Path("docs/test-results/tt52-pdf.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
for name, path, old, new, _ in SELECTED:
    assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor not unique ({pathlib.Path(path).read_text().count(old)})"
try:
    for name, path, old, new, only in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        try:
            p.write_text(text.replace(old, new))
            try:
                r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt52-pdf.mts"],
                                   env={**os.environ, "ONLY": only}, capture_output=True, text=True, timeout=600)
                out = r.stdout + r.stderr; dead = "FAILED:" in out or r.returncode != 0
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
