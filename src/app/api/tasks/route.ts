import { NextResponse, type NextRequest } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { parseIcs, toIcs } from "@/lib/ics";
import { readJsonObject } from "@/lib/http-json";
import { safeTransaction } from "@/lib/server/transaction";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rows = await db.select().from(tasks).orderBy(asc(tasks.done), asc(tasks.dueAt), asc(tasks.id));
  if (req.nextUrl.searchParams.get("format") === "ics") {
    return new NextResponse(toIcs(rows.map((r) => ({
      uid: r.uid || `fusion-${r.id}@fusion.local`, title: r.title, notes: r.notes,
      start: r.dueAt, end: r.endAt, kind: r.kind, done: r.done,
    }))), { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="fusion.ics"' } });
  }
  return NextResponse.json({ ok: true, rows });
}

export async function POST(req: NextRequest) {
  const b = (await readJsonObject(req)) as ({ title?: string; notes?: string; dueAt?: string | null; ics?: string }) | Response;
  if (b instanceof Response) return b;
  if (b.ics) {
    // PR-04: import is additive and idempotent by UID — re-importing never duplicates
    const events = parseIcs(b.ics);
    let added = 0, skipped = 0;
    for (const e of events) {
      const inserted = await safeTransaction(async (tx) => {
        if (e.uid) {
          // The check and insert must be serialized for the same UID. A
          // database-wide unique constraint would reject legacy duplicates;
          // this cooperative lock needs no destructive migration. Old servers
          // and direct SQL do not participate, so this is not universal.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fusion-calendar-uid:${e.uid}`}, 0))`);
          const dup = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.uid, e.uid)).limit(1);
          if (dup.length) return false;
        }
        await tx.insert(tasks).values({
          title: e.title || "(untitled event)", notes: e.rrule && !/^RRULE:/m.test(e.notes) ? `${e.notes}${e.notes ? "\n" : ""}RRULE:${e.rrule}` : e.notes, kind: e.kind, uid: e.uid,
          dueAt: e.start, endAt: e.end, done: e.done,
        });
        return true;
      });
      if (inserted) added++; else skipped++;
    }
    return NextResponse.json({ ok: true, parsed: events.length, added, skipped });
  }
  if (!b.title) return NextResponse.json({ ok: false, error: "title required" }, { status: 400 });
  const [row] = await db.insert(tasks).values({
    title: b.title, notes: b.notes ?? "", dueAt: b.dueAt ? new Date(b.dueAt) : null,
  }).returning();
  return NextResponse.json({ ok: true, row });
}

export async function PATCH(req: NextRequest) {
  const b = (await readJsonObject(req)) as ({ id?: number; done?: boolean; reminded?: boolean; title?: string; dueAt?: string | null }) | Response;
  if (b instanceof Response) return b;
  if (!b.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  await db.update(tasks).set({
    ...(b.done !== undefined ? { done: b.done } : {}),
    ...(b.reminded !== undefined ? { reminded: b.reminded } : {}),
    ...(b.title !== undefined ? { title: b.title } : {}),
    ...(b.dueAt !== undefined ? { dueAt: b.dueAt ? new Date(b.dueAt) : null, reminded: false } : {}),
  }).where(eq(tasks.id, b.id));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  await db.delete(tasks).where(eq(tasks.id, id));
  return NextResponse.json({ ok: true });
}
