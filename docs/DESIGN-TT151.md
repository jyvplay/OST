# TT151 — QR and time engines

## Scope and evidence

* `src/lib/qr.ts` implements byte-mode QR versions 1–10, L/M/Q/H, with explicit capacity refusal. `scripts/tt151-qr.mts` compares 14 pinned-mask matrices to independently generated python-qrcode 8.0 fixtures and decodes seven symbols with zxing-cpp. Its mask-penalty test compares four separate rules with a Python implementation. This is finite test evidence, not a proof of conformance for all inputs.
* `src/lib/totp.ts` implements Base32, SHA-1/HMAC, HOTP and TOTP. The time suite checks RFC 4648, FIPS 180-4, RFC 2202, 4226 and 6238 vectors. Unsupported algorithms are refused. Malformed percent escapes in URI labels must be rejected, not throw.
* `src/lib/cron.ts` parses five fields and selected macros, describes schedules from parsed fields and enumerates zoned occurrences. A UTC brute-force reference and targeted New York DST gap/overlap cases exercise it. It is **not wired to routine execution**; it does not run scheduled jobs.
* Beam provides a locally generated QR for user-entered text, with a size limit and SVG download. Vault provides session-only TOTP codes while unlocked: no persistence, no encrypted OTP storage, and not a replacement for a full authenticator. The UI does not send OTP secrets to the server. Codes and secrets are dropped from the component state on lock; JavaScript does not guarantee memory zeroisation. Clipboard copying depends on browser permission and may place a code on the system clipboard.
* `scripts/e2e-tt151.mts` exercises both panels in real Chromium against a disposable server and database. It creates and removes its own empty test vault, refuses to overwrite an existing vault, and changes desktop state. Do not run against user data.

These engine tests intentionally do not invent spec-register rows or claim existing complete feature coverage. Their identifiers in test names are local test labels. The feature register and ledger remain separate from these preliminary capabilities.

## Runtime and limits

Executed with Node 22, TypeScript, a real Chromium, PostgreSQL, python-qrcode and zxing-cpp. No independent agents or theorem prover were used. Time-zone rules come from runtime tzdata. QR scanning evidence uses an independent decoder, not camera hardware. No broad visual review or complete application gate has been established by the TT151 tests.

The cron brute-force UTC reference reads UTC fields directly rather than repeatedly invoking ICU `formatToParts`; dedicated DST cases still exercise the zone-aware path. A prior 40-day ICU brute-force probe took roughly 17 seconds; the current full time suite reported 95 ms test time on this environment. They differ in implementation, so this comparison alone is not a formal performance guarantee. Broader test acceleration and profiling remain open.

The generated ledger currently records historical failures in multiple suites. Passing the TT151 tests does not establish that those failures are resolved. Re-run the relevant suites, check fresh main, and perform the full merge gate before merging. No claim is made that all existing features, or 20 additional features, are Class A.
