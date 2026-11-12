# TT160 full gate

The rebuilt production server with system CA and exclusive disposable PostgreSQL ran `.cache/gate/20261110T214708Z/run-1767005-xKHD2i` (local logs), two pure workers and sequential browser suites. Gate exited 1. Concurrency admission 3/3, settlement 2/2, automation HTTP 4/4, TT146 5/5, layout 12/12, office 11/11 and accessibility 9/9 passed.

`e2e-tt148` failed 1/4: real HEIC refusal test timed out; a standalone rerun also failed the same test 3/4. TT124 density failed Routines 1313/300 and Storage 563/480. TT125 failed Files 369/260. TT123 failed Beam 302/300 and Files 369/320. TT118–122 each first failed Routines 1313/700. Session data accumulates between runs; tests that stop on first assertion can mask further failures. Thresholds were not raised and content was not removed to pass them.

The ledger generated after the gate (before standalone TT148 rerun) reports 674 features, built 649 full / 5 partial / 20 blocked; tested 598 full / 64 partial / 12 untested; 4506/4517 saved assertions and six failing-touch rows. Aggregated historical receipts are not a passing gate. Do not merge.
