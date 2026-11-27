# TT235 — metadata changes during legacy companion follow

## Model and resources

This turn used the repo, Node/TypeScript/Next compiler, ESLint, Playwright and actual Chromium 143, the actual Next HTTP server, and a real exclusive disposable PostgreSQL 19 database. PostgreSQL documentation was searched. No independent agents, theorem prover, simulator or external expert reviewer was used. The host provides two CPUs; database-mutating suites ran sequentially.

Objects are an existing row returned by the legacy companion lookup after a primary trash/restore/purge transaction, followed by the row returned under `FOR UPDATE` in the later companion transaction. For every operation and every history in which these two rows differ in any mapped VFS field (timestamps compared at JavaScript millisecond precision), the later transaction must not change or delete that row. A changed primary remains committed; it is not rolled back. An unchanged, still-applicable companion may follow; existing no-op behavior must be preserved. Success is measured as row data, trash state, and response for the forced interleaving, not runtime. This is not a contract about an update before lookup, directory descendants, a missing row inserted after an absence read, exact sub-millisecond timestamp distinctions, changes subsequently undone to identical snapshots, mixed old servers, or a durable association. It is not a secure-erasure or lost-ack guarantee.

H+: comparison of all mapped columns after row locking detects this class of metadata-only change. H−: no comparison of two values can detect an ABA history that returns to the same observed values, and a row snapshot cannot protect unobserved descendants. H∂: scope depends on mapped schema, temporal precision, cooperative behavior, and whether change happens before lookup. The evidence threshold for the narrow repair is a counterexample on the earlier production build, a new build, real PostgreSQL attack tests including a different metadata field, and the affected legacy and browser regressions. A green full gate is separate.

## Frontier and interface

PostgreSQL documents that `FOR UPDATE` holds a row lock until transaction end and prevents concurrent updates/deletes of that locked row; at READ COMMITTED a row-locking command waiting for an update uses the changed row once it is committed. Row locks are not locks on absent rows. See [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) and [transaction isolation](https://www.postgresql.org/docs/15/transaction-iso.html). Those conditions do not prove this software correct in a mixed-version deployment. The still-open interface is the gap between primary commit and companion lookup, plus identifying the right companion across independently trashed groups, changes of children, and lost responses.

## Experiment and repair

`scripts/tt235-companion-metadata-race.mts` uses one real SQL transaction to update only tags (the current `setTags` implementation likewise changes tags without bumping file version), starts a real HTTP request, observes an actual blocked backend with `pg_blocking_pids`, then commits. The pre-patch server failed **0/3**: trash, restore and purge followed the metadata-changed companion. After the change, those three pass, and the separate MIME-only attack also passes: **4/4**. The changed VFS check now compares all mapped VFS row fields, with timestamps compared at the precision represented by JavaScript `Date`.

After patch: production build and changed VFS lint passed. Real PostgreSQL and Chromium regressions: TT234 race 4/4, browser warning 1/1, TT233 8/8, TT232 6/6, TT231 8/8, TT95 concurrency 13/13, TT95 forced race 3/3, TT94 photo guards 12/12, TT128 Photos 11/11, TT55 Files 15/15. These finite experiments do not establish the universal property independently of source assumptions. The recurring gate includes the new attack suite, which is more capable but not demonstrably faster; no Pareto speedup is claimed.

## Independent mechanisms and adversaries

| Construction / artifact | What is established | Cheapest specific attack | Remaining interface |
|---|---|---|---|
| Compare mapped locked row (this change) | actual tag and MIME-only forced races 4/4 | change companion before lookup, restore all fields, or edit a descendant | local observation/provenance gap |
| Compare original TT234 subset (baseline) | rejects tested content change | tag-only update 0/3 | local missing-field counterexample |
| Version token updated by every writer (design) | would simplify comparison when universally maintained | old writer, raw SQL, trigger disable, migration | universal writer participation and ABA remain |
| Fully atomic primary and companion (TT232 duplicate-trash artifact) | tested duplicate guarded Trash only | legacy restores, purge, directory association | broader compatibility and migration gap |
| Retain immutable provenance record (design) | could identify a paired deletion | old independent trash groups, missing old records and purge history | schema and migration problem |
| Never follow (design) | no unintended companion follow | ordinary paired restore | breaks required behavior |
| Serializable transactions (documented design) | participating committed serializable histories serialize | mixed isolation, application retries, wrong identity | insufficient for provenance by itself |

A HTTP 200, a filename match, equal size, matching content, equal digest, equal file version, an existing row lock, a screenshot, a green compiler, a modal unchanged-companion case, a confirmation, a previously read report, a simulated DB, a local mutex, an advisory lock ignored by old writers, an error toast, a later retry, and a ledger label are not substitutes for this contract. The modal shortcut is defeated by the tag-only test: normal unchanged companions succeed but one changed metadata field must be refused.

No ten additional Class-A features, all-app visual review, new graphics, verified test speedup or defensible modern-OS parity percentage was established. The prior full gate was red; do not infer current gate status from it.

## Full gate and visual observation

Full gate `.cache/gate/20261127T035321Z/run-93843-ziWvzY` exited 1; the new metadata test passed 4/4 in the gate. TT124 Routines measured 332/300 words; TT125 Files 375/260; TT123 Files 375/320. The network-dependent `tt134-review-repairs` wide and compact GitHub framing checks returned `unknown` rather than `csp-restricted`; cause not isolated. No caps were changed. A fresh real-Chromium TT183 Files screenshot was inspected: its three example panels are labeled as examples but consume a substantial part of the pane and are text-heavy; this is one screen in one configuration, not an all-app audit. No user-facing wordiness or graphics repair was made.

The next high-information test remains a deterministic barrier between primary commit and companion lookup: install a test-only observation hook without faking the HTTP server or database, then create or replace the companion before lookup. Follow with provenance-bound atomic design and attacks on old trash groups; this turn did not establish that property.
