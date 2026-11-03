import { searchIndexText } from "@/lib/search-index-text";
import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { indexDocs, notes } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import { readJsonObject } from "@/lib/http-json";
import { safeTransaction } from "@/lib/server/transaction";
import { assertNoteRevision, noteInteger, noteWrite, NoteInputError } from "@/lib/note-model";

export const dynamic = "force-dynamic";
type Tx = Parameters<Parameters<typeof safeTransaction>[0]>[0];
async function reindex(tx: Tx, id: number, title: string, body: string) {
  await tx.insert(indexDocs).values({ source: "note", ref: String(id), title, body: searchIndexText(body) })
    .onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title, body: searchIndexText(body), updatedAt: new Date() } });
}
function failure(error: unknown) {
  if (error instanceof NoteInputError) return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
  // Do not return query text, note bodies or database internals to the browser.
  console.error("Note transaction failed", error instanceof Error ? error.name : "unknown error");
  return NextResponse.json({ ok: false, error: "Note storage is unavailable. Your draft has not been saved; retry." }, { status: 503 });
}
export async function GET(req: NextRequest) {
  try {
    await bootstrap();
    if (req.nextUrl.searchParams.has("id")) {
      const id = noteInteger(Number(req.nextUrl.searchParams.get("id")));
      const [row] = await db.select().from(notes).where(eq(notes.id, id));
      if (!row) throw new NoteInputError("note not found", 404);
      return NextResponse.json({ ok: true, row });
    }
    const rows = await db.select().from(notes).orderBy(desc(notes.pinned), desc(notes.updatedAt), desc(notes.id));
    return NextResponse.json({ ok: true, rows });
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  const b = await readJsonObject(req); if (b instanceof Response) return b;
  try {
    const fields = noteWrite(b);
    await bootstrap();
    const row = await safeTransaction(async tx => {
      const [created] = await tx.insert(notes).values(fields).returning();
      await reindex(tx, created.id, created.title, created.body); return created;
    });
    return NextResponse.json({ ok: true, row });
  } catch (error) { return failure(error); }
}
export async function PUT(req: NextRequest) {
  const b = await readJsonObject(req); if (b instanceof Response) return b;
  try {
    const id = noteInteger(b.id);
    const row = await safeTransaction(async tx => {
      const [previous] = await tx.select().from(notes).where(eq(notes.id, id)).for("update");
      if (!previous) throw new NoteInputError("note not found", 404);
      // Legacy clients may omit the precondition; the Notes UI always sends it.
      if (Object.hasOwn(b, "expectedRevision")) assertNoteRevision(b.expectedRevision, previous.revision);
      if (previous.revision === 2_147_483_647) throw new NoteInputError("This note's revision counter is exhausted; duplicate it before editing.", 409);
      const fields = noteWrite(b, previous);
      const [updated] = await tx.update(notes).set({ ...fields, revision: previous.revision + 1, updatedAt: new Date() }).where(eq(notes.id, id)).returning();
      await reindex(tx, id, updated.title, updated.body); return updated;
    });
    return NextResponse.json({ ok: true, row });
  } catch (error) { return failure(error); }
}
export async function DELETE(req: NextRequest) {
  try {
    const id = noteInteger(Number(req.nextUrl.searchParams.get("id")));
    const text = await req.text(); let body: Record<string, unknown> = {};
    if (text.trim()) {
      let value: unknown; try { value = JSON.parse(text); } catch { throw new NoteInputError("malformed JSON body"); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new NoteInputError("expected a JSON object");
      body = value as Record<string, unknown>;
    }
    await safeTransaction(async tx => {
      const [previous] = await tx.select().from(notes).where(eq(notes.id, id)).for("update");
      if (!previous) throw new NoteInputError("note not found", 404);
      if (Object.hasOwn(body, "expectedRevision")) assertNoteRevision(body.expectedRevision, previous.revision);
      await tx.delete(notes).where(eq(notes.id, id));
      await tx.delete(indexDocs).where(and(eq(indexDocs.source, "note"), eq(indexDocs.ref, String(id))));
    });
    return NextResponse.json({ ok: true });
  } catch (error) { return failure(error); }
}
