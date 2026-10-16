import { NextResponse, type NextRequest } from "next/server";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { settings, settingsHistory } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await bootstrap();
  const rows = await db.select().from(settings).orderBy(asc(settings.category), asc(settings.key));
  const history = req.nextUrl.searchParams.get("history") === "1"
    ? await db.select().from(settingsHistory).orderBy(desc(settingsHistory.id)).limit(50)
    : [];
  return NextResponse.json({ ok: true, rows, history });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { key?: string; value?: string };
  if (!body.key) return NextResponse.json({ ok: false, error: "key required" }, { status: 400 });
  const rows = await db.select().from(settings).where(eq(settings.key, body.key)).limit(1);
  const current = rows[0];
  if (!current) return NextResponse.json({ ok: false, error: "unknown setting" }, { status: 404 });
  if (current.lockReason) {
    return NextResponse.json({ ok: false, error: current.lockReason, locked: true }, { status: 423 });
  }
  const next = String(body.value ?? "");
  await db.insert(settingsHistory).values({ key: body.key, oldValue: current.value, newValue: next });
  await db.update(settings).set({ value: next, updatedAt: new Date() }).where(eq(settings.key, body.key));
  return NextResponse.json({ ok: true, key: body.key, value: next, undoFrom: current.value });
}
