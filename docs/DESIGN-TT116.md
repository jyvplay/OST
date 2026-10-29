# TT116 — safe save, retention, stable paging, and the third de-wordification pass

This document is the written half of TT116. It records the formal model the turn worked
inside, the false solutions that were available and rejected, the mechanism-distinct
approaches considered for each build, and the exact places where the work stops being
provable. It is written to be read against the suites, not instead of them.

## A. Runtime honesty

What actually ran this turn, and nothing else: `bash`, `git`, `gh api`, `node`, `npx tsc`,
`npx eslint`, `npx drizzle-kit`, `npm run build`, `next start`, Playwright's bundled
headless Chromium via `scripts/browser-launch.mts#launchChromium`, and PostgreSQL 18 on
`127.0.0.1:5432`. Two local fixture origins on ports 4001 and 4002. One box, two cores,
about 3.9 GB of RAM, one process at a time.

There was no second agent, no theorem prover, no model checker, no fuzzer, no hosted CI,
no external reviewer, and no parallel execution of suites. Every number in this document
came out of a command run in this sandbox, and every command that produced a number is
named next to it. Where a claim has no runnable check behind it, it is marked `H∂` and
is not counted as evidence.

Network access is restricted to `github.com`, `codeload.github.com`, `api.github.com`,
`registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`. No documentation site was
reachable this turn, so TT116 made no new external fetches; the research base is the set
of pages fetched in TT106–TT110 and recorded in those design documents. Any claim that
would have needed a fresh external source is marked as such below rather than asserted.

## B. Formal model

**Objects.** A *memory* is a pair of VFS nodes: a media file at
`/Downloads/Recall/<folder>/<name>` and a receipt at the same path plus `.recall.json`.
A *safe save* is a triple (token, stage node, target path). A *retention run* is a
function from (folder, rule set, dryRun) to (candidates, kept, skipped). A *page
sequence* is a list of reads over an append-only id order.

**Access.** Everything is reached over HTTP against one Next.js server owning one
PostgreSQL database. There is no second writer outside the server, and no filesystem
below the VFS: a "file" is a row.

**Resources.** One process, two cores. A suite may take minutes; the gate takes about
twenty-five. No suite may launch a second Chromium while another is running.

**Success quantifiers.** For this turn:

- *Safe save*: for every interruption point in the staged-replacement sequence, the
  target afterwards holds either exactly the old bytes or exactly the new bytes.
- *Retention*: for every rule set, the applied set equals the planned set; and for every
  memory whose pair cannot be proved, that memory is still present afterwards.
- *Paging*: for every save interleaved between two page reads of one sequence, the union
  of the pages contains no duplicate and skips no memory that existed when page one was
  read.
- *Density*: visible word count strictly below the measured baseline, with every
  accessible name preserved and every removed caption replaced by drawn geometry.

**Boundaries.** Durability ends at the database: there is no `fsync` of a real
filesystem, so "atomic" means "atomic with respect to a PostgreSQL transaction", not
"survives a power cut". Secure erasure does not exist here; retention moves rows to
Trash. Glyph *comprehension* is not modelled at all — only geometry and naming are.

## C. Hypothesis classes and the evidence threshold

**Declared threshold.** A claim is `H+` only if a command in this repository produces a
pass/fail result for it, the command is checked in, and it ran this turn against a
server built from this turn's code. A claim is `H−` if a command produced a result that
contradicts it. Everything else is `H∂`: plausible, perhaps even obvious, but not
measured — and `H∂` never counts towards a feature's status.

### H+ (measured this turn)

