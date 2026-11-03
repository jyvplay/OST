import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { bootstrap } from "@/lib/server/bootstrap";
import { searchExclusions, visiblePath } from "@/lib/server/metadata-search";
import { diagnosticFilePath, privateSearchScope } from "@/lib/search-query";
import { isTextual } from "@/lib/mime";
export const dynamic = "force-dynamic";
export const PREVIEW_CODEPOINTS = 65_536;
const reply = (error: string, status: number) => NextResponse.json({ ok: false, error }, { status });
/** Bounded current public snapshots. No binary decoding, remote fetch, markup
 * interpretation, index-prefix masquerading as full content, or Private read. */
export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("source"), ref = request.nextUrl.searchParams.get("ref") ?? "";
  if (source === "file") {
    try { diagnosticFilePath(ref); } catch { return reply("Invalid public file reference", 400); }
    if (privateSearchScope(ref)) return reply("Private content is never previewed on the host", 400);
  } else if (source !== "note" || !/^[1-9]\d{0,9}$/.test(ref) || Number(ref) > 2_147_483_647) return reply("Preview supports public file and note results", 400);
  try {
    await bootstrap();
    if (source === "file") {
      const excluded = await searchExclusions();
      const result = await db.execute(sql`select n.path as ref,n.name as title,n.mime,n.encoding,n.size,n.updated_at,
        case when n.encoding='utf8' then left(n.content,${PREVIEW_CODEPOINTS}) else '' end as body,
        char_length(n.content)>${PREVIEW_CODEPOINTS} as truncated
        from vfs_nodes n where n.path=${ref} and n.kind='file' and not n.trashed
        and n.mime <> 'application/x-fusion-encrypted' and ${visiblePath(sql.raw('n.path'), excluded)}`);
      const row = result.rows[0]; if (!row) return reply("Result is unavailable or excluded", 404);
      const textual = row.encoding === "utf8" && isTextual(String(row.mime));
      return NextResponse.json({ ok: true, source, ...row, body: textual ? row.body : "", textual, notice: textual ? "Current public file snapshot, not the indexed snippet. At most 65,536 Unicode code points." : "Binary/non-UTF-8 content is not decoded; metadata only." });
    }
    const result = await db.execute(sql`select id::text as ref,title,revision,updated_at,octet_length(body) as size,left(body,${PREVIEW_CODEPOINTS}) as body,char_length(body)>${PREVIEW_CODEPOINTS} as truncated from notes where id=${Number(ref)}`);
    if (!result.rows.length) return reply("Note no longer exists", 404);
    return NextResponse.json({ ok: true, source, ...result.rows[0], mime: "text/plain", textual: true, notice: "Current saved body, not this window's unsaved draft. At most 65,536 Unicode code points." });
  } catch { return reply("Preview storage is unavailable", 503); }
}
