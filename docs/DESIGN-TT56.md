# DESIGN-TT56 — Writer Track Changes, MRU switcher, on-screen display, Paste Special, and untested rows made testable

Tier-5 protocol (A–J). Everything below names the code and the suite that checks it. Results are listed under "Results".

## Runtime honesty

What actually ran: a bash sandbox (2 cores, 3 GB), Node 22.22.3 with `--experimental-strip-types`, `tsc`, Next 16.2.6
(`next build` + `next start`), Playwright 1.64.1 driving Chromium 143 (@sparticuz build, headless), embedded PostgreSQL
17.10, and a Python 3.11 venv with lxml / openpyxl / python-docx-free stdlib zip used as oracles.
Not available, so nothing here claims them: theorem provers, parallel agents, Microsoft Word / Excel, LibreOffice,
Firefox, Safari, real phones, real OS-level shortcuts (Alt+Tab / Meta+Tab never reach a web page outside Keyboard Lock),
real browser page zoom (Ctrl+± cannot be pressed in headless Chromium — ST-07 uses device-scale-factor contexts and the
CDP `Emulation.setDeviceMetricsOverride` instead), system volume / brightness (not readable by any web page).

## A. Formal model

* **Track Changes (FF-22).** A document is a sequence of paragraphs; each run carries `rev?: {kind: ins|del, id, author}`
  and a paragraph mark may carry its own `rev`. With `track.on`:
  `insert(t)` → a run `ins(author)` (merged with an adjacent own insertion);
  `delete(range)` → for each piece: own pending `ins` ⇒ physically removed; another author's `ins` ⇒ nested `del` inside it;
  plain text ⇒ `del(author)`; paragraph marks follow the same three rules.
  `accept(ins)` = drop the mark; `reject(ins)` = remove the content (and anything nested); `accept(del)` = remove;
  `reject(del)` = drop the mark. Invariant: `acceptAll(doc).text === oracle.accept_text` and
  `rejectAll(doc).text === oracle.reject_text` for the saved bytes (lxml oracle, independent of our parser).
* **MRU (WM-05).** `mru: WinId[]`, most recent first. Every reduced command that changes `focus` (or opens / restores /
  tiles / places a window) moves that id to the front; closed ids are dropped; unknown live ids are appended in z order
  (hydrate fallback). The switcher overlay is a pure view `switchItems(state, mode)`; the initial selection is index 1
  (forward) or n−1 (reverse); releasing the held modifier commits exactly one `focus` (or `workspace`) command.
* **OSD (NC-06).** Events `e_i = (kind, label, t_i)`. The pill renders the latest event immediately; the live region is
  written once when `t_now − t_last ≥ 600 ms` with the last label. Burst of n events ⇒ 1 announcement.
* **Paste Special (FF-20).** `pasteSpecial(sheet, clip, values, at, {what, op, transpose, skipBlanks})`: target cell of
  source (i, j) is `at + (transpose ? (i, j)ᵀ : (j, i))`; content = shifted / transposed formula, computed value literal,
  or nothing (formats); `op` combines numerics with the target's current value (blank = 0), text wins, ÷0 ⇒ `#DIV/0!`.
  Transposed formulas: fully relative refs swap row/column offsets (R[a]C[b] → R[b]C[a]); mixed refs shift only the
  relative part by the displacement; absolute refs stay.
* **AX-04.** `keyboardNav(t) := (now − t_lastTabOrF6) < 800 ms`; `focusin(win) ∧ ¬focused(win) ∧ keyboardNav ⇒ focus(win)`.

## B. Hypotheses

* **H+** (expected to hold, tested): accept/reject of our saved revisions equals the independent lxml oracle on random
  edit sequences; MRU order after 5 focus changes equals the reference list; 20 volume steps announce once; the focus-dim
  variable lives only on `:root`; text size is identical at DSF 1 and 2; transposing twice is the identity; every permission
  state shown equals an independent `permissions.query`; no rAF callback runs on a static desktop.
* **H−** (expected to fail, tested as negative shapes): the switcher must NOT open while an ask dialog is open; programmatic
  focus must NOT raise a covered window; Paste Special must NOT invent formats for external clipboard text (it refuses);
  a text value must NOT be combined arithmetically.
