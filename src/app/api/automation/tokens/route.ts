import { NextResponse, type NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/db";
import { auditLog, automationTokens } from "@/db/schema";
import { readJsonObject } from "@/lib/http-json";
import { mintToken, parseScopes, SCOPES } from "@/lib/automation/tokens";

export const dynamic = "force-dynamic";

/**
 * Token management for the local UI.
 *
 * The secret is returned exactly once, in the POST response, and never stored:
 * the row keeps only its SHA-256. A user who loses the token mints another and
 * revokes this one — there is deliberately no "show it again", because the only
 * way to be able to show it again is to keep it.
 */
export async function GET() {
  const rows = await db.select().from(automationTokens).orderBy(asc(automationTokens.createdAt));
  return NextResponse.json({
    ok: true,
    scopes: SCOPES,
    rows: rows.map((r) => ({
      id: r.id, name: r.name, scopes: parseScopes(r.scopes),
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
      revoked: Boolean(r.revokedAt),
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await readJsonObject(req)) as Record<string, unknown> | Response;
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const scopes = parseScopes(body.scopes);
  if (!scopes.length) return NextResponse.json({ ok: false, error: "pick at least one scope: run, read" }, { status: 400 });
  const minted = mintToken((n) => new Uint8Array(randomBytes(n)));
  const [row] = await db.insert(automationTokens).values({
    id: minted.id,
    name: name || "Automation token",
    secretHash: createHash("sha256").update(minted.secret, "utf8").digest("hex"),
    scopes,
  }).returning();
  await db.insert(auditLog).values({ actor: "user", action: "automation.token.created", detail: `${row.id} (${scopes.join(",")})` });
  return NextResponse.json({
    ok: true,
    // The only time this value exists outside the caller's clipboard.
    token: minted.token,
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    example: `curl -s -X POST "$SITE/api/automation" -H "authorization: Bearer ${minted.token}" -H "content-type: application/json" -d '{"commands":"open files; tile left"}'`,
  }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[0-9a-z]{8}$/.test(id)) return NextResponse.json({ ok: false, error: "id must be an 8-character token id" }, { status: 400 });
  const rows = await db.select().from(automationTokens).where(eq(automationTokens.id, id)).limit(1);
  if (!rows[0]) return NextResponse.json({ ok: false, error: "no such token" }, { status: 404 });
  if (rows[0].revokedAt) {
    // Idempotent: revoking twice is the same request, not an error, and the
    // second call must not move the timestamp (that would rewrite history).
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }
  // Revocation is permanent and keeps the row, so the audit trail still resolves the id.
  await db.update(automationTokens).set({ revokedAt: new Date(), secretHash: "" }).where(eq(automationTokens.id, id));
  await db.insert(auditLog).values({ actor: "user", action: "automation.token.revoked", detail: id });
  return NextResponse.json({ ok: true });
}
