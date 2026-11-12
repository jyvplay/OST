# TT157 full gate result

Production build and exclusive disposable PostgreSQL; gate log `.cache/gate/20261109T144955Z/run-817817-Dy1iEl` (local cache, not a versioned artifact). The gate exited 1. Two pure workers and one sequential browser lane were used. Prerequisites, pure lane, new trigger browser test 2/2, Monitor 1/1, layout 12/12, office 11/11, accessibility 9/9 and independent TT132 oracles 5/5 passed. Passing suites do not erase the failures below.

- `tt134-review-repairs`: 6/8; both real GitHub framing tests observed `unknown` rather than `deny`. This does not establish why the live probe returned unknown and cannot be replaced with a fabricated result.
- `e2e-tt146`: 4/5; runtime pane click timed out because a Files window intercepted pointer events.
- `tt124-density`: Routines 790/300, Storage 519/480, plus Writer screenshot click intercepted/timed out.
- `tt125-density`: Files 369/260.
- `tt123-density`: Beam 302/300 and Files 369/320.
- `tt118`–`tt122` density suites: each first failed Routines 790/700; they stop at their first assertion so other violations may remain. These measurements include session data in the disposable database.

The generated ledger after this run reports 674 features, 598 full / 64 partial / 12 untested and 4496/4510 saved assertions, with 9 failing-touch rows. This is an aggregation of saved receipts, not a substitute for the failed gate. No PR merge is justified.
