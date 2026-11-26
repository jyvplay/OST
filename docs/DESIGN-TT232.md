# TT232 — duplicate Trash companion identity

## Scope and formal contract

Objects are a current duplicate-report entry for two distinct VFS files, a target and retained peer with id/version/content-digest, and the target's named public VFS companion with either its id/version/digest or an explicit absent snapshot. For each new guarded request, if the target, peer or companion differs from that report at validation, no target or companion should be moved; if all match, the target and present companion move together in the same transaction while the retained peer remains live. The transaction uses the existing cooperative VFS lock. Scope excludes privileged or old writers that do not take the lock, hash collisions, later deletion of the peer, encrypted-name pairing guarantees, and other legacy Trash operations. A user-confirmed irreversible delete, a backup, and the Storage report itself are different problems. Response loss remains ambiguous.

H+: the narrow contract can be implemented by checking the companion identity while holding the same transaction lock as the primary. H−: an old report alone cannot control later file changes, and noncooperating creators of an absent companion are not covered by an advisory lock. H∂: confidence changes with writer cooperation, identity freshness, legacy client version and private-path semantics. Before an evidence claim, require a real browser/database counterexample, build, targeted retests and patch-specific attacks; all-suite success is a separate threshold. PostgreSQL documents `FOR UPDATE` row blocking and warns that deadlocks require consistent lock ordering ([PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)); advisory-lock serialization is cooperative, not a universal global lock.

## Construction and tests

Baseline on a real Chromium 143/HTTP/PostgreSQL fixture: a companion was edited after the Storage report and the old implementation returned 200, trashing it; the test failed 0/1. The report now includes the target companion snapshot. A new `trashDuplicateWithSidecarGuarded` operation requires an explicit snapshot and checks/moves both within the existing VFS transaction. Old endpoints are retained for compatibility and do not gain this stronger protection. Old report formats lacking the snapshot disable the Storage action with an explanation. If the designated retained peer is itself the companion, the action refuses instead of trashing the last matching copy.

After patch, targeted actual-browser and HTTP tests passed 6/6: changed companion, successful pair, new companion after report, companion equal to retained peer, missing guard, and old-server report. TT231 prior regression passed 8/8. Production build and route/VFS lint passed; Storage has a pre-existing effect lint failure. Test suites use disposable PostgreSQL and local server. The tests show bounded cases, not all possible histories. A companion with a corrupt digest, trashed state or malformed identity refuses. A missing-row concurrent insert is protected only against cooperating writers. Sidecar updates are journaled and indexed with the primary transaction, but restore/purge and legacy clients remain separate paths.

## Mechanism portfolio

| Approach / artifact | Established portion | Attack, unresolved interface and gap |
|---|---|---|
| Same-transaction companion snapshot (implemented) | browser baseline 0/1, patched 6/6 | noncooperating missing-row creator; local coordination gap. |
| Post-commit follow (previous code and baseline) | old behavior preserved for legacy operations | new recipe written after report is trashed; baseline counterexample. |
| Recheck then separate write (design) | can detect a stale snapshot before mutation | concurrent replacement between check and write; local TOCTOU gap. |
| Never move companion (design) | would avoid deleting it | leaves orphaned edits and breaks feature behavior; not accepted. |
| Confirmation (design) | records user intention | confirmation does not bind mutable identity; original stale-state gap. |
| Append-only immutable versions (design) | could enable recovery | separate storage, restore, retention and privacy requirements; larger unimplemented interface. |

A successful HTTP status, a prior report, a confirmation, an unchanged filename, equal byte count, a stale digest, a single target identity, a majority/modal successful case, a rendered icon, an iframe, a green build, a mocked transaction, a local mutex, an absent error toast, a dropped response, a screenshot, an old test run, and a register label are not substitutes. The changed-companion attack detects the modal shortcut: usual unchanged companions are insufficient when even one changed instance must be protected. It does not cover every interleaving.

No independent agents, simulators, theorem provers or expert reviewers were used. Browser tests used a real Chromium and PostgreSQL; Playwright response interception in the old-server attack modifies only the response, not the database, and is labeled accordingly. No all-app visual review, ten Class-A promotions, modern-OS parity figure, or Pareto speedup has been established.

## Full regression gate

The full gate `.cache/gate/20261126T024939Z/run-2782-2U779Z` exited 1: TT124 Routines 306/300, TT125 Files 375/260, TT123 Files 373/320. These are measured on this run, not fixed here; fixture/state differences affect counts. The gate ran after the targeted tests and includes TT232. This is not a green release gate.
