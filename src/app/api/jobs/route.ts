import { NextResponse, type NextRequest } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, fileOps } from "@/db/schema";

export const dynamic = "force-dynamic";

/** DP-14: every background job is observable, with its journal states. */
export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 40);
  const ops = await db.select().from(fileOps).orderBy(desc(fileOps.id)).limit(limit);
  const log = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
  return NextResponse.json({ ok: true, ops, log });
}
