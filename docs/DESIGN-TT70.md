# TT70 — sealed recovery drafts, sparse whole-column ranges, Close all, WM-13 edge-hold, untested rows

## Runtime honesty

- **Ran:**
  - Node 22 (strip-types), tsc, and the Next 16.2.6 production build (three rebuilds this tier).
  - Playwright 1.64.1 with Chromium 143 (headless, @sparticuz), and embedded Postgres 17.10.
  - Python 3.11 venv: msoffcrypto-tool, python-docx, openpyxl, and the standard-library `zipfile`.
- **Did not run:**
  - Word, Excel or LibreOffice (none are available).
  - Firefox or Safari, a real OS share sheet, or a real multi-monitor desktop.
- **Excel behaviour this tier rests on:**
  - **COUNTBLANK and COUNTIF `""`** follow Microsoft's documented semantics, recorded in TT68. A whole column has
    1,048,576 rows, so its blank tail counts.
  - **SUMIFS / COUNTIFS size rule:** Microsoft documents that the ranges must have the same size. Hence
    `A:A` vs `A1:A20` is #VALUE!.
  - **Cross-sheet whole columns:** the expected values (COUNTIFS = 1, SUMIFS = 5, SUMPRODUCT = 1) are hand-computed
    from those rules. I could not observe them in Excel.
- **What was verified externally:**
  - The sealed draft's container format was checked by an independent implementation: msoffcrypto-tool, with HMAC
    integrity verification on.
  - The edge-hold was driven by a real Chromium mouse, not by synthetic dispatches.
- **No theorem prover was used.** The models below are checked by unit tests, an exhaustive 54-input enumeration
  (edge-hold), a 40-sheet differential oracle (ranges) and 19 mutants.

## A. Formal model

**Sealed drafts (FF-15).** A protected document `d` has a password `π(d)` that lives in window memory only.
- **S1 (confidentiality):** a draft of `d` is written only as `Seal(bytes, π(d))`. Seal is MS-OFFCRYPTO Agile:
  SHA-512 spin key, AES-256-CBC, HMAC-SHA512. A still-locked `d` (never unlocked) gets no draft at all.
- **S2 (integrity):** `Open(payload, p)` returns the original bytes, or fails. It never returns different bytes. A
  wrong `p` is reported as *password*; a damaged container is reported as *damage*.
- **S3 (monotone protection):** after a restore, `prot' = π(file) if set, else π(draft) if sealed, else prot`. So
  protection never decreases.

**Sparse ranges (FF-19).** For a range `R` with `|R| > 200k` or a whole column/row:
- **R1 (shape):** the evaluated shape depends on the reference and the *workbook's* used area only, never on the
  sheet it points at.
- **R2 (value):** for every function, the value equals the dense evaluation over the clamped area. Rows with no input
  and no spill are all-empty, all-blank.
- **R3 (tail):** `full(R) − shown(R)` cells are truly blank. Blank-counting functions add them when their criterion
  matches a blank.

**Edge-hold (WM-13).** The state is `(side, latched)`.
- **E1:** a timer is armed iff the pointer enters a non-latched edge that has a neighbouring workspace.
- **E2:** the hop fires only while still in that edge.
- **E3:** after a hop, that edge neither re-arms nor snaps until the pointer leaves it.

## B. Hypotheses

| | Hypothesis | Result |
|---|---|---|
| H+ | Agile sealing under the document password gives drafts the document's own protection | ✓ msoffcrypto opens them with the password, and refuses the wrong one |
| H+ | Sparse rows remove the cost of whole columns without changing values | ✓ 22 formula suites green; 10× faster, ~8× less memory |
| H− | "A clamp to each sheet's used area is harmless" | ✗ refuted: cross-sheet COUNTIFS / SUMIFS / SUMPRODUCT were #VALUE!, and COUNTBLANK(A:A) counted only the used rows (pre-existing) |
| H− | "WM-13 is built" (the register said so) | ✗ refuted: no edge-hold existed. It is built now |
| H∂ | Density tokens scale all controls | ∂ partly: the title bar and `--fs-target` scale, but Files toolbar buttons are text-scaled (25 px at every density) |

## C. Frontier (still not Class A, or limited)

- **Array expressions over a whole column's blank tail** (`SUMPRODUCT(--(A:A=""))`, `FILTER(A:A, A:A="")`) see the
  used area only.
