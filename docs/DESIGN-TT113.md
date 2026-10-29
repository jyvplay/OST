# TT113 — the small print stops being the interface

## Runtime honesty

One agent, one sandbox, no CI, no second reviewer, no theorem prover. Actually used this turn:
node v22.22.3, `tsc --noEmit`, ESLint, `next build` + `next start` (Next 16.4.3), PostgreSQL 18.4,
Chromium 143.0.7499.0 via Playwright, `curl`, `node -e` with `pg`, `drizzle-kit push`, the
repository's own harness and ledger. Every number below is a reading from one of those, taken after
the change it describes. No number here is estimated or recalled.

## A. Formal model

**Admissible object.** A *module pane*: the DOM subtree of one open window.

**What is counted.** *Visible prose*: the words of every text node in that pane that is **not**
inside a control (`button, select, input, textarea, option, summary`), **not** a heading, badge,
label or list row, and **not** inside a `<details>` that is closed. This is deliberately the
narrowest honest definition — it counts only what a person must read past to reach a control.

**Success.** For each of Recall and Browser: visible prose ≤ 120 words on open, **and** the text
removed from view is still present verbatim inside disclosures, **and** each disclosure is operable
from the keyboard alone, **and** every saving control still exists and is enabled.

**Failure.** Any of: prose over budget; disclosed volume below the floor (text deleted rather than
moved); a disclosure that cannot be opened without a pointer; a control lost to compaction.

**Boundary.** Three kinds of text are explicitly **not** compactable, and TT110's suite proved the
boundary empirically mid-turn:
1. a **consequence attached to an action** ("once a database commit starts it is not cancellable"),
2. a **live measurement** ("Bytes received: 1.2 MB"),
3. the **visible label of a drop target** a person aims at.
These must be readable without opening anything. The budget is for background explanation only.

**Adjacent problems that must not be substituted.** Deleting limits (dishonest); hover-only
tooltips (unreachable by keyboard/touch); `title=` alone (not announced reliably); collapsing a
control instead of its explanation (loses function); shrinking the font (same words, less legible).

## B. Outcome space and declared threshold

- **H+** — a pane can be made to read as a tool while keeping every honest word.
- **H−** — the honesty requirement forces the essay: any compaction loses meaning.
- **H∂** — it holds for background explanation but not for consequences, measurements and labels.

**Declared before the work:** H+ only if a measurement shows both the drop *and* the retention —
word counts before and after, and an opened-state count proving nothing was deleted.

**Outcome: H∂ is the honest verdict, and it was found by a test, not by reasoning.** The bulk
compacts (450 → 55 words in Recall); three statements refused to, and the repair restored them.

## C. Frontier

The in-repo precedent is TT110's app banner: when the tool strip is narrower than its contents, the
tail folds into a **More** menu rather than scrolling off-screen. TT112 extended that to every
layout. TT113 applies the same principle to a different axis — prose rather than controls — with
the same rule: fold, never drop. The external constraint is the HTML `<details>` element, which
gives a disclosure that is focusable, Enter-operable and announced by the platform with no custom
ARIA and no script; a `title` tooltip or a hover popover would satisfy the word count and fail the
reachability requirement, which is why the contract names keyboard operation explicitly.

## D. Negative space — 15 shapes that look like a solution

1. Delete the limits → fails the disclosed-word floor (test 2).
2. Move them to a help page → the pane no longer states its own constraints.
3. `title=` tooltips only → not announced, not touch-reachable; the contract requires `summary` focus.
4. A hover popover → same failure, plus it vanishes when the pointer moves.
5. Shrink the font → identical word count; the measurement is words, not pixels.
6. Put the text behind a custom `aria-expanded` div → re-implements `<details>` worse; no built-in semantics.
7. Truncate with an ellipsis → the sentence is unreadable and no longer honest.
8. Collapse the *controls* instead → loses function (and breaks standalone-browser tests that click them).
9. Count characters instead of words → rewards cryptic abbreviations.
10. Count only `<p>` elements → a `<div>` of prose would escape the budget.
11. Measure with `innerText` on the window → includes closed-disclosure text in some engines; the measure walks nodes and checks `details.open`.
12. Exempt "important" text by hand → the exemption becomes the loophole; the three exemptions here are *categories* (consequence, measurement, label), each pinned by an existing test.
13. Lower the budget until the current code passes → the budget was fixed at 120 before measuring (actual: 55 and 11).
14. Rename sections to one word → "1b" alone is not a name; the headings became short *names* with a status badge, not codes.
15. Assert "the UI looks better" → not falsifiable; nothing in this suite asserts taste.

