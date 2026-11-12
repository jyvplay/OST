# TT152: cold-start launch and regression triage

## Contract and evidence threshold

For a live shell boot, a recognized one-shot URL intent must open exactly once after hydration. A cancelled/superseded boot must neither consume the URL nor dispatch its intent. When a named desktop is selected, removing a one-shot intent must preserve the desktop selector so reload returns to the same desktop. This is a browser lifecycle and state-persistence contract, not a proof about all multi-tab concurrency. The patch is accepted locally only after TypeScript, a real-browser delayed-bootstrap regression, a mutation showing that regression fails without the guard, and a named-desktop reload check. Merge requires the wider production gate as well.

## Investigation and repair

React Strict Mode can replay an effect in development; React's documentation describes ignoring stale asynchronous results (https://react.dev/learn/synchronizing-with-effects). The boot effect had a cancellation flag around hydration, but the cancelled continuation could still consume the query and dispatch a launch. This left the current boot with no launch. The continuation now stops after cancellation; it also suppresses a stale failure toast. When the live effect consumes a one-shot intent it retains `desk`, rather than silently switching to `default` on reload.

`scripts/e2e-tt152-boot.mts` uses a real dev server and Chromium. It lets the cancelled setup read the database while holding the next bootstrap, asserts that the launch remains unconsumed, releases it, checks exactly one Spreadsheet window, then checks that the named desktop persists and reloads. It deletes its unique disposable desktop. Two separate mutations were tried: removing the cancellation return failed the cancelled-window assertion, and stripping the retained desktop parameter failed the named-desktop assertion. Both were reverted and the repaired test passed. These tests do not prove all possible schedules.

Vault's session-only one-time-code copy now goes through the shell's sensitive-copy path, rather than bypassing it with a direct clipboard write. That path masks the in-app history and attempts to clear the system clipboard after 30 seconds; browser permissions and clipboard access can prevent clearing. The real-browser TT151 test verifies a clipboard write, the sensitive-copy indication, and a rejected clipboard write reporting failure instead of success; it does not verify the later OS clipboard clear. The OTP entry still is not encrypted/persistent storage.

## Regression evidence and boundaries

The previously recorded office, sheet-layout and TT146 failures were rerun on a production build: 11/11, 7/7 and 5/5 respectively. The four previously recorded offline-worker failures passed 4/4 against a production server. Running a development server is not a substitute for that production-worker test. The full gate was not run and other historical failure records remain; a green subset is not a green gate.

TT152 did not implement cron routine triggers, persistent encrypted OTP entries, or 20 new Class-A features, and did not visually inspect every module. No measurable broad test-speed improvement is claimed. No additional third-party code was incorporated; the React documentation was reviewed for lifecycle behavior. The highest-information next step is to rerun the remaining failed production browser suites in an exclusive disposable environment, investigate any reproducible failures, regenerate the ledger, and run the complete gate against a fresh build.
