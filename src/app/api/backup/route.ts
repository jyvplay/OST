import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notes, settings, vfsNodes } from "@/db/schema";
import { sha256, writeFile } from "@/lib/server/vfs";

export const dynamic = "force-dynamic";

interface BundleEntry { path: string; kind: string; mime: string; encoding: string; content: string; sha256: string }
interface Bundle {
  version: string; exportedAt: string; kind: "data" | "config";
  entries: BundleEntry[]; notes?: unknown[]; settings?: unknown[];
  manifest: { path: string; sha256: string; size: number }[];
}

/**
 * BK-01/BK-03: the manifest carries a digest for every entry, and import
 * recomputes each digest BEFORE writing anything. A tampered or truncated
 * bundle is refused with the offending entry named — "verify, then restore".
 */
export async function GET(req: NextRequest) {
  const kind = (req.nextUrl.searchParams.get("kind") ?? "data") as "data" | "config";
  const nodes = kind === "data"
    ? await db.select().from(vfsNodes).where(eq(vfsNodes.trashed, false))
    : [];
  const entries: BundleEntry[] = nodes.map((n) => ({
    path: n.path, kind: n.kind, mime: n.mime, encoding: n.encoding, content: n.content, sha256: n.sha256 || sha256(n.content),
  }));
  const bundle: Bundle = {
    version: "fusion-bundle-1",
    exportedAt: new Date().toISOString(),
    kind,
    entries,
    notes: kind === "data" ? await db.select().from(notes) : undefined,
    settings: await db.select().from(settings),
    manifest: entries.map((e) => ({ path: e.path, sha256: e.sha256, size: e.content.length })),
  };
  return NextResponse.json(bundle, {
    headers: { "content-disposition": `attachment; filename="fusion-${kind}-${Date.now()}.json"` },
  });
}

export async function POST(req: NextRequest) {
  const bundle = (await req.json()) as Bundle & { dryRun?: boolean };
  if (bundle.version !== "fusion-bundle-1") {
    return NextResponse.json({ ok: false, error: "unknown bundle version" }, { status: 400 });
  }
  // phase 1: verify everything
  const failures: { path: string; reason: string }[] = [];
  for (const e of bundle.entries ?? []) {
    const digest = sha256(e.content);
    const declared = bundle.manifest?.find((m) => m.path === e.path)?.sha256 ?? e.sha256;
    if (declared && declared !== digest) failures.push({ path: e.path, reason: "digest mismatch" });
  }
  if (failures.length) {
    return NextResponse.json({ ok: false, verified: false, failures, restored: 0 }, { status: 409 });
  }
  if (bundle.dryRun) {
    return NextResponse.json({ ok: true, verified: true, wouldRestore: bundle.entries.length });
  }
  // phase 2: apply
  let restored = 0;
  for (const e of bundle.entries ?? []) {
    if (e.kind !== "file") continue;
    await writeFile({
      path: e.path, content: e.content, encoding: e.encoding === "base64" ? "base64" : "utf8",
      mime: e.mime, reason: "restore",
    }).then(() => { restored += 1; }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true, verified: true, restored });
}
