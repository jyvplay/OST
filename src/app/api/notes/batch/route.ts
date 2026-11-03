import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { indexDocs, notes } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import { safeTransaction } from "@/lib/server/transaction";
import { boundedJsonObject } from "@/lib/server/bounded-json";
import { noteBatch, NOTE_COLLECTION_BYTES } from "@/lib/note-workflows";
import { searchIndexText } from "@/lib/search-index-text";

export const dynamic = "force-dynamic";
/** Copy-only import/split: no supplied identity can overwrite a saved note.
 * All validation precedes SQL; notes and all index rows commit together. */
export async function POST(request: NextRequest) {
  const body = await boundedJsonObject(request, NOTE_COLLECTION_BYTES + 4096); if (body instanceof Response) return body;
  let fields: ReturnType<typeof noteBatch>;
  try {
    if (Object.keys(body).some(key => key !== "notes")) throw new Error("Unsupported batch field");
    fields = noteBatch(body.notes);
  } catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Invalid note batch" }, { status: 400 }); }
  try {
    await bootstrap();
    const rows = await safeTransaction(async transaction => {
      await transaction.execute(sql`set local lock_timeout = '4s'`);
      await transaction.execute(sql`set local statement_timeout = '15s'`);
      const created = await transaction.insert(notes).values(fields).returning();
      await transaction.insert(indexDocs).values(created.map(row => ({ source: "note", ref: String(row.id), title: row.title, body: searchIndexText(row.body) })));
      return created;
    });
    return NextResponse.json({ ok: true, rows });
  } catch {
    return NextResponse.json({ ok: false, error: "Note batch could not be confirmed. Refresh the library before retrying; no partial batch is committed." }, { status: 503 });
  }
}