| Claim | Evidence |
|---|---|
| A staged replacement journals seven stages in causal order | `tt116-safesave.mts` 15/0 |
| An expected-version mismatch with `onConflict:"copy"` publishes `name (copy N).ext` | same |
| A FAILED attempt releases its token for retry; the sweep cannot reclaim an in-flight save | same |
| Input representability is validated before the stage is published | same, and §F.1 |
| An applied retention run trashes exactly the dry run's candidates | `tt116-recall-retention.mts` 7/0 |
| An unpaired memory is skipped and survives a run that would otherwise take it | same |
| Rules compose by intersection; `maxAgeDays:0` keeps nothing | same |
| Ten invalid scopes/rule shapes are refused with 400 | same |
| A pinned page sequence returns 6 distinct memories where the unpinned one skipped 1 | same |
| Recall renders 153 visible words, 43 controls, 52 marks, 33 distinct shapes | `tt116-density.mts` 6/0 |
| Every shortened control still answers to its full accessible name | same |
| 0 label-in-name violations in Recall | same, and `e2e-a11y` 9/0 |
| One page URL yields three distinct folders under three groupings | `tt116-recall-archive.mts` 8/0 |
| Identical bytes answer `stored:false` + `duplicateOf` and write no file | same |
| A deliberate re-save still stores | same |
| A receipt is never regenerated after it is lost | same |
| A scoped search excludes a sibling sharing a name prefix | `tt116-platform.mts` 9/0 |
| `POST /api/search` returns 501 `rebuilt:false` | same |
| `write`/`move`/`trash` are journaled; a move records both ends | same |
| `privacy.screenCapture=off` is enforced inside the commit transaction | same |

### H− (contradicted this turn, and acted on)

- *"A reopen-and-compare proves the bytes are representable."* False: the driver
  substitutes U+FFFD for a lone surrogate before PostgreSQL sees it, and
  `createHash().update(string)` applies the same substitution, so both digests agree on
  corrupted data. Representability is an input property. (§F.1)
- *"Validating input before the journal row exists is equivalent."* False: a refusal
  raised before the PREPARE insert is invisible to the journal. (§F.2)
- *"`move` and `trash` are not journaled."* False — and this one was a test bug, not a
  product bug: the route takes `src`/`dst`, and sending `{from,to}` made the server
  correctly refuse an identical move. The missing journal entry was a missing operation.
- *"A trashed node is gone."* False: the row persists with `trashed=true`, so absence
  must be read from a listing, not from a 404.
- *"A duplicate-code feature row can be added to a new family file."* False: the ledger
  resolved the duplicate by position and left three promotions reading `partial`.

### H∂ (unmeasured; explicitly not claimed)

- That the 10 new glyphs are *understood*. Geometry is measured; comprehension is not.
- That the staged-replacement guarantee survives a host power failure.
- That retention's intersection semantics are the ones a person expects, as opposed to
  the ones documented.
- MD-07's no-`EyeDropper` branch, unchanged from TT115: this Chromium has `EyeDropper`,
  so the fallback is unreachable without deleting the global in an init script.
- PR-07j's "merge back" half, unchanged from TT115.

## D. False-solution shapes

Fifteen ways to appear to have done this turn's work without doing it. Each is named,
with why it is wrong and what in the repository refuses it.

1. **The word-count diet.** Delete the sentence that warns a commit cannot be cancelled
   and the count drops. Refused by the floor assertion in `tt116-density.mts`, which
   requires that exact warning, the drop-target label and a pathway heading to be on
   screen.
2. **The disclosure dodge.** Move the filter row inside `<details>`; collapsed text is
   not visible text. Refused by the measurement itself, which skips
   `details:not([open])` *and* asserts a control count of at least 40.
3. **The deletion dodge.** Remove three filters; fewer controls, fewer words. Refused by
   the named-control list: seventeen names must all resolve.
4. **The letter icon.** Replace a caption with "M" in a span. Refused by the geometry
   check: every mark must be an `<svg>` with real path data.
5. **The one-shape icon set.** Draw one square and reuse it ten times. Refused by the
   distinctness check: at least 20 geometrically distinct shapes.
6. **The emoji shortcut.** Paste 🧹 instead of drawing a broom. Refused by the emoji
   scan over control labels.
7. **The silent rename.** Shorten the visible label *and* the accessible name together,
   which passes a word count and breaks eight suites and every screen reader. Refused by
   the name check and by `e2e-a11y`'s label-in-name rule.
