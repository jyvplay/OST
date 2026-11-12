# TT156: Monitor disclosure, bounded evidence

## Question and model
On a 1280×900 or 1500×1040 Chromium desktop with the disposable app database, can the Monitor present core status first while retaining its diagnostic panels? Success means native keyboard-operable disclosure, all previously rendered panels still mounted and reachable, and lower initially visible text without altering density caps. This is not a proof of screen-reader behavior, mobile discoverability, or production readiness of each engine.

H+: named groups reduce initial Monitor density while preserving interactions. H−: disclosure makes important controls undiscoverable, inaccessible or loses state. Boundary: expanded groups remain long; native details implementation and labels may not suit every assistive technology. Best known frontier: prior full gate Monitor measured 1508 words (cap 520); TT156's TT119 and TT120 runs measured 305 in their respective sessions, and TT124 Monitor passed. This is a different run with a mutable database, not a controlled timing or perfect before/after experiment.

## Six mechanisms and attacks
1. Native details/summary: Enter and Space open; Enter closes/reopens in real Chromium. Screen readers not tested.
2. Group labels: three topical summaries; visible in screenshot, but no independent user discoverability study.
3. Persistent mounted children: a changed filter input survives closing and reopening its group. Reload persistence is not claimed.
4. Core Monitor remains exposed: the existing in-flight control is awaited without expanding any group.
5. Existing engine controls: 16 panel test IDs checked visible after opening two groups; real text input edited. This does not exercise every control.
6. Regression containment: production build, TypeScript, TT141 browser 8/8 and the new browser test 1/1 passed; TT124 still fails Routines and Storage. No complete gate rerun.

The new browser test was run before the patch and failed waiting for the missing disclosure, then passed after implementation; expanded-state screenshot visually inspected. W3C guidance on [progressive disclosure](https://www.w3.org/WAI/people-use-web/tools-techniques/presentation/) and [disclosure keyboard operation](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-card/) informed the design; implementation is independent and native details is not the APG example implementation.

## Misleading result shapes to avoid
1. A passing cap is not proof of usability. 2. Hidden controls are not removed controls. 3. Mounted controls are not necessarily discoverable. 4. Keyboard success is not screen-reader verification. 5. One viewport is not all sizes. 6. A screenshot is not an interaction test. 7. Test IDs being visible do not prove outcomes. 8. Edited input is not durable persistence. 9. A lower word count is not necessarily less cognitive load. 10. Mutable database counts are not controlled paired measurements. 11. A passing app is not a passing gate. 12. A production build is not a complete regression. 13. Historical receipts are not current verification. 14. Shorter interface text is not evidence of new functionality. 15. A draft PR is not a merged, release-ready result.

## Remaining gaps
TT124 density: Routines 697/300, Storage 507/480. TT119 and TT120 first fail Backup 459/440 (and stop at the first assertion); additional prior density failures may remain. TT125 and TT123 were not rerun here. Full gate, assistive-technology testing, all-app visual review, original graphics, measured repeat-test performance improvement and twenty new Class-A promotions remain unfinished. Do not merge on this evidence. Browser suites share a disposable database and must run exclusively.
