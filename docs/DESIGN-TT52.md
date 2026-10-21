# TT52 — first-party PDF engine + PDF app (FF-03, PR-08 → built)

Before TT52 a PDF was shown with `<embed>`. That never worked here: the app's own CSP has `object-src 'none'`, headless
and many mobile browsers have no PDF viewer, and nothing could be edited. TT52 replaces it with `src/lib/pdf`, a
from-scratch engine (no pdf.js / PDFium / mupdf / poppler code), a PDF app (`src/components/modules/Pdf.tsx`) and a Peek
preview that uses the same renderer.

**Runtime honesty.** Everything below was run in this sandbox: Node 22, tsc, Next 16, headless Chromium 143
(Playwright), and a Python venv with test-only oracles: **pypdfium2 5.14.0** (PDFium, Chrome's engine; BSD-3/Apache-2.0),
**pikepdf 10.17.0** (qpdf), **pypdf 6.21.0** and **Pillow + libtiff** (CCITT encoder). The engine was not checked with
Acrobat, poppler or mupdf (none are available). Firefox and Safari were not tested. No oracle ships in the app.

## A. Formal model

**Document.** `PdfDoc.open(bytes, password?)` takes the bytes and gives back:
- the xref, a map from object number to an entry (free, offset, or in an object stream);
- the trailer and the catalog;
- the page list. Each page is resolved from the page tree with inherited attributes: Resources, MediaBox, CropBox and
  Rotate.

Objects are immutable once parsed. An edit never mutates a `PdfDoc`. `PdfEditor(doc)` collects changed and new objects
and writes them:
- **`save()`** writes an incremental update: `bytes ‖ new objects ‖ xref ‖ trailer(/Prev = old startxref)`.
- **`saveClean()`** fully rewrites every object reachable from the new trailer.

The app re-opens the result as a new `PdfDoc`, so the undo stack is a stack of byte strings.

**Invariants (each is tested):**
- **I1 prefix.** `save(doc).subarray(0, doc.bytes.length)` equals `doc.bytes`, unless the xref is damaged. In that case
  `save` falls back to `saveClean`, rather than chaining onto bad offsets.
- **I2 re-open.** Every output re-opens in our engine and in PDFium and qpdf, with the intended page count, order,
  rotation, annotations and title.
- **I3 encryption.** Edits to an encrypted file stay encrypted under the file's own security handler. Strings are
  written in clear only when the file declares `/StrF /Identity`.
- **I4 names.** Names keep their bytes exactly: parsed names are byte strings, and `nameText()` is used for display only.
- **I5 graphics state.** A content stream (page, form, Type 3 glyph, pattern, appearance) cannot pop the caller's
  graphics state. `Q` and end-of-stream unwinding both stop at the stream's floor.
- **I6 privacy.** `saveClean()` contains no bytes of deleted pages. `save()` keeps them, as incremental updates
  must; the UI says so on the "Clean copy" button.
- **I7 bounded.** Hostile input (garbage, truncation, page-tree loops, absurd /Count, CCITT /Rows of 2^30) ends within
  bounded time and memory, with an Error or a partial result, never a hang.

**Rendering.** `renderPage(doc, page, canvas, {scale, rotate, annotations, deadline})` interprets the content stream
into a Canvas 2D device:
- the CTM, paths, clips, text through embedded glyph outlines, images, shadings types 1–7, and transparency groups with
  blend modes and constant alpha;
- annotation appearance streams, synthesised when a file has none.

`pageChars` and `layout` give text with positions for find, copy and highlighting.

## B. Hypotheses

- **H+1** The engine agrees with PDFium on page count across the corpus. *Confirmed: 951 of 951.*
- **H+2** Text agrees with PDFium (bigram F1 ≥ 0.93 mean). *Confirmed: 0.9394.*
- **H+3** Our saves are read back by PDFium and qpdf with exactly the intended edits. *Confirmed* (see H).
- **H+4** The CCITT decoder is bit-exact against an independent encoder (libtiff). *Confirmed: 27 of 27 strips.*
- **H−1** "Mean pixel similarity 0.95 means rendering is done." *Rejected.* White paper dominates that metric. The strict
  ink metric (0.74) and visual review found real bugs: the CID FontMatrix fold, the shading matrix, missing synthesised
  appearances, and the graphics-state unwinding (§I).
- **H−2** "PDFium is ground truth." *Partly rejected.* PDFium text ignores optional-content visibility, prints raw codes
  for fonts without Unicode data, and cannot open several files that are damaged but recoverable. These are reported as
  oracle-unverifiable, not as passes.
- **H∂** Soft masks, JPX and JBIG2 matter for a minority of real files: scans use JBIG2/JPX, and designed PDFs use soft
  masks. They are disclosed limits, not hidden ones.

## C. Frontier: what this tier does not do

- **Images:** JPEG 2000 (JPX) and JBIG2 images are drawn as a hatched placeholder with a warning (35 and 112 streams in
  the corpus).
- **Transparency:** soft masks set through ExtGState `/SMask` are not applied. Knockout and isolated groups, overprint
  and pattern strokes are approximated.
- **Text:** CID fonts without ToUnicode, and simple fonts whose names imply GBK, can extract differently from PDFium. The
  text layer ignores `/OC` visibility only when asked (`includeHiddenOC`).
- **Signatures:** digital signatures are neither created nor validated.
- **Forms:** fields using composite fonts get NeedAppearances instead of a generated appearance.
- **Unresolved disagreements:**
  - **issue5421:** a black square where PDFium paints nothing; not yet explained.
  - **pr6531_2:** no engine agrees on its Info strings.
  - **Pages-tree-refs:** PDFium counts a page it cannot load.
  - **TrueType_without_cmap:** merge text order differs.
- **Synthesised appearances** are approximations of what PDFium/Acrobat draw: geometry and colour match, but line
  styles and fonts are simplified.

## D. Negative tests (≥ 15 shapes)

The unit suite covers 26 negative or adversarial shapes:
1. wrong password (×4 files);
2. read-only field;
3. unknown field;
4. deleting all pages;
5. a duplicate permutation;
6. an out-of-range permutation;
7. an empty permutation;
8. out-of-range rotate;
9. markup with no rects;
10. ink with no strokes;
11. damaged xref offset (save must rewrite);
12. empty input;
13. a non-PDF;
14. a truncated file;
15. random bytes;
16. a self-referencing page tree with /Count 999,999,999;
17. an 18-input shading function;
18. a square annotation with no colours;
19. a Link annotation (no appearance synthesised);
20. a corrupt CCITT stream;
21. a truncated CCITT stream;
22. CCITT garbage under K = −1, 0 and 1;
23. CCITT Columns/Rows of 2^30;
24. unbalanced `q` in a nested stream;
25. extra `Q` in a nested stream;
26. GBK name bytes.

The e2e suite adds:
- a wrong password in the real dialog;
- Ctrl+Z typed in the Find box;
- **the modal-shortcut failure test:** while the Title dialog owns the keyboard, Ctrl+Z, Ctrl+S, PageDown and Ctrl+Y
  must not undo, save or change page, and the file on disk must stay byte-identical.

## E. Approaches (mechanism-distinct)

1. **Differential vs PDFium text** (bigram F1, 1,071 pages).
2. **Differential vs PDFium renders** (pixel similarity and strict ink agreement, 921 pages, Chromium canvas).
3. **Re-open oracle:** PDFium page count, rotation and text, plus qpdf `check()` and title, plus pypdf annotations and
   fields over 1,161 editor jobs.
4. **Bit-exact codec oracle:** libtiff CCITT G4, G3-1D and G3-2D, plus a structural proof that the code tables are
   prefix-free and their Kraft sums are ≈ 1.
5. **Hand-built PDFs** (`scripts/tt52/mkpdf.ts`) for exact properties: the prefix invariant, page order, form values,
   privacy.
6. **Mutation testing** (§G).
7. **Real-UI e2e in Chromium**, with saved files re-read by PDFium and pypdf.
8. **Visual review** of the worst render pairs, which is how the §I bugs were found.

## F. Artifacts

- **Engine:** `src/lib/pdf/`
  - `pdfobj.ts`, `pdfdoc.ts`, `pdfcrypt.ts`, `pdffilters.ts`;
  - `pdfccitt.ts` (new);
  - `fontdata.ts` (generated: Adobe Core14 AFM metrics under the Adobe AFM licence, quoted in the file; AGL/AGLFN
    BSD-3; CFF standard strings);
  - `pdfglyph.ts`, `pdffont.ts`, `pdfcolor.ts`, `pdfinterp.ts`, `pdfcanvas.ts`, `pdftext.ts`;
  - `pdfappear.ts`, `pdftextfit.ts`, `pdfedit.ts`.
- **UI:** `src/components/modules/Pdf.tsx`, `PdfPreview.tsx`; Peek wiring; open-with and registry entries; the forge row
  (grade A, with the gaps written into the boundary text).
- **Tests:** `scripts/tt52-pdf.mts` (28 tests), `scripts/e2e-tt52-pdf.mts` (8 tests), `scripts/tt52-mutants.py`,
  `scripts/tt52/mkpdf.ts`.
- **Differential tools:** `scripts/tt52-textcmp.mts`, `scripts/tt52-render.mts` with `scripts/tt52/render-entry.ts`, and
  `scripts/tt52-editcmp.mts`.
- **Oracles (test-only):** `scripts/oracle/pdf_probe.py`, `pdf_editcheck.py`, `ccitt_encode.py`.
- **Corpus:** `scripts/corpus/fetch-pdf.py` (pdf.js test PDFs, pinned commit, Apache-2.0).
- **Ledger:** `src/db/seed-data/features-tt52.ts`.

## G. Second-order adversary: mutation testing

`scripts/tt52-mutants.py` has 19 mutants. **All 19 are killed** (16 on the first run, plus 3 added with the §I repairs).
Sources were restored byte-for-byte after each mutant.

The mutants cover:
- **CCITT** (5): mirrored vertical offsets, missing black extended codes, pass mode to b1, horizontal colour,
  uncapped padding;
- **wiring:** the CCITT decoder not wired into image loading;
- **editor:** the read-only guard, the delete-all guard, the duplicate-permutation guard, the damaged-xref fallback,
  /Prev, string encryption;
- **name encoding;**
- **appearances and shading:** synthesised-appearance colour gating, shading arity;
- **the CID FontMatrix fold;**
- **graphics state:** both halves of the unwinding fix;
- **encryption:** embedded-file-only (/EFF) documents demanding the password again.

The uncapped-padding mutant is killed by an out-of-memory crash rather than an assertion. That is weaker evidence: it
proves the cap matters, but not which assertion would catch a smaller overrun.

Not mutated, because they are browser-only: the canvas shading-matrix fix and the app's keyboard scoping. Those are
covered by the render differential and the e2e modal test.

## H. External verification

| Check | Result |
|---|---|
| Corpus open (972 pdf.js test files) | 966 open, 5 need a password (all open with their manifest passwords), 1 broken in every engine |
| Page count vs PDFium/pypdf | 954 / 954 |
| Text vs PDFium (bigram F1, 1,078 pages) | mean **0.9398**; 979 ≥ 0.95; 1,006 ≥ 0.80 |
| Renders vs PDFium (951 reference pages, page 1, scale 1) | 947 rendered (2 timeouts at 30 s, 2 that only PDFium opened before the §I-9 repair); mean pixel similarity **0.9565**; mean ink agreement **0.7446** (strict any-channel metric); ink ≥ 0.9 on 296, ≥ 0.8 on 530, ≥ 0.5 on 805 |
| Editor outputs re-opened by PDFium + qpdf + pypdf | 1,163 jobs over the corpus (917 incremental saves, 51 clean-rewrite fallbacks, page ops, merges, extracts): **1,153 pass**, 6 unverifiable (the oracles cannot open the original), 4 disagree — Pages-tree-refs (PDFium counts a page it then cannot load) and its merge-12, pr6531_2 (crafted Info strings neither engine decrypts), and merge-18, whose second page (TrueType_without_cmap.pdf) PDFium extracts differently from the original (not investigated) |
| CCITT vs libtiff | 27 / 27 strips bit-exact (G4, G3-1D, G3-2D; up to 2,600 columns) |
| e2e (Chromium 143, real UI) | 8 / 8 |

The pdf.js corpus is a torture corpus: many of its files are deliberately broken or exercise rare features. On
everyday PDFs agreement is higher (tracemonkey, alphatrans and the 160F tax form render as PDFium does in the e2e
screenshots), but this was checked by eye on a handful of files, not measured.

## I. Repairs found during this tier, and the attack aimed at each patch

1. **Shading `/Matrix` applied twice** (function-based shadings).
   - Repair: the matrix is applied once, in `paintShading`.
   - Attack: the render differential re-run on all shading files; no regressions.
2. **Invalid shadings painted** (an axial shading whose function takes 18 inputs).
   - Repair: Domain arity is validated, matching PDFium, which paints nothing.
   - Attack: a mutant plus valid-shading control cases.
3. **CID-keyed CFF glyphs 1000× too large** when the top FontMatrix is explicit.
   - Repair: the FD fold is cancelled only when the top matrix is absent.
   - Attack: a corpus regression test on glyph extent, and a mutant.
4. **Annotations without /AP were invisible.**
   - Repair: `pdfappear.ts` synthesises Square, Circle, Line, Polygon, PolyLine, Ink, markup, Text and FreeText.
   - Attack: no-colour and Link negatives, and a mutant.
5. **Names were UTF-8 decoded in storage**, which corrupted GBK font names on rewrite.
   - Repair: byte-exact names.
   - Attack: a round-trip test and a mutant.
6. **Encrypt dictionaries with an indirect /CF failed.**
   - Repair: deep resolution.
7. **CCITT padding filled to the requested `/Rows`, not the capped row count.**
   - Repair: the padding loop uses the cap.
   - Attack: the 2^30 negative test, which found this bug in the first place, and a mutant.
8. **Graphics-state unwinding** (found by visual review of bug1001080, whose Type 3 glyphs are CCITT image masks).
   - Bug: the end of *every* content stream did `while (stack.length) restore()`. That popped the caller's `q` levels
     too, so after any form XObject or Type 3 glyph the page lost its CTM, clip and colours.
   - Repair: per-stream floors for both `Q` and end-of-stream unwinding.
   - Attack: a unit test with unbalanced `q` and extra `Q`, the bug1001080 glyph count (8 → 41), two mutants, and a
     full render re-run (§H numbers are after this fix).

9. **Embedded-file-only encryption** (found by the final render run: `auth-event-ef-open.pdf` and
   `encrypted-attachment.pdf` opened in PDFium but asked us, and qpdf, for a password).
   - Bug: any failed password check refused the document. With `/StmF` and `/StrF` Identity (PDF 2.0 §7.6.5) only the
     `/EFF` filter (embedded files, usually `/AuthEvent /EFOpen`) is encrypted, so the document itself is plain.
   - Repair: such documents open without a password, with a warning that attachments stay locked (and are not readable
     after a full rewrite).
   - Attack: a regression test on both corpus files, a control proving a fully encrypted file still needs its
     password, and a mutant.

## J. Stopping

I stopped when every test and mutant passed and the remaining low-agreement pages were all explained by the disclosed
gaps in §C (JPX, JBIG2, ExtGState soft masks), apart from the few named there. The next tier's most valuable PDF work
is ExtGState soft masks, which need an offscreen-layer device, and then JBIG2 generic regions.
