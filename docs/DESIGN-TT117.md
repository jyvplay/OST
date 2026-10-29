# TT117 — thirteen Class-A completions, the fourth de-wordification pass, and a faster honest gate

## A. Runtime honesty

What actually ran this turn, and nothing else: `bash`, `git`, `gh`, `node`, `npx tsc`,
`npx eslint`, `npx drizzle-kit push`, `npm run build`, `next start`, Playwright's bundled
headless Chromium via `scripts/browser-launch.mts#launchChromium` (sparticuz build, side-installed
under `/home/user/tools` from registry.npmjs.org because the sandbox has no system Chromium), and
PostgreSQL 18.4 (binaries fetched as the `postgresql-binaries` wheel from PyPI and run from `/tmp/pg`,
because the sandbox ships no PostgreSQL). One box, no second agent, no theorem prover, no hosted CI,
no external reviewer. Every number below came from a command in this sandbox named next to it.

Network is restricted to github.com / npm / PyPI hosts. No documentation site was fetched this turn;
all thirteen engines are original code written against in-repo contracts (RFC 5545's RRULE shape is
implemented from the format's well-known grammar, verified by round-trip tests, not copied code).

## B. Formal model

**Objects.** An *alarm* is (id, label, HH:MM, weekday set, enabled, snooze). A *recurrence* is
(freq, interval, byDay?, count?, until?). A *manifest* is a path-sorted list of receipt facts
(path, sha256, bytes, mime, method, capturedAt). A *register row* is (code, status, test string).

**Access.** Pure engines (`src/lib/clock-core.ts`, `recurrence.ts`, `notes-stats.ts`, `clip-io.ts`,
`find-core.ts`, `recall-report.ts`, `browser-io.ts`, `routine-io.ts`, `spec-health.ts`) are pure
functions: same input, same output, no I/O. UI integrations read/write only through the module's
existing channel (localStorage for alarms, `/api/notes`, `/api/routines`, `/api/tasks`, shell clips).

**Resource counted.** Visible words = visible text nodes inside the module root, excluding collapsed
`<details>` bodies and (for Browser) the framed content pane; drawn marks = visible `<svg>` elements
with non-empty geometry; distinct shapes = distinct geometry strings.

**Success quantifiers.**
- *Engine correctness*: for every test vector in `tt117-core.mts` (12 tests), the pure function
  returns the asserted value, including refusal cases (invalid times, bad regexes, malformed imports).
- *Class A promotion*: a row is `built` only if (a) a suite's assertions address its own mechanism,
  (b) a module claims it in `src/lib/registry.ts`, (c) every suite its test string cites exists.
  SP-01 checks (b) and (c) mechanically over the live register.
- *Density*: Recall < 160 visible words (TT116 ended at 153; TT117 added manifest controls),
  Browser chrome < 90, 0 emoji-as-mark, 0 empty SVGs, every removed caption's full phrase still
  resolving as an accessible name.
- *Speed*: `run-fast.sh` must produce identical per-suite verdicts to `run-all.sh` on the pure
  suites it accepts, and must refuse any suite that reaches a server/browser/database/network.

**Boundaries.** Alarms fire only while Fusion is open (a closed web app cannot schedule an exact
alarm; the UI says so). Manifest verification compares receipt facts; re-hashing media bytes remains
RC-19. Clipboard/routine/browser imports are files a person chooses; nothing is fetched.

## C. Outcome space

- **H+** (suite-measured this turn): the 13 promotions CK-01…SP-01 + AX-19 (see gate table in the
  final report; `tt117-core` 12/0, `e2e-tt117`, `tt117-density`).
- **H−** (contradicted and acted on): "Jan 1→31 2026 has 22 business days" — it has 21; the e2e
  expectation, not the engine, was wrong, and a unit assertion now pins the correct count.
  "Cited suites live in `scripts/` root" — three live in `scripts/diag` and `scripts/oracle`;
  `/api/spec-health` now scans recursively.
- **H∂** (unmeasured, not claimed): glyph *comprehension*; alarm firing across a sleeping laptop;
  the 253 pre-existing register issues SP-01 lists (224 built + 29 partial rows no module claims —
  most are shell/platform features whose home is not a module; triage is future work, and the panel
  says so by listing them rather than hiding them).

## D. False-solution shapes (the modal shortcuts, and what refuses them)

1. **Promote a partial RC row by editing its status.** Refused by the standing rule plus SP-01:
   the row needs a claiming module and a citing suite whose assertions name its mechanism.
   (This turn promoted zero pre-existing partials; the RC partials are partial for physical
   reasons — headless Chromium cannot certify an OS file dialog — and remain partial.)
2. **Flip `implements: []` on Recall to a guessed list.** The list was derived from the register's
   own RC-01…RC-42 rows and is checked by SP-01 against the live register.
3. **Win the Browser word count by deleting the embed-refusal explanation.** `tt117-density`
   asserts the explanation as a floor whenever it renders (/platform rule, not an app bug/,
   /X-Frame-Options/).
4. **Win it by hiding chrome in a collapsed disclosure.** The measurement counts controls and
   requires the named controls to resolve; hidden geometry has no box and is not counted.
5. **Emoji instead of drawings.** The emoji scan over control labels fails the suite.
6. **One shape reused.** Distinct-geometry counting (Recall ≥ 20 distinct of 54 marks).
7. **Rename the accessible name along with the caption.** The named-control list uses the
   pre-pass phrases; renaming both fails it, as does any label-in-name break.
8. **Verify a manifest by re-hashing the manifest against itself.** `verifyManifest` compares
   against a live receipt list assembled from `/api/fs` reads; the unit test mutates bytes,
   drops and adds memories and expects three separate diff buckets.
9. **Import that silently overwrites.** Clip/routine/browser imports dedupe or skip-and-report;
   sensitive clips are refused, never re-imported as usable text.
10. **A recurrence that drifts (31 Jan → 28 Feb → 28 Mar).** The monthly test asserts 31 Mar.
11. **A regex filter that falls back to literal on error.** `compileFind` returns the error;
    the UI shows it as a badge and does not filter.
12. **Speed the gate by skipping or sampling suites.** `run-fast.sh` runs every named suite with
    the identical invocation and verdict rule; it only changes scheduling, and refuses
    server/browser suites outright (mechanical grep, not a trust list).
13. **Speed it by sharing one Chromium.** Not done: browser suites keep the sequential path.
14. **Count code words as prose to hit a reading-time number.** NT-01's test pins the exact
    word count with a fenced block present (20, not 25).
15. **Persist alarms server-side to claim background firing.** Not claimed; storage is
    browser-local and the limitation is printed in the Clock UI.
16. **Export browser proxy session ids "for completeness".** Excluded by design and asserted
    absent from the export string in the unit test.

**Detector for the modal shortcut (#1/#2).** `GET /api/spec-health` over the live register:
any TT117 code appearing in its issue list fails the turn. At gate time it lists none.

## E. Mechanism portfolio (per feature: construction / proved / unresolved / cheapest falsifier)

| Feature | Construction | Proved | Unresolved | Falsifier | Gap |
|---|---|---|---|---|---|
| CK-01 | 8-day wall-clock scan for next fire | weekend/weekday/disabled/snooze vectors | sleep/wake of the host | add Fri-only alarm on Sat | local |
| CK-02 | delta splits over cumulative laps | fastest/slowest/average, refusal | — | feed decreasing laps | local |
| CK-03 | stripped-day arithmetic, sign-aware business count | Jan-2026 = 21 pinned | holiday calendars (none claimed) | reverse the dates | local |
| NT-01 | fence/inline-code-aware prose scan | exact 20-word vector | CJK word segmentation | paste code-only note → 0 words | local |
| PL-01 | RRULE subset with anchor-day monthly clamp | BYDAY set, COUNT, UNTIL | BYSETPOS etc. (refused loudly) | FREQ=HOURLY → error | local |
| PL-02 | RRULE carried through parse/store/emit | parse→export→parse identity | TZID rules (stays as before) | import, export, diff | local |
| CB-01 | redacted export + validating merge | sensitive refused, dedupe | cross-device merge conflicts | import a masked entry | local |
| RT-01 | whitelist re-validation on import | non-whitelisted cmd refuses file | — | import `exec` action | local |
| FN-01 | compiled pattern with positions, 500 cap | literal escape, bad-regex error | searching bodies (snippets only, stated) | search `(` | local |
| RC-40 | deterministic receipt manifest + 3-way diff | byte-identical re-export | >100 memories (search cap, stated) | mutate one byte count | local |
| RC-41 | receipt-field aggregation | totals + undated counted | same cap | undated receipt | local |
| RC-42 | sha256 grouping across folders | wasted-bytes arithmetic | — | two folders, same bytes | local |
| BR-01 | guarded session (de)serialisation | unsafe dropped+counted | profile cookie jars (not exported, stated) | `javascript:` URL in file | local |
| SP-01 | pure register checker + live endpoint | all 4 issue kinds on fixtures | 253 pre-existing issues to triage | cite a missing suite | local |
| AX-19 | glyph-first chrome, floor-asserted content | both modules measured | comprehension | delete the Blocked text | local |

## F. Second-order adversaries (aimed at this turn's own patches)

- **Alarms interval checker** could double-fire within one minute: fired keys are
  `id@fireTime` in a ref set; the e2e adds one alarm and sees exactly one next-fire line.
- **Manifest loader** reads up to 100 receipts (the search cap): the panel states the count it
  used, and RC-40's nuance states the cap rather than implying archive-wide completeness.
- **Glyph-only Browser buttons** could strand touch users: every one carries `title` (tooltip)
  plus the full `aria-label`; `tt117-density` resolves each by its full name.
- **`run-fast.sh` xargs** could interleave result JSON writes: suites write distinct files;
  verdicts were compared against the sequential run on the same set (both FASTDONE, same counts).
- **SP-01's strictness** could be "fixed" by claiming everything from one module: that would
  still pass the checker — recorded here as a known limit; the claim list is code-reviewed data,
  not proof. H∂.

## G. Verification binding

Self-verified only (no external verifier exists in this sandbox — see TT116 §I, unchanged).
Strongest available bindings: PostgreSQL adjudicates register contents (`/api/features`,
`/api/spec-health` read the live DB); axe-core via incumbent `e2e-a11y`; the density suites
measure the rendered DOM in a real Chromium rather than trusting source text.

## H. Test-speed result (measured, not asserted)

Same 7 pure suites (unit, a11y-unit, layout-unit, maps-unit, stream-unit, tabletop-unit,
tt117-core): sequential `JOBS=1` 16.9s → `JOBS=4` 10.6s wall (1.6×), identical verdicts and
identical `docs/test-results/*.json`. The remaining time is node/ts-hook startup per suite,
which parallelism amortises but cannot remove; browser/server suites are untouched by design.
