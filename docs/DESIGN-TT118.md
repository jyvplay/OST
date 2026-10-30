# TT118 — twelve Class-A features, every-app de-wordification (AX-20), honest speedup

Continues TT117 on the same branch and PR. Register: 471 → **483 requirements,
377 built** / 64 partial / 18 probe / 24 blocked / 0 skeleton (live
`/api/features` and `/api/spec-health`, zero issues for the new codes).

## What was built (each: engine + UI + unit contract + mechanism e2e where the UI is the mechanism)

| Code | Feature | Engine | Proved by |
|---|---|---|---|
| DF-01 | Editor version diff (line + word, 400-line display cap, 4000-line compute cap refused beyond) | `src/lib/diff-core.ts` | tt118-core, e2e-tt118 |
| NT-02 | Notes hashtags / `[[wiki-links]]` / backlinks (headings, URLs, `a#b` are not tags) | `note-links.ts` | tt118-core |
| PL-03 | Planner agenda buckets (whole local days) | `agenda.ts` | tt118-core, e2e-tt118 |
| WD-01 | Clock meeting overlap via real Intl offsets, 30-min cells | `zones.ts` | tt118-core, e2e-tt118 |
| WD-02 | Clock countdowns (browser-local, re-validated on load) | `zones.ts` | tt118-core, e2e-tt118 |
| CV-01 | Calculator converter, 8 categories, exact defined factors, IEC ≠ decimal data | `converter.ts` | tt118-core, e2e-tt118 (100 °C = exactly 212 °F in the UI) |
| UC-01 | Browser clean-link: strips utm_*/click-ids, **names what it removed**, keeps load-bearing params | `url-clean.ts` | tt118-core, e2e-tt118 (control) |
| ST-10 | Settings export/import, closed vocabulary, locked keys refused and named | `settings-io.ts` | tt118-core |
| BK-06 | Backup bundle compare (added/removed/changed/unchanged + byte delta) | `backup-compare.ts` | tt118-core |
| TM-02 | Terminal did-you-mean (OSA Damerau–Levenshtein, written from scratch; silent < 3 chars) | `suggest.ts` | tt118-core, e2e-tt118 (`hlep` → `` `help` ``) |
| PH-02 | Photos month timeline strip, undated counted not dropped | `photo-timeline.ts` | tt118-core, e2e-tt118 |
| SV-01 | Find saved searches (full input stored, mode re-validated, cap 30) | `saved-searches.ts` | tt118-core, e2e-tt118 (persists across reload in one profile) |
| AX-20 | Visible words/marks/controls measured in **all 47 module windows** | `scripts/tt118-density.mts` | tt118-density |

Covers map: 12/12 feature codes `full` in tt118-core; e2e-tt118 5/5.

## AX-20 measured table (this build, real Chromium, 1440×960 windows)

Wordiest: spec 11,006 (the register itself — document content, bound 11,500) ·
settings 1,517 (169 labelled controls, bound 1,600) · apps 883 (catalogue
summaries, bound 950) · monitor 487 · backup 387 · messages 335 · storage 308 ·
beam 294 · media 187 · sheet 180 · recall 156 · vector 141 · clipboard 135 ·
find 129 · imageedit 124 · lens 122 · clock 115 · writer 115 · calculator 106 ·
tables 100 · files 98 · routines 96 · alerts 95 · planner 91 · capture 84 ·
together 81 · localdisk 81 · slides 78 · privacy 77 · whiteboard 68 · share 61 ·
ssh 60 · vault 57 · archive 54 · maps 54 · pdf 50 · music 48 · video 39 ·
notes 37 · contacts 37 · photos 28 · books 26 · devices 24 · editor 22 ·
terminal 14 · browser 7 · peek 4. Global ceiling 700 for everything else;
tighter bounds for the ten modules this turn touched. Document content (a note
being edited, task titles, filenames) is counted, never exempted.

