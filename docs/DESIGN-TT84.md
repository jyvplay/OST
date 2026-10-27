# TT84 — Model-aware Writer Word Count (FF-82), PDF `/UserUnit` physical-render verification (FF-81), full `FormulaEvalTestData_Copy.xlsx` parity (S5), and Per-Bucket Uninstall Assistant (AP-02 / FM-07)

## Runtime honesty

**Tools and runtimes actually executed in this sandbox:**
- Node.js 22.22.3, TypeScript 5.9.3 (`npx tsc --noEmit`), Next.js 16.2.6 production build (`npm run build`) and production server (`next start -H 0.0.0.0 -p 3999`).
- PostgreSQL 18.4 (`@embedded-postgres/linux-x64`) running locally on `127.0.0.1:5432` (`app_db`), initialized with UTF-8 (`-E UTF8 --locale=C`) via `scripts/sandbox/bootstrap.sh`.
- Real headless Chromium 143 (`@sparticuz/chromium`) driven by Playwright (`scripts/e2e-tt81.mts`, `scripts/tt80-banner.mts`, `scripts/e2e-a11y.mts`) plus `axe-core` 4.14.0 for WCAG 2.2 AA accessibility verification.
- Independent test-only Python 3.11 oracles in `/home/user/tools/venv`:
  - **MuPDF 1.28.5 (`pymupdf`)** — independent C/Python PDF renderer that honors page-dictionary `/UserUnit` (unlike PDFium / `pypdfium2`, which ignores `/UserUnit`), used to verify physical raster dimensions and signature ink placement across all four quarter-turn rotations (`0°`, `90°`, `180°`, `270°`);
  - **`pypdf` 6.21.0** and **`pyHanko` 0.38.0** — independent PDF dictionary/annotation reader and cryptographic CMS signature validator;
  - **`python-docx`** + Python `unicodedata` — independent `.docx` reader and NFC word/paragraph/line oracle for Writer Word Count;
  - **`openpyxl`** + Python `csv` (`scripts/oracle/xlsx_csv.py`) — independent reader of Excel's cached formula values across all 4,158 cells of `FormulaEvalTestData_Copy.xlsx` (`scripts/fixtures/tt81/poi-formulas.xlsx`);
  - **`shapely` 2.2.0 (GEOS)** — independent planar boolean-geometry oracle (`scripts/vector-boolean.mts`).

**Not available / not claimed:**
- No native Microsoft Word, Excel, PowerPoint, or Adobe Acrobat desktop applications were available in this Linux sandbox.
- No physical Android phone/tablet, hardware NPU, or human usability cohort was run.

---

## A. Formal model

### 1. Model-aware Writer Word Count (`FF-82`, `src/lib/office/wordcount.ts`)
- **Admissible objects:** Plain text $T \in \Sigma^*$ (`countWriterText`), a lossless WordprocessingML document $D = (\text{blocks}, \text{notes}, \text{parts})$ (`countWordDoc`), or a model selection range $R = [a, b)$ over $D$'s paragraph offset space (`countWordRange`).
- **Information/access model:** Operates strictly in memory over `WordDoc` / `Range` with zero network I/O or telemetry.
- **Resource counted:** Words $W$, reader-visible grapheme clusters with spaces $C$, grapheme clusters without whitespace $C_{\neg s}$, non-empty paragraphs $P$, and lines $L$, in $O(|D|)$ time and $O(|D|)$ auxiliary space.
- **Success predicate:**
  $$\forall D, R:\quad \text{countWordDoc}(D) \text{ and } \text{countWordRange}(D, R)$$
  must:
  1. Group contiguous Unicode letters, digits, and combining marks (`\p{L}`, `\p{N}`, `\p{M}`) with internal apostrophes/hyphens into single words (`"don't"`, `"re-enter"`, decomposed `"re\u0301sume\u0301"` $= 1$ word each) while counting each CJK Unified Ideograph (`\p{Unified_Ideograph}`) as 1 word;
  2. Count characters by Unicode grapheme clusters (`Intl.Segmenter(..., { granularity: "grapheme" })`);
  3. Exclude tracked deletions (`it.rev?.kind === "del"`, `it.kind === "del"`, deleted table rows `row.rev?.kind === "del"`, deleted table cells `w:cellDel`), inline image labels (`it.kind === "image"`), field codes (`w:instrText`), bookmark/comment anchors, note reference markers, and covered vertical-merge continuation cells (`vmerge === "continue"`);
  4. Merge paragraphs across deleted paragraph marks (`p.markRev?.kind === "del"`) within the same block list;
  5. Count referenced footnotes and endnotes (`doc.notes` referenced by non-deleted note tokens in `doc.blocks`) and report them alongside the main body count.