## E. Mechanism portfolio

| # | Mechanism | Keeps the words? | Keyboard? | Used |
|---|-----------|------------------|-----------|------|
| 1 | Native `<details>` disclosure | yes, verbatim | yes, built in | **yes — primary** |
| 2 | Status badge replacing a sentence ("no new request") | summarises | n/a | yes, for section state |
| 3 | `title=` on a short label | yes, on hover | no | yes, only *in addition* |
| 4 | Labelled toolbar groups replacing a button wall | n/a | unchanged | yes, memory actions |
| 5 | Banner **More** fold (TT110/TT112) | yes, in a menu | yes | inherited, not re-done |
| 6 | Deleting text | **no** | — | rejected by contract |

## F. Artifacts

- `src/components/ui.tsx` — `Hint`, the disclosure primitive (`<details>`, labelled summary, title).
- `src/app/globals.css` — `.fs-hint`, `.fs-toolgroup(s)`, `.fs-tgroup`.
- `src/components/modules/Recall.tsx`, `RecallMemory.tsx`, `Browser.tsx`, `ProxyFrame.tsx`.
- `scripts/e2e-tt113-density.mts` — 6 tests, including the anti-cheat and the keyboard test.
- `src/db/seed-data/features-tt113.ts` (AX-16) and `updates-tt113.ts`.

## G. Second-order adversaries

- **The count-gamer** — deletes a limit to win the budget → test 2's floor on disclosed words.
- **The tooltip-smuggler** — replaces disclosures with `title=` → test 3 fails: no `SUMMARY` to focus.
- **The control-hider** — compacts by removing a button → test 4 enumerates the six saving actions.
- **The pre-opened disclosure** — ships `<details open>` to look compact while printing everything → test 3 asserts the first disclosure starts closed.
- **The vague label** — "More", "Info" → test 2 rejects summaries under 6 characters.
- **The silent regression** — a later turn re-adds prose → the budget runs in the gate on every future turn.

## H. Verification

External: Chromium measures the DOM; the harness records; `tsc`, ESLint and `next build` decide
whether it compiles; PostgreSQL holds the Specs rows. Headline readings:

| Pane | Visible prose before | after | disclosures | words held | controls |
|------|---------------------|-------|-------------|-----------|----------|
| Recall | ~450 | **55** | 12 | 483 | 47 |
| Browser | 79 | **11** | 2 | 79 | 40 |

Opening every Recall disclosure: 55 → **464** visible words (nothing was deleted). Keyboard: focus
lands on `SUMMARY`, Enter opens, 26 words revealed. Six saving pathways present and enabled; memory
actions in 4 labelled groups.

## I. Repair log

1. **Hidden consequence (found by `e2e-tt110-recall`).** "Once a database commit starts it is not
   cancellable" went into a disclosure; the suite reads the pane's `innerText`, which skips closed
   disclosures, and failed. Restored as visible text beside its button.
2. **Hidden measurement (same suite).** "Bytes received: …" became a badge reading "0 B received".
   Restored to the established wording inside the compact badge.
3. **Renamed drop target (found by `e2e-tt109-shell`).** The paste zone's visible label no longer
   contained "paste a copied media file", so the test — and a person scanning for where to paste —
   could not find it. The visible label carries the phrase again.
4. **Double disclosure marker (found by screenshot).** The native `▶` rendered beside the chevron;
   `summary::marker { content: "" }` was missing alongside the `-webkit-` rule.
5. **New attack aimed at the patch:** the density suite now asserts the first disclosure is
   **closed** on open — the cheapest way to "fix" a hidden-text failure would be to ship everything
   expanded, and that now fails.

## J. Stopping, residual gap, next test

**Proved.** Recall and Browser open as tools (55 and 11 words), every removed word is still there
(483 held, 464 restored on open), the disclosures are keyboard-operable, no saving pathway was lost,
and three categories of text that must stay visible are pinned by tests that already existed.

**Gap.** Only two modules are measured. The other ~40 modules have no density budget, and some
(Privacy, Backup, Monitor) are likely as wordy as Recall was. The budget is also a single global
number rather than one scaled to pane size.

**Next highest-information test.** Run the same measurement across every module in the registry and
publish the distribution — one run would say exactly which panes are still documents, and it would
cost one suite rather than one turn per module.
