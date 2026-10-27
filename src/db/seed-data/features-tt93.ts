import type { SpecRow } from "./row";

/** Current bounded transfer/restore evidence and a Photos classification correction; no Class A promotion. */
export function patchTT93(row: SpecRow): SpecRow {
  if (row.code === "FM-03") return {
    ...row, tier: "B", status: "partial",
    route: "Files copy/cut/paste and rename → /api/fs → transaction-scoped VFS tree transfer and file_ops journal",
    nuance: "Current database-local transfers verify each source file's stored-content digest, validate the source tree and destination, then move or copy current nodes, move saved versions, rebuild file search and mark COMPLETE in one PostgreSQL transaction. Participating writers/tree operations and file-bearing backup restore share a cooperative tree gate; transfers overlapping thumbnail cache also share its cleanup gate. The historical Jobs step names are logical labels: no external temp/reopen verification, pause/resume, complete undo or cross-provider/native crash recovery is implemented. For public VFS files, photo sidecar move/copy is part of the same transaction and conflicting destination sidecars are refused; sidecar trash/restore/purge remain separate best-effort operations. Encrypted Private names cannot be paired by the server without browser assistance. Older servers, some internal operations and direct SQL can bypass the gate. Canonical FM-03 is tier B.",
    test: "tt93-transfer.mts covers real PostgreSQL/HTTP nested trees, history/search, digest and journal/index faults, retained destination data, trash, Private, Unicode and sidecar collision; tt93-transfer-race.mts forces selected tree/writer/cache interleavings. These do not prove all races, native filesystem semantics or crash recovery.",
  };
  if (row.code === "FM-11") return {
    ...row,
    nuance: "Tree trash/restore and file-search updates run together in one transaction. Separately trashed groups stay separate; a legacy item with a null group is restored alone because membership is ambiguous. Ordinary/conditional writes, mkdir, move/copy and file-bearing backup restore participate in the tree-operation gate; older servers, some internal mutations and raw SQL do not. Trashed paths remain reserved. Retention is manual, Private sizes may be encrypted sizes, and backups omit Trash. Permanent deletion removes current database rows/history/search, not backups, WAL, replicas or physical remnants; this is not secure erasure. Canonical FM-11 is tier B.",
    test: `${row.test} tt93-transfer-race.mts and tt93-restore-race.mts add selected cooperating transfer/restore races, not universal isolation.`,
  };
  if (row.code === "BK-01") return {
    ...row,
    nuance: `${row.nuance} File-bearing restore now cooperates with current VFS tree mutations and overlapping thumbnail-cache cleanup; a serializable conflict requires a fresh preview. Older servers, nonparticipating operations and direct SQL are outside this lock.`,
    test: `${row.test}; tt93-restore-race.mts forces tree-gate, trash and cache-cleanup orderings.`,
  };
  if (row.code === "MD-03") return {
    ...row, tier: "A", status: "partial",
    route: "Photos module over browser/VFS library, non-destructive recipe sidecars and capability-probed export",
    nuance: "Photos provides a browser/VFS library, non-destructive recipe editor and PNG/JPEG/WebP/AVIF exports. A public-VFS photo and its recipe move/copy together in one transaction; a destination sidecar collision refuses the whole transfer. Trash/restore/purge sidecar follow is still best-effort and not atomic, and encrypted Private names need browser-layer pairing. This PWA does not integrate Android MediaStore. HEIC requires browser/platform HEVC capability and was unavailable in the tested Chromium, so the canonical MediaStore-and-HEIC feature is not complete.",
    test: "e2e-tt54.mts exercises real Photos recipes, sidecar happy paths and independently decoded exports; tt93-transfer.mts tests sidecar collision preservation. Native MediaStore and working HEIC on a supported device remain unverified.",
  };
  return row;
}
