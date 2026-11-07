# TT148 — bytes over names, keys over labels

This turn finishes the previous turn's uncommitted work (TT146/TT147), closes two
more register rows to **built**, fixes one real product bug that three density
suites were reporting, makes two test scripts genuinely faster, and re-verifies
the gate suite by suite. Every claim below is tied to a command that ran and to
a file that exists.

## 1. What was actually verified, and with what

| Tool | What it is | Where it ran |
| --- | --- | --- |
| Node 22.22.3 + `--experimental-strip-types` | runs the `.mts` suites directly | every suite below |
| Chromium 143.0.7499.0 (Playwright, `/tmp/chromium`, swiftshader) | the real browser, no mocks | all `e2e-*` suites |
| Postgres 15 (`app_db`) + `next dev` on :3999 | the real server and journal | all `e2e-*` suites |
| Pillow 13.0.0 / libavif (`scripts/oracle/avif_fixture.py`) | independently **encodes** the AVIF the app must decode | `tt148-core`, `e2e-tt148` |
| pillow-heif 1.8.1 / libheif (`scripts/oracle/heic_fixture.py`) | independently **encodes** a genuine HEIC the app must refuse | `tt148-core`, `e2e-tt148` |
| numpy float64 oracle (`scripts/oracle/resample_oracle.py`) | independent resampler for LN-05/LN-06 | `tt146-oracle` |

No simulator, theorem prover, or cloud agent was used. Nothing was parallelised
across machines; the single 2-vCPU box ran one browser at a time.

## 2. FF-06 — HEIC / AVIF decode (C → **built**)

**Formal shape.** Input: a byte string `b` and a display name `n`. Admissible
objects: ISOBMFF image containers (`ftyp` major/compatible brands), the classic
signatures (PNG/JPEG/WebP/GIF/BMP/SVG), and anything else. Decision: a total
function `kind(b) ∈ {avif, heic, png, jpeg, webp, gif, bmp, svg, unknown}`, then a
decode attempt only for kinds the *engine* can decode, then a message.

**The thing that was wrong before.** `kind` was inferred from the extension, so
an AVIF saved as `.heic` (routine: several encoders emit `.heif`, users rename)
was refused as "not supported by this browser" even though the browser decodes
AVIF happily. The refusal blamed the engine for a naming accident.

**What it does now** (`src/lib/image/foreign-container.ts`, used by
`src/lib/thumbs/render.ts`):

- brand table: `avif/avis/av01` → AVIF; `heic/heix/hevc/hevx/heim/heis` and the
  `mif1/msf1` family (resolved by compatible brands) → HEIC; a box whose declared
  size exceeds the buffer or is below its own header → `unknown`;
- `unknown` bytes are **never** handed to a decoder (asserted by a call counter);
- a decoder failure on an AVIF is reported as *a file that could not be decoded*,
  not as an unsupported format; a HEIC is reported as *a format this engine has
  no decoder for*, with a conversion route;
- `MIME_OF` has no entry for `unknown` — the type is a function of the sniff.

**Evidence.**

- `tt148-core.mts` — 7/7. Brand matrix incl. `mif1`+compatible-brand resolution,
  malformed-box refusals, decode policy with a scripted decoder, and two
  **third-party fixtures**: the Pillow AVIF sniffs as `avif` and its `ispe` box
  carries exactly the 24×16 Pillow reports; the libheif HEIC (brand `heic`, 808
  bytes) sniffs as `heic` and is refused with `unsupportedFormat = true` while
  the same policy decodes the AVIF fixture — so the refusal is a property of the
  file, not of the code path.
- `e2e-tt148.mts` — 4/4, 29 s. In real Chromium: the AVIF written to
  `/Documents/*.heic` really thumbnails in Files (a `blob:` image whose
  `naturalWidth/Height` are 24×16, matching the in-page `createImageBitmap`
  answer), and the genuine HEIC shows `data-thumb="none"` with the sentence
  naming the missing HEVC decoder — while the *same page* is quoted failing to
  decode those bytes, so the message is measured rather than asserted.

**Remaining gap, stated.** There is no HEVC software decoder in this build
(writing one is out of scope and would be enormous); on engines without one the
row is "refuse with the true reason", on Safari-class engines it is "decode".
That split is in the row's own nuance.

## 3. IN-04 — system-key capture (B → **built**)

**Formal shape.** Input: a `KeyboardEvent`. Output: a chord string in canonical
order (Meta, Ctrl, Alt, Shift, key) derived from `event.code`; a
`modifierOnly` flag; a classification `reaches the page | reserved | conflict`
with a reason; and a plan whose preconditions are read from the live document
(`document.hasFocus()`, `document.fullscreenElement`, `"keyboard" in navigator`).

**Why it matters.** The web has no OS-wide hotkey. The failure mode the row
exists to prevent is a settings panel that says "global shortcut" and silently
loses the key press to the browser. So the three answers are kept apart, the
reserved list is written down with a reason per entry (≥20), and the disclosure
states the limit in the same breath as the feature.

**Evidence.**

- `tt148-core.mts` — layout independence (same `code`, three different `key`
  values → one chord), canonical order under any press order, bare modifiers
  refused, Numpad/Bracket mapping, reserved-vs-own-binding classification, and
  a regex that fails the build if the copy ever claims global reach.
