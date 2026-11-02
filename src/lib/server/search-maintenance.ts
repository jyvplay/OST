import { sql } from "drizzle-orm";
import { safeTransaction } from "./transaction";
import { diagnosticFilePath } from "@/lib/search-query";
import { searchExclusions, visiblePath } from "./metadata-search";
import { isPrivateVfsPath } from "@/lib/mime";

/** Derived data only. Readers see the old or new index, never the intermediate
 * delete. Lock primary tables BEFORE the index, matching normal write order.
 * A busy/large database is refused on timeout, not labelled rebuilt. */
export async function rebuildSearchIndex() {
  return safeTransaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '4s'`);
    await tx.execute(sql`set local statement_timeout = '15s'`);
    await tx.execute(sql`lock table vfs_nodes, notes, index_docs in share row exclusive mode`);
    const exclusions = await searchExclusions(tx);
    await tx.execute(sql`delete from index_docs where source in ('file','note')`);
    await tx.execute(sql`insert into index_docs (source,ref,title,body,updated_at)
      select 'file',n.path,n.name,case when n.encoding='utf8' and (n.mime like 'text/%' or n.mime in ('application/json','image/svg+xml')) then left(n.content,50000) else '' end,now()
      from vfs_nodes n where n.kind='file' and not n.trashed and n.mime <> 'application/x-fusion-encrypted'
        and ${visiblePath(sql.raw('n.path'), exclusions)}`);
    await tx.execute(sql`insert into index_docs (source,ref,title,body,updated_at)
      select 'note',id::text,title,left(body,50000),now() from notes`);
    const counts = await tx.execute(sql`select source,count(*)::int as n from index_docs group by source order by source`);
    return { rebuilt: true, counts: counts.rows, exclusions, bodyLimit: 50000, bodyUnit: "Unicode code points", at: new Date().toISOString() };
  });
}
export const diagnosticPath = diagnosticFilePath;
export async function diagnoseSearchPath(raw: string) {
  const path = diagnosticPath(raw);
  // Never ask the database whether a particular private name exists.
  if (isPrivateVfsPath(path)) return { path, status: "private", indexed: false, notice: "Private files are searched in the unlocked tab, not the host index." };
  return safeTransaction(async tx => {
    const exclusions = await searchExclusions(tx);
    const excluded = exclusions.find(p => p === "/" || path === p || path.startsWith(`${p}/`));
    const result = await tx.execute(sql`select n.kind,n.mime,n.encoding,n.trashed,
      char_length(n.content)::int as content_chars,i.id is not null as indexed,
      (i.title=n.name and i.body=case when n.encoding='utf8' and (n.mime like 'text/%' or n.mime in ('application/json','image/svg+xml')) then left(n.content,50000) else '' end) as current
      from vfs_nodes n left join index_docs i on i.source='file' and i.ref=n.path where n.path=${path}`);
    const node = result.rows[0];
    if (!node) return { path, status: "missing", indexed: false, notice: "No saved file exists at this path." };
    if (node.trashed) return { path, status: "trashed", indexed: false, notice: "Trashed files are hidden from search." };
    if (node.kind !== "file") return { path, status: "folder", indexed: false, notice: "This is a folder. Use it as the search scope." };
    if (node.mime === "application/x-fusion-encrypted") return { path, status: "encrypted", indexed: false, notice: "Encrypted file content is not in the host index." };
    if (excluded) return { path, status: "excluded", indexed: false, exclusion: excluded, notice: "This folder is excluded by search settings." };
    if (!node.indexed) return { path, status: "not-indexed", indexed: false, notice: "No fast-index entry. Rebuild the index or save this file." };
    if (!node.current) return { path, status: "stale", indexed: true, notice: "The fast-index entry differs from the current saved file. Rebuild it." };
    const textual = String(node.mime).startsWith("text/") || ["application/json", "image/svg+xml"].includes(String(node.mime));
    const nameOnly = !textual || node.encoding !== "utf8";
    return { path, status: nameOnly ? "name-only" : "indexed", indexed: true, bodyLimit: 50000,
      truncated: !nameOnly && Number(node.content_chars) > 50000,
      notice: nameOnly ? "Fast search covers the filename, not this binary body's text. Try supported live metadata." : "The filename and first 50,000 Unicode code points are current in the fast index." };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
