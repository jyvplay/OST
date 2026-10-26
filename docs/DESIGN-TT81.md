# TT81 — three testable feature slices: spreadsheet MODE family, PDF signature placement, Slides literal Find/Replace

## Runtime honesty / provenance

This report describes the artifacts and tests actually run in this sandbox. No independent agents, theorem prover, symbolic executor, or simulator was used. Verification was executable tests, compiler/type checking, browser end-to-end tests, and independent open-source readers/renderers.

- Application runtime: Node.js 22.22.3, TypeScript 5.9.3, Next.js 16.2.6, PostgreSQL 18.4 (embedded server, local only), Playwright with headless Chromium 143.
- Independent readers/oracles available and used: Apache POI's cached `FormulaEvalTestData_Copy.xlsx` values, openpyxl, python-pptx, pypdf, pyHanko 0.38, PDFium through pypdfium2 5.14, and Python standard-library ZIP/XML tools. Python 3.11. The browser ran against the production Next.js build at `http://localhost:3999`.
- No Microsoft Excel, PowerPoint, Acrobat, hardware/mobile browser, human end-user study, public certificate authority, timestamp authority, OCSP or CRL responder was available. pyHanko validates the cryptographic signature but does not supply a public trust decision for the self-signed test signer.
- Test-only source review: the Apache POI formula fixture is from `apache/poi` commit `140db93794f3029dadd216be522e68c8d9b76ec8`, with Apache-2.0 LICENSE and NOTICE in `scripts/fixtures/tt81/`; pyHanko is MIT, python-pptx is MIT, and the Apache fixture is test-only. Their executable/library code is not imported into the shipped feature implementations. The algorithms and UI in this change are first-party implementations, not copied, renamed, or linked to those packages.
- The retrieved feature comparator/source APIs are not a substitute for a proof of originality. `git diff` identifies the authored files; license provenance above applies to the test fixture and external tools, not to a claim that source review can prove independent invention.

## A. Formal model

These are three separate contracts, not one umbrella claim of “office parity.”

**Spreadsheet.** An admissible input is a formula whose parsed arguments are numbers, scalar expressions, direct cell references, ranges, arrays, or errors in the current workbook model. For `MODE` and `MODE.SNGL`, a range/array contributes numeric cells only; scalar arguments (including a direct single-cell reference) must be numeric, and an error propagates. If no value occurs at least twice, return `#N/A`; ties return modes ordered by first encounter. `MODE.MULT` returns each most-frequent number, same order, as a vertical dynamic array; a blocked spill follows the engine's normal `#SPILL!` rule. The resource is time O(n) and auxiliary space O(u), where n is inspected values and u distinct numbers; evaluator graph/cell-count limits remain those of the engine. Success is: for every input in the tested finite set, local result/errors equal the specified contract; for all 17 MODE cells in this particular Apache POI fixture, the cached Excel values equal our computed results. This is not a universal quantifier over all Excel workbooks.

**PDF placement.** An admissible page has a finite CropBox `[x0,y0,x1,y1]` with `x1>x0`, `y1>y0`, and `/Rotate` a multiple of 90°. Coordinates are PDF default user-space units (normally 1/72 inch). A caller supplies `(left, top, width, height)` in displayed page coordinates, origin at the top-left after page rotation. Success is: for each tested page and each supplied valid box, the computed `/Rect` is the inverse-rotation mapping of precisely that box, the rectangle lies in the CropBox, and after signing an independent renderer shows signature appearance ink within the chosen box. Invalid, nonfinite, zero/negative, malformed, or out-of-page input is rejected before mutation/signing. Tolerance: exact geometry assertions in PDF units; raster checks allow one pixel at scale 1.

**Slides search.** Input is a parsed slide deck with slide-owned DrawingML text in paragraphs, runs, tables, and groups. Search is a literal substring (never a user regular expression), optionally case-insensitive and optionally limited to the current slide. Paragraphs, hard line breaks, and dynamic fields are boundaries; notes, masters, images, chart data, and package XML are excluded. Replacement replaces all matching text, preserves the first matched run's style, produces one undoable mutation, and serializes only changed slide parts plus the package's existing modified timestamp. Limits are query ≤4096 UTF-16 code units, replacement ≤65536, at most 100,000 hits, and at most 16 MiB positive expansion. Success is tested fixture-by-fixture against python-pptx readback and undo/redo. It is not universal PowerPoint search equivalence.

