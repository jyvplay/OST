# TT96 — bounded calculator work and investigation of TT95 regressions

## Runtime, scope, and honest status

Work used the checked-out PWA on Node 22.22.3, PostgreSQL 18.4, and headless Chromium 143.0.7499.0, with separate explicitly disposable development, production-gate, and preview databases. The work is partial: **zero new canonical Class A features have been promoted**, versus the user's requirement of at least ten. PR-09 remains partial; no prior failing aggregate has been reclassified as passing. The most recent completed TT95 production gate failed **65/69 suites, 474/480 cases, exit 1**. All six named failures passed selected reruns (2 + 2 + 1 + 1), but that cannot erase the aggregate or prove causes. See `docs/DESIGN-TT95.md` and `docs/evidence/tt95-final-*`.

A new production build passed and a larger production gate is running. Its result must be recorded separately once complete; a build or selected reruns alone are not a passing gate. Earlier privacy throughput and latency failures are unresolved; TT95's final run measured encrypt 55 MB/s against ≥50 MB/s, and host/private save 33.1/49.4 ms against a limit of approximately 51.03 ms, so its pass was near both limits. No performance fix or threshold change is claimed.

## Formal contract and quantifiers

For a **single expression** of at most **512 UTF-16 code units** and at most **64 nested parentheses/unary operators**, Programmer mode accepts decimal, `0x`, `0b` and `0o` integers; parentheses; unary `+`, `-`, `~`; binary `* / %`, `+ -`, `<< >>`, `&`, `^` (XOR), `|`, in that precedence order. For each selected width in {8, 16, 32, 64}, every intermediate is reduced modulo 2^width. Signed mode interprets division, remainder, right shift and decimal display as two's complement; division truncates toward zero. Unsigned right shift is logical. Shift counts are themselves word-sized expressions: **after wrapping and signed interpretation**, they must be nonnegative and less than the width. Thus in 8-bit unsigned mode `1 << 256` is `1 << 0`, not an unbounded shift. Division by zero, unsupported grammar, excessive input and excessive nesting are rejected. Decimal, hex, octal and binary output are derived from the exact BigInt word. Scientific mode retains the existing Number evaluator and 12-significant-digit display; the palette remains scientific, where `^` is exponentiation. Standalone radix literals beyond the safe integer range are refused in that mode rather than silently rounded; this is not a claim that Number-based decimal/scientific arithmetic is exact.

History is in the mounted window's memory by default. Only an explicit toggle opts future calculations into **unencrypted, origin-local browser storage**; saved history is not Notes, global Search, encrypted Private storage, or a backup. Other same-origin scripts and anyone with access to the browser profile may read it; browser eviction, storage denial and quota remain possible. An amnesic session neither reads nor writes/deletes that saved history. The app displays at most 40 recent entries ordered by recorded time and prunes older stored entries after a successful save. Cooperating same-origin tabs use Web Locks where available; per-entry keys avoid a single-array lost append. Without Web Locks, concurrent pruning/clearing is best effort and can leave extra stored entries or race with a clear. A failed storage operation is reported as potentially committed, not definitely absent. No cross-device sync or exactly-once guarantee is made.

**H+ — selected evidence:** the Python oracle generated 2,112 deterministic integer cases (1,600 binary and 512 depth-three trees) covering each width and signedness; the TS suite passed 8/8. Chromium exercised real controls, exact 64-bit output, default/session history, opt-in reload/filter/restore/delete, unencrypted localStorage, a held Web Lock with two queued tabs, quota/corruption, amnesia, offline calculation, narrow reflow and axe; 9/9 passed. Independent test doubles checked storage boundaries and faults 6/6. These are selected tests, not universal proof.

**H− — selected refusal/detection:** programmer invalid expressions, zero divisors and bad shift counts are rejected; malformed history is preserved rather than overwritten; duplicate ids do not overwrite; explicit deletion is restricted to the calculator prefix; denied storage does not produce a confirmed-save message. The two TT95 UI failures were investigated with new deterministic baselines: lower-edge context menus escaped the desktop (0/2 before repair); selected dark-Silver server badges measured 4.48:1, below 4.5:1 (2/4 before repair). The repaired edge-menu tests passed 5/5, and the badge contrast tests passed 5/5 across 13 styles × 2 themes × hovered/unhovered, including deliberate old-behavior injections. These reproductions identify real defects consistent with two gate symptoms; they do **not** establish that either was the unique cause of the TT95 failures.

