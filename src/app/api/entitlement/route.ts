import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { entitlements, licenseAuthority } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import { readJsonObject } from "@/lib/http-json";

export const dynamic = "force-dynamic";

interface Claim { clientId: string; kind: "pro" | "propack"; iat: number; exp: number | null; issuer: string }

const b64u = (b: Buffer) => b.toString("base64url");

async function authority() {
  await bootstrap();
  const rows = await db.select().from(licenseAuthority).limit(1);
  if (!rows[0]) throw new Error("licence authority not initialised");
  return rows[0];
}

/** key format: base64url(claimJson).base64url(ed25519 signature) */
function makeKey(claim: Claim, privatePem: string) {
  const payload = Buffer.from(JSON.stringify(claim));
  const sig = edSign(null, payload, createPrivateKey(privatePem));
  return `${b64u(payload)}.${b64u(sig)}`;
}
function verifyKey(key: string, publicPem: string): Claim | null {
  const [p, s] = key.split(".");
  if (!p || !s) return null;
  const payload = Buffer.from(p, "base64url");
  const sig = Buffer.from(s, "base64url");
  if (!edVerify(null, payload, createPublicKey(publicPem), sig)) return null;
  try { return JSON.parse(payload.toString()) as Claim; } catch { return null; }
}

export async function GET(req: NextRequest) {
  const clientId = req.nextUrl.searchParams.get("clientId") ?? "anonymous";
  const auth = await authority();
  const rows = await db.select().from(entitlements).where(eq(entitlements.clientId, clientId)).orderBy(desc(entitlements.id));
  const now = Date.now();
  const active = rows.filter((r) => r.status === "active" && (!r.expiresAt || r.expiresAt.getTime() > now));
  return NextResponse.json({
    ok: true,
    publicKey: auth.publicKey,
    entitlements: rows,
    tier: active.some((r) => r.kind === "propack") ? "propack"
      : active.some((r) => r.kind === "pro") ? "pro"
      : active.some((r) => r.kind === "trial") ? "trial" : "none",
    gracePeriodDays: 14,
    note: "Verification is offline-capable: cache the public key and the signed claim; the app never loses features because the network did (BL-02).",
  });
}

export async function POST(req: NextRequest) {
  const body = (await readJsonObject(req)) as ({ action?: string; clientId?: string; kind?: "pro" | "propack"; key?: string }) | Response;
  if (body instanceof Response) return body;
  const clientId = body.clientId ?? "anonymous";
  const auth = await authority();

  if (body.action === "trial") {
    const existing = await db.select().from(entitlements).where(eq(entitlements.clientId, clientId));
    if (existing.some((e) => e.kind === "trial")) {
      return NextResponse.json({ ok: false, error: "trial already used on this client" }, { status: 409 });
    }
    const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000);
    await db.insert(entitlements).values({ clientId, kind: "trial", expiresAt: expires, status: "active" });
    return NextResponse.json({ ok: true, kind: "trial", expiresAt: expires });
  }

  if (body.action === "issue") {
    // self-hosted authority: this is the "store" side, kept in-tree so the
    // whole licensing path is verifiable end to end rather than mocked.
    const claim: Claim = {
      clientId, kind: body.kind ?? "pro", iat: Date.now(), exp: null, issuer: "fusion-local-authority",
    };
    return NextResponse.json({ ok: true, licenseKey: makeKey(claim, auth.privateKey), claim });
  }

  if (body.action === "activate") {
    if (!body.key) return NextResponse.json({ ok: false, error: "key required" }, { status: 400 });
    const claim = verifyKey(body.key.trim(), auth.publicKey);
    if (!claim) return NextResponse.json({ ok: false, error: "signature verification failed" }, { status: 400 });
    if (claim.clientId !== clientId && claim.clientId !== "*") {
      return NextResponse.json({ ok: false, error: "key is bound to another client id" }, { status: 400 });
    }
    await db.insert(entitlements).values({
      clientId, kind: claim.kind, licenseKey: body.key.trim(), status: "active",
      expiresAt: claim.exp ? new Date(claim.exp) : null,
    });
    return NextResponse.json({ ok: true, kind: claim.kind, claim });
  }

  if (body.action === "verify") {
    const claim = body.key ? verifyKey(body.key.trim(), auth.publicKey) : null;
    return NextResponse.json({ ok: true, valid: Boolean(claim), claim });
  }

  return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
}
