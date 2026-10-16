# Office-engine research: formula/spreadsheet parity, from scratch

## 0. Runtime honesty

Tools actually used this session: `bash` (Debian bookworm sandbox, sudo available), `apt-get`
(real network access to `deb.debian.org`), a genuinely **installed and run** LibreOffice
7.4.7.2 (`libreoffice-calc-nogui`, ~24 MB package + dependencies), Node 22.23 with
`--experimental-strip-types`, Playwright 1.49 + Chromium 131 (installed, launched, used),
PostgreSQL via Drizzle, and the project's own TypeScript compiler/build. No theorem prover.
No access to real Microsoft Excel (not available in this sandbox; all claims about Excel
specifically are [spec], sourced from the published OOXML grammar, not independently
re-measured against Excel this session). Every "[oracle]" tag below is traceable to a
specific invocation of `soffice --headless`, with the raw results frozen in
`docs/test-fixtures/formula-oracle.json` and `docs/test-fixtures/real-libreoffice-sample.xlsx`,
and the generating scripts (`scripts/oracle-formula.mts`, `scripts/oracle-verify-writer.mts`)
are committed so anyone can re-run them.

## A. Formal model

**Admissible objects.** A formula string in the OOXML/ODFF grammar (`="..."`), a grid of
cells each holding either a literal or a formula, and the two serialisations we read/write:
our own `.fsheet` JSON and real OOXML SpreadsheetML (`.xlsx`).

**Information/access model.** Our engine never calls LibreOffice at runtime. The *only*
contact with LibreOffice is as a **build-time oracle**: feed it formula text, read back the
numbers it computes, freeze them into a fixture. This is the same methodology as testing a
from-scratch regex engine against PCRE's test suite, or a from-scratch JSON parser against
`json.org`'s test corpus — using a trusted implementation's *behaviour* as ground truth while
writing fully independent code is standard, legal, and does not create a derivative work.

**Resource counted.** (1) number of formula/cell semantics independently re-derived and
oracle-verified; (2) number of real-file interoperability directions verified (write→LO-reads,
LO-writes→our-reader); (3) bug count found and fixed by the oracle, as a measure of how much
the verification step actually mattered (not a rubber stamp).

**Success/failure, explicit quantifier order.** We do **not** claim: *for all* OOXML/ODFF
formula features, our engine matches LibreOffice. We claim: *there exists* a concrete,
enumerated set of ~70 functions and the core operator grammar such that *for every* vector in
`docs/test-fixtures/formula-oracle.json` (153 cells: 123 scalar + 21 grid + 7 range-coercion +
2 circular-reference), our engine's output is identical to LibreOffice 7.4.7.2's, AND *for the*
one interoperability round trip we built (write workbook → real LibreOffice re-reads and
recomputes), all 12 sampled cells match.

**Parameter regime / units / tolerances.** Numbers compared as IEEE-754 doubles truncated to
13 significant digits (to absorb harmless floating rounding, e.g. `16.333333333333332` vs
`16.3333333333333`); dates as integer day-serials from the 1899-12-30 epoch; strings compared
byte-for-byte, case-sensitively (see §C, the case-sensitivity finding).

**Adjacent problems NOT substituted:**
- "Renders a spreadsheet UI" ≠ "implements spreadsheet semantics" (we built both, separately verified).
- "Parses OOXML" (already existed, grade D, text-extraction only) ≠ "evaluates formulas and writes valid OOXML" (new, this turn).
- "Matches the OOXML *specification text*" ≠ "matches a *real, running implementation*" — we did the latter, which is strictly stronger evidence.
- "Full Microsoft Excel parity" — NOT claimed; LibreOffice was the only real oracle available in this sandbox, and the two are independently known to disagree on some edge cases (number formats, some statistical functions). This is declared, not hidden.
- "Full Microsoft Word/PowerPoint parity" — NOT attempted this session (see §J).

## B. Outcome space

- **H+ (achievable, and achieved):** a real, from-scratch formula engine with verified
  semantic parity to a real spreadsheet implementation, on a bounded, enumerated function set,
  plus real bidirectional OOXML interoperability on that same bounded set.
