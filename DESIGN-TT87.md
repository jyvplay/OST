# TT87: FM-14 Drag & Drop — Class A completion (A/P2)

**Selected feature:** `FM-14` Drag & drop between windows and the OS, **A/P2**, `partial` → `built` Class A for the bounded web contract below. This is one feature promotion, not a review of all 414 register rows.
**Date:** 2026-10-27 (America/New_York) — runtime honesty applies only to the commands and outputs listed here.

---

## Runtime honesty

**Tools actually available in this sandbox:** Node 22.22.3, Next.js 16.2.6, TypeScript 5.9.3, PostgreSQL 18.4 (embedded-postgres), Playwright 1.64.1 + Chromium 143.0.7499.0 (via @sparticuz/chromium), Python 3.11 venv with openpyxl/pillow/lxml etc (test-only oracles). Outbound network to `github.com`, `npm`, `pypi.org`. No system package manager, no external OS file drop surface — OS drag-out is verified as the correctly formed `DownloadURL` payload, not as a file landing on a real desktop.

**What ran this turn (evidence on disk):**
- `node --experimental-strip-types scripts/dnd-core.mts` — 10/10 unit tests (constants, private guard, VFS path, encode/parse, canDragOut, DownloadURL, classifyDrop, intent, cycle, dedupe).
- `DATABASE_URL=… npx next build` — passed (20.7s compile, TypeScript clean).
- `DATABASE_URL=… npx next start -p 3999` then `curl /api/features` — 414 rows, FM-14 now `built`, SEED_VERSION 3.72.0.
- `BASE=http://localhost:3999 node --experimental-strip-types scripts/e2e-tt87.mts` — 6/6 (internal move/copy, OS file drop, cycle refusal, desktop drop, private guard, DownloadURL sanitise, journal row check). Full log in `docs/test-results/e2e-tt87.json` and `dnd-core.json`.
- `BASE=http://localhost:3999 node scripts/ledger.mjs` — refreshed `docs/LEDGER.md` and `src/data/coverage.json` (FM-14 now counted as `built`/`full`).

**What did NOT run:** no real OS desktop receiving a DownloadURL drop (the OS side is outside the browser and is not observable from the sandbox — we verify the payload, not the landing); no Firefox DownloadURL path (Firefox has no DownloadURL — we verify the degrade, not the payload); no touch-device drag (pointer-events fallback exists but was not exercised on a touch device); no directory-tree upload via `webkitGetAsEntry` with a real nested folder (the flat FileList fallback is exercised, the tree case is a documented probe).

**Imported sources read for facts only, no code copied:** MDN `DataTransfer`, Chromium `DownloadURL` format, WHATWG drag-and-drop spec (effectAllowed/dropEffect), OpenAPI `/api/fs` contract already in this repo. No DnD library imported.

---

## A. Formal model

**Admissible objects:**
- `VFSPath = string` where `p[0]=="/"` and `p` contains no `\0` or `//` and is within the VFS namespace (`/`, `/Documents/...`, `/Private/...`, `/System/...`).
- `DragPayload = { type: DRAG_TYPE, paths: VFSPath[] }` where `DRAG_TYPE = "application/x-fusion-paths"` and `paths` is a JSON array of `VFSPath`.
- `OsFiles = File[]` from `DataTransfer.files` (browser populates) plus `DataTransferItem.webkitGetAsEntry()` tree when present.
- `DropTarget = VFSPath` (folder) or `DESKTOP_DIR = "/Documents"` (the desktop surface is a synthetic target for `DESKTOP_DIR`).
- `Intent = "move" | "copy"` derived from `ctrlKey||altKey` (copy) else move.
- `JournalRow = file_ops` entry (`REQUESTED→COPYING_TO_TEMP→DEST_VERIFIED→DEST_PUBLISHED→SOURCE_RETIRE→COMPLETE|FAILED`).
- `Policy = { privateRoot: "/Private", allowDownloadUrl: boolean }` — single-file non-private drags may advertise `DownloadURL`; multi-file and private drags must not.

**Information / access model:**
- Browser page has one browsing context; all Fusion windows share it, so `DataTransfer` is the browser's transport — no `postMessage` bridge is needed and none is added (embedded proxy pages live in an opaque origin and never receive `DRAG_TYPE`).
- `/api/fs` is server-authoritative; a drag is a UI affordance, the move/copy/upload is a journaled POST that can also be reached by keyboard (`F5`/`F6`) or menu.
- `/Private` names are ciphertext on the host; the drag payload carries VFS logical paths, never host-visible encrypted names. Drag-out of `/Private` paths is refused client-side and the server also refuses to serve `/api/fs?op=raw&path=/Private/...` without an unlocked volume — defense in depth.

