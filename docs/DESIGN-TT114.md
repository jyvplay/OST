# TT114 — exactly-once saving, and chrome that is drawn instead of written

## Runtime honesty

Really available and really used: `bash`, `git`, `gh`, file read/write/edit, `npm`, `npx tsc`,
`npx eslint`, `npx tsx`, `npx drizzle-kit`, a local PostgreSQL 18, headless Chromium through
`scripts/browser-launch.mts`, `fetch` against the local server, `web_search`/`fetch_page` for
research, and background processes for the server and fixtures.

Not available and not used: any second agent, any theorem prover, any hosted CI, any reviewer but
me, any network other than the five allowlisted hosts. Every number in this document came out of a
command run in this sandbox in this turn; nothing is quoted from memory of an earlier turn without
being re-run, and nothing is projected.

One honest statement about the environment: **the sandbox reset mid-turn**. Everything outside
the repository was destroyed — `node_modules`, the out-of-repo oracle `/home/user/tools`, every
PostgreSQL database, the running server and the fixtures — and the repository was re-cloned, which
discarded the local commits while Arena restored the working-tree snapshot. Nothing was lost
because the files survived; the environment was rebuilt from scratch (install, PostgreSQL
bootstrap, `music-metadata@12.3.2` oracle, two databases, `drizzle-kit push`, build, server,
fixtures) and every result quoted after that point was produced on the rebuilt environment. The
work was then pushed to the remote immediately, before any further measurement, so a second reset
could not destroy it.

One honest statement about parallelism: suites run sequentially. Where this document says
"concurrent", it means eight `fetch` calls issued from one Node process under `Promise.all` against
one server — real concurrency at the server, not simulated.

## A. Formal model

**Objects.** A *feature row* is `(code, family, name, tier, phase, route, nuance, status, test)` in
PostgreSQL, served by `/api/features`. A *memory* is a pair — a media node and a `.recall.json`
receipt — under `/Downloads/Recall/<folder>/`. A *commit* is one `POST /api/fs {op:'recallCommit'}`.
A *control* is a DOM element with an ARIA role and an accessible name.

**Access.** I may edit any file in the repository, run the build, run suites against a disposable
`_test` database, and read anything. I may not reach the public internet except through the five
allowlisted hosts, and may not inspect the user's machine.

**Resources.** One sandbox; one PostgreSQL; one Chromium; a full gate costs ~15 minutes and cannot
overlap a rebuild, because `next start` serves only the build it was started with.

**Success predicate for this turn.** (1) at least ten core features move from "graded built with
nothing measuring them" to "named by a suite that measures them", with no fabricated grade; (2) the
Recall commit path gains a property it did not have; (3) Recall and the Browser become measurably
less wordy, with original graphics, and lose no pathway; (4) all Recall requirements are mirrored
into Specs; (5) the full gate passes on a virgin database; (6) a new PR is opened and left open.

**Boundary.** I cannot prove anything about machines other than this one, about browsers other than
this Chromium, or about durability under hardware loss. Those are stated as gaps, not covered.

## B. Outcome space and declared threshold

**Declared evidence threshold.** A claim is *verified* only if a command run this turn produced a
number or an exit code that would have differed had the claim been false. A claim supported only by
reading the source is *unverified* and is written as such.

**H+ (verified this turn).**

- Exactly-once publication across a lost acknowledgement: `tt114-recall-token.mts`, 8/0.
- Scene determinism, parallax bound, frame-rate gating, picture validation: `tt114-core.mts`, 9/0.
- Scenes painting, per-window density/zoom, overview search, workspace persistence, colour picker,
  present view: `e2e-tt114-shell.mts`, 9/0.
- Split geometry, tear-out, session restore: `e2e-tt114-tabs.mts`, 5/0.
- Glyph compaction with names intact: `e2e-tt114-density.mts`, 5/0.
- No regression across the full suite set: the gate log in `docs/evidence/`.

**H− (refuted this turn).**

- *"The eleven rows were already built, so they only needed a test."* Refuted for three of them:
  WM-12, LN-09 and WM-04 had no implementation at all behind the `built` grade. Grepping for the
  mechanism, not reading the ledger, is what found this.
- *"A fixed sleep is enough after a debounced write."* Refuted by a flaky PR-07r: the same suite
  passed, then failed, then passed. Replaced with polling; 3/3 then 1/1 green.
