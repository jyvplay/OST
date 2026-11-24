import { NextResponse, type NextRequest } from "next/server";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { desktopState } from "@/db/schema";
import { escapeLike } from "@/lib/server/vfs";
import { readJsonObject } from "@/lib/http-json";

export const dynamic = "force-dynamic";

/**
 * Optimistic concurrency: a stale tab (older revision) cannot clobber a newer
 * desktop state. It gets 409 + the current state and reconciles locally.
 */
export async function GET(req: NextRequest) {
  const prefix = req.nextUrl.searchParams.get("list");
  if (prefix) {
    // AU-02 presets / PR-07r sessions are desktop_state rows under a prefix
    const rows = await db.select({ id: desktopState.id, updatedAt: desktopState.updatedAt, state: desktopState.state, generation: desktopState.generation })
      .from(desktopState).where(like(desktopState.id, `${escapeLike(prefix)}:%`));
    return NextResponse.json({
      ok: true,
      rows: rows.map((r) => ({
        id: r.id, name: r.id.slice(prefix.length + 1), updatedAt: r.updatedAt, generation: r.generation,
        windows: ((r.state as { windows?: unknown[] }).windows ?? []).length,
      })),
    });
  }
  const id = req.nextUrl.searchParams.get("id") ?? "default";
  const rows = await db.select().from(desktopState).where(eq(desktopState.id, id)).limit(1);
  return NextResponse.json({ ok: true, row: rows[0] ?? null });
}

// Create-only: the unique key arbitrates concurrent requests without overwriting
// an existing layout. This intentionally does not change desktop PUT semantics.
export async function POST(req: NextRequest) {
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  // Distinct operation: older servers reject it rather than silently ignoring
  // a precondition and deleting a later incarnation of the same name.
  if (body.op === "deletePresetGuarded") {
    if (typeof body.id !== "string" || !body.id.startsWith("preset:") || body.id.length <= 7 || typeof body.generation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.generation)) {
      return NextResponse.json({ ok: false, error: "Invalid preset guard" }, { status: 400 });
    }
    // Fail closed when the deployment lacks the database-side legacy-writer
    // guard. Check within the DELETE statement, not in a separate preflight.
    const guardReady = sql`current_setting('session_replication_role') IN ('origin', 'local') AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.desktop_state'::regclass
        AND t.tgname = 'ost_desktop_generation_guard'
        AND NOT t.tgisinternal AND t.tgtype = 23 AND t.tgenabled IN ('O', 'A')
        AND t.tgfoid = to_regprocedure('public.ost_preset_generation_guard_fn()')
    )`;
    const removed = await db.delete(desktopState).where(and(eq(desktopState.id, body.id), eq(desktopState.generation, body.generation), guardReady)).returning({ id: desktopState.id });
    if (!removed.length) return NextResponse.json({ ok: false, error: "Preset changed or is absent" }, { status: 409 });
    return NextResponse.json({ ok: true, deleted: true });
  }
  if (body.op !== "createPreset" || typeof body.name !== "string" || !body.name.trim() || body.name.length > 200 || !body.state || typeof body.state !== "object" || Array.isArray(body.state)) {
    return NextResponse.json({ ok: false, error: "Invalid preset" }, { status: 400 });
  }
  const inserted = await db.insert(desktopState).values({ id: `preset:${body.name}`, state: body.state as object, revision: 1 })
    .onConflictDoNothing({ target: desktopState.id }).returning({ id: desktopState.id });
  if (!inserted.length) return NextResponse.json({ ok: false, error: "Preset name already exists" }, { status: 409 });
  return NextResponse.json({ ok: true, revision: 1 });
}

export async function PUT(req: NextRequest) {
  const body = (await readJsonObject(req)) as ({ id?: string; state?: unknown; revision?: number }) | Response;
  if (body instanceof Response) return body;
  const id = body.id ?? "default";
  const revision = Number(body.revision ?? 1);
  // desktop_state.revision is int4: reject instead of letting Postgres throw a 500 that logs the whole state
  if (!Number.isInteger(revision) || revision < 0 || revision > 2_147_483_647) {
    return NextResponse.json({ ok: false, error: "revision must be an integer in 0…2147483647" }, { status: 400 });
  }
  const rows = await db.select().from(desktopState).where(eq(desktopState.id, id)).limit(1);
  const current = rows[0];
  if (current && current.revision > revision) {
    return NextResponse.json({ ok: false, conflict: true, row: current }, { status: 409 });
  }
  if (current) {
    await db.update(desktopState)
      .set({ state: body.state as object, revision, updatedAt: new Date(), generation: sql`gen_random_uuid()` })
      .where(eq(desktopState.id, id));
  } else {
    await db.insert(desktopState).values({ id, state: body.state as object, revision });
  }
  return NextResponse.json({ ok: true, revision });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id.includes(":")) return NextResponse.json({ ok: false, error: "only preset:/session: rows can be deleted" }, { status: 400 });
  await db.delete(desktopState).where(eq(desktopState.id, id));
  return NextResponse.json({ ok: true });
}