### 2. PDF `/UserUnit` scaling (`FF-81`, `src/lib/pdf/pdfdoc.ts`, `src/lib/pdf/pdfcanvas.ts`)
- **Admissible objects:** A parsed PDF page $p$ with CropBox $[x_0, y_0, x_1, y_1]$, quarter-turn rotation $r \in \{0, 90, 180, 270\}$, and optional direct or indirect page-dictionary `/UserUnit` $U$.
- **Parameter regime & boundaries:** Valid $U \in [1, 75\,000]$ (absent $\Rightarrow 1$). Values outside $[1, 75\,000]$ or non-numeric values fall back to $1$ with a recorded warning. `/UserUnit` on a parent `/Pages` node is not inherited per ISO 32000-2 §7.7.3.3. Display view scale is capped at $\le 4096$ CSS px per side and $\le 2\times 10^6$ CSS px area; direct rendering refuses backing canvases exceeding $8192$ px per side or $8\times 10^6$ px area before allocation.
- **Success predicate:** For every valid $U \in [1, 75\,000]$, rotation $r \in \{0, 90, 180, 270\}$, and CropBox offset, `pageTransform(p, s, viewRot)` scales both dimensions and the affine matrix by $U$, agrees with **MuPDF 1.28.5 (`pymupdf`)** physical pixmap dimensions and rendered signature ink bounding boxes, and aligns live viewer text-search highlights and the Info panel.

### 3. Per-Bucket Uninstall & Data Hygiene Assistant (`AP-02` & `FM-07`, `src/lib/storage-core.ts`, `/api/storage`, `Storage.tsx`)
- **Admissible objects:** The 8 user-owned PostgreSQL storage buckets $B_{\text{srv}} = \{\texttt{vfs\_user}, \texttt{trash}, \texttt{versions}, \texttt{notes}, \texttt{alerts}, \texttt{planner}, \texttt{settings}, \texttt{sessions}\}$ plus the browser origin storage bucket $B_{\text{cli}}$ (`localStorage` + `sessionStorage`). Protected system tables (`features`, `spikes`, `license_authority`) and `/System` VFS files are outside the admissible purge set.
- **Success predicate:**
  $$\forall S \subseteq B_{\text{srv}} \text{ with } S \neq \emptyset:\quad \text{preview}(S) \text{ mutates } 0 \text{ rows and returns exact } (\text{rows}_b, \text{bytes}_b)_{b \in S},$$
  and $\text{purge}(S, \text{confirm})$ succeeds iff $\text{confirm} = \texttt{"DELETE"}$, after which $\forall b \in S: (\text{rows}'_b = 0 \wedge \text{bytes}'_b = 0)$ and $\forall b \notin S \setminus \{\texttt{sessions}\}: (\text{rows}'_b = \text{rows}_b \wedge \text{bytes}'_b = \text{bytes}_b)$.

---

## B. Outcome space

- **H+ (Achieved for the bounded contracts above):**
  - `FF-82` (Writer Word Count), `FF-81` (PDF `/UserUnit` viewer scaling), `AP-02` (Per-bucket uninstall assistant — eliminating the last `skeleton` row in the 414-row register), and `FM-07` (Storage overview + digest duplicates) pass static typechecking, unit + property tests, mutation testing (`10/10` killed), and real-browser Chromium E2E with `axe-core` accessibility verification.
  - All 4,158 formula/value cells across all 4 sheets of `FormulaEvalTestData_Copy.xlsx` (`EverythingTests`, `FinanceLibTests`, `StatsLibTests`, `misc`) now agree with Excel's cached values (`0` disagreements, closing `G716`, `D872`, `E872`, `M936`).
