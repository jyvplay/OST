import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { bootstrap } from "@/lib/server/bootstrap";
import { escapeLike } from "@/lib/server/vfs";
import { metadataSearch, metadataSearchRequest, searchExclusions, visiblePath } from "@/lib/server/metadata-search";
import { diagnoseSearchPath, diagnosticPath, rebuildSearchIndex } from "@/lib/server/search-maintenance";
import { searchOptions } from "@/lib/search-query";
import { readJsonObject } from "@/lib/http-json";
import { fuzzyScore } from "@/lib/fuzzy";

export const dynamic = "force-dynamic";
interface Hit { source: string; ref: string; title: string; snippet: string; rank: number; how: string }
const bad = (error: unknown) => NextResponse.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
function unavailable(error: unknown) {
  console.error("Search storage failed", error instanceof Error ? error.name : "unknown error");
  return NextResponse.json({ ok: false, error: "Search storage is unavailable or busy. No rebuild was confirmed; retry.", rebuilt: false }, { status: 503 });
}
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams, mode = p.get("mode") ?? "text";
  if (!["text", "metadata", "diagnose"].includes(mode)) return bad(new Error("Unknown search mode"));
  if (mode === "diagnose") {
    const path = p.get("path") ?? "";
    try { diagnosticPath(path); } catch (error) { return bad(error); }
    try { await bootstrap(); return NextResponse.json({ ok: true, ...await diagnoseSearchPath(path) }); } catch (error) { return unavailable(error); }
  }
  let options: ReturnType<typeof searchOptions>;
  try { options = searchOptions(p); } catch (error) { return bad(error); }
  let metadata: ReturnType<typeof metadataSearchRequest> | null = null;
  if (mode === "metadata") { try { metadata = metadataSearchRequest(p); } catch (error) { return bad(error); } }
  try {
    await bootstrap();
    if (metadata) return NextResponse.json(await metadataSearch(metadata));
    const { q, scope, source, match, extension } = options, started = Date.now();
    const exclusions = await searchExclusions();
    const visibility = sql`and (source <> 'file' or exists (select 1 from vfs_nodes n where n.path=index_docs.ref and not n.trashed and n.mime <> 'application/x-fusion-encrypted' and ${visiblePath(sql.raw('n.path'), exclusions)}))`;
    if (!q) {
      const counts = await db.execute(sql`select source,count(*)::int as n from index_docs where true ${visibility} group by source order by source`);
      return NextResponse.json({ ok: true, hits: [], coverage: counts.rows, tookMs: Date.now() - started });
    }
    const scopeClause = scope ? sql`and (ref=${scope} or ref like ${escapeLike(scope === "/" ? "" : scope) + "/%"})` : sql``;
    const sourceClause = source ? sql`and source=${source}` : sql``;
    const suffixClause = extension ? sql`and source='file' and lower(ref) like ${"%" + escapeLike(extension)}` : sql``;
    let hits: Hit[] = [];
    if (match === "ranked") {
      const fts = await db.execute(sql`select source,ref,title,left(body,180) as snippet,
        ts_rank(to_tsvector('english',coalesce(title,'') || ' ' || coalesce(body,'')),websearch_to_tsquery('english',${q})) as rank
        from index_docs where to_tsvector('english',coalesce(title,'') || ' ' || coalesce(body,'')) @@ websearch_to_tsquery('english',${q})
          ${scopeClause} ${sourceClause} ${suffixClause} ${visibility}
        order by rank desc,title,source,ref limit 40`);
      hits = (fts.rows as unknown as Hit[]).map(row => ({ ...row, rank: Number(row.rank), how: "fts" }));
    }
    if (hits.length < 10 || match === "literal") {
      const like = `%${escapeLike(q.toLowerCase())}%`;
      const substring = await db.execute(sql`select source,ref,title,left(body,180) as snippet,0.05 as rank
        from index_docs where (lower(title) like ${like} or lower(ref) like ${like} or lower(body) like ${like})
          ${scopeClause} ${sourceClause} ${suffixClause} ${visibility}
        order by title,source,ref limit 40`);
      const seen = new Set(hits.map(hit => `${hit.source}:${hit.ref}`));
      for (const row of substring.rows as unknown as Hit[]) if (!seen.has(`${row.source}:${row.ref}`)) hits.push({ ...row, rank: Number(row.rank), how: match === "literal" ? "literal" : "substring" });
    }
    if (match === "ranked" && hits.length < 5 && q.length >= 4) {
      const candidates = await db.execute(sql`select source,ref,title,left(body,180) as snippet from index_docs where true
        ${scopeClause} ${sourceClause} ${suffixClause} ${visibility} order by updated_at desc,source,ref limit 5000`);
      const seen = new Set(hits.map(hit => `${hit.source}:${hit.ref}`)), fuzzy: Hit[] = [];
      for (const row of candidates.rows as unknown as Hit[]) {
        if (seen.has(`${row.source}:${row.ref}`)) continue;
        const score = fuzzyScore(q, row.title) ?? fuzzyScore(q, row.ref.split("/").pop() ?? "");
        if (score !== null) fuzzy.push({ ...row, rank: 0.01 / (1 + score), how: `fuzzy(${score})` });
      }
      fuzzy.sort((a, b) => b.rank - a.rank || a.ref.localeCompare(b.ref)); hits.push(...fuzzy.slice(0, 20));
    }
    const payload: Record<string, unknown> = { ok: true, hits: hits.slice(0, 50), tookMs: Date.now() - started, local: true, match, extension };
    if (p.get("explain") === "1") {
      const total = await db.execute(sql`select count(*)::int as n from index_docs where true ${visibility}`);
      payload.explain = { indexedDocs: Number(total.rows[0]?.n ?? 0), strategy: match === "literal" ? "literal case-insensitive substring; no stemming or fuzzy fallback" : "websearch_to_tsquery + ts_rank, substring, bounded title fuzzy fallback",
        excluded: "Private, encrypted, trashed and current excluded file paths are filtered from results",
        note: "At most 50 returned hits; fast bodies cover up to 50,000 Unicode code points. Live metadata uses separate bounded pages, not a complete index." };
    }
    return NextResponse.json(payload);
  } catch (error) { return unavailable(error); }
}
export async function POST(req: NextRequest) {
  const body = await readJsonObject(req); if (body instanceof Response) return body;
  if (body.confirm !== "REBUILD") return NextResponse.json({ ok: false, rebuilt: false, error: "Explicit REBUILD confirmation required" }, { status: 400 });
  try { await bootstrap(); return NextResponse.json({ ok: true, ...await rebuildSearchIndex() }); } catch (error) { return unavailable(error); }
}