- *"`.then(onOk, onErr)` catches everything the request can throw."* Refuted: an abort that lands
  after the headers makes `r.json()` reject *inside* `onOk`, which `onErr` never sees. The test
  leaked that rejection exactly once in ten runs before the trailing `.catch` was added.
- *"A suite that passes standalone will pass in the gate."* Refuted twice over. `e2e-layout`
  passes 12/0 standalone on the very build whose gate run failed it 10/2 — the failure is a
  strict-mode ambiguity (`getByRole('button', {name:'Trash'})` also matches a `Trashed` sort
  control) that only appears once earlier suites have put rows in the trash. State, not code.
- *"My branch only touched Recall and the Browser, so only those can break."* Refuted by the first
  full gate: **733 passed, 7 failed, and all seven were mine** — in `integration`, `e2e-tt98-orbit`,
  `e2e-tt99-interactions`, `e2e-browser`, `e2e-a11y` and `e2e-layout`, none of which this branch
  edits. A shared component, an accessible name and a menu's item order are global surfaces.
- *"A glyph with a tooltip is an accessibility improvement."* Refuted by axe-core: a button showing
  "Clipboard" whose accessible name is "Save copied image" is a **serious** WCAG 2.5.3
  label-in-name violation, because speech control cannot address what it reads. Two of my fifteen
  buttons failed; the repo's own `"<phrase> · <word>"` convention is the fix.
- *"The banner lost a command when it folded the toolbar."* Refuted by measurement, and worth
  recording because I nearly repaired working code: every folded tool **is** in the More menu — the
  toggles are mirrored as `menuitemcheckbox`, which my first probe did not query. The defect was in
  the probe, then in a stale test, never in the product.
- *"Shortening a label is cosmetic."* Refuted: adding `aria-label="Show saving timeline"` to a
  button silently captured `getByLabel('Saving timeline')` — a substring match — away from the
  timeline strip in `e2e-tt108-recall.mts`, which had passed for six turns.

**H∂ (open).** Whether the no-EyeDropper branch of MD-07 is correct: this Chromium *has*
`EyeDropper`, so the fallback cannot be exercised through the capability gate here, only through
the input it mounts. Whether the three Recall sentences that resist compaction could be shortened
without losing meaning. Whether the token survives database loss — it cannot; it is stored in the
same database as the memory.

## C. Frontier

Verified frontier at the end of this turn: 455 feature rows; the five new suites contribute 36
tests; the eleven promoted rows plus the two new rows are the delta. The gate result is recorded in
`docs/evidence/tt114-production-gate.log` and is the only number I will stand behind for the whole
system.

What moved the frontier was not new capability but *new measurement of old claims*. Three of the
eleven rows turned out to be empty when grepped. That ratio — three in eleven — is the useful
finding for the next turn: the remaining `built`-without-test rows should be assumed empty until
grepped, not assumed working.

## D. Negative space — 16 shapes that look like a solution

1. **Idempotency by digest.** "The same bytes at the same path, so skip." Fails the moment a person
   deliberately saves the same image twice; the contract has an explicit `onDuplicate:'store'`.
2. **Idempotency by `(path, sha256)` unique index.** Makes the duplicate *impossible* rather than
   *answered*; also turns a legitimate second save into a database error.
3. **Server-minted token.** The server cannot mint a token for a request it never received — which
   is the only case that matters.
4. **Token claimed after the write.** A crash between write and claim leaves a memory no token
   names; the retry writes a second one.
5. **Token claimed in a separate transaction.** Two transactions, two failure windows, no atomicity
   between them.
6. **`SELECT` then `INSERT` the token.** The classic check-then-act race: two concurrent arrivals
   both see nothing and both write. `INSERT ... ON CONFLICT DO NOTHING ... RETURNING` is one
   statement and is why the 8-way test yields one write.
7. **Replaying a token for different bytes.** Would let a token overwrite a memory; refused 409.
8. **Reporting `present:true` from the token row.** The token records that a commit happened, not
   that the memory still exists — the trashed-memory test is what forces reading the node, and it
   is what caught the missing `eq(trashed,false)`.
9. **Retry forever.** Turns a refused commit into a storm; the client retries once.
10. **Counting words to prove compaction.** A module can lose words by deleting a limit. The floor
    on disclosed words is the anti-cheat, and it is asserted.
11. **Deleting a control to shorten the toolbar.** Passes a word count; fails the name check, which
    asserts all fifteen former names still resolve.
