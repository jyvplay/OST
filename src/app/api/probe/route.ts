import { NextResponse, type NextRequest } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { capabilityReports } from "@/db/schema";

export const dynamic = "force-dynamic";

/** Capability reports are stored only when the user exports/saves one (DP-11). */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { clientId?: string; ua?: string; report?: unknown };
  const [row] = await db.insert(capabilityReports).values({
    clientId: body.clientId ?? "anonymous",
    ua: body.ua ?? "",
    report: (body.report ?? {}) as object,
  }).returning({ id: capabilityReports.id });
  return NextResponse.json({ ok: true, id: row.id });
}

export async function GET() {
  const rows = await db.select().from(capabilityReports).orderBy(desc(capabilityReports.id)).limit(20);
  return NextResponse.json({ ok: true, rows });
}