- **H− (Impossible under browser/platform constraints):**
  - The 21 platform-blocked rows (e.g., raw Miracast sender, system-wide virtual camera for third-party native apps, sideloading APKs) remain honestly declared `blocked`.
- **H∂ (Boundary conditions):**
  - Word Count uses deterministic Unicode property + CJK ideograph rules rather than dictionary-based Thai/Khmer morphological segmentation.
  - PDF `/UserUnit` caps supported multipliers at $75\,000$ and raster backing surfaces at $8\text{ MP}$.

---

## C. Frontier and resolved blockers from TT81–TT84

1. **Register & Ledger Pipeline Blocker (`FF-81`, `FF-82`, `archive` icon):**
   - `e2e-tt81.mts` and `tt84-wordcount.mts` tagged `FF-81` and `FF-82`, which were missing from `src/db/seed-data/features-tt81.ts`, causing `scripts/ledger.mjs` to exit 1 (`Tests reference unknown feature codes: FF-81, FF-82`). Both rows are now registered in `features-tt81.ts`, and `archive` is registered in `MODULE_ICONS` (`src/lib/icon-data.ts`), restoring `a11y-unit` (8/8) and `scripts/ledger.mjs`.
2. **Independent Physical-Render Oracle for `/UserUnit` (`FF-81`):**
   - TT83/TT84 noted that `pypdfium2` (PDFium) ignores `/UserUnit`. We verified that **MuPDF 1.28.5 (`pymupdf`)** honors `/UserUnit` and added multi-rotation (`0°`, `90°`, `180°`, `270°`), CropBox-offset, indirect-reference (`/UserUnit N 0 R`), and visible-signature ink bounding-box verification against MuPDF in `P4` (`tt81-core.mts`) and `E4` (`e2e-tt81.mts`).
3. **Model-Aware Word Count (`FF-82`):**
   - TT84's initial `countWriterText(docText(d))` counted struck-out tracked deletions (`w:del`), deleted table rows, and inline image labels (`"image"` / `descr`), and split words at combining marks (`\p{M}`). `countWordDoc` and `countWordRange` in `src/lib/office/wordcount.ts` now walk the `WordDoc` model directly, excluding tracked deletions, images, note markers, and covered merged cells, merging paragraphs across deleted paragraph marks, and counting referenced footnotes/endnotes.
4. **Full `FormulaEvalTestData_Copy.xlsx` Differential (`S5` in `tt81-core.mts`):**
   - Verified all 4,158 cells across all 4 sheets of `scripts/fixtures/tt81/poi-formulas.xlsx` against `scripts/oracle/xlsx_csv.py`: `4158/4158` agree (`0` disagreements).
5. **Last Remaining `skeleton` Row in the 414-Row Register (`AP-02` + `FM-07`):**
   - Implemented `src/lib/storage-core.ts`, upgraded `/api/storage` (`GET` + `POST` `preview`/`purge`), and upgraded `src/components/modules/Storage.tsx` with a per-bucket preview and `DELETE`-confirmed purge workflow. `skeleton` count in the 414-row register is now **0**.

---

## D. Negative space (≥ 15 invalid shapes rejected and tested)

