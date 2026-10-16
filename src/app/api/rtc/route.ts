import { NextResponse, type NextRequest } from "next/server";
import { and, asc, eq, gt, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { rtcSignals } from "@/db/schema";

export const dynamic = "force-dynamic";

/**
 * CA-09 / CT-02 signalling. WebRTC needs *some* channel to exchange SDP and ICE;
 * the usual answer is a third-party broker or a WebSocket server. Here it is a
 * Postgres table polled by both peers: slower to connect (~1 s), but it adds no
 * service, no dependency and no data path — media never touches this server.
 * Rows older than 10 minutes are swept on every write.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const room = (p.get("room") ?? "").toUpperCase();
  const me = p.get("me") ?? "";
  const since = Number(p.get("since") ?? 0);
  if (!room || !me) return NextResponse.json({ ok: false, error: "room and me required" }, { status: 400 });
  const rows = await db.select().from(rtcSignals)
    .where(and(
      eq(rtcSignals.room, room), gt(rtcSignals.id, since),
      or(eq(rtcSignals.toClient, me), eq(rtcSignals.toClient, "*")),
    ))
    .orderBy(asc(rtcSignals.id)).limit(200);
  return NextResponse.json({ ok: true, rows: rows.filter((r) => r.fromClient !== me), cursor: rows.at(-1)?.id ?? since });
}

export async function POST(req: NextRequest) {
  const b = (await req.json()) as { room?: string; from?: string; to?: string; kind?: string; payload?: unknown };
  const room = (b.room ?? "").toUpperCase();
  if (!room || !b.from || !b.kind) return NextResponse.json({ ok: false, error: "room, from, kind required" }, { status: 400 });
  if (!["hello", "offer", "answer", "ice", "bye"].includes(b.kind)) {
    return NextResponse.json({ ok: false, error: "unknown signal kind" }, { status: 400 });
  }
  const size = JSON.stringify(b.payload ?? {}).length;
  if (size > 64_000) return NextResponse.json({ ok: false, error: "signal payload too large" }, { status: 413 });
  await db.delete(rtcSignals).where(lt(rtcSignals.createdAt, new Date(Date.now() - 10 * 60_000)));
  const [row] = await db.insert(rtcSignals).values({
    room, fromClient: b.from, toClient: b.to ?? "*", kind: b.kind, payload: (b.payload ?? {}) as object,
  }).returning({ id: rtcSignals.id });
  return NextResponse.json({ ok: true, id: row.id });
}
