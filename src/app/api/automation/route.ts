import { NextResponse, type NextRequest } from "next/server";
import { asc, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { auditLog, automationRuns, automationTokens } from "@/db/schema";
import { readJsonObject } from "@/lib/http-json";
import {
  hasScope, MAX_QUEUE_DEPTH, parseScopes, parseToken, settle, takeToken, timingSafeEqualHex,
  validateRequest, vocabulary, type QueuedRun, type RateLimitState, type RunStatus, type Scope,
} from "@/lib/automation/tokens";

export const dynamic = "force-dynamic";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type TokenRow = typeof automationTokens.$inferSelect;
type RunRow = typeof automationRuns.$inferSelect;

const toRun = (r: RunRow): QueuedRun => ({
  id: r.id,
  tokenId: r.tokenId,
  actions: r.actions as QueuedRun["actions"],
  status: r.status as RunStatus,
  createdAt: r.createdAt.getTime(),
  finishedAt: r.finishedAt ? r.finishedAt.getTime() : null,
  result: r.result,
});

/** Bearer token from either header spelling. The token itself is never logged. */
function bearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  const alt = req.headers.get("x-fusion-token");
  return alt ? alt.trim() : null;
}

async function verify(req: NextRequest): Promise<
  | { ok: true; row: TokenRow; scopes: Scope[] }
  | { ok: false; status: number; error: string }
> {
  const raw = bearer(req);
  if (!raw) return { ok: false, status: 401, error: "missing bearer token" };
  const parsed = parseToken(raw);
  if (!parsed) return { ok: false, status: 401, error: "token is not well formed" };
  const rows = await db.select().from(automationTokens).where(eq(automationTokens.id, parsed.id)).limit(1);
  const row = rows[0];
  if (!row) return { ok: false, status: 401, error: "unknown token" };
  if (row.revokedAt) return { ok: false, status: 401, error: "token was revoked" };
  if (!timingSafeEqualHex(sha256(parsed.secret), row.secretHash)) return { ok: false, status: 401, error: "secret does not match" };
  return { ok: true, row, scopes: parseScopes(row.scopes) };
}

/**
 * GET has two callers:
 *   • an external script with a `read` token, asking what it may send;
 *   • the open shell (no token, same origin) asking what is queued.
 * The shell path changes nothing and is unreadable cross-origin (no CORS
 * header), so it needs no token; it is identified by `pending=1`.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("pending") === "1") {
    const rows = await db.select().from(automationRuns)
      .where(eq(automationRuns.status, "queued")).orderBy(asc(automationRuns.id)).limit(10);
    const queued = await db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.status, "queued"));
    return NextResponse.json({ ok: true, runs: rows.map(toRun), depth: queued.length });
  }
  const who = await verify(req);
  if (!who.ok) return NextResponse.json({ ok: false, error: who.error }, { status: who.status });
  if (!hasScope(who.scopes, "read")) {
    await db.insert(auditLog).values({ actor: `automation:${who.row.id}`, action: "automation.denied", detail: "read scope required" });
    return NextResponse.json({ ok: false, error: "this token has no read scope" }, { status: 403 });
  }
  const queued = await db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.status, "queued"));
  const recent = await db.select().from(automationRuns)
    .where(eq(automationRuns.tokenId, who.row.id)).orderBy(desc(automationRuns.id)).limit(5);
  return NextResponse.json({
    ok: true, vocabulary: vocabulary(), scopes: who.scopes, queueDepth: queued.length,
    recent: recent.map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt.toISOString(), result: r.result })),
  });
}

export async function POST(req: NextRequest) {
  // The body is validated before anything is looked up (the repo-wide rule: an
  // empty body is a 400, never a 401 or a 404).
  const body = (await readJsonObject(req)) as Record<string, unknown> | Response;
  if (body instanceof Response) return body;

  // ---- shell path: claim the queue / report an outcome. No token: this is the
  // UI telling the server what it actually did, and it cannot enqueue anything.
  if (typeof body.settleId === "number") {
    const id = body.settleId;
    if (!Number.isInteger(id) || id < 1) return NextResponse.json({ ok: false, error: "settleId must be a positive integer" }, { status: 400 });
    if (typeof body.ok !== "boolean") return NextResponse.json({ ok: false, error: "ok must be true or false" }, { status: 400 });
    const rows = await db.select().from(automationRuns).where(eq(automationRuns.id, id)).limit(1);
    const row = rows[0];
    if (!row) return NextResponse.json({ ok: false, error: "no such run" }, { status: 404 });
    const next = settle(toRun(row), body.ok, typeof body.result === "string" ? body.result : "", Date.now());
    if (next.status === row.status) return NextResponse.json({ ok: true, unchanged: true, run: toRun(row) });
    await db.update(automationRuns)
      .set({ status: next.status, result: next.result, finishedAt: new Date(next.finishedAt ?? Date.now()) })
      .where(eq(automationRuns.id, id));
    await db.insert(auditLog).values({ actor: "automation", action: `automation.${next.status}`, detail: `run ${id}: ${next.result.slice(0, 200)}` });
    return NextResponse.json({ ok: true, run: next });
  }

  // ---- external path
  const who = await verify(req);
  if (!who.ok) {
    await db.insert(auditLog).values({ actor: "automation", action: "automation.denied", detail: who.error });
    return NextResponse.json({ ok: false, error: who.error }, { status: who.status });
  }
  if (!hasScope(who.scopes, "run")) {
    await db.insert(auditLog).values({ actor: `automation:${who.row.id}`, action: "automation.denied", detail: "run scope required" });
    return NextResponse.json({ ok: false, error: "this token has no run scope" }, { status: 403 });
  }

  const parsed = validateRequest(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, errors: parsed.errors }, { status: 400 });

  const gate = takeToken((who.row.rateState as RateLimitState | null) ?? null, Date.now(), RATE_LIMIT, RATE_WINDOW_MS);
  if (!gate.allowed) {
    await db.update(automationTokens).set({ rateState: gate.state }).where(eq(automationTokens.id, who.row.id));
    await db.insert(auditLog).values({ actor: `automation:${who.row.id}`, action: "automation.throttled", detail: `retry in ${gate.retryAfterMs} ms` });
    return NextResponse.json({ ok: false, error: "rate limit exceeded" }, { status: 429, headers: { "retry-after": String(Math.ceil(gate.retryAfterMs / 1000)) } });
  }

  const queued = await db.select({ id: automationRuns.id }).from(automationRuns).where(eq(automationRuns.status, "queued"));
  if (queued.length >= MAX_QUEUE_DEPTH) {
    return NextResponse.json(
      { ok: false, error: `queue is full (${queued.length}/${MAX_QUEUE_DEPTH}); the open shell has not drained it` },
      { status: 503 },
    );
  }

  const [run] = await db.insert(automationRuns).values({ tokenId: who.row.id, actions: parsed.request.actions, status: "queued" }).returning();
  await db.update(automationTokens).set({ rateState: gate.state, lastUsedAt: new Date() }).where(eq(automationTokens.id, who.row.id));
  await db.insert(auditLog).values({
    actor: `automation:${who.row.id}`, action: "automation.enqueued",
    detail: `run ${run.id}: ${parsed.request.actions.map((a) => a.cmd).join(" ")}`,
  });
  return NextResponse.json({ ok: true, id: run.id, status: "queued", remaining: gate.remaining }, { status: 201 });
}
