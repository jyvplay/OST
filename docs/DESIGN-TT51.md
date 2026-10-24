# TT51 — Slides becomes a lossless editor of real PowerPoint files (FF-23 → built)

Runtime used: bash sandbox, Node 22, tsc, Next 16, Postgres, headless Chromium 143 (Playwright), Python venv with
python-pptx 1.0.2, lxml and msoffcrypto-tool as **test-only** oracles. Not available: theorem provers, parallel agents,
Microsoft PowerPoint or LibreOffice, a GPU, or a real display. Nothing below claims a PowerPoint open check or a pixel
comparison with PowerPoint (PR-11 stays partial).

Corpus: 95 .pptx files from the Apache POI test data (Apache-2.0) and python-pptx's test files (MIT), fetched by
`scripts/corpus/fetch.py` into `/home/user/tools/corpus/pptx` (outside the repository). python-pptx opens 83 of them;
the other 12 are fuzzer cases, a CRC mismatch and a truncated zip, and they are the hostile-input set.

## A. Formal model

### Document (`PptxDoc`, `src/lib/office/pml.ts`)

The package is the model. `PptxDoc` holds:
- `zip`: part name → original bytes; `order`: original part order;
- parsed XML trees, only for the parts we edit: `pres`, `presRels`, `ct` (`[Content_Types].xml`), each slide's
  `{path, rid, sldId, xml, relsXml}` and each notes slide;
- `dirty` (parts to re-serialise), `removed` (parts to drop), `orig` (the original file) and `origNames`.

Nothing is converted into a reduced model and back, so anything the editor does not understand (animations,
transitions, media, OLE, SmartArt, custom XML, extension lists) is carried through untouched.

### Operations

All edits are copy-on-write (`mutSlide`, `mutPres`, `mutPresRels`, `mutCt` clone before changing), so a `snapshot`
is a set of references and undo is exact.

- **Text:** `setShapeText`, `setParaText` (common prefix/suffix diff; the inserted text joins the run the caret sits in),
  `formatRange` (splits runs at the exact boundaries), `formatParas` (alignment, bullets, numbering, level, written in
  schema order).
- **Slides:** `addSlideFromLayout`, `duplicateSlide` (owned parts such as charts and their workbooks are deep-copied;
  shared parts such as layouts, media and hyperlinks are referenced), `moveSlide`, `setHidden`, `deleteSlide`.
- **Shapes:** `addShape`, `addPicture`, `setXfrm`, `setShapeFill`, `setShapeLine`, `zOrder`, `deleteShape`.
- **Notes:** `setNotesText` creates a notes slide, and a notes master plus theme when the deck has none.
- **Write:** `writePptxDoc` re-serialises only dirty parts, keeps the original bytes of any part whose XML did not
  really change, and returns `orig` itself when nothing changed.

### Invariants

- **P1, untouched means byte-identical:** an unedited save returns the original bytes; an edited save changes only the
  parts the edit touched, and edits that cancel out (undo back to the opened state) give back the original file.
- **P2, references stay valid:** every relationship target exists, every part has a content type, every `sldId` is
  unique and ≥ 256, and nothing points at a removed part (slide links, custom shows, sections, notes).
- **P3, reading agrees with python-pptx:** slide order, hidden flags, layout names, notes, shape ids and names, geometry
  with placeholder inheritance, paragraph text, tables and groups.
- **P4, formatting survives edits:** typed text inherits the formatting of the run it joins; every other run and
  paragraph keeps its exact XML.
- **P5, undo is exact:** restoring a snapshot gives a package whose every part equals the snapshot-time part.
- **P6, hostile input is bounded:** 64 MiB file guard, 20,000 parts, 2,000 slides, zip-bomb ratio guard (zipkit),
  no DTDs or entities (xmltree), part names cannot climb out of the package.

### View model (`pmlview.ts`, `pmlgeom.ts`, `slides/render.tsx`)

`slideView(doc, i)` resolves everything the browser needs: master → layout → slide inheritance for placeholders and
text styles, theme colours through the clrMap with lumMod/lumOff/tint/shade/satMod/alpha, backgrounds, fonts.
`pmlgeom.ts` turns 180+ preset geometries (and custom geometry) into SVG paths with the ECMA-376 guide formulas. The
renderer is plain React and SVG; pictures come from blob URLs; charts are drawn from their cached values by the TT50
chart engine.

## B. Hypotheses

- **H+ (expected to hold):** P1–P6 hold on every openable corpus deck for every operation the UI offers.
- **H− (expected to fail, and tested so):** the 12 broken corpus files, a billion-laughs part, a path-climbing target,
  duplicate/missing sldIds, deep nesting and a real zip bomb are all rejected with a clear error instead of hanging.
- **H∂ (boundary):** decks without a rels Default (old LibreOffice), decks without a notes master, BOM-prefixed parts,
  zero-height connectors (UI hit-testing), shared-rId pictures, chart decks with embedded workbooks.

## C. Frontier — what this tier does not do

Text is edited in an overlay textarea, not inline WYSIWYG. Animations, transitions and media are kept but not played.
EMF/WMF pictures show a placeholder. Group rotation is not applied to children. Vertical text is approximated with CSS
`writing-mode`. SmartArt is drawn from its cached drawing part only. Charts are drawn flat from cached values (TT50
limits apply). No PowerPoint/LibreOffice open check (PR-11).

