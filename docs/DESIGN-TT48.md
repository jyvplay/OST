# TT48 — re-encrypting save for Writer and Spreadsheet, tabletop settle fix, multi-tab desktop sync

Runtime used: bash sandbox, Node 22, tsc, Next 16, Postgres, headless Chromium 143 (Playwright), Python venv with
olefile 0.47 (BSD) and msoffcrypto-tool 6.0.0 (MIT) as **test-only** oracles. Not available: theorem provers, parallel
agents, Microsoft Office or LibreOffice. Nothing below claims an Office open check.

## A. Formal model

- **Document protection state** (per window, `Protection` in `src/lib/office/unlock.ts`):
  `{path, password | null, key | null, wasEncrypted, removed}`.
  - **locked:** `wasEncrypted ∧ password = null ∧ ¬removed`. `saveBlocked(p, dest)` is true when the file is locked and `dest = p.path`.
  - **protected:** `password ≠ null`. Every save writes `encryptOffice(plain, password)`.
  - **removed:** `removed = true`, reachable only through the Password… dialog with both fields empty. Only then does a save send `replaceEncrypted: true`.
- **Invariants:**
  - **I1:** a container that is encrypted on the server is never replaced by plaintext unless `removed`. The client enforces it (`saveBlocked`, `replaceEncrypted` only on `removed`), and so does the server (`refuseEncryptedOverwrite`, unchanged from TT47).
  - **I2:** the password never leaves the browser. Only ciphertext (Writer), or the decrypted package for the .xlsx lossless patch, reaches the server. The second case is disclosed.
  - **I3:** every save draws a fresh package key, data salt, segment IVs, verifier and HMAC key. Only the password-derived key (salt plus 100,000-round SHA-512) is cached per window.
  - **I4:** `decrypt(encrypt(P, pw), pw) = P` byte-exactly, as checked by an independent implementation.
- **Encryption format:** MS-OFFCRYPTO §2.3.4.10–15 Agile.
  - EncryptionInfo is version 4.4 with flags 0x40, followed by the XML descriptor.
  - EncryptedPackage is a u64 size followed by AES-256-CBC over 4096-byte segments, with IVᵢ = SHA-512(keyDataSalt ‖ LE32 i)[0:16].
  - The HMAC-SHA512 covers the whole EncryptedPackage stream.
  - The `\x06DataSpaces` storage follows §2.1.5–2.1.8.
- **Container format:** MS-CFB v3 (`src/lib/office/cfbwrite.ts`).
  - 512-byte sectors, with a 64-byte mini stream below the 4096-byte cutoff.
  - The FAT spills into a DIFAT beyond 109 FAT sectors.
  - Sibling trees are balanced binary search trees in §2.6.4 order (length first, then uppercase UTF-16), all nodes black. §2.6.4 permits this ("mark every node as black").

## B. Hypotheses

- **H+** (supported by evidence):
  - msoffcrypto decrypts our files with HMAC verification.
  - olefile parses them under `DEFECT_INCORRECT`.
  - Our DataSpaces streams are byte-equal to msoffcrypto's own writer.
- **H−** (would falsify): any corpus file failing the msoffcrypto, olefile or our-reader round trip; any mutant surviving; plaintext reaching an encrypted original without removal. None was observed.
- **H∂** (not decidable here): whether Word and Excel open the files.
  - The evidence is indirect. Two independent implementations (msoffcrypto and olefile) accept the bytes, and the parameters match what Office 2013+ writes by default.
  - PR-11 therefore stays **partial**.

## C. Frontier

Done this turn:
- CFB writer.
- Agile encryption.
- DataSpaces.
- Per-window key cache.
- Writer and Spreadsheet set, change, remove and re-encrypt, with the download also encrypted.
- Server `returnBytes` mode.

Not done:
- RC4, CryptoAPI and IRM.
- Writing Standard encryption (a Standard original becomes Agile).
- Certificate key encryptors.
- Spreadsheet iconSet and dataBar drawing.
- Writer header and footer editing.

## D. Negative shapes (each has a test)

