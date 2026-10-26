# TT84 — PDF unit regression and Writer Word Count

## A. Scope and honesty

TT84 is a bounded increment, not a Class-A or competitor-parity claim. It adds a Writer Word Count dialog with document and current-selection counts, exercises the existing PDF `/UserUnit` viewer support in a real browser, and repairs a collision in the shared TT81 browser fixture uploader. Existing banners and menu naming were left unchanged.

## B. Feature implementation

- `src/lib/office/wordcount.ts` owns the first-party count rules. It uses Writer's existing letter/number tokenization, counts visible characters as Unicode grapheme clusters where `Intl.Segmenter` is available (with a code-point fallback), normalizes CRLF, omits paragraph line breaks from character totals, and omits whitespace for the no-spaces total.
- `src/components/modules/Writer.tsx` exposes **Word count…** in the status bar. The modal reports page, word, character-with-spaces, character-without-spaces, non-empty paragraph, and line counts. If a selection is inside the main document body when opened, it reports selection words and characters too. Escape and backdrop close it, focus is placed in the dialog, Tab remains on its only control, and closing returns focus to the opener.
- `scripts/e2e-tt81.mts` checks the Writer dialog with actual keyboard input and a real selection. Its PDF case checks `/UserUnit 2.5` page geometry, an adjacent default-unit page, text-search highlight geometry, the Info panel, bounded canvas sizes, and independent pypdf readback.
- The browser harness now gives each uploaded fixture a unique path, including same-extension fixtures. This prevents final cleanup from trying to trash a duplicate path after its first instance has already been purged.

## C. Threat model / failure modes considered

Word Count risks include empty documents, whitespace-only selections, paragraph separators, CRLF input, apostrophes, hyphenated terms, combining marks, emoji sequences, stale browser selections, modal focus loss, and accidental counting of non-selected document content as the selection. Unit tests cover empty/whitespace, CRLF and blank paragraphs, apostrophes/hyphens, combining marks, emoji graphemes, and a 20,001-word stress input. The browser test selects just the first word of a three-word document, checks total and selection values, checks the keyboard trap/focus return, runs axe on the open modal, and checks for uncaught page errors.

The PDF test attacks a second path through unit handling: a 300×400 page with `/UserUnit 2.5` must display and rasterize at 750×1000 at 100% zoom; the neighboring default-unit page stays 300×400. The search highlight's x-coordinate must also use the scaled transform. The script waits for rendered backing-canvas dimensions rather than merely asserting that a canvas element exists.

## D. Test matrix and actual evidence

| Artifact | Checks | Result |
|---|---|---:|
| `scripts/tt84-wordcount.mts` | four unit tests: empty; whitespace/CRLF; Unicode/word boundaries; long input | 4/4 |
| `scripts/e2e-tt81.mts` | Spreadsheet MODE.MULT, PDF signature geometry, Slides Find/Replace, PDF UserUnit browser path, Writer Word Count, uncaught browser page errors | 6/6 |
| `scripts/tt80-banner.mts` | one banner and own/mirrored original menu names across Writer, Slides, Spreadsheet, PDF, Vector, Whiteboard, Tables, Editor, Photos, Image Editor, Image Quick | 11/11 |
| `npx tsc --noEmit` | strict repo TypeScript check | passed |
| `npm run build` | optimized Next production build | passed with `DATABASE_URL` pointing at the live local PostgreSQL; first invocation without the required env failed during API page-data collection and was rerun correctly |
| targeted ESLint | `wordcount.ts`, `e2e-tt81.mts`, and `tt84-wordcount.mts` clean; `Writer.tsx` remains lint-red with 102 existing errors at branch base and 102 after this change (mostly `react-hooks/refs`), warnings 4 at base / 3 after; no claim of file-wide lint success |
| `docs/screens/tt84-writer-count.png` | visual browser capture of the modal, selected text and Writer banner | inspected |
| `docs/screens/tt84-pdf-unit.png` | visual browser capture of the UserUnit-scaled page, highlight, PDF banner and menu names | inspected |

