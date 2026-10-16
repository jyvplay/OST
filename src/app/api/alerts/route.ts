import { NextResponse, type NextRequest } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { alerts } from "@/db/schema";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(alerts).orderBy(desc(alerts.pinned), desc(alerts.id)).limit(200);
  return NextResponse.json({
    ok: true, rows,
    platformNote:
      "A web app cannot read other applications' notifications. There is no NotificationListenerService analog; " +
      "these are Fusion's own alerts plus anything delivered through the Notification API.",
  });
}

export async function POST(req: NextRequest) {
  const b = (await req.json()) as { app?: string; title?: string; body?: string; priority?: string; groupKey?: string };
  const [row] = await db.insert(alerts).values({
    app: b.app ?? "Fusion", title: b.title ?? "Alert", body: b.body ?? "",
    priority: b.priority ?? "normal", groupKey: b.groupKey ?? (b.app ?? "Fusion"),
  }).returning();
  return NextResponse.json({ ok: true, row });
}

export async function PATCH(req: NextRequest) {
  const b = (await req.json()) as { ids?: number[]; read?: boolean; pinned?: boolean; snoozeMinutes?: number };
  if (!b.ids?.length) return NextResponse.json({ ok: false, error: "ids required" }, { status: 400 });
  await db.update(alerts).set({
    ...(b.read !== undefined ? { read: b.read } : {}),
    ...(b.pinned !== undefined ? { pinned: b.pinned } : {}),
    ...(b.snoozeMinutes ? { snoozeUntil: new Date(Date.now() + b.snoozeMinutes * 60000) } : {}),
  }).where(inArray(alerts.id, b.ids));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (id) await db.delete(alerts).where(eq(alerts.id, id));
  else await db.delete(alerts);
  return NextResponse.json({ ok: true });
}