1. Wrong password, rejected by msoffcrypto (`tt48-office`, `e2e-tt48`).
2. Wrong-case password (`e2e-tt48`).
3. One flipped ciphertext bit, rejected by msoffcrypto HMAC verification and by our reader (`tt48-office`).
4. Non-ZIP input to `encryptOffice` is refused.
5. An empty password is refused.
6. A CFB name containing `/` is refused.
7. A CFB name over 31 characters is refused.
8. Duplicate CFB sibling names, compared case-insensitively, are refused.
9. After a cancelled unlock, the Password… dialog does not open (`e2e-tt48`).
10. After a cancelled unlock, Save and Ctrl+S leave the original byte-identical (`e2e-tt48`, `e2e-tt47`).
11. A mismatched confirmation is reported inline in the dialog.
12. A plaintext upload over a now-encrypted file is refused by the server (`e2e-tt48`).
13. A lossless patch over a protected file is refused (`e2e-tt47`).
14. Password… on a workbook that is not .xlsx is disabled.
15. After a password change, the old password is refused.
16. A stale tab's save is answered 409 and does not overwrite (`e2e-tt48-sync`).
17. A row without an inner revision hydrates with no 409 (`e2e-tt48-sync`).

**Modal-shortcut failure test:** Ctrl+S and Ctrl+W inside the masked password dialog do not reach the Writer or the Shell (`e2e-tt47`, still passing).

## E. Mechanism-distinct approaches considered

1. **WebCrypto PBKDF.** Rejected: Agile's spin is not PBKDF2, and the TT47 measurement showed per-call overhead for 100k SHA-512 calls.
2. **Server-side encryption.** Rejected: it violates I2, because the password would reach the server.
3. **Reusing msoffcrypto at runtime.** Rejected: it is Python, so not lightweight and not in-browser.
4. **Writing Standard (ECB) encryption.** Rejected: weaker and has no integrity check.
5. **Our own Agile encryption with a CFB writer, in the browser.** Chosen.
6. **Caching the derived key per window versus re-deriving on every save.** Caching chosen: about 8 ms per save instead of about 985 ms, while every other secret stays fresh.

For the tabletop flake:
- **(a)** Equal bounding boxes as the settle signal: the old approach, proven insufficient.
- **(b)** A `transitionend` listener: fragile when the transition is interrupted.
- **(c)** Computed `transitionDuration` plus a margin, exposed as `data-settled`: chosen.

## F. Artifacts

- **Library:** `src/lib/office/cfbwrite.ts`; `src/lib/office/offcrypto.ts` (`encryptOffice`, `deriveAgileKey`, `dataSpacesStorage`); `src/lib/office/unlock.ts` (`Protection`, `askPassword`, `sealPackage`, `saveBlocked`).
- **Apps and API:** Writer and Spreadsheet Password… controls; the `/api/sheet` `returnBytes` mode.
- **Shell:** `src/components/Shell.tsx`, hydrate revision fix and 409 reconcile.
- **Tabletop:** `src/components/Tabletop.tsx`, `data-settled`.
- **Tests:** `scripts/tt48-office.mts`, `scripts/e2e-tt48.mts`, `scripts/e2e-tt48-sync.mts`; oracles `scripts/oracle/cfb_probe.py` and `scripts/oracle/msoff_decrypt.py`.

## G. Second-order adversary

- **Mutation testing:** 7 mutants, all killed by `tt48-office`:
  1. Mini-stream cutoff `<` changed to `<=`.
  2. Swapped BST subtrees.
  3. Name order without the length-first rule.
  4. Segment IV index changed to i+1.
  5. HMAC computed without the size prefix.
  6. DataSpaces minor version set to 1.
  7. Key-derivation loop starting at 1.
- **Test bugs found on the way (fixed in the tests, not the product):**
  - A "plaintext leak" check flagged zero blocks, which occur both in the ZIP and in CFB padding. The check now uses distinctive blocks at every byte offset.
  - A status wait matched the dialog's own text ("password removed — the next save…") before the save finished. The wait is now anchored on `^saved /`.
  - An unreadable corpus workbook was used as a fixture.

