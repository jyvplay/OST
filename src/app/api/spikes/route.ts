import { NextResponse, type NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { spikes } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";

export const dynamic = "force-dynamic";

export async function GET() {
  await bootstrap();
  const rows = await db.select().from(spikes).orderBy(asc(spikes.code));
  return NextResponse.json({ ok: true, rows });
}

export async function PATCH(req: NextRequest) {
  const b = (await req.json()) as { code?: string; status?: string; result?: string };
  if (!b.code) return NextResponse.json({ ok: false, error: "code required" }, { status: 400 });
  await db.update(spikes).set({
    ...(b.status ? { status: b.status } : {}),
    ...(b.result ? { result: b.result } : {}),
  }).where(eq(spikes.code, b.code));
  return NextResponse.json({ ok: true });
}
