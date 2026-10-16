import { NextResponse, type NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, routines } from "@/db/schema";

export const dynamic = "force-dynamic";

import { ROUTINE_COMMANDS, validateActions as validate } from "@/lib/routines";

export async function GET() {
  const rows = await db.select().from(routines).orderBy(asc(routines.id));
  return NextResponse.json({ ok: true, rows, commands: ROUTINE_COMMANDS });
}

export async function POST(req: NextRequest) {
  const b = (await req.json()) as { name?: string; trigger?: string; triggerArg?: string; actions?: unknown; ranId?: number; dry?: boolean };
  try {
    if (b.ranId) {
      await db.update(routines).set({ lastRun: new Date() }).where(eq(routines.id, b.ranId));
      await db.insert(auditLog).values({ actor: "routine", action: b.dry ? "routine.dryrun" : "routine.run", detail: String(b.ranId) });
      return NextResponse.json({ ok: true });
    }
    const actions = validate(b.actions);
    const trigger = ["manual", "interval", "display-connected", "time-of-day"].includes(b.trigger ?? "") ? b.trigger! : "manual";
    const [row] = await db.insert(routines).values({
      name: b.name || "Routine", trigger, triggerArg: b.triggerArg ?? "", actions,
    }).returning();
    return NextResponse.json({ ok: true, row });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  const b = (await req.json()) as { id?: number; enabled?: boolean };
  if (!b.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  await db.update(routines).set({ enabled: Boolean(b.enabled) }).where(eq(routines.id, b.id));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (id) await db.delete(routines).where(eq(routines.id, id));
  return NextResponse.json({ ok: true });
}
