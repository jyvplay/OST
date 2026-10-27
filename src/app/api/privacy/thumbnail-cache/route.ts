import { and, eq, like } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { auditLog, indexDocs, vfsNodes, vfsVersions } from "@/db/schema";
import { bootstrap } from "@/lib/server/bootstrap";
import { safeTransaction } from "@/lib/server/transaction";
import { lockThumbnailCache } from "@/lib/server/thumbnail-cache-lock";

export const dynamic = "force-dynamic";
const PREFIX = "/System/Cache/thumbs/%";

/** Explicit, narrowly scoped cleanup of the old thumbnail cache, including orphaned versions.
 * This removes rows, not database backups, WAL, replicas or securely erased media. */
export async function POST(req: NextRequest) {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return NextResponse.json({ ok: false, error: "Expected JSON confirmation." }, { status: 400 });
  const origin = req.headers.get("origin");
  if (origin) {
    const hosts = [req.headers.get("host"), ...(req.headers.get("x-forwarded-host") ?? "").split(",")].map((host) => (host ?? "").trim()).filter(Boolean);
    try { if (!hosts.includes(new URL(origin).host)) throw new Error("origin"); }
    catch { return NextResponse.json({ ok: false, error: "Origin host does not match this server." }, { status: 403 }); }
  }
  if (Number(req.headers.get("content-length") ?? 0) > 1024) return NextResponse.json({ ok: false, error: "Confirmation too large." }, { status: 413 });
  let body: unknown;
  try {
    if (!req.body) throw new Error("missing body");
    const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024) { await reader.cancel().catch(() => {}); return NextResponse.json({ ok: false, error: "Confirmation too large." }, { status: 413 }); }
      chunks.push(next.value);
    }
    const joined = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
  } catch { return NextResponse.json({ ok: false, error: "Expected JSON confirmation." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || (body as { confirm?: unknown }).confirm !== "CLEAR THUMBNAIL CACHE") {
    return NextResponse.json({ ok: false, error: "Explicit thumbnail-cache confirmation required." }, { status: 400 });
  }
  try {
    await bootstrap();
    const counts = await safeTransaction(async (tx) => {
      await lockThumbnailCache(tx);
      const versions = await tx.delete(vfsVersions).where(like(vfsVersions.path, PREFIX));
      const nodes = await tx.delete(vfsNodes).where(like(vfsNodes.path, PREFIX));
      const index = await tx.delete(indexDocs).where(and(eq(indexDocs.source, "file"), like(indexDocs.ref, PREFIX)));
      const counts = { nodes: nodes.rowCount ?? 0, versions: versions.rowCount ?? 0, index: index.rowCount ?? 0 };
      await tx.insert(auditLog).values({ actor: "user", action: "privacy.clearThumbnailCache", detail: `nodes=${counts.nodes} versions=${counts.versions} index=${counts.index}` });
      return counts;
    });
    return NextResponse.json({ ok: true, ...counts });
  } catch {
    // A lost COMMIT acknowledgement means the outcome is unknown, not necessarily rolled back.
    return NextResponse.json({ ok: false, error: "Could not confirm cache cleanup; inspect the cache and try again." }, { status: 500 });
  }
}