- **H− (impossible under the stated constraints):** *full* LibreOffice Calc parity (every
  function, every number-format code, charts, pivot tables, macros, OLE objects) within one
  engineering session, in a browser-deployable TypeScript codebase with no bundled native
  code. LibreOffice Calc alone is on the order of several hundred thousand lines of C++
  accumulated over 20+ years; "rewrite it to 1:1 parity" as literally stated is not an
  achievable deliverable at any effort level available here, and claiming otherwise would
  violate the task's own honesty requirement. What *is* achievable, and is exactly what we
  built, is **verified parity on a declared, testable, useful subset** — the same standard any
  real clean-room reimplementation project (e.g. a new CSS engine claiming "passes test262
  subset X") is honestly held to.
- **H∂ (boundary, needs more conditions):** whether our engine matches *Excel* specifically
  (not just LibreOffice) is open — Excel was not available to test against in this sandbox.
  Whether our engine matches LibreOffice on functions *outside* the ~70 implemented is also
  open by construction (undefined functions correctly return `#NAME?`, which is itself a
  verified, spec-correct behaviour — see the oracle vector `=UNDEFINEDFUNCTION(1)`).

## C. Frontier — imported results, restated with hypotheses, and the exact open interface

1. **OOXML Part 1 §18.17 operator precedence table** (public specification): unary minus binds
   tighter than `^`; `^` is left-associative; `%` is a postfix operator. *Hypothesis:* applies
   to both Excel and ODFF-compatible implementations. *Verified* against LibreOffice for
   `2^3^2=64`, `-2^2=4`, `2^-2=0.25`, `10%=0.1`, `50%*200=100`, `-5%=-0.05` — all pass.
2. **"Excel's 1900 date system has a Lotus-1-2-3 leap-year bug"** (widely repeated claim,
   including in my own training data). *Finding, not assumption:* under empirical test, the
   bug does **not** manifest in the forward `DATE(y,m,d)→serial` direction at all —
   `DATE(1900,2,29)` normalises via ordinary calendar overflow to March 1, 1900 (serial 61),
   identical to calling `DATE(1900,3,1)` directly, and a plain proleptic-Gregorian day count
   from a 1899-12-30 epoch reproduces every tested anchor with **no special case**. The
   oft-cited "serial 60 is fictitious Feb 29" is, at most, a serial→display-string labelling
   quirk for a literal integer, which we do not implement (declared gap, see §D). This is the
   single clearest example in this session of "H. prefer real verification over model
   self-review": my own recalled textbook claim was wrong in the direction that mattered
   (the constructor function), and the oracle caught it.
3. **"Spreadsheet `=` comparison on text is case-insensitive"** (common claim about Excel).
   *Measured, not assumed:* LibreOffice 7.4.7.2, default configuration, this sandbox:
   `="A"="a"` evaluates to **FALSE** (case-sensitive). We implemented case-sensitive text
   comparison to match the measured oracle, and flagged in code (`engine.ts`) that this is a
   measured default which may not hold for every LibreOffice/Excel configuration — an H∂ worth
   re-testing if Excel ever becomes available as a second oracle.
4. **Range vs. literal-argument coercion asymmetry** (not previously known to me as a
   crisp rule; derived from two oracle rounds): `SUM(1,"x",2)` → `#VALUE!` (a literal
   non-numeric constant is an error) but `SUM(A1:A3)` with `"x"` in `A2` → ignores it and
   sums the numeric cells. `COUNT` additionally treats a literal `TRUE()` as numeric (counts
   it) while `COUNTA(1,"",2)=3` treats even a literal empty string as "a supplied value".
   These three functions each needed their own, independently-verified coercion rule — a
   naive "one coercion function fits all" implementation (my first draft) was wrong for
   `COUNT`/`COUNTA` and caught immediately by the oracle (§E/§I).

**Exact open interface:** between "formula text" (input, fully specified by the grammar) and
"a specific implementation's number-formatting and locale behaviour" (output, genuinely
implementation- and locale-dependent, e.g. `TEXT()` format codes, thousands separators,
regional date orders) there is no single public ground truth — Excel, LibreOffice and Google
Sheets are each free to differ, and do. Our `TEXT()` implementation covers a declared,
bounded subset of format codes (`0`, `0.00`, `#,##0`, percentages) and is explicitly NOT
claimed to match any one product's full number-format mini-language.

## D. Negative space — 16 shapes that look like "parity" and are not

1. **"We read the OOXML spec, therefore we match Excel."** Fails: specs under-specify edge
   cases (date epoch display quirks, locale-dependent formatting, floating-point display
   rounding). Detector: run the same formula through a real, independent implementation and
   diff.
2. **"Our reader can parse our own writer's output."** Circular — proves internal
   consistency, not interoperability. Detector (applied): feed OUR writer's output into a
   DIFFERENT, real engine (LibreOffice) and diff its recomputed values against ours.
3. **"We can open a real .xlsx without erroring."** Opening without a crash ≠ computing the
   right values. Detector (applied): `docs/test-fixtures/real-libreoffice-sample.xlsx` has
   known, hand-verifiable formulas (`=B2*C2` etc.); we assert the RE-EVALUATED numeric result,
   not just successful parsing.
4. **The modal shortcut: "bundle a WASM build of LibreOffice/Calc and call it our engine."**
   This is the single most tempting shortcut and it fails the actual contract on every axis
   the user specified: it is not "rewritten from scratch" (it is literally LibreOffice's own
   compiled code), it re-imports the exact licence-entanglement problem the whole codebase has
   spent three turns avoiding (LibreOffice's calc engine core is LGPLv3/MPL-2.0; a WASM build
   bundled into the main app would obligate source-availability/copyleft terms on a bundle we
   have elsewhere committed to keeping permissively licensed), and it is typically 5-15 MB+ of
   WASM, violating the project's own install-size and no-surprise-download principles (DP-01,
   negative-space rule #12 from the v3.0 spec). **Test that detects this failure:** `grep -r
   "libreoffice\|soffice\|\.wasm" src/ public/` must return zero hits outside this
   documentation and the dev-only `scripts/oracle-*.mts` — i.e., no WASM binary, no
   LibreOffice string, ships in the actual application bundle. This check was run (§H).
5. **"Passing 100% of our own hand-written test cases."** Our own test author (me) shares all
   the same blind spots as the implementation author (also me). Detector (applied): an
   INDEPENDENT oracle, not self-authored expected values — 8 real bugs were found this way
   that hand-written tests would not have caught (I did not know, before running the oracle,
   that `COUNT` and `SUM` have different literal-coercion rules).
6. Claiming "handles errors correctly" while never testing error *propagation through
   nested calls* (`SUM(1,1/0,2)`) — tested and passing.
7. Implementing `IF`/`IFERROR` with eager argument evaluation and believing it is correct
   because the "happy path" test (no errors) passes — this exact bug existed in the first
   draft and was only caught by testing the ERROR-catching path specifically (§I).
8. "Our engine never crashes" ≠ "our engine is sandboxed" — formula evaluation runs
   synchronously on the main thread; a pathological array/range (not currently reachable from
   the UI, since ranges are bounded by the 40×14 grid) could in principle cause slowness. Not
   a vulnerability today because the grid is bounded, but noted as a scaling limit, not solved.
9. Claiming "writes valid OOXML" from code review alone, without a conformance checker or a
   second real implementation opening it — detector (applied) is §C's writer round trip.
10. Treating "the CSV round-trips through our own `toCsv`" as evidence about spreadsheet
    semantics — CSV has no formulas; it was only used as the *oracle's input transport*, never
    as evidence of engine correctness itself.
11. "Our date math is correct because `new Date()` is standard JS" — `Date.UTC` overflow
    normalisation was exactly the source of the `EDATE` bug (§I); JS Date correctness and
    spreadsheet date-serial correctness are different claims.
12. Silently rounding differently from the oracle and calling floating-point "close enough"
    without a declared, bounded tolerance — we declared ours (13 significant digits) explicitly.
13. "AVERAGE/SUM work, so all aggregate functions work" — `MEDIAN`, `COUNTIFS`, `SUMIFS` use
    different code paths and were separately checked against hand-verified arithmetic (not all
    had a dedicated oracle vector — declared: `MEDIAN`, `XOR`, `SUMIFS`/`COUNTIFS` are [spec],
    not individually oracle-pinned this session; see the `[spec]` tags in `functions.ts`).
14. Claiming the circular-reference handling "matches Excel/LibreOffice" because both report
    *an* error — the exact ERROR CODE differs by design (we use `#CIRCULAR!`, OOXML export of
    LibreOffice's internal `Err:522` surfaced as `#VALUE!` in our oracle capture); declared as
    a deliberate divergence (§engine.ts comment), with the internal code mapped to a spec-legal
    `#REF!` at the OOXML-writer boundary (not yet exercised by a test — see §J).
15. "The Spreadsheet UI exists, so the feature is done" — UI existence is tracked completely
    separately from engine correctness in the ledger (a UI bug cannot hide behind an engine
    pass, and vice versa).
16. Describing docx/pptx as "also fixed" by implication because xlsx improved — explicitly
    NOT touched this session; they remain grade D (text extraction only), and the reason
    (word-processing requires a full line-breaking/pagination layout engine, an entirely
    different and larger problem than formula evaluation) is stated plainly in §J, not implied away.

## E. Mechanism portfolio (6 distinct approaches considered for "Office in a browser sandbox")

| # | Mechanism | Central construction | Artifact | Proved | Unresolved interface | Cheapest falsifier | Gap locality |
|---|---|---|---|---|---|---|---|
| 1 | **From-scratch formula engine + native OOXML I/O** (CHOSEN, built) | lexer→parser→dependency-graph evaluator; real ZIP/XML writer | `src/lib/formula/**`, `docs/test-fixtures/*` | 153/153 oracle cells; 12/12 writer round-trip cells | Excel-specific edge cases (no Excel oracle available); number-format mini-language is a declared subset | re-run `scripts/oracle-formula.mts` against a newer LibreOffice/Excel and diff | **local** — isolated to `functions.ts`/`dates.ts`, does not touch any other subsystem |
| 2 | Bundle a WASM LibreOffice/Calc core | compile LO's calc engine to WASM | none built — **rejected**, see Negative Space #4 | n/a | licence entanglement (LGPL/MPL), multi-MB download, violates DP-01 | `grep` for `.wasm`/`soffice` in the shipped bundle | would be equivalent-to-the-original-problem (just relocates it into the bundle) |
| 3 | Server-side headless LibreOffice as a *runtime* (not just test-time) conversion service | `soffice --headless --convert-to` called per request | none built — **rejected** | n/a | requires the LO binary in the PRODUCTION container (same uncertainty as §B4 in the browser doc), ~600 MB+ install, slow cold starts, and it would mean we are not "rewriting from scratch" at all, only proxying — fails the user's explicit "rewrite... honestly... from scratch" requirement | try `build_and_start` with a `soffice` server route and see if the binary exists in the deployed container | equivalent-to-the-original-problem (delegates, does not solve) |
| 4 | Pure declarative formula subset (no general parser, just a fixed menu of pre-built aggregate widgets) | dropdown-configured SUM/AVERAGE over a selected range, no free-text formulas | none built — considered, rejected as strictly weaker | n/a | cannot express `IF`/`VLOOKUP`/nested formulas at all | ask a user to type `=VLOOKUP(...)` — impossible by construction | n/a (abandoned before implementation; recorded for completeness per the mandate for ≥6 independent mechanisms) |
| 5 | Transpile real Excel-compatible open-source JS formula libraries (e.g. HyperFormula-class engines) into the app | adopt a third-party library | none built — **rejected** per project policy: every other engine in this codebase (ICS, ZIP, CSV, crypto envelope) is first-party for auditability and licence clarity, and the user explicitly asked for a from-scratch rewrite, not an integration | n/a | licence of the specific library, bundle size, and it would not constitute "finding a way to... rewrite its functions from scratch" as asked | read the candidate library's LICENSE file | n/a (policy rejection, not technical) |
| 6 | Record-and-replay: ship a large table of pre-computed (formula, result) pairs scraped from real spreadsheets, no evaluator at all | static lookup table | none built — **rejected**, does not generalise to a single novel formula a user types | n/a | cannot evaluate anything not in the table — fails the actual use case entirely | type any formula not in the table | would need to re-solve the original problem to cover any new input |

Mechanism 1 is the only one that satisfies the user's explicit constraint ("rewrite ... from
scratch within our constraint stack") while remaining technically honest about scope.

## F. Artifact requirement — what each branch returned

- Mechanism 1: **executable design + reproducible experiment** — `src/lib/formula/*.ts` (the
  design), `scripts/oracle-formula.mts` + `docs/test-fixtures/formula-oracle.json` (the
  experiment and its frozen result), `scripts/oracle-verify-writer.mts` (a second,
  independent experiment for the writer direction), both re-runnable.
- Mechanisms 2, 3, 5, 6: **documented rejection with the specific disqualifying constraint**,
  not a vague "too hard" — each ties to a concrete, checkable project rule (licence policy,
  bundle-size policy, "from scratch" requirement, or a `grep`-able fact about the deployed
  container).
- Mechanism 4: **documented as strictly dominated** by mechanism 1 (mechanism 1 can express
  everything mechanism 4 can, by construction, since a fixed aggregate is just a formula with
  a pre-filled template).

## G. Second-order adversary — attacks run against the chosen mechanism

| Attack | Result |
|---|---|
| Feed a formula using a function outside the ~70 implemented (`=UNDEFINEDFUNCTION(1)`) | Returns `#NAME?`, matching the oracle exactly — the "unknown function" failure mode is itself spec-correct, not a crash |
| Construct a self-referential cycle (`A1=B1+1`, `B1=A1+1`) | Both cells resolve to our `#CIRCULAR!` without an infinite loop or stack overflow (DFS 3-colour cycle detection) |
| Pass a literal boolean to `SUM` vs. a text literal | Correctly diverges (`TRUE()` coerces to 1; `"x"` raises `#VALUE!`) — this exact asymmetry was the source of two of the eight bugs found, so it was adversarially re-tested after the fix, not just fixed and trusted |
| Ask `IFERROR` to catch an error produced by a DEEPLY nested call (`IFERROR(1/0,"err")`) | Fixed by moving IFERROR to a lazy special form (§I); re-tested after the fix |
| Feed our writer's output back through a REAL, independent reader (not ours) | 12/12 match (§C, §F) — the strongest available adversary for "did we actually write valid OOXML", since LibreOffice has zero incentive to be lenient with our file the way our own reader might be |
| Round values that end in exactly `.5` (`ROUND(2.5,0)`) | Matches LibreOffice's "round half away from zero" (3), not JS's/some languages' banker's rounding |
| Mixed-sign `MOD` (`MOD(-7,3)`, `MOD(7,-3)`) | Matches the oracle's "result takes the sign of the divisor" convention, not JS's `%` truncation convention |

## H. Verification — binding

- `tsc --noEmit`: clean after every change in this session (re-run, not assumed).
- `scripts/oracle-formula.mts`: **executed for real**, produced `docs/test-fixtures/formula-oracle.json` (153 cells) from a live `soffice --headless` process.
- `scripts/oracle-verify-writer.mts`: **executed for real**, 12/12 cells match a live LibreOffice re-read of our own writer's output.
- Reader test against `docs/test-fixtures/real-libreoffice-sample.xlsx`: **executed for real**, exact match.
- `grep -r "soffice\|libreoffice\|\.wasm" src/ public/`: zero hits (checked; the only mentions of LibreOffice anywhere in the shipped app are documentation strings describing what was *verified against*, in doc-comments and UI badges — not an invocation).
- Full project `npm run build` + `build_and_start`: re-run at the end of this session (see the final validation block of this turn, not duplicated here).

## I. Repair log (this session)

First oracle run: **115/123 pass, 8 fail.** Each failure traced to a specific, fixed root cause:
1. Percent literal (`10%`) silently dropped its `%` in the parser → fixed, re-verified (0 regressions in the other 122 cases, re-ran full suite, not just the fixed case).
2. `COUNT`/`COUNTA` used the same strict/lenient coercion as `SUM` → gave each its own, oracle-matched rule.
3. `IFERROR`/`ISERROR`/`ISNA` relied on exceptions that eager evaluation made unreachable → moved `IF`/`IFS`/`IFERROR`/`IFNA`/`CHOOSE` to lazy AST-level special forms in `engine.ts`; **new attack added**: confirmed `IF(TRUE, 1, <a branch that would itself throw>)` never evaluates the untaken branch (not just that the happy-path value is right).
4. `EDATE` overflowed into the wrong month at month-end → explicit day-of-month clamping added; **new attack added**: re-tested `EDATE` at every month-end transition in 2024 (a leap year) in the ad hoc verification pass, not just the single originally-failing case.
Second oracle run: **123/123, 21/21 grid, 7/7 range-coercion, 2/2 circular — 153/153.**

## J. Stopping condition and exact remaining gap

Per the task's stopping rule, this is not claimed as "solved" in the unbounded sense — it is
the strongest verified artifact reachable in this session, with the gap stated exactly:

**What is verified:** ~70-function formula engine + bidirectional real-OOXML interoperability
for single-sheet spreadsheets, oracle-matched against real LibreOffice on 153 captured cells
plus a 12-cell independent writer round trip.

**What is explicitly NOT done (not implied, not hidden):**
- Word processing (.docx) and presentations (.pptx) remain grade D (read-only text
  extraction) — these require a page-layout/line-breaking engine (hyphenation, kerning,
  pagination, float/wrap), which is a different, larger problem than formula evaluation and
  was not attempted this session. The honest next step, if pursued, is the SAME methodology
  (from-scratch layout code, verified against a real renderer used only as a build-time
  oracle) applied to a much larger surface.
- Charts, pivot tables, conditional formatting, cell styling beyond bold, and macros are not
  implemented in the spreadsheet engine (declared scope boundary, consistent with every other
  Forge engine in this codebase).
- Number-format codes (`TEXT()`, cell display formatting) cover a bounded subset.
- No Excel oracle was available to cross-check LibreOffice-specific findings (case-sensitive
  comparison, the 1900-date finding) against a second real implementation.

**Next highest-information test:** obtain (or sandbox-install, if feasible in a future
session) a real Microsoft Excel or Excel-compatible oracle and re-run
`scripts/oracle-formula.mts`'s vector set against it, diffing against the LibreOffice-derived
fixture — this would upgrade every "[oracle: LibreOffice]" tag to a cross-validated fact or
surface the first genuine Excel/Calc divergence this project has found.

## TT15 — spreadsheet v2, number formats, xlsx fidelity, charts

**New modules** (all pure TypeScript, client-safe unless noted):

| File | What | Verified by |
|---|---|---|
| `src/lib/formula/numfmt.ts` | Excel format codes: 4 sections, `[Color]`, literals/escapes, `0 # ?`, thousands + trailing-comma scaling, `%`, `E+/E-`, `@`, dates/times (`m` = minutes after `h`/before `s`), `AM/PM`, elapsed `[h] [m] [s]`, fractional seconds. `TEXT()` now uses it. | office-engine-2 (expected strings hand-derived from Microsoft's format-code guide). PyPI `formulas` TEXT() was probed and found wrong (e.g. `TEXT(45361,"mmm d")` → "Mar 1"), so it is **not** used as an oracle here. |
| `src/lib/formula/sheetops.ts` | reference shifting (`$` anchors, off-grid `#REF!`), insert/delete with workbook-wide repair, TSV clipboard, copy/paste blocks, AutoFill (least-squares trend, text+number series, cyclic copy), stable sort (blanks last), find/replace, selection stats, `_xlfn.`/`_xlws.` prefixes | office-engine-2 |
| `src/lib/formula/sheetui.ts` | current region, Ctrl+Arrow jumps, fill-handle geometry, header heuristic, autocomplete token, active-call argument index, signatures | office-engine-2 |
| `src/lib/formula/sheetmeta.ts` | charts (bar/line/pie/scatter, multi-series; ported from the competitor TT14 `chart.ts` and extended) + conditional formatting rules + untrusted-JSON sanitisers | office-engine-2, e2e-office |
| `src/lib/formula/xlsx.ts` (server) | styles both ways, widths, frozen rows, prefixes, array-formula spill export, shared-formula read | `scripts/oracle-xlsx.mts` (openpyxl 3.1, both directions) |

**Bugs found this tier (and by what):**
- Error literals (`=#REF!*10`) did not parse → `#NAME?` instead of `#REF!` (office-engine-2 insert/delete test).
- xlsx reader: self-closing styled blank `<c …/>` swallowed the next cell's value (code review while adding styles; regression-covered by oracle-xlsx B).
- xlsx writer: explicit date formats mapped onto locale-dependent built-in ids 14/22 → lossy (openpyxl oracle).
- `SORTBY` documented but missing → `#NAME?`; `SORT` compared mixed types as strings, case-sensitively (real-browser e2e).
- Shell: desktop `overflow:hidden` was scrolled by focus, hiding window title bars; boot hydrate used a persisted viewport from another screen (screenshot inspection).

**Declared gaps:** grid bounded to A..AZ × 1000 rows; fixed row height (wrapped text clipped); no merged cells, borders, data validation, comments, pivot tables; cut-paste does not re-point formulas that reference moved cells; charts and conditional formats are not exported to xlsx; Excel 365 XLDAPR dynamic-array metadata not emitted (spills export as legacy `{=…}` array formulas with correct values); no Excel or LibreOffice in this sandbox, so Excel-specific open/save behaviour is unverified.

**Run:**
```
T="node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs"
$T scripts/office-engine.mts        # 35 tests (incl. office-engine-2)
$T scripts/oracle-parity.mts        # LibreOffice fixture + PyPI formulas fixture
ORACLE_PY=/path/to/python-with-openpyxl $T scripts/oracle-xlsx.mts
BASE=http://localhost:3999 $T scripts/e2e-office.mts   # real Chromium, 11 tests
```

## TT16 — image editing (layers + PSD), vector studio v2, browser session hardening

**Image (FF-30/31).** `src/lib/image/{doc,paint,history,psd,raster}.ts`, pure; UI in `ImageStudio.tsx`, with the classic quick editor kept as a tab.
- **Compositor:** 12 separable W3C Compositing-1 modes, layer opacity, masks, offsets.
- **PSD codec:** RLE/ZIP/raw channels, luni names plus MacRoman Pascal names, masks, merged composite.
- **Oracles:**
  - Chromium/Skia `globalCompositeOperation` with exact-representable inputs: |Δ| 0 for 9 modes, 1 for color-dodge/burn/soft-light on opaque backdrops, ≤2 on translucent ones.
  - psd-tools 1.25 in both directions: layer pixels byte-exact; its compositor vs ours Δmax 1.
- **Bugs found by the oracles and visual inspection:**
  - blur dark fringe (straight-alpha box blur);
  - Pascal names are MacRoman, not Latin-1;
  - clipped tool labels;
  - ellipse selection drawn as a rectangle.

**Vector (FF-32).** `src/lib/vector/{xml,path,model}.ts`, pure; UI in `Vector.tsx`.
- **Path engine:**
  - full SVG 1.1 grammar with F.2 error recovery;
  - normalised to absolute M/L/C/Z; Q/T are converted to cubics exactly;
  - arcs follow F.6.5/F.6.6 (≤90° pieces, k = 4/3·tan(Δ/4));
  - bounds from derivative roots; adaptive length; nonzero/evenodd containment; hit testing by the engine.
- **SVG import** is an allowlist translator that reports everything it drops. It handles:
  - style attribute and inheritance;
  - `<use>`, with cycle and depth guards;
  - gradients with `%` offsets (clamped, monotonic) and href inheritance;
  - no DOCTYPE entity expansion.
- **Canvas rendering:** the canvas renders our own export serialisation, so what you see is what gets exported.
- **Two independent oracles:**

| Check | svgelements 1.9.6 | Chromium |
|---|---|---|
| bbox (L/C/Q) | exact (1e-17) | ≤1e-5 (float32) |
| bbox (arcs → cubics) | ≤1.6e-4 rel. | ≤1.5e-4 rel. |
| length | ≤1.5e-4 rel. | ≤9e-5 rel. |
| transform lists (13) | identical | identical (`transform.baseVal`) |
| fill containment | — | 8,538 `isPointInFill` samples agree (edge points within 0.35 px skipped) |
| rx=0 arc | reports length 0 (deviates from spec) | straight line (spec): **we follow the spec** |

- **Render parity:** Chromium rasterises the original fixture and our import→export at 2×. 0.10% of pixels differ by more than 24/255, all along arcs. Each difference is one Skia 4× vertical-supersample coverage step: 205/4 ≈ 52 for that red on white. That is caused by ~0.01 px geometric deviation from the cubic arc approximation, as checked with the fill-only arc test.
- **Gaps:**
  - no boolean ops;
  - no text to outlines (needs glyph data);
  - text bounds estimated at 0.6 em/char;
  - no markers, patterns, filters, masks or clipPaths;
  - nested `<svg>` viewport clipping not reproduced;
  - arcs are stored as cubics after import.

**Browser (PR-07, competitor port).** `src/lib/browserSession.ts` adds:
- URL guard: http(s) only, no userinfo, never the shell's own origin;
- normalisation of untrusted saved sessions;
- batch close (others / to the right / duplicates; pinned tabs kept);
- pinning, groups and search;
- sleep invariants (visible and pinned tabs never sleep);
- per-host `allow=` delegation.

It also fixes two defects:
- **Security:** a restored session could put shell-origin content into a frame with `allow-scripts allow-same-origin`.
- **Bug:** closing the active tab left a blank view.

Six rows that the register claimed as "built" had no UI before TT16. They are now implemented and e2e-tested.

**Competitor TT14 tree, final audit.**
- `vector.ts` / `vectorGeometry.ts`: superseded. Our engine does true path geometry; theirs keeps path `d` as an opaque string with bbox-only hit testing, and their gradient offsets turn "50%" into NaN.
- `browserState.ts`: pareto-superior parts ported (above).
- `sandboxPolicy.ts`: only the explicit `allow` denials were superior (ported); its per-origin rule table hard-codes three demo hosts.
- All pareto-superior elements found in the tree have now been ported or superseded.

Competitor vector parity also added: arrow (line tool + Arrowhead → plain path, no `<marker>`) and parametric stars (point count / inner ratio re-editable after moves/rotations; `restar` keeps centre, radius, rotation). Suites added: `vector-engine` (18), `oracle-svg` (4), `e2e-vector` (11), `browser-session` (5), `e2e-browser` (6). Ledger after TT16: built 182 full / 65 partial / 22 blocked; tested 65 full / 73 partial / 131 untested; 228/228 tests. Screenshots: `docs/screenshots/tt16-vector-studio.png` and `tt16-vector-nodes.png`.

## TT17 — spreadsheet v3: merged cells, borders, data validation, frozen column

Engine module: `src/lib/formula/sheetlayout.ts` (pure, no DOM). Persisted by `workbook-json.ts`, which sanitises the data
(drops malformed merges, overlapping merges and unknown rule types), and round-tripped by `xlsx.ts`.

**Merged cells** (`Sheet.merges`, a list of A1 ranges)
- The menu offers Merge & Center, Merge Across (one merge per row), Merge Cells and Unmerge.
- Before discarding data the app shows Excel's own wording: "Merging cells only keeps the upper-left value and discards other values."
- We keep the *first non-empty* value in reading order, moved to the anchor cell. Excel's documented behaviour is "upper-left";
  we have not checked the case where the upper-left cell is empty against Excel. Declared unverified.
- The rules are those Microsoft and trainers document:
  - partially overlapping an existing merge is refused;
  - sorting a range that intersects a merge is refused ("This operation requires the merged cells to be identically sized").
    We refuse on *any* intersecting merge, which is stricter than Excel: Excel allows identically sized merges.
- Selection expands to cover merges, and arrow keys and Tab step over them.
- Inserting or deleting rows and columns shifts and shrinks merges; a merge deleted down to one cell is dropped.
- xlsx: `<mergeCells>` both ways. Verified by openpyxl in both directions (oracle-xlsx test C).

**Borders** (per edge: hair < dotted < dashed < thin < medium < double < thick, plus colour)
- Ten presets: all, outside, inside, top, bottom, left, right, thick outside, top-and-bottom, none.
- They are applied to the shared edge of *both* neighbouring cells. Display resolves a shared edge to the heavier side.
- xlsx `<border>` reading and writing is verified by openpyxl, including colours and the vertical-alignment and `xSplit` fields.
- Theme colours are read as "unset"; `mediumDashed` and diagonal borders are dropped (declared).
- The old style key (`JSON.stringify(style, sortedTopKeys)`) silently dropped nested border sides. This was found and replaced
  by a deep key.

**Data validation** (`Sheet.validations`)
- Rule types: list, whole, decimal, date (serial), textLength, custom, with the eight operators.
- Error styles: stop, warning and information.
- Rules check **typed entries only**:
  - only Stop blocks an entry: Retry/Cancel;
  - Warning offers Yes/No/Cancel;
  - Information offers OK/Cancel.
- Pasting replaces cells without checking, which is the documented Excel behaviour; "Circle invalid data" audits afterwards.
- Typed list sources are capped at 255 characters (Excel strips longer ones on repair).
- `showDropDown="1"` in OOXML means the arrow is *hidden*. This is inverted in both directions and verified by openpyxl.
- Undeclared choices:
  - list matching is case-insensitive;
  - Ctrl+Enter fill skips validation.
- The in-cell list menu and the input prompt render at *grid* level. Visual inspection showed the first version was clipped by
  the cell's `overflow:hidden`. Playwright still "saw" the clipped menu, so `e2e-sheet-layout` now hit-tests every option with
  `elementFromPoint`.

**Frozen first column**: sticky positioning in the grid, and `xSplit` in the xlsx `<pane>`, which openpyxl reads back as "C2"
together with the frozen row.

**Tests**
- `scripts/sheet-layout.mts` (6, engine)
- `scripts/oracle-xlsx.mts` (5; tests C and D are new: openpyxl reads our merges, borders and DV, and we read openpyxl's)
- `scripts/e2e-sheet-layout.mts` (6, real Chromium against the production build, including Export .xlsx → reopen from the VFS
  with every TT17 feature intact)
- Screenshot: `docs/screenshots/tt17-sheet-layout.png`.

**Not done (declared)**
- x14 `extLst` validations (cross-sheet list sources written by modern Excel) are ignored.
- No conditional-formatting export, no diagonal borders, no centre-across-selection alignment.
- Date rules take serial numbers, not date pickers.

## TT19 — defined names (FF-36) and vector Pathfinder (FF-37)

**Defined names.** `names.ts` implements Excel's name rules (web-checked): first character a letter or `_`,
then letters/digits/`.`/`_`; no spaces; ≤255 characters; not A1-like within XFD1048576 and not R1C1-like; `C`/`R`
reserved; case-insensitive, unique per scope. `Workbook.defineName(name, ref, scope?)` validates and syntax-checks
the definition; evaluation substitutes names into the formula AST (`expandNames`) before `evalRaw`, so
`ROW(Sales)`, `ROWS(Sales)` and ext functions see a real range. Sheet scope shadows workbook scope on that
sheet; unknown names → `#NAME?`; cycles → `#NAME?` (depth 32); row/column insert/delete rewrites name refs via
the same `adjustForStructure` used for cells. Persisted in workbook JSON and in xlsx `<definedNames>`
(`localSheetId` for sheet scope; `_xlfn.` prefixes added/stripped; hidden and `_xlnm.*` built-ins skipped on
import). UI: editable Name Box (define a new name for the selection, or type a name/reference to jump), a Names
panel (Ctrl+F3) with refers-to, current value, scope and delete, plus formula autocomplete.
Oracles: openpyxl-authored workbook → Python-computed values; our file → openpyxl names/destinations and the PyPI
`formulas` engine's recalculation (it cannot resolve sheet-scoped names on any file — asserted symmetrically).
Gaps: relative refs inside names are fixed, `Sheet1!Name` is not parsed, `\`-prefixed / non-ASCII names refused.

**Pathfinder.** `src/lib/vector/boolean.ts`: Unite / Minus Front / Intersect / Exclude with Illustrator's paint
and stacking rules (front paint, Minus Front keeps the back), via polygon-clipping 0.15.7 on operands
flattened at 0.05 units in document space (transforms and groups honoured; even-odd exact, nonzero exact for
same-direction or nested subpaths, crossing mixed-direction nonzero flagged as approximate). Oracle: GEOS
(shapely 2.2) rebuilt from primitive parameters — exact for polygons, IoU ≥ 0.9995 with curves. Gap: results
are polygonal, not Béziers; Divide/Trim/Merge/Crop/Outline/Minus Back are not implemented.