- `e2e-tt148.mts` — the capture box in Settings: `Ctrl+Shift+K` →
  "reaches the page"; `Ctrl+T` → "not usable" with the browser's own use quoted;
  `Ctrl+Space` → named as *this app's own binding* (and explicitly **not** blamed
  on the browser); the limit line says "only while this window has focus" and
  matches no global-claim wording; Clear clears it. A second case presses
  `Meta+E` (the real Files binding) **into the capturing box** and asserts the
  window count does not change — the event is consumed, so a capture UI cannot
  fire the shell behind it.

## 4. Product bug found by the gate, and fixed

`tt122-density` failed three separate density suites (`tt121`, `tt118`, `tt122`)
with `monitor: 911 visible words exceeds its bound`. The cause was not words but
a **duplicate render**: `Monitor.tsx` mounted `NetworkSection`,
`SchedulerSection` and `TestsFasterSection` twice. Removing the duplicate set and
capping the two live tails (jobs, audit log) to 8 rows each — with an explicit
`tail: 8 of N` line, so nothing is silently hidden — brings Monitor to **411
words** against a 500 bound. `tt122-density` now reports
`1 passed, 0 failed` (apps 937 ≤ 950, monitor 411 ≤ 500).

The Apps overview also crossed its 950-word bound by five words when the Mail
module joined the catalogue; four registry summaries were tightened (fewer words,
same facts) and it measures 937.

## 5. Test scripts made pareto-superior

| Suite | Before | After | Why it is strictly better |
| --- | --- | --- | --- |
| `tt146-oracle` | 13 python processes, 1.47–1.55 s of process startup alone (measured: `13 one-shot spawns: 1471 ms` / `1550 ms`) | **one** long-lived oracle process, suite wall time 0.45 s (work 247 ms) | Same inputs, same numbers, same assertions; ~1.3 s and 13 interpreter+numpy imports removed per run. A per-line JSON protocol with the old one-shot form still accepted. |
| `tt122-density` (and siblings) | on failure it printed only the count | prints the offending control text per module (`EMOJI-IN-CONTROL ✕ \| ↻ \| …`) and the exact over-bound number | Same assertions; failures now name the element, which is what turned the Monitor duplication from a mystery into a one-line fix. |

Both changes keep the fidelity contract: the assertions are untouched, and the
oracle fallback to the one-shot protocol is kept for a sandbox that cannot hold a
child process open.

## 6. Honest accounting against "≥20 rows to Class A this turn"

- Closed **this turn**: FF-06, IN-04 (code + pure suite + browser suite + seed
  promotion).
- Closed **in this branch, finished this turn** (they were left uncommitted when
  the previous turn ran out of budget): the 17 rows in
  `src/db/seed-data/features-tt147.ts` (HW-03, HW-09, HW-10, FE-11, FE-12,
  FE-13, CT-03, HW-04, HW-07, WM-16, AU-01, AP-05, PR-06, PR-07o, ST-02, …).
  They are only claimed here because their suites are the ones the gate runs;
  their own evidence lives in `tt147-core` (10/10) and `e2e-tt147` (6/6).
- Therefore the merged PR moves **19 rows**, not 20+, and the remaining gap is
  stated rather than papered over: the 31 partial / 23 blocked rows are mostly
  platform impossibilities (VM, raw TCP, OS-wide hotkeys) or engines that do not
  exist yet, and each needs its own turn of real work.

## 7. What is still red, with the exact reason

The full gate (`scripts/run-gate.sh`) was run end to end this turn. Its verdict
was not clean; each failure is accounted for:

- **Stale expectations, fixed here**: `tt134-icon-review` pinned the old "search"
  magnifier for Find (the registry ships a funnel glyph since an earlier turn);
  `tt134-review-repairs` pinned the register at exactly 647 rows (it is 665 and
  only grows); `tt131-ledger` pinned CK-01 and FM-18 to `partial` after later
  turns promoted them. All three now assert the *invariant* instead of a frozen
  label, and `tt131-ledger` is verified 5/5.
- **Contention flakes**: ~10 browser suites failed inside a 15–30 s locator
  budget while this turn was compiling (`tsc`, two hung experiment runs) on the
  same 2 vCPUs. They are re-run serially, alone, in the verification batch; the
  per-suite outcomes are recorded in §8.
- **Environment-bound**: `tt134-review-repairs` also asks the browser to observe
  `github.com` framing headers; when the peer is unreachable the suite reports
  `unknown` and fails by design (it refuses to fake the observation).
- **Gate script self-corruption (operator error, recorded)**: this turn edited
  `scripts/run-gate.sh` **while bash was executing it**, which truncated the
  tail of the loop (`line 63: -60: command not found`). Bash reads scripts by
  byte offset, so editing a running script is unsafe. The final gate run must use
  the committed script unchanged.

## 8. Re-verification after the fixes

See `docs/test-results/` and the report for the per-suite results of the
verification batch (`tt134-icon-review`, `tt121-density`, `tt118-density`,
`e2e-vector`, `e2e-tt130-privacy`, `e2e-sheet-layout`, `e2e-office`, `e2e-tt146`,
`e2e-tt81`, `e2e-tt73-writer`, `e2e-tt49-writer`, `e2e-tt129-offline`), run
one at a time with nothing else on the machine.
