#!/usr/bin/env python3
"""TT65 mutation check for Track Changes in every story (FF-49): each mutant re-introduces one plausible bug in
src/lib/office/{wordedit,wordml,hdrftr,wordspell}.ts; scripts/tt65-writer-stories.mts (lxml oracle docx_stories.py + XSD)
must FAIL for every mutant. Files are restored byte-for-byte afterwards (verified), and so is the results file.
Run from the repository root:  python3 scripts/tt65-writer-mutants.py   (MUT=<substring> for a subset)
"""
import os, subprocess, sys, pathlib

E, W, H, S = "src/lib/office/wordedit.ts", "src/lib/office/wordml.ts", "src/lib/office/hdrftr.ts", "src/lib/office/wordspell.ts"
MUTANTS = [
    ("read: header/footer revision ids not reserved (defect 1)", W, ', ...[...doc.hf.xml.values()].map((h) => h.path)]', ']'),
    ("save: notes not renumbered against other parts (defect 2)", W, 'for (const k of kidsOut) if (k.k === "el") renumberRecords(k);', ''),
    ("save: headers not renumbered against other parts (defect 2)", W, '    renumberRecords(h.xml.root);\n', '\n'),
    ("note view shows struck text (defect 3)", E, 'if (it.rev?.kind === "del") { off += n; continue; }', ''),
    ("header view shows struck text (defect 4)", H, 'if (it.rev?.kind === "del") continue; // struck text', '// struck text'),
    ("note edits never tracked (TT61 plain path)", E, 'if (doc.track?.on || (!notP && hasRevisions(note.blocks as Para[]))) {', 'if (false) {'),
    ("header line edits rebuilt instead of edited in place", H, '!(tracked || hasRev(prev))) continue;', 'true) continue;'),
    ("new header lines not marked inserted", H, 'if (tracked) { const rv = newRev(doc, "ins");', 'if (false) { const rv = newRev(doc, "ins");'),
    ("removed header lines dropped under tracking", H, 'if (!trackOld) continue;', 'continue;'),
    ("tail normalisation off (final mark inserted / deleted)", H, 'if (tracked && st < out.length) {', 'if (false) {'),
    ("join keeps first paragraph's props even for a whole deleted paragraph", E, '{ p.p = nx.p; p.pc = nx.pc; p.pPr = nx.pPr; }', '{ }'),
    ("removed line keeps its field codes", H, 'it.t !== "k" || it.kind !== "fieldcode" || it.rev?.kind === "del" ? [it]', 'true ? [it]'),
    ("Review lists no story changes", E, 'for (const st of stories(doc)) for (const c of mainRevisions(', 'for (const st of [] as Story[]) for (const c of mainRevisions('),
    ("Accept / Reject All skip stories", E, 'const k = resolveAllMain(storyDoc(doc, nb), accept);', 'const k = 0;'),
    ("story spelling fixes untracked", S, 'if (doc.track?.on) {\n    const d = E.storyDoc(doc, nb);', 'if (false) {\n    const d = E.storyDoc(doc, nb);'),
    ("view edits may cut into fields", E, 'for (let k = h.a; k < h.b; k++) if (frozen[k]) return false;', ''),
    ("typed {PAGE} under tracking stays literal text", H, 'if (seg !== "{PAGE}" && seg !== "{NUMPAGES}") { at = insertText(d, at, seg); continue; }', '{ at = insertText(d, at, seg); continue; }'),
    ("alignment change not tracked", H, 'trackParaProps(d, np, before); np.dirty = true; }', 'np.dirty = true; }'),
    ("final-mark change not moved to the paragraph before", H, 'if (P && rv && !P.markRev) {', 'if (false) {'),
    ("spelling: struck letters split words again", S, 'if (i.t === "r" && i.rev?.kind === "del") { off += n; continue; }', 'if (i.t === "r" && i.rev?.kind === "del") { for (let k = 0; k < n; k++) at.push(off + k); s += "\\u0000".repeat(n); off += n; continue; }'),
]

RESULTS = pathlib.Path("docs/test-results/tt65-writer-stories.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
for name, path, old, *_ in SELECTED: assert pathlib.Path(path).read_text().count(old) == 1, f"{name}: anchor found {pathlib.Path(path).read_text().count(old)}x"
try:
    for name, path, old, new in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        try:
            p.write_text(text.replace(old, new))
            r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt65-writer-stories.mts"],
                               capture_output=True, text=True, timeout=900)
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