12. **Replacing a glyph with a letter or an emoji.** Passes word count and name check; fails the
    drawing check (`svg` present, no emoji range) that exists for this shape.
13. **Reusing one glyph for every concept.** Passes all three; fails the geometry-distinctness
    check (21 glyphs rendered, 19 geometrically distinct).
14. **Moving the label into `title` only.** A tooltip is not an accessible name for a screen reader
    in every mode; the suite asserts `aria-label`, and `title` is additional, not instead.
15. **Counting frames to prove a split.** Two frames stacked in a column are still two frames; the
    suite compares bounding boxes (649×552 at x=21 and x=670).
16. **Trusting the ledger's `built`.** The modal shortcut of this whole project. **Detector:**
    `grep -rln "<the mechanism the nuance names>" src` — if the symbol the row describes does not
    appear in `src`, the row is empty regardless of its grade. Run against the eleven rows, this
    returned nothing for WM-12, LN-09 and WM-04.

## E. Mechanism portfolio

Six mechanism-distinct approaches, each with what it builds, what it proved, where it stops, and
the cheapest way to break it.

**1. Token claim inside the commit transaction (RC-39).**
*Construction:* `recall_commits(token PK, path, digest, bytes, created_at)`; the claim is the first
statement in `safeTransaction`, `INSERT ... ON CONFLICT DO NOTHING ... RETURNING`; no returned row
means someone else owns the token, so the request is answered from the existing commit after
reading the node to see whether it is still there.
*Artifact:* `src/lib/server/recall-commit.ts`, `src/lib/recall.ts`, `scripts/tt114-recall-token.mts`.
*Proved:* one write under 8-way concurrency; 409 on a token reused for different bytes; honest
`present:false` after a trash; untokened saves unchanged; four malformed tokens refused 400.
*Exact unresolved interface:* the token lives in the same database as the memory, so the guarantee
ends where that database ends. Cross-database or cross-host exactly-once is not claimed.
*Cheapest falsifier:* run the 8-way test with the claim moved after the write; it must produce more
than one file.
*Gap class:* **local**. The mechanism is complete for one server and one database.

**2. Pure-function core with a seeded generator (LN-09).**
*Construction:* `src/lib/scene-core.ts` — scenes are pure functions of a seed, so the drawing is
testable without a screenshot; `parallaxOffset` is clamped and `+0`-normalised; `sceneFps` returns
0 for a hidden tab regardless of every other input.
*Artifact:* `scene-core.ts`, `SceneLayer.tsx`, `scripts/tt114-core.mts` (9/0, under one second).
*Proved:* determinism per seed; distribution (worst decile 190 of 2000); worst parallax excursion
0.0700 = 0.03 + the 0.04 cap; 30 fps only when visible, unthrottled and motion is wanted.
*Unresolved:* that the canvas *looks* good is not asserted and cannot be; only that it paints.
*Cheapest falsifier:* remove the clamp and re-run; the excursion assertion must exceed 0.07.
*Gap class:* **local**.

**3. Geometry assertions instead of counts (PR-07d/e/j).**
*Construction:* a `data-testid="br-frames" data-split` container; the suite reads both panes'
bounding boxes and compares them.
*Artifact:* `scripts/e2e-tt114-tabs.mts`.
*Proved:* side-by-side 649×552 at x=21/x=670 with equal widths and a shared top edge; stacked
1298×276 at y=315 above y=591; a torn tab opens a second window showing that URL while the source
keeps two tabs.
*Unresolved:* merging a torn window back is not asserted — the row claims "tear out / merge back"
and only tear-out is measured. Stated in the nuance.
*Cheapest falsifier:* render the panes in a column and keep the flag; the x-comparison must fail.
*Gap class:* **equivalent-only** for the merge half: untested, so no trust is inherited by it.

**4. Polling a debounced write (PR-07r).**
*Construction:* the reducer debounces its persistence, so the suite polls `/api/state` until the
session it holds is the one just built, with a 10 s deadline.
*Artifact:* `scripts/e2e-tt114-tabs.mts`.
*Proved:* three tabs, the active tab, a group, a pin and a horizontal split survive a real reload;
green on four consecutive runs after the repair, having been intermittently red before.
*Unresolved:* the debounce interval itself is not asserted; only that the write lands within 10 s.
*Cheapest falsifier:* disable the persistence write; the poll must time out and the assertion fail.
*Gap class:* **local**.

