import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { bootstrap, bootstrapState } from "@/lib/server/bootstrap";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    // fire-and-forget: liveness must not wait on the spec reconciliation
    void bootstrap().catch(() => undefined);
    return NextResponse.json({ ok: true, db: "up", bootstrap: bootstrapState(), ts: Date.now() });
  } catch (err) {
    return NextResponse.json({ ok: false, db: "down", error: String(err) }, { status: 500 });
  }
}