## H. External verification

- **olefile (BSD):** strict compound-file parse of 40 random trees (5,618 streams), a 7.5 MB DIFAT file, and every encrypted output.
- **msoffcrypto-tool (MIT):** decryption with `verify_integrity=True` of:
  - 22 corpus .docx/.xlsx files (1,933 B to 2.96 MB);
  - every file saved through the UI in `e2e-tt48`.
- **msoffcrypto-tool's own encrypt output:** byte-equal to our four DataSpaces streams.

## I. Repair, plus a new attack on each patch

1. **Tabletop wall drag (TT47 13/1). Two causes, both fixed:**
   - **(a) Settle timing.** The test's equal-boxes check passed mid-transition. Fix: `data-settled`, computed from the face's transition duration, plus a wait in the test.
   - **(b) Product bug: a stale closure in `up()`.**
     - pointermove is a continuous-priority event, so React batches its state updates to the next frame. pointerup is discrete and runs at once.
     - So a release in the same frame as the last moves read `drag.moved = false`, and the move was silently dropped.
     - This happened under load (the full run) and for fast flicks on slow devices.
     - Fix: a synchronous `dragRef` mirror that `down`, `move` and `up` read and write.
   - **Attack.** The new test "TT48 fast flick" dispatches pointerdown, 8 pointermoves and pointerup in one JS task.
     - It failed on the pre-fix build and passes on the fix.
     - Its assertion was later broadened to "moved or piled", because landing on another /Documents card piles correctly.
   - **Result.** e2e-tabletop 15/0 in five runs on the fixed builds. Earlier on this tier, the settle fix alone failed 1 of 3 standalone runs and the full run.
2. **SH-08 (found while chasing a false "409" lead).**
   - **Bug:** hydrate used revision 1 when the state JSON lacked one, so every save got 409 and failed silently forever.
   - **Fix:** hydrate at `max(row.revision, state.revision, 1)`.
   - **On 409:** a new `reconcile` reducer action. The server's newer desktop wins for shared data (workspaces, icons, tabletop); the tab keeps its **own** windows and focus; the revision never goes back; the user gets an info toast.
3. **Regression in my own first fix, caught by the full run.**
   - The first 409 handler hydrated the server state wholesale, which closed the windows open in the refused tab.
   - The WebRTC test (two contexts on one desktop) failed 2 of 2.
   - `reconcile` replaced it, and the WebRTC test is 62/0 again.
4. **Attack on that patch:** `e2e-tt48-sync`.
   - Reducer unit test: own windows only, shared data adopted, revision monotonic, active-workspace fallback.
   - A row without an inner revision gives no 409.
   - A second writer's newer desktop gives a 409 on the stale save; nothing of the other tab is lost; both windows open in this tab stay on screen; the next save lands above it.

## Results

- **Full run on the encryption build:** 94 suites, 829/832.
  - The failures were e2e WebRTC (the regression in item 3), the e2e-privacy timing flake (14/0 on rerun), and e2e-tabletop wall drag (item 1b).
- **Reruns on the final build:** e2e 62/0, e2e-tabletop 15/0, e2e-layout 12/0, unit 23/0, layout-unit 8/0, e2e-tt48-sync 4/0.
- **Before the reconcile change** (unaffected by it): tabletop-unit 17/0, e2e-beauty 6/0, e2e-a11y 9/0.
- **Ledger:** **837/837 across 95 suites.** Built 289/58/21; tested 169/78/121; Tails 9/10/20.
- **Caveat:** the total combines one full run with reruns of the affected suites on later builds. There was no second full run.

## J. Stopping

Stopped after:
- the re-encryption features were fully wired and verified by independent tools;
- the tabletop failure (settle timing plus a real stale-closure drag bug) and the multi-tab bug (including my own regression) were fixed with tests;
- the ledger was updated.

Spreadsheet iconSet/dataBar drawing and Writer header/footer editing remain unbuilt. They are listed in the PR blockers rather than started half-finished.