**5. The name/word/drawing triple (AX-17).**
*Construction:* each compacted control keeps its phrase as `aria-label` and `title`, and shows a
stroke glyph plus one word. The suite asserts the word budget, the exact former names, the presence
of a real `svg`, the absence of emoji, and geometric distinctness between glyphs.
*Artifact:* `AppIcon.tsx` (42 glyph names), `ui.tsx` (`Section.icon`), `RecallMemory.tsx`,
`Browser.tsx`, `scripts/e2e-tt114-density.mts`.
*Proved:* 15 actions, 16 visible words (from 45), 124 px tall in two rows instead of four, 15 drawn
glyphs, 0 emoji, 15/15 names resolving, 21 glyphs rendered with 19 distinct geometries.
*Unresolved:* whether a person *understands* a given glyph. A drawing is not a legend; this is why
the full phrase remains as the name and the tooltip rather than being replaced by the picture.
*Cheapest falsifier:* delete one button; the name check must fail while the word count improves.
*Gap class:* **equivalent-only** for comprehension — not measurable without users.

**6. Grep-the-mechanism as a grading audit.**
*Construction:* for each row graded `built` with no test, grep `src` for the symbol its nuance
describes.
*Artifact:* the audit itself, plus the resulting work on WM-12, LN-09 and WM-04, plus a standing
assertion in `tt114-recall-token.mts` that no Recall row is `built` without naming a test and that
every suite file named by a Recall row exists on disk.
*Proved:* three of eleven rows were empty; the new assertion passes against all Recall rows.
*Unresolved:* the assertion covers the `RC-` family only, and "names a test" is weaker than "the
test measures the claim". A row could name a suite that tags it trivially.
*Cheapest falsifier:* point a Recall row at a non-existent file; the suite must fail. (This is how
the check was found to be too naive: it first failed on two rows whose `test` field is prose
containing two filenames, and was fixed to extract filenames rather than split the string.)
*Gap class:* **local** for existence, **equivalent-only** for adequacy.

## F. Artifacts

| Artifact | What it is | Result |
| --- | --- | --- |
| `scripts/tt114-recall-token.mts` | HTTP + PostgreSQL, no browser | 8 passed, 0 failed |
| `scripts/tt114-core.mts` | pure functions, < 1 s | 9 passed, 0 failed |
| `scripts/e2e-tt114-shell.mts` | Chromium, 8 contexts | 9 passed, 0 failed |
| `scripts/e2e-tt114-tabs.mts` | Chromium, 4 contexts | 5 passed, 0 failed |
| `scripts/e2e-tt114-density.mts` | Chromium, 4 contexts | 5 passed, 0 failed |
| `src/lib/server/recall-commit.ts` | token claim, replay, 409 | — |
| `src/lib/scene-core.ts`, `src/components/SceneLayer.tsx` | scenes | — |
| `src/lib/windowing/state.ts`, `WindowFrame.tsx` | per-window density/zoom | — |
| `src/components/AppIcon.tsx` | 42 original stroke glyphs | — |
| `src/db/seed-data/features-tt114.ts`, `updates-tt114.ts` | RC-39, AX-17, 13 nuance updates | — |
| `docs/evidence/tt114-production-gate.log` | the full gate | see §H |

## G. Second-order adversaries

Candidate-specific attacks, each aimed at the thing its candidate would most like to be true.

- *Against the token:* reuse it with different bytes (409, nothing written); reuse it after the
  memory is trashed (`present:false`, no resurrection); fire eight at once (one write); abort one
  mid-flight and retry (one memory); send four malformed tokens (400, nothing written).
- *Against the glyph pass:* assert the fifteen former names still resolve; forbid emoji; require a
  real `svg`; compare glyph geometry so one shape cannot stand for every concept; re-run the eight
  suites that address those buttons by name — which is how the `getByLabel` substring capture in
  `e2e-tt108-recall.mts` was caught.
- *Against the density claim:* the anti-cheat floor on disclosed words, so compaction by deletion
  fails; re-measured after the glyph pass (Recall 75 prose words, 11 disclosures, 463 words).
- *Against the split:* compare geometry, not counts.
- *Against the scene:* assert that `off` paints nothing, so "it paints" cannot be satisfied by a
  layer that always paints.
- *Against my own repairs:* every repaired suite was re-run, and the two flaky ones were run three
  and four times consecutively rather than once.