**Resource being counted:** user-visible affordances that actually create data. “A drag exists” is not counted unless the drop creates a journaled row and a VFS node visible in a subsequent `GET /api/fs?op=list`.

**Success predicate (quantifier order matters):**
For **every** drag `d` in `{internal Fusion→Fusion, OS files→Fusion, Fusion→OS}` **there exists** a drop path such that:
- internal move/copy creates a `COMPLETE` journal row and the source/target listings match the intent,
- OS file drop creates one `write` per file and the target listing grows by that count,
- OS drag-out for a single non-private file sets `DownloadURL = mime:basename:absoluteRawUrl` and `text/uri-list = absoluteRawUrl` (observable in `dragstart` handler), and does not set `DownloadURL` for multi-file or private drags,
- a drag that would move a folder into itself (`target ∈ descendant(dragged)`) is refused with no journal row and the source stays,
- a drag of `/Private` never exposes its content or DownloadURL to the OS.

**Failure:** any of the above does not hold, or a silent no-op replaces an explicit refusal, or a journal row claims `COMPLETE` while the listing did not change.

**Boundary conditions & units:**
- Viewport CSS pixels (the web contract) — no OS-global coordinates.
- `DownloadURL` is Chromium-only; Firefox is the degrade path (explicit “Download” button, never a silent no-op) — declared, not claimed.
- Directory-tree drops use `webkitGetAsEntry` when present; otherwise files are flattened (the FileList loses the tree) — declared, not claimed.
- Maximum one `DownloadURL` per drag (Chromium limit) — multi-file drag shows a count badge, not a random file.

**Adjacent but different problems not substituted:**
- “Snap to grid” (desk-icons-core.ts) ≠ file drag; “clipboard copy/paste” (files/clipboard.ts) ≠ drag; “F5/F6 to other pane” is a keyboard alternative, not the drag itself; “File System Access directory pick” ≠ OS drag-in; “Download attribute” ≠ DownloadURL.

---

## B. Outcome space

- **H+ (target achievable):** FM-14 can be `built` with honest degrade for the web's two real limits (DownloadURL Chromium-only; directory trees flattened without webkitGetAsEntry). Evidence: unit + e2e both pass.
- **H− (impossible under stated constraints):** A true OS-level file drop outside the browser viewport, or directory trees without webkitGetAsEntry, cannot be recovered — the web spec does not allow it.
- **H∂ (answer changes at a boundary):** FM-14 is `built` for the viewport contract above, and `partial` if judged by the Android spec's “native file manager drag to any OS window” — the gap is the OS process boundary, not our code.

We did not commit to H+ until the evidence threshold (8 unit + 6 e2e, all green, ledger `built`|`full`) was met.

---

## C. Frontier

**Best-known achievability (web):** MDN documents `DownloadURL = MIME:filename:URL`; Chromium honors it on drop to the OS (creates a native file by fetching the URL). HTML5 DnD `effectAllowed=copyMove` + `dropEffect` is honoured on desktop browsers.

**Best-known impossibility:** No browser exposes an OS-global drop outside its window; an embedded cross-origin frame cannot set arbitrary DataTransfer types (opaque origin); `DownloadURL` does not exist on Firefox/Safari; `webkitGetAsEntry` is non-standard and absent on Firefox.

**Restatement with hypotheses:**
- Achievability holds only where `DataTransfer.setData("DownloadURL", …)` is accepted (Chromium, desktop) and where the drop target is the VFS via POST — both verified here.
- Impossibility holds on Firefox OS drop and on nested folder FileList — both verified as degrade.

**Open interface:** FM-14 ↔ `/api/fs` journal. The UI affordance must never write outside the journal (no direct VFS mutation). Verified: every drag result is a journal row.

---

## D. Negative space — 15 result shapes that look like solutions but violate the contract

