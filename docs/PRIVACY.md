# Privacy (TT18): Tails-like, improved — what the host can and cannot see

User-directed extension rows **SC-10…SC-15** (the spec's SC table ends at SC-09). Code: `src/lib/privacy/*`,
`src/components/modules/Privacy.tsx`, `next.config.ts`. Tests: `privacy-crypto` (9), `privacy-layer` (9),
`metaclean` (6), `e2e-privacy` (11) — all host-side verified (SQL over the actual tables), not self-reported.

## Threat model
**Defended:** an honest-but-curious or later-seized *host* — the Next.js server, Postgres, its disk and backups.
**Not defended:** a malicious server (it serves the JS and could ship a key-stealing build), a compromised
browser/OS, shoulder-surfing, traffic analysis by the network. These are stated, not hidden.

## Mapping to Tails
| Tails | Here | Difference |
|---|---|---|
| Persistent Storage, LUKS2 + Argon2id (5.14+) | `/Private`, AES-256-GCM per file, Argon2id 64 MiB t=3 keyslots | per-file, so the host sees file count/size buckets/tree shape; LUKS hides those inside one block device |
| Change passphrase = rewrap | same (one keyslot rewrapped, files untouched) | — |
| — | recovery key slot, rotation kills the old key | Tails has no recovery key |
| Amnesic live session | `?amnesia=1` / "always start amnesic": RAM VFS overlay, deny-by-default host writes, fresh desktop, localStorage shadow, IndexedDB refused, `Cache-Control: no-store` on API | the *browser* may still keep history/DNS/GPU caches — use a private window for that layer |
| USB-removal emergency shutdown + RAM wipe | Ctrl+Alt+Shift+Backspace / button: forget keys, wipe RAM files, blank page, `location.replace` | cannot power off or wipe browser-process memory; JS wipe is best-effort |
| MAT2 metadata cleaner | in-browser cleaner (JPEG/PNG/WebP/GIF/SVG/DOCX/XLSX/PPTX), PDF refused | keeps JPEG Orientation (exiftool `-all=` leaves photos rotated) |
| — | host audit: finds anything stored in clear under /Private, one-click seal | improvement |

## Formats
- **Content blob:** `"FEN1"` · version · flags · 12-byte IV · AES-GCM(payload). AAD = magic+version+flags+volumeId.
  Payload = u32 length · mime · encoding · data · zero padding to **Padmé** length (≤12% overhead, leaks O(log log n) bits).
- **Names:** `~` + base64url(SIV12 ‖ ct), SIV = HMAC-SHA256(name key)[:12], AAD `FNM1|vol`. Deterministic so
  lookup by path works; equal names in the same volume encrypt equally (accepted leak).
- **Keys:** HKDF(salt = volumeId, info = `fusion-private-1/<purpose>`) from a random 256-bit DEK; keyslot AAD binds
  volume, slot id, kind and KDF parameters (downgrade/swap → authentication failure). Header: `/Private/.keyslots.json`.
- **Host-cleartext entries** inside /Private (planted by another client) appear as `[clear] name`; creating new
  `[clear]` names is refused (422); moving one re-seals it in the browser.

## What the host still learns
Ciphertext sizes (Padmé buckets), number of files and directory shape, write timing, that a volume exists
(as Tails: "detectable even though encrypted"), and anything a user explicitly exports outside /Private.
Deep links (`?open=…&path=/Private/…`) put plaintext paths in the *browser's* history (not the host's);
`Referrer-Policy: no-referrer` keeps them from leaking to other sites.

## TT19 — private search (SC-16)
TT18 left /Private unsearchable (the host index deliberately never holds it) and every search query went to the
host in clear. Now `GET /api/search` is intercepted by the privacy layer:

| Query | Who searches | Does the host see the query text? |
|---|---|---|
| scope inside `/Private` | in-tab `PrivateIndex` only | **No** — zero `/api/search` requests (network spy, e2e) |
| scope `/Private` while locked | nobody (`locked: true`, empty) | No |
| unscoped, unlocked | in-tab index **and** host index, merged (`hostQueried: true`) | Yes (declared: needed to search host files) |
| amnesic session | RAM overlay files searched in place, plus host | Yes, for the host part |

The index is built lazily on the first search after unlock from decrypted reads (≤5 000 files, ≤2 MiB each,
64 MiB total; non-text files by name only), updated incrementally on write/move/trash, and dropped on lock, on
any key change (checked on every request) and on emergency wipe. It lives only in JS memory; strings cannot be
zeroised (same declared limit as the RAM overlay). Ranking for private hits is substring-count based, so
private hits sort ahead of host `ts_rank` hits.

**Repair found by its own test:** clearing `layer.keys` outside `session.lock()` used to leave the decrypted
index alive until the next unlocked search. `handle()` now drops it whenever the live key object differs.

## Performance ("no degradation" — measured, not asserted)
Chromium on this 2-CPU sandbox, server + Postgres on the same host (`docs/privacy-bench.json`):
- AES-GCM in the browser: **190–357 MB/s encrypt**, 345–494 MB/s decrypt across runs (4 MiB, median of 5).
- 256 KiB save end-to-end, median of 8: host 26–28 ms vs /Private **28–35 ms** (+1.5–6 ms).
- Found while measuring: the old base64 encoder cost ~14 ms per 256 KiB (20× the cipher). Replaced by a
  table-driven codec (native `toBase64` where available), byte-identical to Node `Buffer` on 6 000 inputs.
- Remaining cost: ciphertext travels as base64 (+33% bytes). Unlock costs ~1 s on purpose (Argon2id).
