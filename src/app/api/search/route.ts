import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { indexDocs } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import { escapeLike } from "@/lib/server/vfs";
import { fuzzyScore } from "@/lib/fuzzy";

export const dynamic = "force-dynamic";

interface Hit { source: string; ref: string; title: string; snippet: string; rank: number; how: string }

/**
 * Ranking without pg_trgm (not guaranteed in this sandbox):
 *  1. full-text via websearch_to_tsquery + ts_rank   -> how = "fts"
 *  2. substring fallback for partial tokens          -> how = "substring"
 * Both paths return provenance so the palette can label every row (UX: provenance).
 */
export async function GET(req: NextRequest) {
  await bootstrap();
  const p = req.nextUrl.searchParams;
  const q = (p.get("q") ?? "").trim();
  const scope = p.get("scope") ?? "";
  const source = p.get("source") ?? "";
  const explain = p.get("explain") === "1";
  const started = Date.now();

  if (!q) {
    const counts = await db.execute(sql`select source, count(*)::int as n from index_docs group by source order by source`);
    return NextResponse.json({ ok: true, hits: [], coverage: counts.rows, tookMs: Date.now() - started });
  }

  const scopeClause = scope ? sql`and ref like ${escapeLike(scope) + "%"}` : sql``;
  const sourceClause = source ? sql`and source = ${source}` : sql``;

  const fts = await db.execute(sql`
    select source, ref, title,
           left(body, 180) as snippet,
           ts_rank(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,'')),
                   websearch_to_tsquery('english', ${q})) as rank
    from index_docs
    where to_tsvector('english', coalesce(title,'') || ' ' || coalesce(body,''))
          @@ websearch_to_tsquery('english', ${q})
      ${scopeClause} ${sourceClause}
    order by rank desc, title asc
    limit 40`);

  let hits: Hit[] = (fts.rows as unknown as Hit[]).map((r) => ({ ...r, how: "fts" }));

  if (hits.length < 10) {
    const like = `%${escapeLike(q.toLowerCase())}%`;
    const sub = await db.execute(sql`
      select source, ref, title, left(body, 180) as snippet, 0.05 as rank
      from index_docs
      where (lower(title) like ${like} or lower(ref) like ${like} or lower(body) like ${like})
        ${scopeClause} ${sourceClause}
      limit 40`);
    const seen = new Set(hits.map((h) => `${h.source}:${h.ref}`));
    for (const r of sub.rows as unknown as Hit[]) {
      if (!seen.has(`${r.source}:${r.ref}`)) hits.push({ ...r, how: "substring" });
    }
  }

  // SR-03 typo tolerance: only when exact paths found little, over a bounded
  // candidate set (titles only, ≤ 5 000 rows) so cost stays predictable.
  if (hits.length < 5 && q.length >= 4) {
    const cands = await db.execute(sql`
      select source, ref, title, left(body, 180) as snippet from index_docs
      where true ${scopeClause} ${sourceClause}
      order by updated_at desc limit 5000`);
    const seen = new Set(hits.map((h) => `${h.source}:${h.ref}`));
    const fuzzy: Hit[] = [];
    for (const r of cands.rows as unknown as Hit[]) {
      if (seen.has(`${r.source}:${r.ref}`)) continue;
      const s = fuzzyScore(q, r.title) ?? fuzzyScore(q, r.ref.split("/").pop() ?? "");
      if (s !== null) fuzzy.push({ ...r, rank: 0.01 / (1 + s), how: `fuzzy(${s})` });
    }
    fuzzy.sort((a, b) => b.rank - a.rank);
    hits.push(...fuzzy.slice(0, 20));
  }

  hits = hits.slice(0, 50);
  const payload: Record<string, unknown> = { ok: true, hits, tookMs: Date.now() - started, local: true };
  if (explain) {
    const total = await db.select({ n: sql<number>`count(*)::int` }).from(indexDocs);
    payload.explain = {
      indexedDocs: Number(total[0]?.n ?? 0),
      strategy: "websearch_to_tsquery + ts_rank, substring fallback",
      excluded: "paths under search.excludes are never indexed",
      note: "If a file is missing: it is binary, trashed, or excluded.",
    };
  }
  return NextResponse.json(payload);
}

export async function POST() {
  // rebuild: cheap here because the index is derived, not primary
  await bootstrap();
  const counts = await db.execute(sql`select source, count(*)::int as n from index_docs group by source`);
  return NextResponse.json({ ok: true, rebuilt: true, coverage: counts.rows });
}