**H∂ — frontier:** the original Calculator specification does not enumerate every scientific function, key or unit and broader scientific/keypad coverage remains unproven; radix literals within compound scientific expressions are still not programmer expressions. Only selected Chromium/Desktop PostgreSQL schedules were exercised, not physical mobile devices, other engines, native installed-PWA associations or arbitrary storage failures and crashes. Calculator history is browser-profile data and is not encrypted, globally indexed, recoverable after browser eviction, synchronized across devices, or included in backups. A separate direct probe found an existing scientific-units defect: `1e308 km to mm` returns `ok: true` with `Infinity mm` rather than rejecting overflow; this was not repaired in the production build being gated. The TT95 fan-count, embedded-terminal follow, spreadsheet A2 and fallback-gesture timeouts have not been causally repaired. Existing Photos CAS, offline queue, VFS locks and privacy guarantees retain the boundaries in TT95/TT94. Scoped lint is not repository-wide lint.

## Negative shapes and adversarial schedules

1. Decimal fraction supplied to the integer parser.
2. Scientific function name supplied to programmer mode.
3. Unsupported `**` exponent syntax and unsupported `>>>`.
4. Division by zero.
5. Remainder by zero.
6. Shift count equal to the width.
7. Negative signed/effective shift count.
8. Unsupported width (7 rather than 8/16/32/64).
9. Missing digits after `0x` and invalid hexadecimal, binary or octal digits.
10. Adjacent values without an operator and malformed repeated shift characters.
11. Trailing operator or unmatched parenthesis.
12. JavaScript statement/property names or code-injection punctuation.
13. More than 512 characters, including whitespace padding.
14. More than 64 nested parentheses or unary operators.
15. Large radix literal beyond `Number.MAX_SAFE_INTEGER` in scientific mode.
16. A stored record with malformed JSON, wrong id/key, invalid mode/width/signedness/time or oversized text.
17. A duplicate history id.
18. A denied `setItem` / quota error; separately, a pruning deletion failure after a successful append.
19. More than 1,000 pre-existing calculator keys: reads fail closed but an explicit delete can recover.
20. Two tabs queue distinct writes behind an actually held Web Lock.
21. Amnesia with an existing local history and enabled preference: neither reading, writing nor deleting the underlying history is allowed.
22. Lower-right context click; menu taller than the available large-text surface; viewport shrink after opening.
23. The old offscreen placement is injected into the live DOM; geometry and a real click must reject it.
24. A selected Files badge in all light/dark style tokens, hovered and unhovered; the old dark-Silver muted color is deliberately injected and axe must reject it.
25. Modal-shortcut mutations remove the editor guard or the shell modal hold, then actually attempt Ctrl+F and the global palette behind Slides Save-as.

These cases use finite examples and selected schedules. The history unit fault doubles and the two UI injections are explicitly test instrumentation; the UI, browser, database and oracle are real rather than claimed hardware or simulated production services.

## Mechanisms and artifacts

1. `src/lib/programmer.ts`: bounded recursive-descent parser, explicit precedence, modulo arithmetic, signed/unsigned interpretation and base formatting without `eval` or new runtime dependencies.
2. `src/lib/calc.ts`: preserves the scientific/palette evaluator and refuses unsafe standalone radix literals rather than silently displaying rounded integers.
3. `src/components/modules/Calculator.tsx`: labelled mode/width/signedness controls, real keypad and history recall, accessible labels, scrollable small-window layout and explicit local-storage consent/status.
4. `src/lib/calc-history.ts`: independently keyed, validated local records; bounded scanning/pruning, collision/corruption refusal and prefix-only explicit deletion.
5. Same component: checks the active privacy session, skips all persistent history in amnesia, and coordinates participating tabs via Web Locks with an explicitly weaker fallback.
6. `src/components/DesktopSurface.tsx`: measures real menu and desk geometry, translates viewport coordinates, clamps on opening/resize and scrolls oversized content.
7. `src/app/globals.css`: uses the readable text token for default badges within selected list rows, preserving other badge tones.
8. `scripts/oracle/tt96-programmer.py`: separately written deterministic Python arbitrary-precision arithmetic oracle, not the application parser. `tt96-programmer.mts`, `tt96-calc-history.mts` and `e2e-tt96-calculator.mts` exercise its contract and storage behavior.
9. `e2e-tt96-desktop-menu.mts` and `e2e-tt96-files-contrast.mts`: real-browser edge/resize/dock and axe/style checks, including deliberate detection controls.
10. `tt96-calculator-mutants.py`: 19 targeted mutations run in temporary copies, with selected original baselines checked first; `tt90-modal-mutant.py` rechecks two actual Slides shortcut-failure mutations on the disposable development server.
11. `features-tt96.ts`, seed 3.76.6, ledger generator and guarded runners: report PR-09 as partial and incorporate the new tests without calling these sub-capabilities separate Class A promotions.

