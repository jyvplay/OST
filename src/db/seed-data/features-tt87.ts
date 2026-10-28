import type { SpecRow } from "./row";

/** TT87: repair config restore and stop overstating the separate timeline/drill/key features. */
export function patchTT87(row: SpecRow): SpecRow {
  if (row.code === "FM-08") return {
    ...row, tier: "A/B", phase: "P2", status: "probe",
    route: "Local disk → user-selected File System Access directory, IndexedDB handle persistence, re-grant and conflict-free import",
    nuance: "Mounting depends on the browser exposing showDirectoryPicker and the user granting access; it is not a general removable/network-volume driver or VFS overlay. Imports use a conditional create and a free name so existing Fusion documents are not overwritten. Local Disk is unavailable in amnesic mode because local writes would persist. This turn exercised real Chromium origin-private file-system handles and IndexedDB; native folder-picker permission persistence, removable media, SMB, SFTP, WebDAV and FTP remain unverified or absent.",
    test: "e2e-tt87-localdisk.mts uses real Chromium filesystem handles, IndexedDB reload, binary import/name collisions and VFS conditional-write failures; it does not exercise a native directory picker",
  };
  if (row.code === "BK-02") return {
    ...row, tier: "B", phase: "P3", status: "partial",
    route: "Local disk → direct-child UTF-8 sync with conflict inbox and VFS conditional writes",
    nuance: "Unsupported local names, directories, invalid UTF-8, large files, encrypted and binary Fusion entries remain occupied and are skipped rather than overwritten. New VFS files are created conditionally; conflict resolution refuses a changed VFS id/version/digest or local digest. Local Disk is unavailable in amnesic mode and conditional writes into /Private are refused. The browser cannot atomically compare-and-swap user-visible local files against native apps, and creation of an absent local name has a remaining race; pause other editors. No recursive sync, deletion propagation, shared-base merge, offline queue or native cross-process lock is claimed.",
    test: "e2e-tt87-localdisk.mts: real Chromium OPFS handles and PostgreSQL, skipped-name preservation, BOM and binary cases, stale conflicts, explicit resolution, file versions, conditional VFS writes and collision-free import",
  };
  if (row.code === "BK-03") return {
    ...row, tier: "A", phase: "P1", status: "built",
    route: "Backup → config export / preview / restore; src/lib/backup/bundle.ts; /api/backup; serializable restore transaction",
    nuance: "Editable settings export separately from documents and notes. Version-2 snapshots checksum the complete canonical payload; the browser independently verifies it, and the server validates setting values, skips unknown/locked keys visibly, previews changes, checks for a stale destination, writes settings plus undo history atomically and refreshes open Fusion tabs. Plain SHA-256 is not authentication. Optional passphrase encryption uses browser-side PBKDF2/AES-GCM; the decrypted snapshot is sent to this Fusion server. Legacy v1 files have unprotected metadata/settings and require explicit consent. The current web implementation still needs a running Fusion server and PostgreSQL.",
    test: "tt87-backup.mts (format, Unicode, SHA-256, malformed and tampered inputs); tt87-backup-http.mts (real config round trip, validation, locks, stale preview, history and rollback); tt87-transaction.mts (real PostgreSQL commit/rollback and injected connection faults); e2e-tt87-backup.mts (Chromium download, encryption, wrong password, tamper refusal, cancel, restore, two-tab refresh and keyboard accessibility)",
  };
  if (row.code === "BK-01") return {
    ...row, tier: "B", phase: "P2", status: "partial",
    route: "Backup → current data snapshot with checksummed VFS files/folders and notes; optional browser-side encrypted download; serializable merge restore",
    nuance: "TT87 removes silent partial restores: validation and preview precede one database transaction including changed files, prior-file snapshots, search index, notes and journal. Existing folders keep their tags; identical notes are skipped and edited notes remain alongside restored copies. The 64 MiB snapshot contains current non-trashed files/folders and notes, not tasks, contacts, previous file versions, trash, incremental history or remote destinations. Plain checksums are not authentication; use encrypted downloads and protect the passphrase. Legacy v1 metadata/notes/settings are not integrity-protected and require explicit consent.",
    test: "tt87-backup-http.mts: real PostgreSQL round trip including UTF-8, binary, empty folder, notes, private-index exclusion, stale preview, legacy consent and an injected mid-transaction failure; tt87-backup.mts: malformed and altered bundles",
  };
  if (row.code === "BK-05") return {
    ...row, tier: "A", phase: "P2", status: "partial",
    route: "Backup → Verify digests and restore preview",
    nuance: "A checksum verification and a dry-run preview are available; neither is a real restore drill or proof that a backup can be recovered on another device. Monthly scheduling, sampled scratch restores and durable health states are not implemented.",
    test: "e2e-tt87-backup.mts verifies the actual browser-side checksum and preview; no scheduled restore drill is claimed",
  };
  if (row.code === "BK-06") return {
    ...row, tier: "A", phase: "P2", status: "partial",
    route: "Backup → browser-side PBKDF2/AES-GCM passphrase encryption",
    nuance: "The export passphrase remains in the browser and there is no escrow. Losing it makes the backup unreadable. A separately issued recovery key for these general backups is not implemented (the Privacy volume has its own distinct recovery mechanism). Decrypted contents are sent to the Fusion server on restore.",
    test: "e2e-tt87-backup.mts checks encrypted download, wrong passphrase, ciphertext tampering and absence of the passphrase in recorded requests",
  };
  if (row.code === "LY-12") return {
    ...row,
    nuance: `${row.nuance} TT87 marks an animated face unsettled in the same render commit and refuses new card drags until it settles; this prevents mapping a drag through a moving 3-D transform.`,
    test: `${row.test}; e2e-tabletop.mts checks the first animated pose, waits for its real transition and drags a pinned card on the unfolded wall`,
  };
  if (row.code === "SC-10" || row.code === "SC-13") return {
    ...row,
    nuance: `${row.nuance} TT87 conditional VFS writes are refused for /Private and in amnesic sessions; unreviewed future filesystem operations fail closed at those boundaries. Local Disk is unavailable in amnesic sessions rather than writing to a local folder.`,
    test: `${row.test}; privacy-layer.mts and e2e-tt87-privacy.mts exercise the conditional-write privacy boundary against PostgreSQL and Chromium`,
  };
  if (row.code === "SH-06") return {
    ...row,
    nuance: `${row.nuance} TT87 caps each pending animation-frame batch at 256 samples; overflow discards the whole batch and resets the tracker, intentionally sacrificing actions rather than activating from an incomplete path. The pointermove fallback was forced and tested in Chromium, not in a second browser engine.`,
    test: `${row.test}; tt87-pointer-queue.mts (exact cap and 100,000-sample burst); POINTER_EVENT_SOURCE=pointermove e2e-tt86-pointer.mts (real CDP input through forced fallback plus synthetic burst recovery)`,
  };
  return row;
}