1. Splitting a single word at a Unicode combining mark (`"cafe\u0301s"` counted as 2 words) — rejected & tested (`W9`, `M1`).
2. Counting an entire paragraph of CJK ideographs as 1 word — rejected & tested (`W9`, `M2`).
3. Counting struck-out tracked deletions (`w:del` runs) in Writer Word Count — rejected & tested (`W10`, `E5`, `M3`).
4. Counting inline image filenames/alt-text (`makeImage`) as words in Writer Word Count — rejected & tested (`W10`, `M4`).
5. Counting deleted table rows (`w:trPr/w:del`) or deleted cells (`w:cellDel`) in Writer Word Count — rejected & tested (`W10`, `M5`).
6. Counting two paragraphs merged by a tracked paragraph-mark deletion (`markRev.kind === "del"`) as separate paragraphs — rejected & tested (`W11`, `M6`).
7. Counting footnote/endnote reference superscripts or list bullet markers in a selection word count — rejected & tested (`W11`).
8. Leaving `/UserUnit` unresolved when stored as an indirect PDF object (`N 0 R`) — rejected & tested (`P4`, `M9`).
9. Inheriting `/UserUnit` from a parent `/Pages` dictionary — rejected & tested (`P4`, `M10`).
10. Allocating an unbounded backing canvas when `/UserUnit` is large ($75\,000$) — rejected & tested (`P4`).
11. Accepting a purge request without the exact confirmation string `"DELETE"` (e.g. `"delete"`, `"yes"`, `true`, or missing) — rejected & tested (`U1`, `E6`, `M7`).
12. Allowing the uninstall assistant to target protected system tables (`features`, `spikes`, `license_authority`) or `/System` VFS files — rejected & tested (`U1`, `E6`).
13. Mutating rows during a `preview` call — rejected & tested (`U2`, `E6`).
14. Leaving residual rows in a purged bucket or mutating an unselected bucket during `purge` — rejected & tested (`U2`, `E6`, `M8`).
15. **Modal-shortcut failure test:** Adding a second control or mismatched `aria-label` inside a modal dialog that breaks keyboard focus trapping or WCAG 2.5.3 `label-content-name-mismatch` (`E5` single-control `Tab` trap in Word Count; `E6` `axe-core` audit on the Uninstall preview modal).

---

## E. Mechanism portfolio

| # | Mechanism | Concrete artifact | Proved portion | Open interface | Cheapest falsification | Gap class |
|---|---|---|---|---|---|---|
| 1 | Unicode grapheme + script-aware word tokenizer | `countWriterText` in `src/lib/office/wordcount.ts` | Combining marks, apostrophes/hyphens, CJK ideographs, ZWJ emoji, 20k-word linearity (`W1`–`W9`) | Dictionary-based Southeast Asian segmentation (Thai/Khmer) | `M1`, `M2` in `tt84-mutants.py` | Local linguistic scope |
| 2 | Lossless `WordDoc` AST walker for counts & ranges | `countWordDoc`, `countWordRange` in `src/lib/office/wordcount.ts` | Excludes `w:del` runs, deleted rows/cells, images, note refs; merges deleted paragraph marks; counts referenced notes (`W10`–`W12`, `E5`) | Unmodeled SmartArt / chart text | `M3`–`M6` in `tt84-mutants.py` | Local model boundary |
| 3 | Page-local affine `/UserUnit` scaling + MuPDF oracle | `pdfdoc.ts`, `pdfcanvas.ts`, `P4` in `tt81-core.mts`, `E4` in `e2e-tt81.mts` | Direct & indirect `/UserUnit`, CropBox offsets, 4 rotations, 8 MP guard, MuPDF pixel & signature-ink parity | Physical printer driver scaling | `M9`, `M10` in `tt84-mutants.py` | External desktop viewer |
| 4 | Full `FormulaEvalTestData_Copy.xlsx` differential | `S5` in `scripts/tt81-core.mts` + `scripts/oracle/xlsx_csv.py` | 4,158 / 4,158 cells across all 4 sheets match Excel's cached values (`0` disagreements) | External add-in / iterative-calc workbooks in `X1_ALLOW` | Mutate `LOOKUP` / `MODE` provenance | Local corpus breadth |
| 5 | Verifiable per-bucket preview & guarded purge state machine | `src/lib/storage-core.ts`, `/api/storage/route.ts`, `Storage.tsx` | Live SQL row/byte preview, `DELETE` gate, `/System` & spec protection, `verifyPostPurge` invariant (`U1`–`U3`, `E6`) | OS-level PWA icon removal (browser-owned) | `M7`, `M8` in `tt84-mutants.py` | Browser platform boundary |
| 6 | Live 11-app banner + accessibility gate | `scripts/tt80-banner.mts`, `scripts/a11y-unit.mts`, `scripts/e2e-a11y.mts` | All 11 creative apps pass banner audit (`11/11`) with live PostgreSQL; `a11y-unit` `8/8`; `e2e-a11y` `9/9` | Non-Chromium browser engines | `axe-core` in `E3`, `E5`, `E6` | Cross-browser |