8. **The mocked save.** Make `safeSave` write directly and report the seven stages
   anyway. Refused by the stage-order assertions and by the sweep test, which requires a
   real stage node to exist and be reclaimable.
9. **The digest tautology.** Verify the staged bytes by hashing the same string twice.
   This is exactly what the first implementation did, and §F.1 is the record of catching
   it.
10. **The optimistic retention.** Trash by rule and let the audit sort out the pairs
    afterwards. Refused by the skip-and-survive assertion: an unprovable pair must be
    left alone.
11. **The union rule.** Compose retention rules by union, which deletes more and looks
    more effective. Refused by the intersection assertion over `maxAgeDays:1 +
    maxItems:1`.
12. **The dry run that is not dry.** Return a plan and trash anyway. Refused by counting
    the folder before and after a dry run.
13. **The offset page.** Keep using `OFFSET` and call the skipped memory a race. Refused
    by the pinned-vs-unpinned comparison, which produces 6 against 7.
14. **The status flip.** Change `partial` to `built` in the ledger and cite a suite that
    touches the module. Refused by this turn's rule that every promotion names a suite
    whose assertions address the feature directly — and by the fact that writing those
    suites narrowed three claims (§E).
15. **The green-by-reuse gate.** Run the gate against the database the development
    iterations used, where fixtures already exist. Refused by the virgin-database recipe:
    `DROP DATABASE`, `CREATE DATABASE`, `drizzle-kit push`, rebuild, restart, warm.

**Detector for the modal shortcut.** The modal shortcut this turn is #14 — promotion by
assertion rather than by evidence. The detector is mechanical and was run: for each
promoted code, grep the named suite for the code in a `test(name, covers, fn)` cover map
*and* read the assertion bodies for a reference to the feature's own mechanism (the
digest, the pin, the intersection, the name, the switch). A row whose suite mentions it
only in a cover map, with no assertion naming its mechanism, fails the detector. All
twelve promotions pass it; the detector is why RC-13's UI control exists at all, since a
feature no human can reach is not a feature that a UI suite can honestly cover.

## E. Three claims this turn made *smaller*

Writing a test is the cheapest way to discover that a sentence was too wide. Three rows
now say less than they did:

- **RC-34** claimed recognition of bytes "the archive already holds". The scan is
  `WHERE parent = <folder>`: recognition is per folder. The row now says so.
- **SR-05** claimed "scoped in-folder search". It is a path-prefix scope anchored on the
  separator — a stronger and more precise statement, now tested against a sibling folder
  whose name is a prefix of the scope.
- **DP-14** claimed "every background job observable" with the implication of stages.
  Writes and safe saves carry stage lists; trash and restore write one COMPLETE row. The
  row now distinguishes them.

## F. Two genuine defects found by the suites

1. **The digest tautology.** `safeSave` originally proved the staged bytes by reopening
   them and comparing a hash. A lone surrogate in the input is replaced with U+FFFD by
   the driver on the way in, and `createHash().update(string)` performs the same
   substitution on the way out, so a corrupted save verified clean. The fix validates
   representability on the *input*, and additionally asserts `decodedBytes ===
   declaredBytes`.
2. **The invisible refusal.** Validation ran before the journal's PREPARE insert, so a
   refused save left no trace. The validation now runs inside the try, after the row
   exists, and the refusal is a journaled FAILED stage.

A third was found in the test suite rather than the product: `tt116-recall-retention`
left an unpaired fixture in the database, which made `e2e-tt107-memory`'s integrity audit
fail in a shared gate database. The suite now cleans up after itself, and the failure is
recorded here because "a suite that poisons a later suite" is a defect class, not an
accident.

## G. Mechanism-distinct approaches

### G.1 Safe save (FM-18)

