import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const dynamic = "force-dynamic";

/**
 * FM-07 storage overview. Duplicates are found by content digest (sha256),
 * not by name+size: two different files can share both, and identical files
 * often have different names. Versions are reported separately because they
 * are the hidden cost of "reversible by default".
 */
export async function GET() {
  const categories = await db.execute(sql`
    select case
      when mime like 'image/%' then 'images'
      when mime like 'video/%' then 'video'
      when mime like 'audio/%' then 'audio'
      when mime like 'text/%' or mime in ('application/json') then 'text'
      when mime like 'application/vnd.openxmlformats%' or mime = 'application/pdf' then 'documents'
      when mime = 'application/zip' then 'archives'
      else 'other' end as category,
      count(*)::int as files, coalesce(sum(size),0)::bigint as bytes
    from vfs_nodes where kind = 'file' and trashed = false
    group by 1 order by 3 desc`);
  const large = await db.execute(sql`
    select path, size, mime from vfs_nodes where kind='file' and trashed=false order by size desc limit 15`);
  const dupes = await db.execute(sql`
    select sha256, count(*)::int as copies, max(size)::int as size,
           (count(*) - 1) * max(size) as reclaimable, array_agg(path order by path) as paths
    from vfs_nodes where kind='file' and trashed=false and sha256 <> '' and size > 0
    group by sha256 having count(*) > 1 order by reclaimable desc limit 30`);
  const trash = await db.execute(sql`
    select count(*)::int as files, coalesce(sum(size),0)::bigint as bytes from vfs_nodes where trashed = true and kind='file'`);
  const versions = await db.execute(sql`
    select count(*)::int as versions, coalesce(sum(size),0)::bigint as bytes from vfs_versions`);
  return NextResponse.json({
    ok: true,
    categories: categories.rows, large: large.rows, duplicates: dupes.rows,
    trash: trash.rows[0], versions: versions.rows[0],
  });
}