---

## F. Concrete artifacts

- **Production code:**
  - `src/lib/office/wordcount.ts` (`countWriterText`, `countWordDoc`, `countWordRange`, `countableRangeText`)
  - `src/components/modules/Writer.tsx` (status bar & Word Count modal wired to `countWordDoc` and `countableRangeText`)
  - `src/lib/storage-core.ts` (`SERVER_BUCKETS`, `validateBucketSelection`, `validatePurgeRequest`, `summarizePreview`, `verifyPostPurge`, `inspectBrowserStorage`, `clearBrowserStorage`)
  - `src/app/api/storage/route.ts` (`GET` bucket metrics + `POST` `preview` and `purge`)
  - `src/components/modules/Storage.tsx` (`AP-02` Uninstall & data assistant UI + accessible preview/confirm modal)
  - `src/lib/icon-data.ts` (`archive` module icon registration)
  - `src/db/seed-data/features-tt81.ts` & `src/db/seed.ts` (`FF-81`, `FF-82`, `patchTT84` for `AP-02` and `FM-07`, `SEED_VERSION = "3.69.0"`)
- **Tests, fixtures & mutation runners:**
  - `scripts/tt84-wordcount.mts` (`15/15` passing: `W1`–`W12` + `U1`–`U3`)
  - `scripts/tt81-core.mts` (`13/13` passing: `S1`–`S5`, `L1`–`L4`, `P1`–`P4` with MuPDF & openpyxl oracles)
  - `scripts/e2e-tt81.mts` (`7/7` passing in real Chromium 143: `E1`–`E7`)
  - `scripts/tt84-mutants.py` (`10/10` mutants killed)
  - `scripts/tt52/mkpdf.ts` (`indirectUserUnit` and `crop` support)
  - `scripts/integration.mts` (`25/25` passing)
- **Visual captures (inspected):**
  - `docs/screens/tt84-pdf-unit.png`
  - `docs/screens/tt84-writer-count.png`
  - `docs/screens/tt84-storage-uninstall.png`

---

## G. Second-order adversary & mutation results (`scripts/tt84-mutants.py`)

| Mutant | Target | Result |
|---|---|---|
| `M1` Drop `\p{M}` from `WORD_RE` (split decomposed accented words) | `src/lib/office/wordcount.ts` | **KILLED** (`W9`, `W12`) |
| `M2` Group CJK ideographs into single multi-character words | `src/lib/office/wordcount.ts` | **KILLED** (`W9`) |
| `M3` Ignore `it.rev?.kind === "del"` (count struck-out tracked deletions) | `src/lib/office/wordcount.ts` | **KILLED** (`W10`) |
| `M4` Include inline image `it.label` in `countableInlineText` | `src/lib/office/wordcount.ts` | **KILLED** (`W10`) |
| `M5` Count deleted table rows (`r.rev?.kind === "del"`) | `src/lib/office/wordcount.ts` | **KILLED** (`W10`) |
| `M6` Do not merge paragraphs across deleted paragraph marks (`markRev`) | `src/lib/office/wordcount.ts` | **KILLED** (`W11`) |
| `M7` Accept case-insensitive `"delete"` confirmation token | `src/lib/storage-core.ts` | **KILLED** (`U1`) |
| `M8` Skip residual-row check in `verifyPostPurge` | `src/lib/storage-core.ts` | **KILLED** (`U2`) |
| `M9` Do not resolve indirect `/UserUnit` reference (`N 0 R`) | `src/lib/pdf/pdfdoc.ts` | **KILLED** (`P4`) |
| `M10` Inherit `/UserUnit` from parent `/Pages` dictionary | `src/lib/pdf/pdfdoc.ts` | **KILLED** (`P4`) |

**Score: 10/10 mutants killed.**

---

## H. Verification summary