| # | Mechanism | Artifact | Proved | Unresolved interface | Cheapest falsifier | Local vs equivalent |
|---|---|---|---|---|---|---|
| 1 | Stage under a token, reopen in a second transaction, verify, replace | `src/lib/server/safe-save.ts` | 15 assertions | No `fsync`; durability ends at the DB | Kill PostgreSQL mid-replace and read the target | Local: equivalent to a journaling rename only if the DB is the storage layer |
| 2 | Single-transaction write with a `CHECK` on length | not built | — | Cannot verify a digest the DB did not compute | Write a lone surrogate and compare digests | Equivalent only for byte-exact inputs |
| 3 | Copy-on-write version chain, publish by pointer swap | not built | — | Version table has no pointer column | Add a column and swap under load | Strictly stronger; costs a schema migration |
| 4 | Client-side two-phase commit with a token | partially present (RC-39) | Lost-ack idempotency proved TT114 | Client must retain the token across a reload | Reload between phases | Local only: a client that forgets is a client that duplicates |
| 5 | Advisory-lock the target path for the whole save | rejected | — | Serialises unrelated saves to one path | Two concurrent saves to one path | Equivalent safety, worse liveness |
| 6 | Write to a real temp file and `rename(2)` | impossible here | — | There is no filesystem under the VFS | `ls /.safe-save` outside the DB | Not local-equivalent: a different storage model |

### G.2 Retention (RC-13)

| # | Mechanism | Artifact | Proved | Unresolved interface | Cheapest falsifier | Local vs equivalent |
|---|---|---|---|---|---|---|
| 1 | Plan-then-apply with intersection rules, pair-locked trash | `src/lib/server/recall-retention.ts` | 7 assertions | Concurrent saves during a long run are not in the plan | Save during an applied run | Local: a plan is a snapshot, not a lock |
| 2 | Trigger-based deletion in PostgreSQL | rejected | — | A trigger cannot be dry-run | Ask for a plan | Not equivalent: loses review |
| 3 | Background sweeper on a timer | rejected | — | Violates "nothing happens unless a person asks" | Leave the app open | Not equivalent: changes the privacy model |
| 4 | Client-side selection, server deletes a list | rejected | — | Client could list a path it never saw | Post a path outside the folder | Weaker: the scope check must be server-side |
| 5 | Quota-triggered eviction at save time | not built | — | Would refuse a save for a reason the person did not choose | Fill the folder and save | Different semantics, not a substitute |
| 6 | Tombstone + later purge | partially present (Trash) | Restore proved in earlier turns | Purge is a separate explicit act | Restore after a run | Local: this is why the feature trashes rather than erases |

### G.3 Stable paging (RC-18)

| # | Mechanism | Artifact | Proved | Unresolved interface | Cheapest falsifier | Local vs equivalent |
|---|---|---|---|---|---|---|
| 1 | Pin the highest id on page 1, filter `id <= asOf` | `/api/fs?op=recallPage` | 6-vs-7 comparison | A memory saved after page 1 is not in the sequence | Save, then page, then refresh | Local: a view of one instant |
| 2 | Keyset pagination on (created_at, id) | not built | — | Needs a composite index to stay cheap | Page a 100k-row archive | Equivalent correctness, better cost |
| 3 | Server-side cursor | rejected | — | Holds a transaction open across requests | Open two tabs | Not equivalent: stateful server |
| 4 | Snapshot isolation per sequence | rejected | — | Read Committed is the default; a repeatable-read transaction cannot span requests | Same | Not available across HTTP |
| 5 | Client-side dedupe of overlapping pages | rejected | — | Hides the skip instead of fixing it | Count distinct ids | Strictly weaker |
| 6 | Materialised timeline table | not built | — | Another write on the commit path | Measure commit latency | Different cost model |

### G.4 De-wordification (AX-18)