Adjacent-but-different problems not substituted: spreadsheet recalc equivalence over all Excel functions/workbooks; locale-dependent MODE input; `.xlsx` authoring/recalculation by Excel; PDF certificate-chain trust, revocation, trusted timestamps, invisible signing UI, touch-drag arbitrary placement, PDF/A conformance, encrypted-PDF signing; searching Notes/Masters/charts/images, rich multi-paragraph replacement, preserving all run formatting over multiple matched runs, regex search, PowerPoint rendering, collaboration/track changes, or full-slide text extraction from unsupported drawings.

## B. Outcome space and evidence threshold

- **H+ (slice is achievable):** a bounded implementation passes typecheck, local positive and adversarial tests, a true-browser workflow, and where applicable a separately implemented reader/renderer. This threshold is met for the stated slices and tested fixtures only.
- **H− (contract impossible):** no such impossibility is established. None of the three tasks is claimed impossible.
- **H∂ (condition-dependent):** the outcome changes at the boundaries above: MODE provenance (scalar/direct-ref vs range), ties/no-repeat/spill collision; page rotation/CropBox coordinates and requested box validity; text split across runs vs paragraph/field boundaries; imported files outside tested parser support; and 100k/16-MiB caps.

The evidence threshold is not “all features are A.” It is the explicit combination of static checking + tests below. A broader product-grade Class A label remains conditional on the untested interoperability and coverage listed in J.

## C. Frontier and exact open interface

No external impossibility or deep literature result is needed for these finite implementation contracts. The useful frontier is operational:

1. **Spreadsheet:** local function semantics plus shape-aware spill engine are first-party. Apache POI's corpus provides precomputed cached values written by Excel; openpyxl independently parses our saved formula and package. The boundary is Excel's own fresh recalculation: openpyxl is not an Excel formula evaluator, and POI cached results are a finite reference corpus, not the full language specification.
2. **PDF:** the placement map is an affine inverse for quarter-turn rotations, tested in four orientations; pyHanko checks signature integrity/cryptographic validity, pypdf checks the saved widget rectangle, PDFium checks rendered appearance. The boundary is public trust and viewer-specific rendering. A valid signature is not identity proof.
3. **Slides:** OOXML XML parsing/serialization plus run-local text mapping retains the first run's styling and untouched ZIP parts. python-pptx independently opens the saved package. The boundary is Office's full rich-text semantics and renderer behavior; python-pptx is a package reader, not PowerPoint.

No imported theorem is asserted. GitHub API source/fixture retrieval and package version checks are recorded above; no web-search connector was used. Code was built locally rather than reusing an external library implementation.

## D. Negative space (at least 15 plausible but invalid substitutes)

1. Ignoring MODE errors instead of propagating them.
2. Coercing text from a range to numbers (wrong argument provenance).
3. Treating direct scalar cell-reference text the same as text inside a range.
4. Returning a value when no mode repeats rather than `#N/A`.
5. Choosing last-encountered tie rather than first-encountered order.
6. Returning only one MODE.MULT result or horizontally spilling it.
7. Overwriting an occupied spill target rather than `#SPILL!`.
8. Checking only formula text in `.xlsx`, not the value after saving/reopening.
9. Testing a formula over a hand-picked happy path only and omitting Excel-cached held-out cells.
10. Placing a custom signature rectangle in unrotated page coordinates on a rotated page.
11. Treating MediaBox as CropBox without checking offsets.
12. Clamping an invalid box into the page and claiming it honored the requested coordinates.
13. Accepting NaN/infinity/zero/negative dimensions.
14. Declaring PDF signed/trusted based on widget appearance rather than digest/signature checks.
15. Checking `/Rect` without rendering the appearance (an empty box could pass geometry).
16. Treating user query text as regex, allowing metacharacters to change literal matching or cause expensive backtracking.
17. Matching across paragraph, hard-break, or field boundaries, inventing text that does not appear as a single run of prose.
18. Searching notes/masters when UI claims only slide-owned text.
19. Replacing each run separately, which breaks a term split across runs.
20. Replacing across runs but assigning all matched text to an arbitrary style or destroying unrelated run attributes.
21. Changing matched results while iterating forward, which shifts offsets and skips/replaces wrong occurrences.
22. Mutating a deck before enforcing query, output-growth, and hit-count caps.
23. Showing search results but not applying edits to the serialized package.
24. Calling “undoable” when replace-all is not one transaction.
25. Calling UI checks full interoperability just because a browser screenshot exists.

