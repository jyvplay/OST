import { NextResponse, type NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { features } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await bootstrap();
  const rows = await db.select().from(features).orderBy(asc(features.sort));
  const format = req.nextUrl.searchParams.get("format");
  if (format === "csv") {
    // requirements.csv — regenerated from the live register (spec reading contract #1)
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const head = "id,family,name,tier,phase,route,status,test,nuance";
    const body = rows
      .map((r) => [r.code, r.family, r.name, r.tier, r.phase, r.route, r.status, r.test, r.nuance].map(esc).join(","))
      .join("\n");
    return new NextResponse(`${head}\n${body}\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="requirements.csv"',
      },
    });
  }
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  return NextResponse.json({ ok: true, total: rows.length, counts, rows });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as { code?: string; status?: string };
  if (!body.code || !body.status) return NextResponse.json({ ok: false, error: "code and status required" }, { status: 400 });
  await db.update(features).set({ status: body.status }).where(eq(features.code, body.code));
  return NextResponse.json({ ok: true });
}
