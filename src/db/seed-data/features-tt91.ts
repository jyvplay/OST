import type { SpecRow } from "./row";

/** TT91 changes are bounded improvements, not new Class A promotions. */
export function patchTT91(row: SpecRow): SpecRow {
  if (row.code === "PR-07m") return {
    ...row, status: "partial",
    route: "Private proxy → Save to Files: streamed original bytes, progress/cancel, atomic numbered create in /Downloads",
    nuance: "An explicit Save to Files action reads original proxy bytes up to the 8 MiB VFS cap and atomically creates a numbered file without overwriting a concurrent creator. It shows progress, allows cancellation before the commit, and opens /Downloads in Files. These bytes are copied unencrypted to the Fusion server, not /Private; amnesic sessions refuse and no offline replay is queued. A failed commit acknowledgement is reported as unknown. Page-initiated downloads still use the browser's own download system; there is no complete download queue, resume or native manager.",
    test: "tt91-browser-download.mts checks bounds, names, response faults and amnesia; e2e-tt91-browser-download.mts tests real Chromium, PyPI, PostgreSQL collision/retry, Files discovery, a real oversized package and injected cancellation/HTTP faults. This is partial, not a complete native download manager.",
  };
  if (row.code === "FM-11") return {
    ...row,
    nuance: `${row.nuance} Permanent deletion transactionally removes matching current VFS nodes, saved versions and file-search entries from the current database, including descendants; root deletion is refused and wildcard-like neighboring paths remain untouched. Current ordinary/conditional writes and mkdir cooperate with tree trash/restore/purge via shared/exclusive advisory locks; move/copy, backup restore, some internal directory creation, older servers and direct SQL do not. This is not secure erasure of backups, WAL, replicas or disk remnants.`,
    test: `${row.test}; tt91-purge.mts, tt91-purge-race.mts and e2e-tt91-purge.mts test real HTTP/PostgreSQL, Chromium confirmation, wildcard neighbors, orphan history, failure rollback and forced cooperating write interleavings; mutation tests inject omissions`,
  };
  if (row.code === "SC-10") return {
    ...row,
    nuance: `${row.nuance} Current cache cleanup, regular and conditional cache writes, and cache-related trash, restore and purge cooperate using a transaction-scoped PostgreSQL advisory lock. Other mutation paths, older servers and raw SQL do not take that lock; deletion is not secure erasure.`,
    test: `${row.test}; tt91-thumbnail-cleanup-race.mts forces HTTP/PostgreSQL interleavings; tt91-race-mutants.py removes each cooperating cleanup/write lock`,
  };
  return row;
}