## D. Negative tests (≥ 15 shapes)

From `tt51-slides.mts` "hostile input" plus the e2e modal test: 10 clusterfuzz files, CRC mismatch, truncated zip,
billion laughs, path climbing, missing sldIdLst entries, duplicate sldIds, deep XML nesting, a real zip bomb, an
unsupported picture type, an oversized file; and the **modal-shortcut failure test** — Delete / Backspace / Ctrl+Z /
Ctrl+D pressed while the Save-as dialog, the slide show or the notes field has the keyboard must not delete the shape,
undo or duplicate a slide (they do on the canvas).

## E. Approaches (mechanism-distinct)

1. Reader oracle: python-pptx field-by-field comparison (`pptx_probe.py`).
2. Package validator: an independent lxml checker for rels, content types, sldIds and shape ids (`pptx_validate.py`).
3. Byte identity: unedited and cancelled-out saves compared with the original bytes.
4. Mutation testing: `scripts/tt51-mutants.py` re-introduces plausible bugs; the suite must fail for each.
5. Real-UI e2e: Chromium drives the module; saved files are re-read by python-pptx.
6. Encryption cross-check: our Agile encryption decrypted by msoffcrypto-tool, and its output decrypted by ours.
7. Visual inspection of screenshots (shapes, tables, backgrounds, charts, slide show).

## F. Artifacts

`src/lib/office/pml.ts`, `pmlview.ts`, `pmlgeom.ts`; `src/components/modules/Slides.tsx`, `slides/render.tsx`;
`scripts/tt51-slides.mts`, `scripts/e2e-tt51-slides.mts`, `scripts/tt51-mutants.py`, `scripts/oracle/pptx_probe.py`,
`scripts/oracle/pptx_validate.py`; `src/db/seed-data/features-tt51.ts`.

## G. Second-order adversary — mutation testing

`scripts/tt51-mutants.py`, first run: **7/17 killed**. The suite was weaker than its test names claimed. Each survivor was
classified:

| Survivor | Verdict | Action |
|---|---|---|
| absolute rel targets | test gap (no corpus deck uses them) | synthetic absolute-target deck in the reader test |
| case-insensitive part lookup | test gap **and a real bug** (see I) | synthetic mixed-case deck; repair |
| chart workbook shared on duplicate | test gap: the test said "own workbook" but checked only the chart part | owned-part comparison |
| duplicate sldId | test gap: the test deleted the duplicate before validating | uniqueness check right after duplicate |
| media GC on slide delete | test gap: the deleted slide's pictures were still used | slide with a picture used nowhere else |
| bring to front | test gap: only "back" was exercised | front checked by index and name |
| re-serialised unchanged parts / cancelled edits re-zip | test gap: undo compared parts, not the file | whole-file byte equality after undo (P1) |
| restore's dirty re-add | **equivalent** (dirty never shrinks) | replaced: restore keeps the edited part map |
| early identity return | **equivalent** (backed by the `!changed` check) | replaced: remove the second check |
| pml part-count guard | **equivalent** (zipkit's MAX_ENTRIES is the same 20,000) | replaced: 64 MiB size guard (now tested) |

Final: **18/18 killed** (16 in the full run; the media-GC and two-spellings mutants re-run after fixing the script's
test selection and adding multi-site mutants). Sources were restored byte-for-byte after every mutant.

## H. External verification

python-pptx and msoffcrypto-tool are third-party implementations. They are not PowerPoint.

## I. Repairs found during this tier, and the attack aimed at each patch

1. **Mixed-case part names wrote a slide twice.** OPC part names are case-insensitive. A deck whose rels say
   `slides/slide1.xml` while the zip holds `Slide1.XML` opened fine, but an edited save wrote both spellings (an invalid
   package). Repair: `canonicalNames` re-keys referenced parts to the referenced spelling at read time.
   - First attempt was itself wrong (rels parts were renamed before their parts, following the stale spelling). Found
     by the debug run; the pass order was fixed.
   - **Attack on the patch:** one part named with two spellings (presentation rels vs the notes slide's
     back-reference). In one zip order the slide was renamed to the notes spelling and written twice again. Repair:
     the first reference claims a spelling (root and main-part rels first), and slide paths and `partXml` map to the
     real zip key. Both zip orders are now tested; the mutant removing both layers is killed.
2. **Zero-height connectors could not be selected** (the click target had no area). Repair: lines thinner than 8 px get
   a transparent 10 px hit band. Covered by the e2e test.
3. **Double-click edit never opened** because pointer capture retargets the event to the stage. Repair: hit-test with
   `elementsFromPoint`.
4. **Slide show was not full-window and Escape could miss it** (`position: fixed` inside a transformed window; focus).
   Repair: portal to `document.body` and a capture-phase window key handler while the show runs. The modal-shortcut
   test proves root shortcuts never fire during the show.
5. **Legacy .fdeck opened as a blank deck** because the file API returns uploads base64-encoded. Repair: decode first.
6. **Stage clipped the slide** (missing `min-height: 0`), **toolbar glyphs rendered as tofu** (replaced with inline SVG
   icons and plain text), and **charts reflowed at thumbnail size** (now laid out at half natural size and scaled).

## J. Stopping

Stopped when the engine suite, the e2e suite and every mutant were green and the ledger had no failing test touching
any row. The frontier in C is what remains.