**Modal-shortcut shortcut rejected:** a search pane or custom signature is not an excuse to claim modal isolation because a click happened to focus the panel. The specific failure is the canvas/window key handler receiving Ctrl+F/Delete while a real modal owns keyboard focus, potentially opening another overlay or deleting a selected object. The added attack sends Ctrl+F and Delete into the active Slides Save-as input and asserts the search pane stays closed and saved bytes do not change; existing `e2e-tt51-slides` additionally tests Save-as, slideshow, and notes focus against Delete/undo/duplicate. The spreadsheet/PDF UI tests also exercise their real dialogs, but do not imply all dialogs across all apps were newly re-audited this turn.

## E. Mechanism portfolio (independent artifacts; not six names for one test)

| Mechanism | Construction and concrete artifact | Evidence-bound portion (not formal proof) | Exact open interface | Cheapest falsification / adversary | Gap class |
|---|---|---|---|---|---|
| 1. Formula semantic partition | `ArgAccessor.isSingleRef` plus `modes()` in `officeFunctions3.ts` | scalar-vs-range distinction, errors, tie ordering, empty/no-mode | Excel behavior for unrepresented coercions/locales | replace scalar with text, direct text ref, range text, error in range | local edge semantics |
| 2. Differential formula corpus | 17 `MODE` formulas from Excel-cached POI workbook, included as Apache-2.0 test-only fixture with provenance | 17 formula outputs including legacy problematic M936 | formula corpus breadth and Excel recalc version | independently inspect all cached MODE cells and compare | local breadth; whole Excel semantics remains much larger |
| 3. Independent combinatorial oracle | deterministic 240-vector brute-force frequency count vs production frequency Map | count set and tie order for small integer vectors | floating point/large arrays and evaluator input grammar | duplicate all values or choose no duplicates at n=3 and n=43 | local randomized evidence |
| 4. Shape-aware spreadsheet UI integration | Chromium, workbook file written/read back through app | MODE.MULT spill rendered, edited formula saved, reopened values agree | Office's own recalculation / all exported features | occupy spill child; reopen and verify spill values | integration boundary, not original problem |
| 5. Affine inverse geometry | first-party `signaturePageSize` / `signatureRectAt` in `sigplacement.ts` | exact mapping for 0/90/180/270, negative crop origin, full-page and edge invalid cases | non-quarter-turn page rotations (refused); arbitrary PDF user-unit interpretation | adversarial nonzero CropBox plus rotation -90/270, box touches each edge | local geometry |
| 6. Signed artifact validation | build incrementally signed PDF, pyHanko integrity + validity, pypdf widget rect, PDFium rendered ink | four rotated pages with visible ink inside supplied displayed rectangle | trust, revocation, timestamps, independent desktop Acrobat | sign then flip signed bytes / move widget out of box | signature cryptography generality stays partly original |
| 7. Run-offset replacement | first-party `pmlsearch.ts`: concatenate run text in bounded paragraphs; locate literal offsets; apply descending; first insertion inherits first run | case/literal matching across runs, group/table text, package untouched parts except modified time | complex PowerPoint layout, language-specific casing, shared refs, relationship edges | hit spans three runs, repeated term, `$&`, HTML/XML metacharacters | local matching engine |
| 8. Independent OOXML reader | python-pptx reads output; checks text in shape/table/group, style and Notes remain untouched | package opens and selected semantics survive serialization | Office rendering of all OOXML parts | parse and inspect output and compare ZIP part hash set | local interoperability oracle |
| 9. Real-user-input browser workflow | Playwright Chromium over built Next app; menu, checkbox, save, search, undo/redo, modal key events | E1 spreadsheet, E2 PDF, E3 Slides, no browser page errors | hardware, mobile, assistive technology, native Office | keyboard-only flow and small viewports | integration/local |