* **H∂** (partially true, disclosed): Track Changes does not record formatting changes (`w:rPrChange`), table structure
  edits or moves; Alt+Tab itself is reserved by the OS; the OSD covers in-app media only; "Match system" is opt-in because
  the house default theme is Dark (TT22 palette decision) and headless Chromium reports light.

## C. Frontier

The remaining Class-A gap for Writer is formatting-change tracking and comments threads; for Spreadsheet, pivot depth,
x14 conditional-format extensions and hyperlink editing. These are listed under blockers rather than claimed.

## D. Negative shapes (≥ 15) + modal shortcut

1. Switcher chord with an ask dialog open → nothing (e2e-tt56 "modal failure test").
2. Esc during the switcher → focus unchanged.
3. Window blur while held → cancel, no commit.
4. Closed window ids never appear in the MRU (property test, 400 trials).
5. Hydrate without `mru` → fallback by z, no crash.
6. OSD: 20 events within 600 ms → exactly one announcement.
7. `data-osd="off"` media → no OSD.
8. Track Changes: deleting your own pending insertion leaves no `w:del` (physically removed).
9. Rejecting an outer insertion removes the nested deletion; resolving that stale key returns false.
10. Paste Special with no in-app clip → refusal toast, no write.
11. Paste Special over a partial merge → refusal (merge conflict message), no write.
12. Paste op with a text source or text target → text pasted, no NaN.
13. Paste op ÷ 0 → `#DIV/0!` error literal (not Infinity).
14. Transposed reference beyond row 1 / column A → `#REF!`, never a wrapped address.
15. Programmatic `.focus()` into a covered window → no raise (AX-04).
16. Permission names Fusion never requests → never "granted" (SC-03 test).
17. Auth paths (/login, /api/auth/session …) → 404 (DP-01).
18. Static desktop → 0 rAF callbacks (RG-03).