| Gate | Command / Oracle | Result |
|---|---|---:|
| TypeScript strict check | `npx tsc --noEmit` | **0 errors** |
| Production Next.js build | `DATABASE_URL=... npm run build` | **passed** |
| `scripts/tt84-wordcount.mts` | `W1`–`W12` (`python-docx` oracle) + `U1`–`U3` (`storage-core`) | **15/15** |
| `scripts/tt81-core.mts` | `S1`–`S5` (4,158 POI cells), `L1`–`L4` (`python-pptx`), `P1`–`P4` (`pypdf`, `pyHanko`, `PDFium`, `MuPDF`) | **13/13** |
| `scripts/e2e-tt81.mts` | Real Chromium 143 + `axe-core` (`E1`–`E7`) | **7/7** |
| `scripts/tt80-banner.mts` | All 11 creative apps audited in Chromium with live PostgreSQL | **11/11** |
| `scripts/a11y-unit.mts` & `e2e-a11y.mts` | Contrast, `fz()` enforcement, glyph coverage (`archive` icon added), ARIA/axe | **8/8 & 9/9** |
| `scripts/vector-boolean.mts` | Pathfinder boolean ops vs GEOS (`shapely`) | **6/6** |
| `scripts/integration.mts` | HTTP API integration suite | **25/25** |
| `scripts/tt77-pdf-composite.mts` & `tt77-pdfsig.mts` | PDF transparency/blend vs PDFium + 972-file corpus signature check | **18/18 & 23/23** |
| `scripts/tt84-mutants.py` | 10-mutant adversary across `wordcount.ts`, `storage-core.ts`, `pdfdoc.ts` | **10/10 killed** |
| Live Ledger (`scripts/ledger.mjs`) | 414 features: **340 built / 53 partial+probe / 21 blocked / 0 skeleton**; **1655/1655 tests passing** | **0 failing touches** |

---

## I. Repairs performed and re-tested this turn

1. **Mutant `M5` survivor repair:** On the first run of `scripts/tt84-mutants.py`, `M5` (`if (r.rev?.kind === "del") continue;`) survived because `E.tableRowOp(..., "delete")` marks both `row.rev` and the runs inside the row as `del`. External WordprocessingML files can mark `<w:trPr><w:del/></w:trPr>` or `<w:tcPr><w:cellDel/></w:tcPr>` without run-level `<w:del>`. We added `w:cellDel` handling in `wordcount.ts` and added an explicit row-level `w:trPr/w:del` assertion in `W10`. Re-running `tt84-mutants.py` killed **10/10** mutants.
2. **WCAG 2.5.3 `label-content-name-mismatch` repair in `Storage.tsx`:** On the first run of `e2e-tt81.mts` `E6`, `axe-core` flagged `label-content-name-mismatch` because the bucket `<input type="checkbox">` elements had `aria-label={b.label}` inside a `<label>` that also contained `b.description`, and the `Cancel` button had `aria-label="Close uninstall preview"`. Removing the redundant/mismatched `aria-label` attributes so the accessible name matches the visible text resolved the violation; `e2e-tt81.mts` passed **7/7** with 0 `axe-core` violations.
3. **Screenshot framing repair:** The initial `E6` screenshot captured `app.screenshot()` which clipped the right side of the centered portalled modal; switching to `page.screenshot()` captured the full desktop, Storage window, and modal cleanly (`docs/screens/tt84-storage-uninstall.png`).

---

## J. Stopping condition and next highest-information tests

All mandatory verification gates for `FF-81`, `FF-82`, `AP-02`, `FM-07`, and `S5` (`FormulaEvalTestData_Copy.xlsx`) pass, and the register now has **0 `skeleton` rows** (`340` fully built, `265` fully tested, `1655/1655` automated tests passing).

**Next highest-information tests for subsequent turns:**
1. Upgrade remaining `partial` Tier-A rows (such as `PR-07n` Find in page, `PR-07o` Browser profiles, `SH-13` PWA LaunchQueue file-open flow, and `AP-01` / `AP-05` App & background inventory) with end-to-end Chromium tests.
2. Add dictionary-assisted segmentation for script families without inter-word spaces beyond CJK ideographs (Thai/Khmer/Lao) if multilingual locale parity is targeted.