## F. Executable artifacts / reproducing

- `src/lib/formula/ext/officeFunctions.ts` preserves direct-reference provenance; `officeFunctions3.ts` computes MODE/MODE.SNGL/MODE.MULT; `src/lib/formula/sheetops.ts` marks MODE.MULT as a dynamic-array function.
- `src/lib/pdf/sigplacement.ts` validates and maps a displayed-coordinate box; `PdfSignatures.tsx` exposes optional custom coordinates and rejects invalid placements through existing UI error reporting.
- `src/lib/office/pmlsearch.ts` performs literal slide text search/replacement; `Slides.tsx` exposes Find in Tweak, Ctrl+F, current-slide and case toggles, Replace all, results, and a visible scope contract.
- `scripts/tt81-core.mts` (11 cases: spreadsheet semantics + all 17 POI cached outputs + independently generated 240-vector oracle; Slides input corpus built from python-pptx; pypdf/pyHanko/PDFium) and `scripts/e2e-tt81.mts` (4 browser cases). The test-only xlsx fixture, LICENSE, NOTICE: `scripts/fixtures/tt81/`.
- Reproduce local gates: `node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt81-core.mts`; then `BASE=http://localhost:3999 node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt81.mts` against a built, running app/database. `npx tsc --noEmit` and production `npm run build` were also run.
- DP-15 is the TT80 one-banner feature, registered and audited across 11 apps. Screenshots are captured artifacts in `docs/screens/tt80-*.png`. DP-15 is not one of the three TT81 module slices.

## G. Second-order adversary and boundary attacks

For **MODE**, attack the implementation's distinction itself: `MODE(A1,2,2)` where A1 is text; `MODE(A1:A3)` with text; direct text reference; error in range; no repeated values; equal frequency; duplicate values at earliest and latest locations; scalar `TRUE`; numeric-looking literal string; dynamic array collision and later release. The fixture/cache check covers 17 real formulas; test vectors are bounded integers, not NaN/infinity locale cases. The strongest residual attack is Office formula-parser disagreement before `modes()` receives accessors or a mode-dependent formula in an unsupported evaluator feature.

For **PDF**, attack geometry rather than just successful output: negative-origin CropBox, -90° normalization, each rotation, off-page full-page rectangle, exact edges, zero-sized and nonfinite values, dimensions exceeding display size, 45° (refused), and signed output verification at all four rotations. Mutation after signing should yield invalid signature (existing TT77 negative tests cover signature mutation, this new suite attacks rectangle admission). Limit: PDF page `/UserUnit` and non-right-angle rotation are not represented by this UI placement contract; `/UserUnit` is a potential unit mismatch to test before a broader release claim.

For **Slides**, attack string offsets and XML lifecycle: repeated matches, search term split across run boundaries, HTML/XML metacharacters, dollar replacement strings, astral Unicode, casefold behavior, hard break/field/paragraph barriers, huge repeated replacement that exceeds growth guard, invalid surrogate/control text, grouped/table text, notes exclusion, untouched part hash equality, undo/redo, and Ctrl+F/Delete while Save-as is focused. The single-row Python/PowerPoint editor verifies structure, not Office rendering. Strongest remaining attack: UTF-16 offsets vs JavaScript regex offsets for a query containing supplementary-plane symbols before a hit; JS regex match indexes are UTF-16 indices, which is the same indexing unit as JS string slices, but additional corpus mutation testing is still warranted.

## H. Verification actually performed