| # | Mechanism | Artifact | Proved | Unresolved interface | Cheapest falsifier | Local vs equivalent |
|---|---|---|---|---|---|---|
| 1 | Caption → `aria-hidden` glyph, phrase kept as `aria-label` + `title` | `RecallMemory.tsx`, `Recall.tsx` | 153 words, 0 violations | Comprehension unmeasured | Ask a person what the broom means | Local: naming is proved, meaning is not |
| 2 | Tooltip-only labels | rejected | — | A tooltip is not an accessible name on touch | Tab to the control | Weaker |
| 3 | Icon font | rejected | — | A font is a dependency and a licence | Check the licence | Not permissible here |
| 4 | Sprite sheet with `<use>` | not built | — | Would defeat the distinctness check as written | Count distinct geometries | Equivalent output, different measurement |
| 5 | Progressive disclosure of whole sections | partially used | — | Hiding a consequence is forbidden | Read the floor assertion | Not equivalent for consequences |
| 6 | Shorter prose, same structure | used for the two policy notes | 213 → 153 overall | Prose still dominates the remaining count | Re-measure | Local: complementary, not a substitute |

## H. Candidate-specific second-order adversaries

For each build, the attack aimed at *the patch* rather than at the original defect:

- **Safe save.** After moving validation inside the try, the new risk is a journal row
  that claims PREPARED for a save that never staged anything. Attacked by asserting the
  full stage list on success and the FAILED stage with a released token on refusal.
- **Retention.** After adding the UI control, the new risk is an Apply button that
  applies something other than what was planned. Attacked by asserting the Apply control
  does not exist before a plan, and that the applied set equals the planned set.
- **Paging.** After pinning, the new risk is a pin that never expires, so a refresh never
  shows new memories. Attacked by asserting an unpinned read sees the new memory.
- **Density.** After shortening labels, the new risk is a visible word outside the
  accessible name. Attacked by a label-in-name sweep using one normaliser for both sides
  — using two is how TT115's checker invented violations that did not exist.
- **Specs mirror.** After adding a family file, the new risk is a duplicate code resolved
  by position. This one *fired*: the first attempt left FM-18, RC-13 and RC-18 reading
  `partial`. The repair moves them to the update map, and the verification is a direct
  read of `/api/features` for all four codes.

## I. External verification binding

There is no external verifier available in this sandbox: no CI, no second agent, no
reviewer, no reachable documentation host. Every claim in §C is therefore
*self-verified* — produced by suites written in the same session as the code they test —
and is downgraded accordingly. The strongest independent checks available were used
where they exist:

- `axe-core` (`e2e-a11y`) is third-party code evaluating the accessibility claims,
  including label-in-name. It passed 9/0.
- PostgreSQL itself adjudicates the transaction and digest claims; the digests are
  computed in the database, not in the test.
- `music-metadata@12.3.2` remains the out-of-repo oracle for TT101/TT102 metadata, used
  by absolute-path import and never vendored.

Claims resting only on code written this session are marked as such in §C and should be
read as "consistent with its own tests", not "independently verified".

## J. Gate

The gate is 71 suites against a virgin database, with a server rebuilt from this turn's
code and warmed before the first suite. The log is
`docs/evidence/tt116-production-gate.log`.

| Gate | Database | Suites | Passed | Failed | Exit |
|---|---|---|---|---|---|
| A | `tt116_seal_test` (virgin) | 71 | 784 | 2 | 1 |
| B | `tt116_seal3_test` (virgin) | 71 | **786** | **0** | **0** |

Gate A's two failures were both caused by this turn and both were caught by incumbent
suites, which is the outcome the standing rule "when a new suite and an incumbent
disagree, the incumbent wins" exists to produce:

- `e2e-tt111-recall` — the de-wordification pass shortened the tap-policy note and took
  the route to the switch with it. Repaired, and `tt116-density` now asserts that every
  policy note still names `Settings → Privacy → …`, which is an attack aimed at this
  turn's own patch.
- `tt114-recall-token` — RC-34's `test` string named `e2e-tt109-recall.mts`, a file that
  does not exist. The guard that refuses a feature row citing a suite that is not on
  disk did its job against a fabricated reference. Repaired, and every `.mts` name in
  the TT116 seed files was re-checked against the directory.

Previous baselines: TT113 61 suites 704/0, TT114 Gate A 733/7, TT115 Gate F 741/0,
**TT116 Gate B 71 suites 786/0**.