**Modal shortcut failure test:** WM-05 with `.fs-ask` open: Ctrl+` press/release leaves no overlay and the server focus is
unchanged; and the Spreadsheet's Paste Special panel consumes Escape (stopPropagation) so the window does not close.

## E. Mechanism-distinct approaches (≥ 6)

1. **Independent oracle on saved bytes** — Writer revisions read by lxml (`scripts/oracle/docx_track.py`); Paste Special
   results read by openpyxl from the saved .xlsx.
2. **Reference model + random property tests** — MRU (400 trials, > 1000 opens), Paste Special (300 random blocks with
   op / skip / transpose), Track Changes (40 random decision sets).
3. **Algebraic laws** — transpose ∘ transpose = id; accept-all ∘ reject-all consistency.
4. **Mutation testing** — three hand mutants of `pasteSpecial` / `transposeFormula` (skip blanks, offset swap, ÷0) are
   each killed by tt56-sheet-paste.
5. **Instrumented runtime counters** — rAF counted by an init script (RG-03); OSD live-region mutations counted by a
   MutationObserver.
6. **Server-state ground truth** — focus / z / mru read back from `/api/state` (WM-05, AX-04, WM-10).
7. **Computed-style ground truth** — opacity / `--fs-focus-dim` / transition-duration / font-size read with
   `getComputedStyle` (WM-10, ST-05, ST-07).
8. **Static analysis of the build output** — `.next/static` grep for auth and ad-SDK markers (DP-01 / DP-02).

## F. Artifacts

`src/lib/windowing/mru.ts`, `src/components/Switcher.tsx`, `src/lib/osd.ts`, `src/components/OsdLayer.tsx`,
`src/lib/permissions.ts`, `src/lib/focus-raise.ts`, Track Changes in `src/lib/office/wordml.ts` / `wordedit.ts` /
`writer/view.ts` / `Writer.tsx`, `pasteSpecial` + `transposeFormula` in `src/lib/formula/sheetops.ts` and the Paste
Special panel in `Spreadsheet.tsx`; tests `scripts/tt56-writer-track.mts`, `tt56-shell-unit.mts`, `tt56-sheet-paste.mts`,
`e2e-tt56.mts`, `e2e-tt56-rows.mts`; oracle `scripts/oracle/docx_track.py`; register `src/db/seed-data/features-tt56.ts`.

## G. Second-order adversary

* *"The MRU property test's reference model copies the implementation's touch rules."* True — it re-states the rules
  in a simpler list form, so it catches bookkeeping bugs (stale ids, duplicates, ordering) but not a wrong rule. The
  acceptance test (spec's "5 focus changes") and the e2e against server state are the independent checks.
* *"The OSD test only proves one announcement in a burst, not that a screen reader speaks it."* True; no screen reader
  runs in the sandbox. The test proves the ARIA contract (role=status, polite, one text change).
* *"Paste Special transposition semantics may differ from Excel for mixed references."* Possible; no Excel here. The
  fully relative rule is the documented behaviour of keeping in-range relationships; mixed-ref handling is disclosed.
* *"RG-03 counts rAF only from page JS."* CSS animations are not rAF; the beauty suites already forbid infinite CSS
  animations on the desktop.

## H. External verification

lxml (Writer), openpyxl (Spreadsheet), Chromium's own `navigator.permissions.query` (SC-03), Chromium feature detection
(RG-07), PostgreSQL-persisted state (WM-05 / AX-04 / WM-10). No Microsoft Office / LibreOffice open check (PR-11 stays partial).

## I. Repairs, and a new attack on each patch

See "Results" for the repairs made during this tier and the attack written against each.

## J. Stopping

Stopped when every new row had a passing suite against an external ground truth, the full run-all on the TT55 build was
recorded, and the remaining budget was needed for the ledger, commit and PR update.

## Results

**Last tier's gate (TT55 build 325154f, full run-all, 112 suites):** 988 passed / 6 failed. Failures: e2e-privacy
"no performance degradation" (timing gate), tt42-proxy setup (port never opened), e2e-tt44 (host-key dialog measured at
opacity 0.46 mid-fade, then 3 cascading timeouts). On the TT56 build tt42-proxy 2/2 and e2e-tt44 5/5 pass; the
e2e-privacy timing gate (/Private save ≤ 1.3 × host + 8 ms) keeps failing on this 2-core sandbox (48–58 ms vs 31–37 ms),
so it is reported as failing, not loosened (SC-10 stays partial).

**TT56 build:** tt56-writer-track 6/6 · tt56-shell-unit 4/4 · tt56-sheet-paste 4/4 (3/3 mutants killed) · e2e-tt56 10/10 ·
e2e-tt56-rows 7/7 · regression: unit 23 · a11y-unit 8 · layout-unit 8 · tt28-unit 5 · tt55-files-unit 7 · tt46-writer 12 ·
tt49-writer 9 · tt47-sheet 8 · tt49-sheet 10 · e2e-tt55-shell 3 · e2e-tt55-files 13 · e2e 64 · e2e-office 11 · e2e-tt47 5 ·
e2e-tt49 5 · e2e-tt49-writer 6 · e2e-a11y 9 (one flake when run straight after e2e-tt55-shell; 9/9 alone) · e2e-layout 12 ·
e2e-beauty 6 — all passing.

**Ledger:** 368 features; built full 292 / partial 54 / blocked 21 / none 1; tested full **201** (was 190) / partial 74 /
untested **93** (was 104); tests 1025/1026 (the one failure is the e2e-privacy timing gate).

**Repairs found by the new tests (I):**
1. *"Match system" theme rejected by the server* — the settings validator allowed only dark / light, so the new radio
   would have failed to save. Fixed in `settings-validate.ts`; the e2e now asserts the PUT is accepted (attack on the
   patch: the test reloads the page and proves the theme comes from the OS, then flips the OS scheme live).
2. *Motion token units* — Chromium serialises the token as `.16s` / `0s`; the test now converts CSS time to ms instead of
   string-matching (attack: reduced motion must also zero every button transition duration).
3. *Switcher hint drew arrow glyphs as tofu* (visual check, docs/screens/tt56-switcher.png) — replaced with words.
4. *Maps and the Quick panel treated "system" as dark* — both now resolve through prefers-color-scheme.
5. *AX-04 test geometry* — the first layout let the covered window intercept the title-bar click; the covering window now
   fully contains the covered one (attack: programmatic focus must not raise; the focused control must be topmost).

**Visual inspection:** docs/screens/tt56-switcher.png (overlay with window / app / workspace tabs, previous window
preselected), tt56-focusmode-osd.png (focus mode dims unfocused windows to 0.45 — the desktop shows through them, which
is the requested single-variable dim; a brightness filter would hide the desktop better and is a candidate change), and
tt56-paste-special.png.
