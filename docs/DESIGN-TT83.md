# TT83 — PDF page-unit fidelity, banner visual review, and bounded continuation

## Scope and outcome

This turn resumes the pushed TT82 lookup fix and keeps it intact. The new bounded feature is PDF 1.6+ page `/UserUnit` handling: page display geometry and content transforms now use the page's default-user-space unit, invalid values are ignored with a warning, and raster work is bounded before canvas allocation. It is a specific PDF correctness slice, **not** a product-wide Class A claim.

The existing unified Fusion banner was not redesigned: TT80 already established its menu vocabulary and shared banner. This turn exercised its real-browser audit and visually inspected Vector at 1440×900. Ten app audits passed; Quick Edit could not be seeded because the application backend could not connect to PostgreSQL. The Vector screenshot had an explicit offline/server-error toast, so it is visual evidence for banner layout only, not working app persistence. No banner fix was justified by that inspection.

## Runtime and method actually used

- Node.js 22, TypeScript compiler (`npx tsc --noEmit`), the repo's Node/TypeScript headless harness, and a real headless Chromium process (`playwright` plus test-only `@sparticuz/chromium`, installed outside the repo under `/home/user/tools`).
- Python 3.11 test-only venv with `pypdf`, `pypdfium2`, `pyHanko`, and `openpyxl`; pypdf independently read the generated `/UserUnit` and signature widget rectangle.
- A running Next.js development server was started for the visual check and then stopped. PostgreSQL was **not** available/listening; app APIs returned connection-refused / HTTP 500. The banner audit's `imagequick` test failed while parsing that unavailable API response.
- No independent agents, theorem prover, Excel/Acrobat desktop, or native mobile device was available. Web search was used for PDFium/UserUnit evidence; no third-party implementation code was copied into production.

## A. Formal model

**Admissible objects.** A PDF no larger than the existing 256 MiB app guard, parsed by `PdfDoc`; each page has a normalized CropBox, quarter-turn rotation, and optionally a direct page-dictionary `/UserUnit` value. A valid supported unit is a finite PDF number in `[1, 75,000]`; absent means 1. This implementation's chosen upper bound is an implementation limit, not a claim that ISO mandates 75,000 for every reader.

**Information/access model.** `PdfDoc` resolves an indirect value and sees the page dictionary. `pageTransform` maps default user-space coordinates to device pixels; `boundedPageScale` selects a display scale; `renderPage` checks the actual raster dimensions before image decoding or allocation. The PDF writer does not rewrite content coordinates or page boxes. pypdf sees the stored property independently. PDFium is not a rendering oracle for this property: the experiment below and its API documentation show it does not apply `/UserUnit`.

**Resource counted.** Raster backing-canvas pixels, not source bytes: display scale is bounded to at most 4,096 CSS pixels on a side and 2,000,000 CSS pixels in area; callers use at most 2× DPR, and the renderer independently refuses a backing surface exceeding 8,192 pixels per side or 8,000,000 pixels in area. Invalid dimensions are rejected before decoding or allocation.

**Success predicate and quantifiers.** For every parsed page with valid `U ∈ [1,75,000]`, every finite user-space point, every quarter-turn rotation, and every accepted positive scale, the page transform's linear and translation terms must be the prior transform multiplied by `U`; output width/height use the same factor. For every supported UI zoom and page size, the chosen view scale must obey both raster caps. For an invalid numeric value, the reader must use `U=1` and retain an inspectable warning; it must not silently reinterpret invalid input as a large scale. A single mismatch, unbounded canvas, missing warning, changed no-`/UserUnit` geometry, or changed signature widget coordinates falsifies this slice.

**Units/boundaries.** PDF default user space is conventionally 1/72 inch; `/UserUnit` is a positive scale in multiples of 1/72 inch. At `U=2.5`, a 300×400 user-space page maps to 750×1,000 physical points at scale 1. Floating output is tested exactly for binary-friendly values and by inequalities for resource bounds. The boundary is implementation support up to 75,000; malformed, nonnumeric, less-than-one, and greater-than-limit values fall back to 1 with warnings. Huge valid pages are view-scaled down or refused before raster allocation.

**Adjacent but different problems not substituted:** inheriting `/UserUnit` from a `/Pages` parent (it is page-local); changing MediaBox/CropBox coordinates; modifying content-stream matrices; physical print/PDF export; non-quarter-turn `/Rotate`; signature geometry in normalized display coordinates; PDFium implementation parity; geospatial coordinate interpretation; and arbitrary or encrypted PDF editing.

## B. Outcome space

- **H+ (achievable):** correct page-local unit scaling is implementable in this engine by a single affine-transform factor plus physical-size-aware scale selection. The local transform, safety bound, and unchanged signature default-user-space coordinates are now executable tests.
- **H− (impossible claim under present verification):** a claim of independently verified rendering parity with PDFium is not available; PDFium itself ignores `/UserUnit`. A pypdf dictionary readback cannot prove pixels or print size.
- **H∂ (boundary/conditions):** values above the selected 75,000 limit, malformed properties, resource-exceeding rasters, page attributes that are not inheritable, and external viewers that ignore the property require explicit downgrade/fallback behavior. Acrobat-level parity remains unverified.

