import { NextResponse, type NextRequest } from "next/server";
import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { togetherEvents, togetherRooms } from "@/db/schema";
import { readJsonObject } from "@/lib/http-json";

export const dynamic = "force-dynamic";

/**
 * Together (synchronised playback) — anchor clock model.
 *
 * The room stores (positionMs, anchorMs, playing). Any client can compute the
 * authoritative position as: position = positionMs + (serverNow - anchorMs) when
 * playing. Clients estimate their own clock offset from the t0/t1 round trip and
 * correct drift with playbackRate nudges, never with seeks — seeking is what
 * makes naive watch-parties judder.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const code = p.get("room")?.toUpperCase() ?? null; // FIX: POST uppercases; GET must match
  const since = Number(p.get("since") ?? 0);
  const t0 = Number(p.get("t0") ?? 0);
  const serverNow = Date.now();
  if (!code) return NextResponse.json({ ok: true, serverNow, t0 });

  const rooms = await db.select().from(togetherRooms).where(eq(togetherRooms.code, code)).limit(1);
  const room = rooms[0] ?? null;
  const events = room
    ? await db.select().from(togetherEvents)
        .where(and(eq(togetherEvents.room, code), gt(togetherEvents.id, since)))
        .orderBy(asc(togetherEvents.id)).limit(100)
    : [];
  const authoritative = room
    ? room.playing ? room.positionMs + (serverNow - Number(room.anchorMs)) : room.positionMs
    : 0;
  return NextResponse.json({ ok: true, serverNow, t0, room, events, authoritativePositionMs: authoritative });
}

export async function POST(req: NextRequest) {
  const b = (await readJsonObject(req)) as ({
    room?: string; clientId?: string; kind?: string; payload?: Record<string, unknown>;
    positionMs?: number; playing?: boolean; mediaRef?: string; name?: string;
  }) | Response;
  if (b instanceof Response) return b;
  const code = (b.room ?? "").toUpperCase();
  if (!code) return NextResponse.json({ ok: false, error: "room required" }, { status: 400 });
  const now = Date.now();

  const rows = await db.select().from(togetherRooms).where(eq(togetherRooms.code, code)).limit(1);
  let room = rows[0];
  if (!room) {
    const [created] = await db.insert(togetherRooms).values({
      code, name: b.name ?? `Room ${code}`, mediaRef: b.mediaRef ?? "",
      leaderClient: b.clientId ?? "", anchorMs: now,
    }).returning();
    room = created;
  }

  const kind = b.kind ?? "heartbeat";
  if (["play", "pause", "seek", "setMedia"].includes(kind)) {
    await db.update(togetherRooms).set({
      positionMs: Math.max(0, Math.round(b.positionMs ?? room.positionMs)),
      playing: kind === "pause" ? false : kind === "play" ? true : room.playing,
      anchorMs: now,
      ...(b.mediaRef !== undefined ? { mediaRef: b.mediaRef } : {}),
      leaderClient: b.clientId ?? room.leaderClient,
    }).where(eq(togetherRooms.code, code));
  }

  await db.insert(togetherEvents).values({
    room: code, clientId: b.clientId ?? "anon", kind, payload: (b.payload ?? {}) as object, serverTs: now,
  });

  const fresh = (await db.select().from(togetherRooms).where(eq(togetherRooms.code, code)).limit(1))[0];
  return NextResponse.json({ ok: true, serverNow: Date.now(), room: fresh });
}
