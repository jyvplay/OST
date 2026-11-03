import { sql } from "drizzle-orm";
import { contentFiltersUsed, type SearchResources } from "@/lib/search-resources";
import { escapeLike } from "./vfs";
/** SQL identifiers are fixed by this module, never supplied by a requester. */
export function nodeResourceFilter(value: SearchResources) {
  const terms = [sql`true`];
  if (value.modifiedAfter) terms.push(sql`n.updated_at >= ${value.modifiedAfter + "T00:00:00.000Z"}::timestamptz`);
  if (value.modifiedBefore) terms.push(sql`n.updated_at < ${value.modifiedBefore + "T00:00:00.000Z"}::timestamptz`);
  if (value.minBytes) terms.push(sql`n.size >= ${Number(value.minBytes)}`);
  if (value.maxBytes) terms.push(sql`n.size <= ${Number(value.maxBytes)}`);
  if (value.excludeFolder) terms.push(value.excludeFolder === "/" ? sql`false` : sql`n.path <> ${value.excludeFolder} and n.path not like ${escapeLike(value.excludeFolder) + "/%"}`);
  return sql.join(terms, sql` and `);
}
export function indexedResourceFilter(value: SearchResources) {
  const terms = [sql`true`];
  if (contentFiltersUsed(value)) {
    const noteTerms = [sql`true`];
    if (value.modifiedAfter) noteTerms.push(sql`m.updated_at >= ${value.modifiedAfter + "T00:00:00.000Z"}::timestamptz`);
    if (value.modifiedBefore) noteTerms.push(sql`m.updated_at < ${value.modifiedBefore + "T00:00:00.000Z"}::timestamptz`);
    if (value.minBytes) noteTerms.push(sql`octet_length(m.body) >= ${Number(value.minBytes)}`);
    if (value.maxBytes) noteTerms.push(sql`octet_length(m.body) <= ${Number(value.maxBytes)}`);
    terms.push(sql`((source='file' and exists(select 1 from vfs_nodes n where n.path=index_docs.ref and ${nodeResourceFilter(value)})) or (source='note' and exists(select 1 from notes m where m.id::text=index_docs.ref and ${sql.join(noteTerms, sql` and `)})))`);
  } else if (value.excludeFolder) terms.push(value.excludeFolder === "/" ? sql`source <> 'file'` : sql`(source <> 'file' or (ref <> ${value.excludeFolder} and ref not like ${escapeLike(value.excludeFolder) + "/%"}))`);
  return sql.join(terms, sql` and `);
}