- `npx tsc --noEmit`: clean after implementation.
- `npm run build` (production): clean, including TT81 additions.
- `tt81-core`: **11/11**.
- `e2e-tt81`: **4/4**, real Chromium; output files independently read by python-pptx/pypdf as specified; no browser page errors.
- `tt80-banner`: **11/11**, one banner and menu mirroring checks for Writer, Slides, Spreadsheet, PDF, Vector, Whiteboard, Tables, Editor, Photos, Image Editor, Quick Edit.
- Restored test-only POI and PDF corpora and OOXML XSDs from pinned GitHub test sources after a resumed sandbox did not contain the external `/home/user/tools` resources. Then `tt79-sheet` 5/5, `tt77-pdfsig` 23/23, `tt76-slides` 8/8, `tt78-sheet` 11/11, `e2e-tt79-pdf` 5/5, `e2e-tt77-pdfsig` 7/7, and `e2e-tt51-slides` 6/6 all passed after restoration. The first attempts before restoring the external test corpus failed due solely to missing paths; their final results were rerun and green. No blanket regression success is claimed.
- `e2e-a11y`: 9/9 after the banner refactor. The TT81 Slides browser flow also injects axe and checks for serious/critical violations with the Find pane open.
- Saved screenshots were visually opened in Arena's image viewer: Writer, Vector, Spreadsheet, PDF, Slides, Whiteboard, Image Editor, Editor, Tables, Photos, plus the new TT81 Slides and PDF screens. The original TT80 screenshots show a single non-wrapping tool strip under the Fusion menu row. The first TT81 Slides capture showed crowded checkbox labels; flex spacing was applied, then a production rebuild and fresh browser run passed, and the updated image was inspected. This is screenshot-content review, not a hardware or full-size user study.
- A first full tabletop run was 13/15; its north-wall hit-test and TT48 fast-flick tests both passed when run independently, and the full suite was rerun: **15/15**. The earlier misses appear timing-sensitive; the rerun does not prove the flake impossible.

## I. Repair and new attacks

- TT80 real repairs (design details in `DESIGN-TT80.md`): one banner strip instead of wrapping; Vector/Whiteboard/Imaging grid spans fixed; menu items read live control state; escape closes from outside the focused trigger; menu names checked against a negative list; tests scope to app window. DP-15 row/seed updated. The 11-app Playwright audit is the new attack on these repairs.
- TT81 MODE added direct-reference provenance; attack after patch: direct ref to text, range text, error, logical literal, tie, collision, independent 17 cached formulas, 240-vector brute force, and UI spill/save/reopen.
- PDF custom box added explicit geometry instead of an unbounded drag UI; attack after patch: every quarter rotation with negative CropBox offset, all invalid geometry classes, signature validate and PDFium ink bounding region.
- Slides replace-all added as one engine mutation; attack after patch: repeated matches/run boundaries, XML special characters, Unicode, huge output, no-op byte preservation, and modal focus. The property-like randomized frequency test is deliberately separate from formula dispatch, and all gates were rerun after local code repairs.

## J. Stopping, limits, and next highest-information tests

This turn did **not** make all application features A-grade, nor establish universal spreadsheet/PDF/PowerPoint parity. It produced three bounded feature slices with passing local and real-browser tests. Remaining known blockers relevant here:

1. Excel's full 446k+ corpus still has four known `EverythingTests` formula disagreements from prior TT79 ledger; this turn fixes MODE-specific cases, not all four. Consult latest `docs/LEDGER.md` and `docs/test-results/tt74-office.json`.
2. PDF: no public trust store, revocation, RFC 3161 timestamping, Acrobat validation, PKCS#12 variants outside tested vectors, or `/UserUnit` geometry validation; do not represent local trust as global identity.
3. Slides: no full Office rendering, native PowerPoint automation, broad corpus round-trip after find/replace, paragraphs/spaces/non-rendered field behavior across every producer, or rich run formatting across all replaced runs. Replacement uses the first matched run's style, intentionally.
4. Not all large full regression gates were rerun. The one new e2e suite reports only four cases, not quality grades for all spreadsheet/PDF operations.
5. External compute was reproducible locally in this sandbox, but no actual mobile/Windows/macOS/A11y hardware was available.
6. Visual check was screenshot content inspection; not a full-size human study. The checkbox-spacing patch was followed by a fresh production build, `e2e-tt81` 4/4, `tt80-banner` 11/11, and updated screenshot inspection.
7. TT80 screenshots include a home / sandbox test fixture; they are not production app content.

**Next best tests:** after the label spacing patch, rebuild and rerun `e2e-tt81` plus `tt80-banner`; extend find/replace over all 95 Apache POI slide decks to compare text before/after in a held-out parser; independently generate more `/UserUnit` / non-origin CropBox PDF fixtures with PDFium; use Excel itself on a real desktop for fresh formula recalculation. A complete product-grade “Class A” claim requires the rest of the existing blockers and full gate, not just this TT81 patch.
