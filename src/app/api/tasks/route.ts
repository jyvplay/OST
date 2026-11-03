import { NextResponse, type NextRequest } from "next/server";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { inspectIcsImport, parseIcs, toIcs } from "@/lib/ics";
import { readJsonObject } from "@/lib/http-json";
import { safeTransaction } from "@/lib/server/transaction";
import { assertTaskExpected, taskId, taskWrite, TaskInputError, type TaskFields } from "@/lib/task-model";

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
  const b = await readJsonObject(req);
  if (b instanceof Response) return b;
  if (b.ics !== undefined && typeof b.ics !== "string") return NextResponse.json({ ok: false, error: "ics must be text" }, { status: 400 });
  if (b.ics) {
    // PR-04: import is additive and idempotent by UID — re-importing never duplicates
    const events = parseIcs(b.ics);
    if (b.preview === true) {
      // Preflight has no database reads or writes; UID dedup is rechecked only
      // at import time, so preview does not promise an eventual added count.
      return NextResponse.json({ ok: true, parsed: events.length, warnings: inspectIcsImport(b.ics), serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown" });
    }
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
  try {
    const value = taskWrite(b);
    const [row] = await db.insert(tasks).values(databaseFields(value)).returning();
    return NextResponse.json({ ok: true, row });
  } catch (error) { return inputFailure(error); }
}

const databaseFields = (value: TaskFields & { reminded?: boolean }) => ({
  ...value, dueAt: value.dueAt ? new Date(value.dueAt) : null, endAt: value.endAt ? new Date(value.endAt) : null,
});
const publicFields = (row: typeof tasks.$inferSelect): TaskFields => ({
  title: row.title, notes: row.notes, done: row.done, kind: row.kind as TaskFields["kind"],
  dueAt: row.dueAt?.toISOString() ?? null, endAt: row.endAt?.toISOString() ?? null,
});
function inputFailure(error: unknown): NextResponse {
  if (error instanceof TaskInputError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  throw error;
}

export async function PATCH(req: NextRequest) {
  const b = await readJsonObject(req);
  if (b instanceof Response) return b;
  try {
    const id = taskId(b.id);
    const row = await safeTransaction(async (tx) => {
      // Lock the real row before comparing the complete client snapshot. The
      // comparison and update are one transaction, not a race-prone preflight.
      const [previous] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
      if (!previous) throw new TaskInputError("item not found", 404);
      const current = publicFields(previous);
      if (Object.hasOwn(b, "expected")) assertTaskExpected(b.expected, current);
      const value = taskWrite(b, current);
      const [updated] = await tx.update(tasks).set(databaseFields(value)).where(eq(tasks.id, id)).returning();
      return updated;
    });
    return NextResponse.json({ ok: true, row });
  } catch (error) { return inputFailure(error); }
}

export async function DELETE(req: NextRequest) {
  try {
    const raw = req.nextUrl.searchParams.get("id");
    const id = taskId(raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined);
    const text = await req.text();
    let body: Record<string, unknown> | undefined;
    if (text.trim()) {
      let value: unknown;
      try { value = JSON.parse(text); } catch { throw new TaskInputError("malformed JSON body"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskInputError("expected a JSON object");
      body = value as Record<string, unknown>;
    }
    await safeTransaction(async (tx) => {
      const [previous] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
      if (!previous) throw new TaskInputError("item not found", 404);
      if (body && Object.hasOwn(body, "expected")) assertTaskExpected(body.expected, publicFields(previous));
      await tx.delete(tasks).where(eq(tasks.id, id));
    });
    return NextResponse.json({ ok: true });
  } catch (error) { return inputFailure(error); }
}
