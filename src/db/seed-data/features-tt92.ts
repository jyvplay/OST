import type { SpecRow } from "./row";

/** Evidence corrections and bounded trash improvements; no Class A promotion. */
export function patchTT92(row: SpecRow): SpecRow {
  if (row.code === "FM-03") return {
    ...row, tier: "B", status: "partial",
    route: "Files copy/cut/paste and rename → /api/fs → multi-stage file_ops journal",
    nuance: "A transfer creates a temporary VFS copy, checks the selected root's recorded digest, publishes it and (for move) retires the source, recording steps. The stages use separate transactions, not one atomic transaction; children are not individually re-read and verified, crash recovery/pause-resume and full undo are incomplete, and folder search/history can be left inconsistent. Move/copy also does not share the newer tree-operation gate. The canonical specification assigns FM-03 tier B, not the earlier web register's A.",
    test: "integration and e2e-tt55-files exercise ordinary journal states, moves, copies and conflict-free names; they do not prove crash recovery, atomic directory transfers or all concurrent interleavings.",
  };
  if (row.code === "FM-11") return {
    ...row, tier: "B", status: "partial",
    route: "Files → Trash: original path, recorded date, aggregate trash bytes, restore or confirmed permanent deletion",
    nuance: "Tree trash/restore and file-search updates now run together in one transaction. Separately trashed groups stay separate; a legacy item with a null group is restored alone because membership is ambiguous. Ordinary/conditional writes and mkdir cooperate with the tree-operation gate; move/copy, backup restore, older servers and raw SQL do not. Trashed paths remain reserved. Retention is manual, Private sizes may be encrypted sizes, and backups omit Trash. Permanent deletion removes current database rows/history/search, not backups, WAL, replicas or physical remnants; this is not secure erasure. Canonical FM-11 is tier B, not A.",
    test: "tt92-trash.mts and tt92-trash-race.mts test real HTTP/PostgreSQL trees, rollback, null groups, literal wildcard paths and forced cooperating races; e2e-tt92-trash.mts tests the Chromium metadata/restore UI. tt91-purge and Chromium confirmation suites cover bounded permanent deletion. Other mutation paths and crash recovery remain unproven.",
  };
  if (row.code === "FM-18") return {
    ...row, status: "partial",
    route: "VFS ordinary and conditional writes → PostgreSQL transaction, version snapshot, search and journal",
    nuance: "There is no /api/fs safeSave operation, temp-output/reopen validation, or Android SAF provider implementation. Ordinary database writes atomically update the VFS content, prior version and search row within the current cooperative write path; a lost commit acknowledgement can be ambiguous. Native-provider safe-save, non-overwriting Save a Copy when replacement is unavailable, and the canonical complete SAF contract are not implemented.",
    test: "tt91-write-atomic.mts injects index failures and concurrent overwrites; integration checks a prior version exists. These do not establish the native SAF safe-save contract.",
  };
  if (row.code === "PR-01") return {
    ...row, status: "partial",
    route: "First-party VFS text editor with ordinary transactional database writes and version timeline",
    nuance: `${row.nuance} The editor does not implement the canonical Android SAF temp/reopen/replace safe-save contract; see FM-18.`,
    test: `${row.test}; FM-18's native provider safe-save remains unimplemented.`,
  };
  return row;
}
