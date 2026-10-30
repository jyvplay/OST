# TT121 — twenty-one Class-A features, drawn star glyphs, gate extended

Register: 505 → **526 requirements, 420 built** / 64 partial / 24 blocked /
18 probe (live `/api/features`, `/api/spec-health` clean for all TT121
codes). SEED 3.91.0. PR #14 kept open at the user's instruction.

## Built (engine + UI + unit contract; mechanism e2e where the UI is the mechanism)

| Code | Feature | Code | Feature |
|---|---|---|---|
| CV-02 | Calculator memory register (window-only, NaN refused) | EB-01 | Books chapter + % read (clamped) |
| ED-05 | Editor sort / reverse-sort / dedupe lines | PD-01 | PDF stepped zoom (shared ladder) |
| CK-05 | Clock timer presets 1m–1h | WB-06 | Whiteboard zoom % + 100% reset |
| TM-05 | Terminal `sort` (-n/-r/-u) and `uniq` (adjacent vs -g) | PL-06 | Planner copy-today's-agenda text |
| NT-05 | Notes list ordering (pinned lead) | SR-11 | Find copy-results-as-text |
| MD-10 | Media playback speed (snapped ladder) | MU-04 | Streams library sort (stable, non-mutating) |
| SC-19 | Vault strength meter + CSPRNG generator | PH-05 | Photos sort by name/size |
| NC-07 | Alerts unread-only + derived count | CN-07 | Contacts has-email/phone facets |
| CB-02 | Clipboard kind facets (whole-entry only) | BK-09 | Dated backup filenames, strict parse |
| MP-09 | Maps decimal + DMS coordinates with copy | AP-06 | Apps group facet |
| AX-23 | Drawn star/starFill UiGlyphs replace ★/☆ text | | |

Evidence: `tt121-core` 19/19, `e2e-tt121` 4/4 (memory recall into the
expression, 25m preset → 25:00, editor sort+dedupe on a real file,
terminal `sort -u`, playbackRate = 1.5 on the element, facet filtering,
star renders as inline SVG, generated passphrase rates strong),
`tt121-density` 47/47 apps.

## Redirected by the code (not duplicated)

NT-05 was planned as note pinning — Notes already had server-side pins;
it became list ordering. SR-11 was planned as result filtering — Find
already had pattern filtering; it became an exportable result list.
Both redirections are recorded in the seed rows.

## What the gate caught this turn

1. **AX-23 broke TT120's CN-06 e2e** — it asserted the literal "★
   Starred" text. The drawn glyph is the intended new contract, so the
   incumbent now uses the accessible name "Starred". Disclosed here;
   the change is in `scripts/e2e-tt120.mts` in this commit.
2. **Spec word bound 11_500 → 11_800 in all four density suites** —
   the register grew by exactly these 21 rows and Spec lists every row
   (measured 11_529). Bound maintenance with the reason in a comment,
   same treatment as TT120's Clock/Monitor bounds.
3. **PH-04 failed once inside the first gate run and passed isolated
   and in the clean re-run** — recorded as gate-contention flake (the
   TT120 e2e-a11y pattern), not silently absorbed.
4. Two measurement/test bugs of my own: an over-clever sort-then-uniq
   expectation, and a float-rounding expectation in MP-09 — both fixed
   in the tests after the engines proved correct.

## Speedup accounting (honest)

The gate grew (26 → 30 suite summaries) because tt121-core,
e2e-tt121 and tt121-density joined it; one clean run is 14m01s vs
TT120's 12m01s for fewer suites — cost scales with coverage, no
fidelity was traded. Per-suite cost is dominated by sequential
Chromium contexts against one server/DB, which remains the honest
constraint. The TT121 e2e initially hung on a missing `browser.close()`
— fixed; suites must close their browser (recorded rule).

## Outcome space

- **H+:** twenty-one features at stated evidence; full gate green as
  one command; ★ no longer depends on font fallback anywhere in
  Contacts.
- **H−:** unchanged platform limits; playback speed cannot reach into
  provider embeds (stated in the Media UI).
- **H∂:** full-ledger green (run-all.sh not run end-to-end; the gate
  covers TT116–TT121 families plus incumbents listed in run-gate.sh).

**Next highest-information test:** full `run-all.sh` run; then the
remaining partials that are buildable without platform primitives
(SH-10/SH-13/SH-14 shell family, FM-11/FM-14 files family).
