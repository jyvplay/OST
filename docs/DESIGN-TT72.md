# TT72 — Office readers by XML syntax and namespace, Writer part relationships; SH-11 pad; SC-05 access log

## Runtime honesty

- **Ran:**
  - Node 22 with strip-types, tsc, and the Next 16.2.6 production build (three rebuilds).
  - Playwright 1.64.1 with Chromium 143, headless.
    - Its own fake capture devices (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`) for SC-05.
  - Embedded Postgres 17.10.
  - Python 3.11 with lxml, python-docx, openpyxl and zipfile as oracles.
  - The mutant runner.
- **Did not run:**
  - Word, Excel, PowerPoint or LibreOffice: the office claims rest on the corpus, lxml, python-docx and openpyxl, not on Microsoft apps.
  - A real second monitor: `/display` was a second page in the same browser context, which is exactly the
    BroadcastChannel scope a real second window would share.
  - Real camera, microphone or screen hardware: Chromium's fake devices were used.
  - Firefox, Safari and phones.
- **No theorem prover.** "Safety over 2 000 generated cases" is a seeded property test, not a proof.
- **A regression I introduced earlier this turn, found and fixed:**
  - Commit 0bef657 sent every Writer part through namespace canonicalisation. That broke byte-identical no-edit
    saves for 49 of 113 corpus documents: Word 2007 spells markup compatibility `ve:`, so those parts were rewritten.
  - tt72-office only checked reads, and the regression appeared only when tt46-writer and tt49-writer were re-run.
  - Repaired below (I2). It was never released in a gate.

## Truth check (why these rows)

- **Writer and Spreadsheet first,** as asked. The tier began with the office readers (0bef657):
  - XML 1.0 attribute syntax: single quotes, and spaces around `=`.
  - Namespace by URI, not by prefix.
- **Two "built" rows had no code:**
  - SH-11: the Blackout pad nudged only its own screen.
  - SC-05: there was no device-access log.
  - Both are now built and tested. Their register text says they were absent until TT72.

## A. Formal model

- **Office:**
  - A reader R is *syntax-invariant* when R(x) = R(x′) for every x′ that an XML 1.0 + Namespaces 1.0 processor treats as
    the same infoset as x: quote style, `S? = S?`, prefix choice, default namespace.
  - A writer is *lossless* when W(R(x)) equals x byte for byte on every part except `docProps/core.xml` (`dcterms:modified`).
  - OPC: a relationship id is scoped to its **source part**. resolve(part, rId) uses `<dir>/_rels/<part>.rels`.
- **SH-11:**
  - Message m = ⟨v, kind, from, to, seq, op⟩.
  - A shell applies m only if all of these hold:
    - parse(m) ≠ ⊥;
    - m.to = self;
    - m.seq > last[m.from].
  - padCommands(op, desktop) yields commands that name only the focused, non-minimised window (or cycle / showDesktop).
- **SC-05:**
  - An entry is live from a grant until every track has ended, either by an `ended` event or by `stop()`.
  - outcome ∈ {granted, denied, failed}.

## B. Hypotheses

- **H+ (confirmed):**
  - Single-quoted and foreign-prefix office files read identically: W1, W5, S1, P1, C1.
  - The pad moves the presenting screen's window: e2e 1–2.
  - The access log follows the real stream lifecycle: e2e 1–2.
- **H− (confirmed):**
  - TT71's Writer resolved comment and note pictures through the document's rels, and its media cache crossed parts.
    W6 found one corpus file (testComment.docx: the comment's picture was styles.xml). W7 shows the body's picture
    appearing in the header, the comment and the footnote.
- **H∂ (open):**
  - OOXML Strict WML (purl.oclc.org) is still not in WML_CANON. It stays a blocker.
  - An edited part of a foreign-prefix document is written canonically: valid and the same infoset, but with different
    prefixes and hoisted declarations.

## C. Frontier

- **Pictures inserted in the editor** go into the main document part only. Inserting into a header, comment or note
  through the UI is not offered.
- **The pad:**
  - It drives the newest presenting screen only; there is no picker when two are open.
  - Same-origin scripts are trusted by design. Proxied pages are not same-origin (see G2).
- **The access log:**
  - It covers Fusion modules. Sites inside the Browser use the browser's own permission UI.
  - It lives in RAM per tab. A second tab has its own log.

## D. Negative shapes (≥15) + modal shortcut

- **SH-11 parse rejects 24 shapes:** null, a number, a string, an array, `{}`, v=2, a missing or empty from, a from
  with a space, a 65-character id, an unknown kind, a bad host, a missing dy, NaN, ∞, a string dx, key "a", key
  "Delete", op "type", a null op, a `../x` recipient, seq −1, seq 1.5, and a string seq on an ack.
- **The e2e channel adversary sends 6 more,** plus replayed and stale seq values.
- **SC-05:** 8 error names are classified, along with a null error, empty or 500-character module names, 300 entries
  (capped at 200), a double stop, and a stream with no tracks.
- **Modal shortcut:** on the Blackout screen, Tab is captured (it cycles the remote windows) and focus does not leave
  the overlay; e2e 2 asserts this.

## E. Mechanism-distinct approaches

1. **Whole-corpus differential:** the original against an equivalent rewrite (q: prefix, default namespace, single
   quotes), for 113 docx, 330 xlsx (1 250 494 cells) and 63 pptx.
2. **Independent oracles:**
   - lxml namespace equivalence (768 parts);
   - python-docx and openpyxl;
   - zipfile + lxml resolution of part relationships (W6).
3. **Synthetic adversarial package:** W7, with one rId in four parts.
4. **Byte-level losslessness:** W8, plus tt46 and tt49.
5. **Real browser, two real pages,** with BroadcastChannel as the transport (e2e-tt72-pad), plus an opaque-origin
   sandbox attack.
6. **A seeded property test** over 2 000 (op, desktop) pairs, plus the real reducer.
7. **Chromium fake capture devices** through the production UI, with request-body leak inspection (e2e-tt72-access).
8. **Mutation testing:** 38 of 38 killed (19 office, 13 pad, 6 access).

## F. Artifacts

- **Code:**
  - `src/lib/office/wordml.ts`: relsOfPart, the per-part media cache, the `canon` original-bytes pass, and the ve: exemption.
  - `src/lib/windowing/pad-link.ts`, `src/components/usePadLink.ts`, and the Shell Blackout overlay.
  - `src/lib/access-log.ts`, `src/components/modules/AccessLog.tsx`, and 9 call sites (Devices ×3, Lens ×2, Capture,
    Share, Clipboard, Maps, Shell).
- **Tests:**
  - `scripts/tt72-office.mts`: W1–W8, S1–S2, P1, C1.
  - `tt72-padlink.mts` (6), `e2e-tt72-pad.mts` (5), `tt72-access.mts` (3), `e2e-tt72-access.mts` (4).
  - `tt72-mutants.py`.
  - `scripts/harness.mts` gains `HARNESS_ONLY`; a filtered run never writes the results file.
- **Seed:** `src/db/seed-data/features-tt72.ts` (FF-21, FF-22, FF-23, FF-51, SH-11, SC-05), SEED_VERSION 3.58.0.

## G. Second-order adversary (attacks on the patch)

- **G1:** an office-reader patch that rewrites parts can break losslessness. It did (0bef657, 49/113); repaired in I2.
- **G2:** the Browser's proxy serves third-party pages from Fusion's origin. Could such a page post to `fusion-shell`?
  - **No.** The proxy frame is sandboxed without `allow-same-origin`, so the page has an opaque origin and its
    BroadcastChannel is partitioned.
  - e2e 4 proves this in Chromium: the frame's script ran (`origin null`), posted 5 valid moves, and nothing moved.
- **G3:** a reloaded pad restarts its sequence, so the receiver's replay filter would drop it. The sequence is seeded
  from the clock (`max(seq+1, Date.now())`), and a unit test covers it.
- **G4:** MediaStreamTrack.stop() fires no `ended` event, so a naive log would stay "live" forever. stop is wrapped,
  and A2 kills the mutant that drops the wrapper.
- **G5:** Stop on the dashboard ends the tracks. The recorder then stops by itself, but the Devices button stayed on
  "Stop". Repaired: `onstop` clears the state, and e2e 1 asserts it.

## H. External verification

- python-docx, openpyxl, lxml and zipfile (W1–W8, S1, P1), none of which this code wrote.
- Chromium's BroadcastChannel origin partitioning and its fake capture devices.
- Postgres-persisted desktop state for display-2.
- No Microsoft app was available.

## I. Repair (+ new attack aimed at the patch)

- **I1:** comments, footnotes and endnotes use their own part's rels, and the media cache is used for the main part
  only. Attacked by W7 (rId9 in four parts) and by mutants O15–O17.
- **I2:** losslessness after canonicalisation.
  - Parts whose text canonicalisation changed are recorded, and an unedited re-emit gets its original bytes back.
  - Word-2007 `ve:` parts with no AlternateContent are read as written.
  - Attacked by W8 (113 originals plus 113 q-prefixed rewrites, byte-identical), tt46 (12/12) and tt49 (9/9).
  - O18 is killed by W8; O19 is killed by tt49's edited-header test, because only an edit exposes the hoisting.
- **I3:** revision ids read in single quotes. Attacked by W5 (21 corpus documents carry w:id values) and O3, which
  survived until W5 existed.

## J. Stopping

- **Full gate:** run-all with 176 suites (TT71: 172) → **1310 passed / 3 failed, 1 crash** (GATE EXIT 0).
  - All four are on the known-flaky list and pass on re-run: tt39-unit 13/0 (the Python ws server did not start in
    time), e2e-tabletop 15/0, and e2e-privacy 14/0 when run alone.
  - e2e-privacy's failures are timing thresholds on a loaded sandbox (49 MB/s; 68 ms vs 40 ms) and the known
    intermittent backup verify. None of that code changed this turn.
- **Targeted:** the 16 Writer unit suites, plus tt72-office, tt72-padlink and tt72-access, after the repair; tt46 12/12 and tt49 9/9.
- **Mutants:** 38/38 killed.
- **Ledger:** tested full **232** (TT71: 230) / partial 72 / untested **79** (81). Tests 1326/1326. Tails: 39 rows (9 / 10 / 20).
- **Why stop here:**
  - The office readers are now syntax-invariant over the whole corpus.
  - Writer part relationships are correct and losslessness holds.
  - The two "built"-but-absent rows are built.
  - The next office steps (Strict WML, header and note picture insertion in the UI) are new features, not repairs, and
    do not fit this turn.
