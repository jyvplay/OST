import { NextResponse, type NextRequest } from "next/server";
import { fusionCaller, readFrames, sessions } from "@/lib/server/ssh/bridge";

/**
 * TT44 (TD-03) one SSH session.
 *   GET    → the frame stream (application/octet-stream; see bridge.ts). Re-attaching replaces the old stream.
 *   POST   → frames from the browser: 1 = control JSON, 2 = terminal input (≤ 1 MiB per request)
 *   DELETE → close
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const json = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { "cache-control": "no-store" } });
type Ctx = { params: Promise<{ id: string }> };

async function find(req: NextRequest, ctx: Ctx) {
  if (!fusionCaller(req)) return json({ error: "forbidden" }, 403);
  const { id } = await ctx.params;
  const s = /^[0-9a-f]{32}$/.test(id) ? sessions().get(id) : undefined;
  return s ?? json({ error: "no such session" }, 404);
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const s = await find(req, ctx);
  if (s instanceof Response) return s;
  return new Response(s.attach(), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-accel-buffering": "no", "x-content-type-options": "nosniff" } });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const s = await find(req, ctx);
  if (s instanceof Response) return s;
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > 1024 * 1024) return json({ error: "too much input in one request" }, 413);
  const errors: string[] = [];
  try {
    for (const f of readFrames(body)) {
      if (f.type === 2) s.input(f.payload);
      else if (f.type === 1) {
        let m: unknown;
        try { m = JSON.parse(f.payload.toString("utf8")); } catch { errors.push("bad control JSON"); continue; }
        if (!m || typeof m !== "object") { errors.push("bad control message"); continue; }
        const e = s.control(m as Record<string, unknown>);
        if (e) errors.push(e);
      } else errors.push(`unknown frame type ${f.type}`);
    }
  } catch (e) { return json({ error: (e as Error).message }, 400); }
  return json({ ok: errors.length === 0, errors, state: s.state });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const s = await find(req, ctx);
  if (s instanceof Response) return s;
  s.close("closed by the user");
  return json({ ok: true });
}