Emoji-in-controls flags outside Browser/Recall (beam, media, vector, writer,
calculator, capture, maps, pdf, notes, devices, spec, settings) are printed in
the suite table as baseline: the detector also fires on geometric text symbols
(⌫ ▶ ●) that predate the glyph system. The no-emoji contract remains asserted
where it was established (browser, recall). This is recorded, not hidden.

Visual check (screenshots `docs/screens/tt118-{recall,browser,clock,calculator}.png`,
inspected this turn): Recall 156 words with drawn marks throughout; Browser
chrome 7 words; Clock shows the honest "no common working hour today" verdict
for NY/London/Tokyo; Calculator Convert shows 1 mi = 1.609344 km exactly.
Observed defect, not fixed this turn: several Browser toolbar glyphs render
near-black on the dark theme (low contrast). Recorded here as the top visual
debt item; the density suite measures word/mark counts, not contrast.

## Honest test speedup

`run-fast.sh` (parallel pure-suite runner) gained `tt118-core` in its default
set. Measured this turn on the identical 14-suite pure set, same invocation,
same verdict rule: **JOBS=1: 19.6 s → JOBS=4: 12.0 s (1.64×)**, with the sorted
verdict lines byte-identical (158 passed, 0 failed both ways). Fidelity proof
is that diff, not the clock: scheduling is the only change; suites share no
state. Server/browser suites remain sequential in `run-all.sh` because they
share one server, one database and (by standing rule) one Chromium — running
those in parallel *would* change what they test, so they were not parallelised.
Pre-existing failure, unchanged by this turn and verified identical on the
stashed TT117 tree: `vector-boolean` 2 passed / 4 failed (GEOS-oracle geometry
tolerances). It is not in the gate claim below.

## Gate (this turn, production build, one Chromium, sequential)

tt118-core 12/12 · e2e-tt118 5/5 · tt118-density 1/1 · tt117-density 1/1 ·
e2e-tt117 5/5 · tt116-density 6/6 · e2e-a11y 9/9 · run-fast pure set 158/158.
**39/39 + 158/158.** Not rerun: the remaining ~180 incumbent suites in
run-all.sh (ledger totals therefore stay H∂, as in TT117).

## Outcome space

- **H+ (verified this turn):** the 13 rows above at the stated evidence;
  identical-verdict parallel speedup 1.64× on the pure set.
- **H− (impossible under current constraints, unchanged):** physical-device
  proofs (camera/mic/sensors), native shell integration, and any claim that
  word counts prove comprehension of the glyphs — geometry and naming are
  measured, understanding is not.
- **H∂ (boundary):** full-ledger green (incumbents not all rerun);
  `vector-boolean` GEOS tolerance failures (pre-existing); Browser toolbar
  glyph contrast (observed, unfixed); glyph comprehension.

## Negative space (shapes that would look done but fail the contract)

Regex line diff without LCS (misaligns repeated lines — DF-01 tests ordered
ops); temperature via a single factor table (100 °C ≠ 212 °F exactly — the
failing test that forced 12-significant-digit rounding); cleaning a URL by
deleting every unknown parameter (breaks signed links — UC-01 keeps and
reports); settings import that applies unknown keys (ST-10 refuses and
names them); agenda bucketed by 24-hour windows instead of local days
(PL-03 boundary task at 23:59); fixed-offset zone math (wrong in DST weeks —
WD-01 uses Intl offsets at the instant); a suggestion engine that guesses on
2-character input (TM-02 stays silent); saved searches storing only the query
text (SV-01 stores scope+mode); density measured on two apps and generalised
(AX-20 measures all 47); speedup claimed from wall-clock alone (TT118
requires byte-identical verdict lines).

## Next highest-information test

Run the full `run-all.sh` ledger against this build to convert the H∂ ledger
claim into a number, and fix the Browser toolbar glyph contrast with an
axe/contrast assertion in tt118-density rather than by eye.
