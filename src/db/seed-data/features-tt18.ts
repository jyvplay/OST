import { F, type SpecRow, type Status } from "./row";

/**
 * TT18 register additions — USER-DIRECTED EXTENSION ROWS (not in "Full V2 and V2.1 Specs.txt", whose SC table
 * ends at SC-09): Tails-like privacy, improved, with as much activity as possible encrypted from the host.
 * IDs SC-10…SC-15 are new; SC-07 (encrypted containers) is advanced via UPDATES_TT18.
 * Threat model (docs/PRIVACY.md): an honest-but-curious or later-seized HOST (server + Postgres + disk),
 * not a malicious server (which could serve hostile JS) and not a compromised browser.
 */
export const tt18Features: SpecRow[] = [
  F("SC-10", "SC", "Encrypted Persistent Storage (/Private): names, contents, versions and desktop-state paths encrypted in the browser before the host sees them",
    "A", "P2", "src/lib/privacy/pcrypt.ts (FEN1 AES-256-GCM content, Padmé-padded; SIV-style deterministic names, HKDF-separated keys) + layer.ts (global fetch guard routing /Private) + session.ts",
    "Tails analogue: LUKS2 Persistent Storage. Verified on the HOST side: SQL over vfs_nodes/vfs_versions/index_docs/audit_log/desktop_state finds no plaintext name, content, size, index entry or path (privacy-layer 1–2, 8; e2e-privacy 2). Interop proven by an independent Python implementation (cryptography + argon2-cffi) decrypting our blobs/names byte-for-byte. The server never indexes /Private whichever op delivered a file (choke point in indexUpsert, attacked by a raw-client move/copy test; leaked rows purged at bootstrap). Still visible to the host by design: ciphertext sizes (Padmé buckets, ≤12% overhead), tree shape, timing, and that a volume exists. Performance: 256 KiB saves 26–35 ms vs 26–28 ms host-side (median of 8, two runs); AES-GCM 317–336 MB/s in Chromium here.",
    "built", "privacy-crypto.mts; privacy-layer.mts 1–5, 8; e2e-privacy.mts 1–3, 9"),
  F("SC-11", "SC", "Keyslots: Argon2id (64 MiB, t=3) passphrase + recovery key, change passphrase without re-encryption, rotate recovery key, idle auto-lock, keys memory-only",
    "A", "P2", "pcrypt.ts createVolume/unlockVolume/changePassphrase/rotateRecoveryKey; header at /Private/.keyslots.json; Privacy module",
    "Mirrors Tails 5.14+ (LUKS2 + Argon2id; Change Passphrase rewraps). Below-floor KDF parameters refused (<200 ms), KDF-downgrade and slot/volume swaps break the AAD. Keys are non-extractable CryptoKeys held only in the tab; a reload forgets them (e2e-privacy 3). Unlock is deliberately ~1 s.",
    "built", "privacy-crypto.mts 1–4; e2e-privacy.mts 1, 3"),
  F("SC-12", "SC", "Remove metadata (MAT2-like): JPEG/PNG/WebP/GIF/SVG/DOCX/XLSX/PPTX cleaned in the browser without re-encoding; PDF refused",
    "A", "P2", "src/lib/privacy/metaclean.ts + cleanfile.ts; Files ▸ Remove metadata (copy); Privacy ▸ Remove metadata (overwrite also drops version history via fs op dropVersions)",
    "Container-level only, so pixels/text are bit-identical (verified by Pillow, python-docx, openpyxl, python-pptx, svgelements). JPEG keeps ONLY Orientation (exiftool -all= is known to leave photos rotated). OOXML: core/app props emptied, custom.xml + thumbnail removed with rels/overrides, w:rsid attributes AND elements stripped (MAT2 parity), comment/person authors anonymised, absPath/revisionPtr removed, zip timestamps 1980 and no extra fields. Truncated/corrupt files throw instead of writing a broken file; zip-bomb and ../ entries refused. Not covered: PDF, embedded media inside OOXML, customXml items, XMP inside SVG foreignObject.",
    "built", "metaclean.mts (6); e2e-privacy.mts 4–5"),
  F("SC-13", "SC", "Amnesic session: host writes denied by default, VFS RAM overlay, desktop state in memory, fresh desktop, localStorage shadowed, IndexedDB refused, HTTP cache disabled for API bodies",
    "A", "P2", "session.ts enterAmnesia + layer.ts RamOverlay/deny-by-default; boot via ?amnesia=1 or the 'always start amnesic' preference; AMNESIC top-bar badge; next.config.ts headers",
    "Tails analogue: the amnesic live session. Compute endpoints still work; /Private still persists when unlocked. Verified: no host row for RAM files, notes refused + logged, localStorage key absent after restart, IndexedDB open throws SecurityError. Limits: the browser itself may keep history/DNS/GPU caches outside our control (use a private window for that layer); RAM wipe in JS is best-effort (GC, no mlock).",
    "built", "privacy-layer.mts 6–7; e2e-privacy.mts 6, 8"),
  F("SC-14", "SC", "Host audit: walks what the host actually stores under /Private, flags plaintext names/contents (e.g. from another client) and seals them in one click",
    "A", "P3", "layer.ts audit(); '[clear] name' addressing for host-cleartext entries; private→private moves of [clear] sources are re-sealed in the browser, never renamed server-side",
    "Two patches were attacked with their own tests: creating a NEW '[clear]' entry is refused (422, no row created), and renaming a planted clear file must not give plaintext content an encrypted name (mutation check: reverting the fix makes the test fail).",
    "built", "privacy-layer.mts 9; e2e-privacy.mts 10"),
  F("SC-15", "SC", "Emergency shutdown: Ctrl+Alt+Shift+Backspace or button drops keys, wipes RAM files/shadows, blanks the page and leaves via location.replace",
    "A", "P2", "session.ts emergencyShutdown; shortcuts.ts BINDINGS 'emergency'; Privacy module button",
    "Tails analogue: removing the USB stick triggers shutdown + RAM wipe. Web limit: we cannot power off the device or wipe browser-process memory; we can forget everything this app holds and leave no history entry pointing at the shell.",
    "built", "e2e-privacy.mts 7"),
];

type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };
export const UPDATES_TT18: Record<string, Patch> = {
  "SC-07": { status: "built", route: "src/lib/crypto.ts .fvault envelopes (per file) + TT18 Persistent Storage container (/Private, src/lib/privacy/*)",
    nuance: "Two container forms: per-file .fvault (PBKDF2 600k → AES-GCM, header as AAD) and the TT18 volume (Argon2id keyslots, encrypted names/contents/versions, host audit). Tink itself is Android-only; WebCrypto + hash-wasm Argon2id are cross-checked against Python cryptography/argon2-cffi.",
    test: "privacy-crypto.mts; privacy-layer.mts; e2e-privacy.mts" },
  "SC-05": { status: "built", route: "access log (camera/mic/screen/clipboard) + TT18 Privacy module (storage state, amnesic RAM stats, blocked-host-write log, host audit)",
    nuance: "Device-access logging as before (status unchanged, not re-verified in TT18); TT18 adds what the host could learn and what was blocked.",
    test: "e2e-privacy.mts 6, 10" },
};
