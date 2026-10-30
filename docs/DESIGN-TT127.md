# TT127 — conditional vault saves, Photos order and gate reliability

## Formal contract and decision threshold

The object is the repository's Next.js application, PostgreSQL VFS, service
worker and browser, not a native Android OS. Participating vault clients read a
single node `(id, version, sha256)` and submit either that identity or `null`
(absent) with their ciphertext. Success means: for all competing *participating*
writers of the same current node, at most one same-snapshot transaction commits;
stale or already-created/trashed/changed targets refuse. Acknowledgement loss
must not be described as rollback or success. The controlled race tests are
finite samples, not a proof of all deployments. A grade-A claim would additionally
require security review, browser and device compatibility, crash/failover and
untrusted-server analysis, and all required release gates. Those conditions are
not all met; no features have been newly certified A.

H+: a Postgres transaction with a unique path and current identity check can
prevent ordinary cooperating clients' stale writes. H−: a browser PWA cannot
provide the spec's native Android privileges or become a standalone offline
OS merely through its service worker. H∂: client version, storage visibility,
Postgres durability, device support and competing noncooperating writers matter.
The design does not assert a complete OS, zeroized JS memory, system autofill,
hardware camera verification, or protection against a malicious server.

External references reviewed: PostgreSQL's Read Committed behavior for locking
reads and concurrent changes, and its discussion of concurrent `ON CONFLICT`
insert (https://www.postgresql.org/docs/15/transaction-iso.html). The existing
`safeTransaction` rejects an uncertain COMMIT acknowledgement and discards the
connection; losing an acknowledgement does not establish the transaction's
outcome. These statements assume the actual unique constraint, transaction
isolation, and deployed server implementation; they are not universal claims
about arbitrary VFS writers, physical devices or restored database histories.

## Mechanisms, counterexamples and cheapest next checks

1. **Atomic file identity:** existing conditional VFS operation locks and checks
   the file or uses conflict-safe insertion; the response now includes committed
   id/version/hash. Artifact: `tt127-conditional.mts` races two HTTP requests on
   real PostgreSQL, checks returned identity, tamper and trash refusals. Gap:
   unconditional writers can deliberately overwrite later; raw SQL, backup
   restores and old servers are not forced to use this protocol. Local gap;
   next test covers an ordinary writer racing a conditional write with held locks.
2. **Vault reconciliation:** client retains the identity and KDF salt from its
   authenticated read, writes conditionally, serializes per-window operations,
   and locks/rechecks after a conflict or uncertain result. Artifact:
   `e2e-tt127-vault.mts`, real Chromium and PostgreSQL with two contexts. A
   Playwright route forwards an actual write, then deliberately aborts its
   response: it is transport fault injection, not a pretend persistence server.
   Gap: no exactly-once transaction token, physical crash/failover or multi-device
   hardware review; conflicting attempted edits must be re-entered. Local gap.
3. **Photos ordering:** don't overwrite name/size sorts with date sorting; group
   non-date sorts into one ordered group; react to changes in sort selection.
   Artifact: `e2e-tt127-photos.mts` uses two real VFS image files and checks tile
   order and next-photo navigation. Gap: date metadata can arrive asynchronously;
   the old intermittent navigation timeout is not proven fixed. Local gap; next
   test deliberately delays actual metadata reads while walking a capture-date list.
4. **Readiness instead of delay:** the accessibility harness waits for shell
   bootstrap and the requested scale, not a banner and fixed delay. Artifact:
   three previously failing tests pass twice with those checks. Gap: product
   hydration failure correctly times out; broader suites still need a full run.
   Local test-harness gap.
5. **Selective waiting:** TT125 browser suite removes per-window 1.2 s sleeps,
   replacing the editor's vulnerable delay with a wait for exact file content;
   other existing selectors retain their assertions. Artifact: measured paired
   runs below. Gap: measurements are a small sample on one host, not a general
   performance theorem; selectors do not prove untested product functionality.
6. **Accessibility repair carried from TT126:** the file-operation journal has
   an accessible name and keyboard focus. Artifact: real browser/axe check in
   `e2e-tt126.mts`. Gap: a targeted axe pass is not complete WCAG or human review.

## Rejected result shapes

A button count; a register promotion; TypeScript alone; an omitted slow test;
a cached page mistaken for a local DB; a mock storage server; HTTP success alone;
a nonzero process claiming a passing summary; a shared lock without an identity
check; a stale read followed by unconditional write; a 409 silently retried as
an overwrite; a connection error called a rollback; a saved optimistic UI state
without a server acknowledgement; ciphertext treated as immune to a hostile
client; a successful optional camera constraint claimed to prove physical torch
state; a single browser claimed as cross-browser proof; an axe run claimed as a
human accessibility review; and a single sorted fixture that does not exercise
both date and name/size. The modal shortcut is “counting UI controls”: a sort
control existed while the final date sort overrode it. The independent detection
is a real UI test using two differently sized images with opposite filename and
size orders, including the editor's next-photo button.

## Timing and runtime

On this two-vCPU environment, the identical TT125 suite and assertions were run
serially with a disposable dev server. Fixed 1.2-second sleep: 60.488 and 61.290
seconds wall; readiness version: 50.181 and 48.774 seconds wall (means 60.889 vs
49.478, about 18.7% less). User+system CPU means were approximately 23.335 vs
22.625 seconds. Order, system load and a two-run sample limit the inference;
this does not claim a universal Pareto improvement or faster full gate. A new
exact-content readiness check strengthens one assertion; no suite was omitted.

The prior accessibility test's three relevant cases reproduced three failures
under the original banner/sleep ordering (38.977 s) and passed twice after
waiting for shell/scale readiness (21.139 and 21.541 s). As the baseline failed,
this is evidence of a race repair, not a valid same-fidelity speed comparison.

Available and actually used: shell, Node 22, TypeScript/Next compiler, Playwright
Chromium, PostgreSQL 17.5 and the existing Python/Shapely oracle in the fast
suite. Web search was used for primary PostgreSQL behavior. No independent agent,
theorem prover, physical camera/torch, or human security reviewer was used.
No third-party source code was incorporated in the changes this turn.

## Verification

- Build and typecheck: passed on the final production code before the production
  gate. The exact validation output is in this turn's tool results.
- Focused tests: conditional HTTP/DB 3/3; two-context Vault 3/3; Photos 1/1;
  TT126 browser 4/4; TT125 3/3; all ran against real processes. Fault injection
  is described above. (Test cases are not equivalent to 20 independently
  certified features.)
- Production gate: **passed**, using Next production build on port 3001 and a
  freshly initialized, exclusive disposable PostgreSQL database. This included
  all listed pure suites, the TT126/TT127 focused suites, `e2e-tt120` 4/4,
  `e2e-a11y` 9/9 and all ten density suites. The updated tests and the user-visible
  application were the same build. Selected gate results are preserved in
  `docs/evidence/tt127-gate-e2e-{a11y,tt120,tt125}.json`. Prior TT126 dev-gate
  failures and isolated retries remain documented in `DESIGN-TT126.md`.
- Targeted ESLint on touched source and test files: zero errors, one existing
  Vault cleanup-ref warning. Full repository lint was not rerun this turn;
  TT126 reported extensive existing failures.
- Camera, multi-browser, offline cold-start, failover, expert security review and
  complete visual inspection of every app remain open. The Lens screenshot was
  inspected this turn, without physical-camera exercise. Existing generic VFS
  writers can still overwrite the vault outside the cooperating-client protocol.

## Follow-up to the fast-run default

After the production gate, review found that the TT126 fast-run repair omitted
`oracle-ai` from the default set. Although the original default refused itself
because this suite has network access, silently dropping it would reduce intended
coverage. The default now runs the original pure set in parallel and then runs
`oracle-ai` serially, failing rather than skipping it. Explicitly supplied pure
suite lists, including the production gate's list, are unchanged. A stub-child
regression verified that the default actually invokes the oracle and propagates
its nonzero exit; TT126 regressions now pass 5/5. The real oracle was **not run**
in this session: its pre-existing held-out corpus has unspecified licences and
its additional independent tools are not installed here. Accordingly the gate
pass is not a claim that oracle-ai passed. The production gate preceded this
script-only follow-up; the gate's exact explicit pure list was rerun successfully
and the updated regression was run, but the full production gate was not repeated.