## Baselines, repairs, and verification

The old scientific evaluator used as the programmer baseline passed **1/8** new contract tests; it lacked bitwise expressions and rounded a large radix literal (`tt96-programmer-baseline.*`). An early test runner caught *all* import failures and silently fell back to the old evaluator; this was repaired to fall back only if the module is absent. The first implementation also used TypeScript parameter properties unsupported by Node's strip-types test path and BigInt literals unsupported by the repository's pre-ES2020 TypeScript target. Explicit fields and `BigInt(0)` fixed those problems; `tt96-programmer-first-recheck.log` and `tt96-first-typecheck-failed.log` preserve the failures.

The first six-case calculator browser run found the history list could be visually overlapped by the footer and could not be clicked; the real layout was changed to permit scrolling and give the history a minimum height. The corrected run passed **6/6**, and the later expanded run **9/9**. This failure and the corrected run are retained under `tt96-calculator-browser-*`.

The desktop-menu baseline's first small-screen test initially clicked a real desktop widget rather than the background, so its timeout was not evidence of menu layout. After selecting an unobstructed desk point, both geometry checks failed on the old code (**0/2**); the measured/clamped/scrollable implementation then passed **5/5**, including Art dock, resizing and injected old placement. `tt96-desktop-menu-{baseline,corrected-baseline,recheck,adversarial}.*` preserve the sequence.

The Files contrast baseline failed the dark Silver selected server badge at **4.48:1** on both hover states; light checks passed. After the targeted CSS change, 13-style × 2-theme × 2-hover checks and an injected previous-color detection passed **5/5**. Exact axe evidence is in `tt96-files-contrast-{baseline,recheck,adversarial}.log`.

Focused sequential regression after repairs passed **48/48 across 8 suites**: programmer 8, history doubles 6, calculator register audit 4, Chromium calculator 9, menu 5, Files contrast 5, Slides 7, destructive-test safety 4 (`tt96-focused-regression.log`). Scoped TypeScript, ESLint for changed TS/TSX and test files, and `git diff --check` passed (`tt96-code-checks.log`); no claim of repository-wide lint. The 19 selected calculator/storage mutants were killed **19/19** in temporary copies, not the live server (`tt96-calculator-mutants.log`). Selected mutations are useful detection controls, not completeness proof.

The required modal/shortcut failure-and-detection test ran in the disposable dev environment: removing the editor guard let **Ctrl+F open behind Save-as**, and removing the shell modal hold let the **global palette open after focus escape**. Both mutants were detected **2/2** (`tt96-modal-mutants.log`); the original Slides suite then passed **7/7**.

## Source review

[Math.js](https://github.com/josdejong/mathjs) (Apache-2.0), [expr-eval](https://github.com/silentmatt/expr-eval/blob/master/LICENSE.txt) (MIT), [BigNumber.js](https://github.com/MikeMcl/bignumber.js/blob/main/LICENCE.md) (MIT) and [OmniCalc](https://github.com/neon-glitch-ESC/omnicalc/blob/main/LICENSE) (MIT) were reviewed for parser, precision and programmer-mode scope; none was installed or copied. [MDN BigInt](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/BigInt), [operator precedence](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Operator_precedence), [Web Storage](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API) and [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) informed the independently written bounded implementation and limits. The external Python oracle and test-only dependencies do not ship in the PWA.

## Final gate, preview, and next test

The expanded production gate is pending. The new optimized build succeeded (`tt96-production-build.log`), and a separate production preview on port 3000 returned HTTP 200. Local headless Chromium evaluated `0xffffffffffffffff` exactly in 64-bit Programmer mode, saw saving disabled in an amnesic session, and had no uncaught page errors (`tt96-preview-smoke.log`). The browser-facing proxied HTTPS URL and physical devices have not been independently exercised. The preview uses a separate database from the destructive gate.

Next: record the entire production gate outcome and any failed cases without overwriting evidence with selected reruns; refresh the mixed-date ledger and rebuild the static endpoint if needed; update the draft PR honestly. If the gate or the ten-Class-A requirement remains unmet, do not report the work as complete or treat focused passes as aggregate success.
