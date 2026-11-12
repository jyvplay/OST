# TT161 — clipped thumbnail gate investigation

## Model and hypotheses
The admissible model is the real production build, Chromium, the Files grid, a disposable PostgreSQL-backed VFS, and a thumbnail whose ancestor clips it outside the listing. H+: scrolling the target into the listing triggers the existing lazy pipeline and permits the genuine-format assertion to finish. H−: the target remains pending or yields a result inconsistent with the same browser's decoder. Boundary: DOM existence or viewport geometry alone is not intersection with a clipped scroll container. This is an observed case, not a proof for every browser, position, cache state, failure, or queue load.

## Evidence and patch
The TT160 genuine HEIC test twice timed out pending. On an instrumented rerun its tile was at y=649–739 while its scrollport ended at y=544, even though the viewport was 900px high. Scrolling it into view moved it to y=341–431 and the unchanged format assertion passed (1/1). MDN describes clipping of intersection rectangles by ancestors: https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API. This corroborates, but does not independently prove, the application-specific causal chain.

The FF-06 tests now scroll their actual tiles into view before waiting for asynchronous results; the same pixel/blob/format and decoder assertions remain. The two uniquely named VFS files are purged afterwards. The new adversarial browser test constructs 60 preceding files and a genuine HEIC in an isolated directory, verifies the target is clipped and pending, scrolls it, and compares the result with the real browser decoder. The directory is purged afterward. Added it to the sequential browser gate. On the production server, revised TT148 passed 4/4 and the new test passed 1/1 twice. A pending value sampled once does not establish indefinite laziness; no network tracing or queue exhaustion experiment was performed. The test reads the same `/tmp/tt148-heic.json` fixture as TT148 and inherits its external fixture prerequisite.

## Six mechanisms and attacks / verification frontier
1. Ancestor clipping: measured target vs scrollport geometry; not every nested layout tested.
2. Lazy observation: deliberately clipped target was pending at sampling; no timing guarantee claimed.
3. Scroll interaction: real Chromium scroll followed by a terminal state; no cross-browser coverage.
4. Decoder: same-page createImageBitmap comparison with genuine HEIC; not a general HEIC conformance test.
5. False positive resistance: retain content, refusal wording, blob and pixel checks in TT148; AVIF unsupported branch was not exercised by this Chromium run.
6. Isolation: unique fixture directory and purge; crashes before finally can still leave fixtures, and tests require an exclusive disposable database.

Misleading result shapes to avoid: DOM present implies visible; viewport overlap implies scrollport overlap; pending implies decoder failure; fixed timeout implies deadlock; one success proves all browsers; one failure proves bad bytes; stub decoder proves real support; extension proves encoding; refusal proves correct reason; cache hit proves fresh rendering; worker started proves completed job; no console error proves correctness; isolated rerun proves full gate; shorter elapsed time proves CPU improvement; aggregate ledger implies Class A. This change has no measured Pareto speedup or feature promotion. The TT160 density gate failures remain unresolved; full gate has not been rerun for TT161, so no clean-gate or merge claim is made. Broader visual review, 20 production-ready Class A promotions, and scheduler/automation security and execution gaps remain outstanding.