E2E used headless Chromium 143 from the repo sandbox, the running app on port 3999 backed by the real local PostgreSQL service, `pypdf` at `/home/user/tools/venv/bin/python`, and `python-pptx` for the existing Slides independent readback. This is not physical-device testing. No Office or Acrobat desktop was run. `pypdf` independently reads the generated PDF's `/UserUnit` values; it does not independently validate physical rendering.

## E. Reproduction

```sh
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db \
  node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt84-wordcount.mts

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db \
ORACLE_PY=/home/user/tools/venv/bin/python BASE=http://localhost:3999 \
  node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt81.mts

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db BASE=http://localhost:3999 \
  node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt80-banner.mts
npx tsc --noEmit
```

The UI screenshots and machine-readable results are committed as `docs/screens/tt84-*.png`, `docs/test-results/tt84-wordcount.json`, `docs/test-results/e2e-tt81.json`, and `docs/test-results/tt80-banner.json` (the latter is the latest 11/11 run).

## F. Measurement definitions

- The tokenization deliberately matches the pre-existing Writer status-bar rule: Unicode letters/numbers, with internal ASCII/curly apostrophes and hyphen/en dash. It is not a locale-sensitive linguistic tokenizer.
- Character totals count grapheme clusters (Intl.Segmenter when available), strip paragraph separators, and for “without spaces” remove whitespace. The fallback counts Unicode code points rather than grapheme clusters.
- Paragraph count in the dialog is the number of non-empty text paragraphs represented by `docText`; blank paragraphs are not counted. The displayed page count is Writer's current paginated view.
- The dialog's document scope is `docText` (the main document body, including modeled body/table paragraphs), not a complete OOXML semantic count.

## G. Limitations and residual attacks

- Word Count is not locale-aware: CJK segmentation, Thai/Khmer word segmentation, language-specific apostrophes, punctuation-number conventions and editor-specific treatment of fields still need corpus comparison against Word/LibreOffice. Headers, footers, footnotes, endnotes, comments, tracked-deletion visibility, text boxes, image text and other non-body parts are outside the reported document total. Selection counts only work for native selections inside the main body.
- Grapheme counting degrades to code points in browsers without `Intl.Segmenter`, so joined emoji may count as multiple characters there. `Intl.Segmenter` and regex tokenization on hostile very large documents need further browser memory/performance profiling; the local stress check is not a maximum-document guarantee.
- The PDF E2E fixture tests two pages and one UserUnit value; it does not independently render physical inch dimensions. PDFium/pypdfium2 ignore `/UserUnit` per the earlier TT83 investigation, so no valid independent physical-render oracle was available in this sandbox. Test more CropBox offsets, rotations, other valid units, oversize pages, and zoom/DPR values before broad parity claims.
- UserUnit rendering in this slice does not establish full PDF fidelity or full document interoperability.

## H. Privacy and resource behavior

The Word Count feature reads the already-open in-memory document and current browser selection only; it adds no network request, persistence, telemetry, dictionary download, or server-side document upload. The E2E fixture upload is test harness behavior. Count computation is linear in text length apart from the platform grapheme segmenter; the modal runs only when opened and uses a snapshot of selection text.

## I. Repair and rerun discipline

The first new PDF E2E attempt exposed two test-harness problems rather than a product defect: it observed a default 300×150 canvas before asynchronous raster completion, and repeated uploads of the same extension shared one VFS path, making cleanup fail after the first purge. The final test now waits for the required backing dimensions and uses a unique per-upload path. The subsequent full suite passed 6/6, the unit suite 4/4, banners 11/11, and TypeScript passed. A first Writer screenshot came from the welcome sample while the keyboard workflow replaced only some visible text; the test was corrected to start through the real New command before typing, then rerun and visually inspected. These repairs are recorded rather than counted as green on their first attempt.

## J. Stopping condition / next blockers

This increment does not establish product-wide Class A. Highest-information next steps: compare the Word Count rules with a controlled Word/LibreOffice locale corpus; test selection boundaries across table cells and paragraphs; verify focus behavior with a screen reader and on mobile; extend `/UserUnit` tests over rotations, offsets, bounds and non-default DPR; and run a real independent PDF renderer that honors `/UserUnit` when one is available. The competing repo was not examined or declared exhausted in this turn.
