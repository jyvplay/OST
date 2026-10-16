import { NextResponse, type NextRequest } from "next/server";
import { eq, like } from "drizzle-orm";
import { db } from "@/db";
import { desktopState } from "@/db/schema";
import { escapeLike } from "@/lib/server/vfs";

export const dynamic = "force-dynamic";

/**
 * Optimistic concurrency: a stale tab (older revision) cannot clobber a newer
 * desktop state. It gets 409 + the current state and reconciles locally.
 */
export async function GET(req: NextRequest) {
  const prefix = req.nextUrl.searchParams.get("list");
  if (prefix) {
    // AU-02 presets / PR-07r sessions are desktop_state rows under a prefix
    const rows = await db.select({ id: desktopState.id, updatedAt: desktopState.updatedAt, state: desktopState.state })
      .from(desktopState).where(like(desktopState.id, `${escapeLike(prefix)}:%`));
    return NextResponse.json({
      ok: true,
      rows: rows.map((r) => ({
        id: r.id, name: r.id.slice(prefix.length + 1), updatedAt: r.updatedAt,
        windows: ((r.state as { windows?: unknown[] }).windows ?? []).length,
      })),
    });
  }
  const id = req.nextUrl.searchParams.get("id") ?? "default";
  const rows = await db.select().from(desktopState).where(eq(desktopState.id, id)).limit(1);
  return NextResponse.json({ ok: true, row: rows[0] ?? null });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { id?: string; state?: unknown; revision?: number };
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
      .set({ state: body.state as object, revision, updatedAt: new Date() })
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
