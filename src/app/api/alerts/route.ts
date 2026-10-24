import { NextResponse, type NextRequest } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { alerts, desktopState, settings } from "@/db/schema";
import { activeRules, decide, normalizeAlert, parseRules, type FocusContext, type FocusRule } from "@/lib/focus-rules";
import { readJsonObject } from "@/lib/http-json";

export const dynamic = "force-dynamic";

/** TT71 NC-02: the rules, the user's time zone and the live desktop context (active workspace, focus mode). */
async function focusInputs(): Promise<{ rules: FocusRule[]; ctx: FocusContext; problem: string }> {
  const rows = await db.select().from(settings).where(inArray(settings.key, ["alerts.focusRules", "alerts.timeZone"]));
  const val = (k: string) => rows.find((r) => r.key === k)?.value ?? "";
  const parsed = parseRules(val("alerts.focusRules"));
  const st = (await db.select().from(desktopState).where(eq(desktopState.id, "default")).limit(1))[0]?.state as { activeWorkspace?: number; focusMode?: boolean } | undefined;
  return {
    rules: "rules" in parsed ? parsed.rules : [],
    problem: "error" in parsed ? `focus rules ignored: ${parsed.error}` : "",
    ctx: { now: new Date(), timeZone: val("alerts.timeZone") || "UTC", activeWorkspace: Number(st?.activeWorkspace) || 1, focusMode: st?.focusMode === true },
  };
}

export async function GET() {
  const rows = await db.select().from(alerts).orderBy(desc(alerts.pinned), desc(alerts.id)).limit(200);
  const f = await focusInputs();
  return NextResponse.json({
    ok: true, rows,
    focus: { rules: f.rules, active: activeRules(f.rules, f.ctx).map((r) => r.name), timeZone: f.ctx.timeZone, activeWorkspace: f.ctx.activeWorkspace, focusMode: f.ctx.focusMode, problem: f.problem },
    platformNote:
      "A web app cannot read other applications' notifications. There is no NotificationListenerService analog; " +
      "these are Fusion's own alerts plus anything delivered through the Notification API.",
  });
}

export async function POST(req: NextRequest) {
  const raw = (await readJsonObject(req)) as Record<string, unknown> | Response;
  if (raw instanceof Response) return raw;
  const n = normalizeAlert(raw);
  if ("error" in n) return NextResponse.json({ ok: false, error: n.error }, { status: 400 });
  const { app, title, body, priority, groupKey } = n.value;
  const f = await focusInputs();
  const d = decide(f.rules, { app, priority }, f.ctx);
  const [row] = await db.insert(alerts).values({
    app, title, body, priority, groupKey,
    heldBy: d.deliver ? null : d.rule.id, heldReason: d.deliver ? null : d.reason,
  }).returning();
  // delivered = false: callers must not raise an OS notification / toast for it (it waits in Alerts, with its reason)
  return NextResponse.json({ ok: true, row, delivered: d.deliver, reason: d.deliver ? "" : d.reason });
}

export async function PATCH(req: NextRequest) {
  const b = (await readJsonObject(req)) as ({ ids?: number[]; read?: boolean; pinned?: boolean; snoozeMinutes?: number; deliver?: boolean }) | Response;
  if (b instanceof Response) return b;
  if (!b.ids?.length) return NextResponse.json({ ok: false, error: "ids required" }, { status: 400 });
  await db.update(alerts).set({
    ...(b.read !== undefined ? { read: b.read } : {}),
    ...(b.pinned !== undefined ? { pinned: b.pinned } : {}),
    ...(b.snoozeMinutes ? { snoozeUntil: new Date(Date.now() + b.snoozeMinutes * 60000) } : {}),
    ...(b.deliver === true ? { heldBy: null, heldReason: null } : {}),
  }).where(inArray(alerts.id, b.ids));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (id) await db.delete(alerts).where(eq(alerts.id, id));
  else await db.delete(alerts);
  return NextResponse.json({ ok: true });
}