## C. Best-known interface and evidence

The PDF specification's page `/UserUnit` is a multiplier of the default 1/72-inch user-space unit, with an implementation-dependent supported range; the commonly cited maximum is 75,000. A PDFium maintainer response says PDFium has no support for it, and pypdfium's API documentation says its page-size interface does not account for the unit. These findings align with the local reproducible experiment: a generated 300×400 PDF with `/UserUnit 2.5` was read as 2.5 by pypdf, but pypdfium reported `(300, 400)` and rendered 300×400 pixels. Sources: [PDFium discussion](https://groups.google.com/g/pdfium/c/M3cLrkLkszc), [pypdfium API notes](https://pypdfium2.readthedocs.io/en/v4/python_api.html), and [PDF coordinate/unit overview](https://pdfa.org/how-big-can-a-pdf-page-be/).

The exact open interface is therefore **our transform and external reader metadata versus a viewer/printer that actually honors the unit**. pypdf validates the stored property and annotation rectangle, but it is not an independent renderer. This code follows the PDF coordinate model; it does not borrow PDFium or another product's implementation.

## D. Negative space: near-solutions rejected

1. Reading `/UserUnit` into `PdfPage` but leaving the transform unchanged (metadata-only).
2. Scaling the CSS `<canvas>` box while leaving content coordinates unscaled.
3. Scaling the page matrix but not the page's output width and height.
4. Scaling page width but not page height or 90°/270° rotation.
5. Scaling the CropBox origin translation differently from the linear terms.
6. Treating the property as inheritable from `/Pages`.
7. Treating a missing value as zero.
8. Accepting `0`, a negative value, or a fractional value below 1 as a usable page scale.
9. Silently treating a string, error object, or malformed indirect value as a numeric multiplier.
10. Clamping `75,001` to `75,000` without telling the user the value was unsupported.
11. Applying the unit to signature `/Rect` values in the file; those remain default-user-space coordinates.
12. Scaling signature coordinates but not the appearance/annotation page transform.
13. Scaling only annotations or form appearances, leaving page content at the old physical size.
14. Scaling only page content, leaving text-selection rectangles and pointer mapping in old coordinates.
15. Fitting only by width; an extremely tall/narrow page can still allocate an enormous surface.
16. Trusting a UI `fit` label while a huge page triggers a giant backing canvas.
17. Letting fixed zoom bypass the raster cap.
18. Treating pypdf's successful dictionary read as proof that rendering is correct.
19. Treating PDFium as the oracle even though it ignores `/UserUnit`.
20. Normalizing the file by rewriting `/MediaBox` and content streams, which can alter signatures and unrelated content.

P4 tests catch the chosen implementation's main modal traps: absent unit; 2.5 unit; 75,000 boundary; 0, -1, 0.5 and 75,001 invalid values; warning presence; parent-only `/UserUnit`; 90° rotation; negative CropBox origin; oversized direct render refusal; safe view-scale bounds; external pypdf property and signature-widget readback.

## E. Mechanism portfolio (independently considered)

| Candidate mechanism | Artifact / proved portion | Unresolved interface | Cheapest falsifier | Gap |
|---|---|---|---|---|
| 1. Metadata-only unit field | P4 pypdf fixture proves the dictionary is observable; a direct counterexample is its unchanged 300×400 `pageTransform` at U=2.5. Rejected. | No physical display change. | Assert transform width is 750, not 300. | Local implementation bug. |
| 2. Multiply one page affine transform by U (selected) | `pageTransform` matrix test; pypdf page and signature rectangle readback; scale-cap test. | No independent renderer honors U in this sandbox. | Compare transformed size/translation for U=2.5, offset crop and 90° rotation. | Local; cross-viewer oracle gap remains. |
| 3. Rewrite MediaBox/content into canonical points | Concrete counterexample: rewriting a signed file invalidates or changes its signed byte range; current engine preserves original bytes. Rejected. | Correctly rewriting every content stream, annotation, form, and signature is another project. | Sign fixture then normalize and validate signature. | Equivalent to original rewrite problem. |
| 4. CSS-only scale | DOM size could be doubled while `renderPage` still allocates and paints the same 300×400 bitmap; rejected by differing bitmap/container dimensions. | Text, pointer mapping, annotations, and thumbnails disagree. | Assert canvas bitmap dimensions and page matrix independently. | Local renderer integration. |
| 5. Separate coordinate mapper for content, annotation, and UI | Candidate artifact is the P4 matrix plus custom-signature widget rectangle; p4 demonstrates widget coordinates remain in default user units. Not selected as separate duplicate mapper. | Every coordinate consumer would need synchronized conversions. | Click/annotation/signature cross-check at a nonzero origin. | Local but broad integration. |
| 6. Delegate rendering to PDFium | Reproduced counterexample: pypdf reads U=2.5 while pypdfium reports 300×400. Rejected as a solution, retained only as comparison for ordinary PDFs. | PDFium currently cannot verify or supply this behavior. | Re-run the fixture through PDFium and inspect its API result. | External tool limitation, not solvable by wrapper code. |
| 7. Refuse every non-1 unit | Concrete fail-closed behavior, but refuses valid large-format PDFs and does not meet the feature contract. | Valid pages remain unusable. | Open the 2.5-unit fixture and confirm refusal. | Product-policy boundary, not parser difficulty. |

These are not seven equivalent implementations: they differ in data normalization, affine mapping, DOM presentation, per-coordinate conversion, external delegation, or refusal. Only #2 is merged. Each rejected route has a reproducible counterexample or falsification condition above.

## F. Concrete artifacts

- Production code: `src/lib/pdf/pdfdoc.ts` reads page-local `/UserUnit`; `src/lib/pdf/pdfcanvas.ts` applies it once to the page transform and exposes bounded zoom calculation; `src/components/modules/Pdf.tsx` and `PdfPreview.tsx` use physical dimensions for fit/preview; `scripts/tt52/mkpdf.ts` generates fixtures.
- Regression suite: P4 in `scripts/tt81-core.mts`; result recorded at `docs/test-results/tt81-core.json`.
- External probe: pypdf independently read the 2.5 property, CropBox/MediaBox and signed widget `/Rect`; pypdfium's ignored-unit output is preserved here as a counterexample, not used as a pass oracle.

## G. Second-order adversary

Attack the exact implementation structure: indirect/malformed values; a `/UserUnit` on parent `/Pages`; units immediately below/at/above accepted bounds; negative CropBox origins; 90° and 270° rotations; maximum UserUnit on tiny and very narrow/tall pages; NaN/nonpositive requested zoom; rounding at the 2 MP view threshold; DPR 2 causing a backing surface over 8 MP; thumbnails and Peek preview that bypass the PDF app; pointer/annotation mapping; valid signatures on a U≠1 page; and a viewer that ignores the unit. The P4 patch was followed by a fresh 12-case TT81 run and a new 75,000-unit direct-render attack that proves refusal happens before canvas creation. Remaining attacks include indirect numeric `/UserUnit`, browser canvas pixel-size behavior at several device-pixel ratios, PDF/A/large-format corpus comparisons, annotations/forms at nonzero CropBox offsets, and Acrobat/printer output.

## H. Verification

- `npx tsc --noEmit`: passed after implementation.
- `scripts/tt81-core.mts`: **12 passed, 0 failed**, including P4 and existing MODE, Slides, and PDF signature cases. Independent pypdf accepted the generated PDF and read the stored UserUnit and signature rectangle.
- `scripts/tt52-pdf.mts`: **28 passed, 0 failed**; all corpus/oracle cases requiring the missing external PDF corpus were explicitly skipped. This is not a corpus result.
- `scripts/tt80-banner.mts`: **10 passed, 1 failed**. Writer, Slides, Spreadsheet, PDF, Vector, Whiteboard, Tables, Editor, Photos, and Image Editor passed. Quick Edit failed while parsing the empty response from `/api/fs`; server logs show PostgreSQL connection refused. Do not call this a clean 11-app pass.
- Visual check: actual 1440×900 Chromium screenshot of Vector shows one Fusion menu row and one non-wrapping strip, with no browser page errors. The screenshot also displayed a 500/offline toast caused by PostgreSQL absence; no persistence behavior was verified. Temporary screenshot removed.
- An app server was stopped after the check. No native Excel, Acrobat, mobile, or physical printer verification occurred.

## I. Repair gate

The first P4 run caught a floating-point edge: the computed 2 MP area was a fraction above the strict bound. The scale calculation now reserves 10,000 CSS pixels for integer-rounding headroom; tests and the compiler were rerun. The next new attack is the 75,000-unit direct render call, which must reject before allocating. Do not infer trust from the pre-repair run.

## J. Stopping and remaining limits

This delivers one additional PDF correctness/resource-bounds slice and resumes the prior Spreadsheet lookup work; it does **not** make every feature Class A. The full Excel cached-value corpus is still absent, so TT82's three matching fixture cells do not close the full Excel ledger. PDFium ignores `/UserUnit`, so no independent pixel-level verifier was available for the new unit behavior. PostgreSQL unavailability blocked the Quick Edit banner seed and caused application API errors in the preview. Banner code/menu vocabulary was not changed because the inspected Vector layout was sound and ten app audits passed; visual review was not possible for every surface in this run.

**Next highest-information tests:** install/restore a real PostgreSQL service, rerun all 11 banner apps and capture fresh screenshots; generate a compact corpus covering indirect `/UserUnit`, all quarter rotations, parent non-inheritance, annotations/forms, and CropBox offsets; compare output with Acrobat or another renderer known to honor `/UserUnit`; rerun full Excel cached-value differential when `FormulaEvalTestData_Copy.xlsx` is available; and continue the remaining Writer/Spreadsheet/PDF feature ledger rather than claiming product-wide parity.