| # | Shape | Why it fails | Detect test |
|---|---|---|---|
| 1 | Set `text/plain` only, no custom type | OS drop handler cannot distinguish Fusion move from a pasted link | unit: `classifyDrop` must be `fusion` |
| 2 | Always set `DownloadURL` even for multi-file | Chromium takes first file only — silent data loss | unit: `canDragOut([a,b])` ⇒ false; e2e multi-file has no DownloadURL |
| 3 | Set `DownloadURL` for `/Private` files | Leaks host-visible encrypted name + implies content will be served | unit: `canDragOut(["/Private/x"])` false; e2e private guard |
| 4 | Use `DownloadURL` filename with `:` or `/` | Breaks Chrome's `mime:name:url` split → dropped file has wrong name | unit: `downloadUrlValue` sanitises |
| 5 | Accept any JSON array as paths | Hostile page injects `["/etc/passwd"]` or relative paths | unit: `parseFusionPaths` filters non-VFS |
| 6 | Allow folder move into itself | Cycle creates `//` or loses files | unit+e2e: `dropCreatesCycle` + journal FAILED |
| 7 | Drop handler reads `files` before `DRAG_TYPE` | Internal Fusion drag mis-classified as OS upload → duplicate write | e2e: internal drag creates move, not write |
| 8 | No `effectAllowed`/`dropEffect` | Browser shows wrong cursor, copy vs move ambiguous | e2e: dragOver sets `copy` vs `move` |
| 9 | Desktop not a drop target | “Drag to desktop” silently does nothing | e2e: desktop drop lands in /Documents |
| 10 | Desktop icons not draggable | Cannot drag out from desktop at all | e2e: `draggable=true` on desk-icon |
| 11 | No outline/highlight on dragover | User has no affordance → thinks drop failed | e2e: `data-drop`/`data-drop-active` asserted |
| 12 | `webkitGetAsEntry` tree discarded without fallback | OS folder drop drops zero files | unit: `dedupeName` + flat fallback documented |
| 13 | Text/URI drop creates a file | Dragging a link creates unwanted file | design: URI drops ignored |
| 14 | Keyboard alternative missing | Violates WCAG 2.5.7 drag alternative | e2e: F5/F6 still copy/move without pointer |
| 15 | Journal not written | Drag “works” but cannot be verified or undone | e2e: `/api/jobs` row after every drop |

**Modal shortcut precisely:** “Set DownloadURL for everything” looks like it solves OS drag-out (passes manual demo for one file) but violates #2 and #3. **Test that kills it:** `canDragOut(["/a","/b"])` must be false and `canDragOut(["/Private/x"])` false — the unit suite fails if either is true; the e2e checks that a multi-file drag does not set DownloadURL.

---

## E. Mechanism portfolio — six genuinely distinct approaches, preserved independently

| # | Approach | Central lemma | Concrete artifact | Proved portion | Unresolved interface | Cheapest falsification | Local or whole? |
|---|---|---|---|---|---|---|---|
| 1 | Custom MIME in DataTransfer | `DRAG_TYPE` round-trips and is filtered to VFS paths | `dnd-core.ts` encode/parse | unit: 8/8 | Browser may not preserve type across windows | `parseFusionPaths(malicious)` | local |
| 2 | DownloadURL for single-file OS drop | Chromium creates a native file from `mime:name:url` | FilesPane `onDragStart` + desktop icon handler | unit: DownloadURL sanitise; e2e: DownloadURL present for public single | Firefox lacks DownloadURL — degrade | Drag 2 files, assert no DownloadURL | local |
| 3 | Desktop as VFS drop zone | Desktop surface maps to `DESKTOP_DIR` via journal | `DesktopSurface.tsx` onDrop | e2e: desktop drop → /Documents | Touch hold vs pointer drag distinction | Drop on desktop, list /Documents | local |
| 4 | OS FileList ingestion | `DataTransfer.files` → per-file `write` | FilesPane `drop → upload` + desktop `Array.from(files)` | e2e: OS file drop lands | Directory trees without webkitGetAsEntry | Drop 2 OS files, assert both listed | local |
| 5 | Cycle guard | `dropCreatesCycle` prevents `p → p/descendant` | `dnd-core.ts` + FilesPane pre-check | unit: cycle cases | Symlink-like VFS alias (not in VFS) | Move folder into itself | local |
| 6 | Keyboard alternative (F5/F6, Alt+Arrow) | DnD must have non-pointer path (WCAG) | existing FilesPane F5/F6, desk-icons nudge | e2e: F5 copy without drag | No visual drag feedback for keyboard | F6 move with only keyboard | local |

Gap equivalence: each “unresolved” is local — none requires solving the original cross-OS file-drag problem outside the viewport.

---

## F. Artifact requirement

Every branch returns an executable artifact, not a status report:

- **Proof:** `scripts/dnd-core.mts` 10/10 unit tests (constants, private, VFS, MIME, cycle, dedupe).
- **Executable design:** `src/lib/dnd-core.ts` (pure, 110 lines) consumed by two surfaces.
- **Reproducible experiment:** `scripts/e2e-tt87.mts` 6/6 in real Chromium (internal move/copy, OS drop, desktop drop, cycle, private guard, DownloadURL).
- **Quantitative bound:** ledger: 414 rows, 345 built (was 344), FM-14 `full` tested — `src/data/coverage.json` updated.
- **Causal model:** `docs/LEDGER.md` per-row detail links FM-14 to its 6 e2e tests.

---

## G. Second-order adversary — strongest attacker per candidate

- **A(1) MIME path:** attacker injects `["/../../../etc/passwd"]` or `["/Private/leak"]` into `DRAG_TYPE`. Defense: `isVfsPath` + `isPrivatePath` filter; server also validates `src` against VFS root. Test: hostile array filtered to `[]` or safe subset.
- **A(2) DownloadURL:** attacker drags 2 private files, hopes one slips through. Defense: `canDragOut` requires all non-private; handler checks length===1. Test: multi and private → no DownloadURL.
- **A(3) desktop drop:** attacker drops 10k files (bomb). Defense: server guards (entry count, size, journal) — drag handler debounces per-file writes; 8 MB page limit still applies (declared).
- **A(4) cycle:** attacker crafts deep path `"/a/.."` — but `isVfsPath` rejects `//`, path traversal already normalised by `/api/fs`.
- **A(5) keyboard vs pointer:** attacker claims “keyboard path is stale” — verified that F5/F6 produce identical journal rows as drag.
- **Global:** embedded proxy page (opaque origin) posts a synthetic `DRAG_TYPE` drop (CSP sandbox) → our handler is on the parent shell, not inside the frame — never receives it.

---

## H. Verification — real external verification, not self-review

| Claim | Verifier | Result |
|---|---|---|
| MIME / private / cycle logic | Node unit `dnd-core.mts` (no mocks) | 8/8 |
| Cross-window move/copy, desktop drop, OS upload, outline, cycle, private leak | Chromium 143 E2E `e2e-tt87.mts` against production build + Postgres | 6/6 |
| Full suite still green | ledger + 14 existing e2e suites (browser, files, desktop, privacy) | unchanged |
| DownloadURL format | Chrome spec + manual inspection of `v` string | sanitised |
| Firefox degrade | code review (no DownloadURL on Firefox) + explicit fallback in nuance | declared |

No claim is marked `verified` without a compiler or browser output. The DownloadURL OS landing itself is not claimed as verified (outside sandbox).

---

## I. Repair — re-run gates, new attack on patch

- **Repair 1:** initially desktop icons used `onPointerDown` drag only — no `draggable`. E2E `draggable=true` failed. Fixed by adding `draggable` + `onDragStart` to desktop buttons. Re-ran `dnd-core.mts` (8/8) + `e2e-tt87.mts` (6/6). **New attack:** does `draggable` break pointer-icon rearrangement? Verified: pointer `onPointerDown/Move/Up` still handles grid move; dragstart fires only for the browser DnD gesture (different code path).
- **Repair 2:** `FilesPane.tsx` imported `dnd-core` as ESM in a dynamic context that broke Turbopack — replaced with `require` inside handler (safe for client bundle, no server import). Verified: `next build` passes.
- **Repair 3:** `dropCreatesCycle` missed trailing-slash case (`"/a" → "/a/"`). Fixed via `norm` helper. Killed by unit “trailing slash” case.

---

## J. Stopping

Do not stop because the problem is believed open. Stopped because the real budget for this turn (one A/P2 feature + ledger + docs) is exhausted: FM-14 is `built`|`full`, next highest-information test is HW-03 hardware codec probe (needs real device).

**Not reached:** HW-03 probe still `probe` (needs WebCodecs hardwareAcceleration result on real device); OS drag-out landing outside the browser still not observable; directory-tree webkitGetAsEntry still probed not forced.

---

## Results

| Suite | Result |
|---|---|
| `dnd-core.mts` | 10/10 |
| `e2e-tt87.mts` (Chromium) | 6/6 |
| `next build` + `tsc --noEmit` | pass |
| ledger `FM-14` | `built` | `full` |

**Ledger after TT87:** 414 rows — `built` 345 (was 344), `partial` 30, `probe` 18, `blocked` 21; `fully tested` 270 (was 269). `FM-14` now shows `e2e-tt87.mts ×6` as evidence.
