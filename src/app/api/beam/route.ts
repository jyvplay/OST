import { NextResponse, type NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { beamSessions, castTargets } from "@/db/schema";
import { readJsonObject } from "@/lib/http-json";

export const dynamic = "force-dynamic";

/**
 * Beam's target list is NOT discovered on the server: a browser cannot do mDNS
 * or SSDP, and neither can this Node process reach the user's LAN meaningfully.
 * Targets are reported by the client from real platform probes (Remote Playback
 * availability, Presentation availability, screen details, PiP support) and
 * persisted here only for trust memory (CA-14) and session history.
 */
export async function GET() {
  const targets = await db.select().from(castTargets).orderBy(desc(castTargets.lastSeen));
  const sessions = await db.select().from(beamSessions).orderBy(desc(beamSessions.id)).limit(25);
  return NextResponse.json({ ok: true, targets, sessions });
}

export async function POST(req: NextRequest) {
  const b = (await readJsonObject(req)) as ({
    action?: string; name?: string; kind?: string; host?: string; capability?: unknown;
    transport?: string; source?: string; sessionId?: number; stats?: unknown; trusted?: boolean;
  }) | Response;
  if (b instanceof Response) return b;
  if (b.action === "seen" && b.name && b.kind) {
    const existing = await db.select().from(castTargets).where(eq(castTargets.name, b.name)).limit(1);
    if (existing[0]) {
      await db.update(castTargets).set({
        kind: b.kind, host: b.host ?? "", capability: (b.capability ?? {}) as object, lastSeen: new Date(),
      }).where(eq(castTargets.id, existing[0].id));
      return NextResponse.json({ ok: true, id: existing[0].id, firstSeen: false, trusted: existing[0].trusted });
    }
    const [row] = await db.insert(castTargets).values({
      name: b.name, kind: b.kind, host: b.host ?? "", capability: (b.capability ?? {}) as object,
    }).returning({ id: castTargets.id });
    return NextResponse.json({ ok: true, id: row.id, firstSeen: true, trusted: false });
  }
  if (b.action === "trust" && b.name) {
    await db.update(castTargets).set({ trusted: Boolean(b.trusted) }).where(eq(castTargets.name, b.name));
    return NextResponse.json({ ok: true });
  }
  if (b.action === "start") {
    const [row] = await db.insert(beamSessions).values({
      targetName: b.name ?? "unknown", transport: b.transport ?? "unknown", source: b.source ?? "unknown",
      state: "active", stats: (b.stats ?? {}) as object,
    }).returning({ id: beamSessions.id });
    return NextResponse.json({ ok: true, sessionId: row.id });
  }
  if (b.action === "stop" && b.sessionId) {
    await db.update(beamSessions).set({
      state: "stopped", stoppedAt: new Date(), stats: (b.stats ?? {}) as object,
    }).where(eq(beamSessions.id, b.sessionId));
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
}