- **A sparse range presents at most 16 full columns** (17 or more is #NUM!). Excel has no such cap.
- **CT-01 send** is verified only with an injected `navigator.share` recorder, so the row is partial.
- **The keyboard path across workspaces is Overview's "→ workspace" button.** Meta+Shift+arrows stays the 16 px move.
- **Carried over from TT69:** NC-02 not built; SH-06 partial; xmlAttrs double-quoted only; no Word namespaces; and the
  sandbox-blocked rows.

## D. Negative shapes tested (≥ 15)

1. Wrong, case-changed, truncated (one character short), trailing-space and empty passwords → *password*.
2. Non-base64 payload, plaintext docx as "sealed", a truncated container, an empty payload, and a non-string payload
   → *damage*.
3. 48 single-bit flips across the container: 13 refused, and 35 that fell in CFB slack opened to **identical** bytes.
   None produced different plaintext.
4. A sealed record with a non-base64 payload, and an unknown encoding → refused by the codec.
5. A sheet draft that isn't a ZIP, and a docx used as a sheet draft → refused.
6. Password changed P1→P2 after the draft → prompt; wrong password → inline alert; Cancel → offer kept, nothing
   restored.
7. A plain draft over a file that has since been protected keeps the protection. This was a latent TT69 bug.
8. Spill-only rows (SEQUENCE children, which have no input) must be counted by SUM(B:B).
9. A remote `=""` is non-blank for COUNTA but blank for COUNTBLANK and COUNTIF `""`.
10. `A:A` vs `A1:A20` when they show the same 20 rows → #VALUE! (the full sizes differ).
11. A smaller SUMIFS sum range vs whole-column criteria → #VALUE!.
12. 17 full columns → #NUM! (documented cap).
13. Edge zone boundaries (8/9 px), NaN coordinates, a desk too narrow for two zones, and a pointer captured outside the
    desk.
14. A 300 ms touch of the edge → no hop; at the last workspace → never armed, and the normal half-snap still works.
15. Release right after a hop → no tiling, via both the preview path **and** the geometric fallback (found by the e2e
    test).
16. A hostile shared `javascript:` URL → no dialog, and the tab falls back to a safe page.
17. **Modal shortcut test (inherited):** Close all → the first question is modal. Escape stops the whole queue: both
    windows stay open and unsaved, and no second question appears.

## E. Mechanism-distinct approaches considered (≥ 6)

**Sealed drafts:**
1. **Agile container under the document password** — chosen. It reuses the audited encryptOffice, so external tools
   can open the draft.
2. **WebCrypto AES-GCM with a PBKDF2-derived key and a custom format** — rejected: a new, unverifiable format.
3. **Keep no drafts** (TT69) — rejected: it loses work.
4. **Store drafts under /Private (Argon2id volume)** — rejected: it requires the private volume to be unlocked, and
   ties the document's protection to a different secret.

**Whole-column ranges:**
5. **Lazy matrix type** — rejected: every function would need rewriting.
6. **Shared frozen empty rows plus an occupancy index** — chosen. It is invisible to the functions, and a mutation
   throws instead of corrupting data.
7. **Never clamp** — rejected: ~100 ms per whole-column reference, even on tiny sheets.
8. **Per-function arithmetic fast paths** — rejected: incomplete.
9. **Workbook-wide axis clamp plus a full-shape tag** — chosen for shape consistency and blank tails.

**Edge-hold:**
10. **Pure state machine plus a component timer** — chosen, because a pointer held still sends no events.
11. **Pointermove-only timing** — rejected: it never fires while the pointer is still.

## F. Artifacts

- **Code:**
  - `src/lib/office/draft-seal.ts` — new.
  - `src/lib/windowing/edge-hold.ts` — new.
  - `doc-lifecycle.ts` / `doc-lifecycle-ui.tsx` (sealed encoding, openSealedWithPrompt, untake) and
    `CloseConfirm.tsx`.
  - Writer / Spreadsheet makeDraft and restoreDraft.
  - `engine.ts` (clampLarge, workbookBounds, occupiedRows, shared rows, blankMask) and `functions.ts` (tail and
    full-size checks).
  - `WindowFrame.tsx` (edge-hold).
- **Tests:**
  - `scripts/tt70-seal.mts` (8)
  - `scripts/e2e-tt70-seal.mts` (2)
  - `scripts/e2e-tt70-closeall.mts` (3)
  - `scripts/tt70-range.mts` (6)
  - `scripts/tt70-edge.mts` (5)
  - `scripts/e2e-tt70-rows.mts` (3)
  - `scripts/tt70-mutants.py` (19 mutants)
- **Outputs:** `docs/heldout/tt70-mutants.txt` (10/10) and `docs/heldout/tt70-mutants-range.txt` (9/9).
- **Screenshot:** `docs/screens/tt70-sealed-draft-prompt.png` (the wrong-password inline alert in the restore prompt).
- **Seed:** `src/db/seed-data/features-tt70.ts`, SEED 3.56.0.

## G. Second-order adversary

- **Attacks on the seal:**
  - *Can a tampered draft restore different content?* 48 bit flips: never. Every flip either fails or lands in unused
    CFB slack.
  - *Does the server ever see plaintext or the password?* The draft record and the sealed bytes were searched for the
    typed text and the password (UTF-8 and UTF-16LE): neither is present.
  - *Does restoring downgrade protection?* Tested both directions: the P1→P2 adversary, and a plain draft over a
    protected file.
- **Attacks on the range patch:**
  - *Rows that hold only spilled values* — killed by mutant "sparse rows ignore spill child rows".
  - *Same shown shape, different size* — two mutants survived until the tests gained these cases.
  - *Per-sheet clamp* — mutant killed.
- **Attack on the edge-hold:**
  - *Release right after a hop* — the e2e test found that the geometric fallback still tiled the window. Fixed (see I).

## H. External verification

- **Writer drafts:** msoffcrypto-tool decrypts the sealed draft taken from the live server with HMAC verification;
  python-docx reads the typed paragraph; the wrong password is refused.
- **Spreadsheet drafts:** msoffcrypto-tool decrypts the sheet draft; Python's `zipfile` reads `fusion-draft.json` and
  finds the edit; openpyxl reads the restored cell in the re-encrypted saved file. P2 opens that file and P1 does not.
- **Close all:** openpyxl reads the workbook saved through Close all.

## I. Repair + attack on the patch

| Found by | Defect | Repair | Attack on the repair |
|---|---|---|---|
| reading TT69 code | restoring a plain draft over a since-protected file dropped the protection | `restoredProtection` (S3) | mutants "plain draft drops the protection" and "draft's password overrides the file's" killed |
| own probe | `=SUM(A:C)` with bottom-row data was #NUM!; 1–2.5 s per formula | sparse rows plus a shared blank mask | mutant "evaluated densely" killed; 22 formula suites green |
| differential oracle | COUNTBLANK(A:A) counted only the used rows | full-shape tag plus blank tail | 3 tail mutants killed |
| own probe | cross-sheet COUNTIFS / SUMIFS / SUMPRODUCT were #VALUE! | workbook-wide axis clamp | mutant "clamped per sheet" killed; full-size mutants killed after 2 new cases |
| e2e | WM-13 release after a hop still tiled (geometric fallback) | latch suppresses both snap paths | e2e asserts the width is unchanged after release, and that the half-snap still works at the last workspace |
| own review | tt70-range declared coverage for SH-06 (the hot-corner row) | relabelled FF-19 | — |
| e2e (DP-13) | assumed every control is density-scaled | assertion narrowed to what is true; limit recorded | — |

## J. Stopping

**Gate:** 164 suites, 1256 passed / 2 failed. e2e-tt28 passed on its rerun. The e2e-privacy backup verify failed
twice right after the 2-hour gate, then passed twice: 14/14 run directly and 14/14 through run-all. It now reports the
backup-report text on failure. The 6 TT70 suites (27 tests) were added to run-all (170 suites) and pass through it.

**Ledger:** 383 features. Tested: full **229** (+2: WM-13, DP-13), partial **72** (+1: CT-01), untested **82** (−3).
Recorded results 1285/1285. Tails 39 rows (9 / 10 / 20).

**Mutants:** 19/19 killed (10 seal, 9 range).

The next tier should start with:
- array expressions over the blank tail (a lazy tail value for comparison operators);
- NC-02;
- the remaining untested rows (SH-12, NC-03, SC-05, PR-07d/e/j, HW-11, BL-03);
- the Lens rows via Chromium's fake media device.
