import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { indexDocs, notes } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import { readJsonObject } from "@/lib/http-json";

export const dynamic = "force-dynamic";

async function reindex(id: number, title: string, body: string) {
  await db.insert(indexDocs).values({ source: "note", ref: String(id), title, body })
    .onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title, body, updatedAt: new Date() } });
}

export async function GET() {
  await bootstrap();
  const rows = await db.select().from(notes).orderBy(desc(notes.pinned), desc(notes.updatedAt));
  return NextResponse.json({ ok: true, rows });
}

export async function POST(req: NextRequest) {
  const b = (await readJsonObject(req)) as ({ title?: string; body?: string; tags?: string }) | Response;
  if (b instanceof Response) return b;
  const [row] = await db.insert(notes).values({
    title: b.title ?? "Untitled", body: b.body ?? "", tags: b.tags ?? "",
  }).returning();
  await reindex(row.id, row.title, row.body);
  return NextResponse.json({ ok: true, row });
}

export async function PUT(req: NextRequest) {
  const b = (await readJsonObject(req)) as ({ id?: number; title?: string; body?: string; tags?: string; pinned?: boolean }) | Response;
  if (b instanceof Response) return b;
  if (!b.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  const [row] = await db.update(notes).set({
    ...(b.title !== undefined ? { title: b.title } : {}),
    ...(b.body !== undefined ? { body: b.body } : {}),
    ...(b.tags !== undefined ? { tags: b.tags } : {}),
    ...(b.pinned !== undefined ? { pinned: b.pinned } : {}),
    updatedAt: new Date(),
  }).where(eq(notes.id, b.id)).returning();
  if (row) await reindex(row.id, row.title, row.body);
  return NextResponse.json({ ok: true, row });
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  await db.delete(notes).where(eq(notes.id, id));
  // FIX: scope to source=note; a bare ref match could drop unrelated index rows
  await db.delete(indexDocs).where(and(eq(indexDocs.source, "note"), eq(indexDocs.ref, String(id))));
  return NextResponse.json({ ok: true });
}