## H. Verification

External verification available here: the TypeScript compiler, ESLint, PostgreSQL, Chromium, and
the Next.js build — four independent implementations that did not have to agree with me. Each is
cited where it was used. No external verifier exists for "the glyph is understandable" or "the
pane looks like a cutting-edge OS", so those claims are **downgraded**: what is verified is the
word count, the row count, the pixel height and the name resolution, not the aesthetics.

`npx tsc --noEmit` clean on every touched file; `npx eslint` clean on the eight source files
touched this turn; `npm run build` exit 0.

## I. Repair log

Each repair below is followed by the attack that was added or re-run against it. A repaired
candidate inherits no trust from its pre-repair state.

1. Replay-after-trash resurrected a memory → added `eq(vfsNodes.trashed,false)`; the test that
   found it is permanent (6/1 → 7/0, now 8/0).
2. `parallaxOffset` returned `-0` → fixed the function, not the test (8/1 → 9/0).
3. A hand-dispatched `Event` does not trigger React `onChange` → suite uses `fill()` (8/1 → 9/0).
4. `Section.icon` typed against another module's union failed `tsc` → `import { UiGlyph, type UiGlyphName }`.
5. A regex over JSX broke on `=>` inside `onClick` → replaced literal strings and asserted one
   match per button (15/15).
6. `getByLabel('Saving timeline')` began matching the newly-labelled button → made exact; the two
   affected tests pass (6/0).
7. PR-07r's fixed sleep sampled a transient → polled; 4/4 green.
8. The abort test leaked a rejection from `r.json()` → trailing `.catch`; 4/4 green.
9. The Recall-row file-existence check mis-parsed prose `test` fields → extract filenames by regex.

The first full gate (733 passed, 7 failed) found seven more, all caused by this branch. Each is
repaired below, and each repair was re-run to the exact pass count TT113 recorded for that suite,
which is the strongest available check that the repair restored the old behaviour rather than
masking it:

10. **`integration` — "PR-07r missing audit note".** My Specs update overwrote a nuance that a
    standing contract requires to begin with `AUDIT`. Extended rather than replaced; the audited
    sentence is first and this turn's measurement follows. Re-run: **25/0** (TT113: 25/0).
11. **`e2e-tt98-orbit` — `End` no longer lands on "Send to Studio".** The WM-12 density and zoom
    entries were appended after the workspace list. Moved before it. Re-run: **22/0** (TT113: 22/0).
12. **`e2e-tt99-interactions` and `e2e-browser` — `getByTitle('Vertical tab sidebar')`.** The glyph
    pass replaced that control's name and tooltip with a state description. The glyph stays; the
    name and title go back to the name the rest of the system knows, with `aria-pressed` carrying
    the state. Re-run: **29/0** and **6/0** (TT113: 29/0 and 6/0).
13. **`e2e-a11y` — two WCAG 2.5.3 label-in-name violations.** Repaired with the repository's own
    `nameWithLabel` convention. Re-run: **9/0** (TT113: 9/0).
14. **`e2e-layout` — strict-mode ambiguity and a cascade.** Not repaired in the source, because
    `e2e-layout` passes **12/0** standalone on the build whose gate run failed it: the ambiguity
    depends on trash content left by earlier suites, and the second failure is the first one's
    cascade through a window left open by the throw. Treated as a gate-state finding, re-measured
    in the final gate rather than patched blind.

The attack added against repair 12 is in `e2e-tt114-density.mts`, which now asserts that the
tab-side control is glyph-only **and** resolves by the incumbent name — so a future turn cannot
re-break either half. The attack added against repair 13 is the same suite's drawing check plus
axe-core itself, which runs over Recall in `e2e-a11y` on every gate.

## J. Stopping, residual gap, next test

The success predicate is met on (1) through (4) and (6); (5) is reported from the gate log below.

**Residual gaps, stated exactly.** MD-07's no-EyeDropper branch is unprovable on a runtime that has
EyeDropper. PR-07j's "merge back" half is unmeasured. The token guarantee ends at the database.
Glyph comprehension is unmeasured. Lint debt elsewhere in the repository is unchanged.

**Next highest-information test.** Point a Chromium build *without* `EyeDropper` at MD-07 by
deleting the global before load — a one-line `addInitScript` that would convert MD-07 from
half-measured to fully measured, and would cost about five minutes.
