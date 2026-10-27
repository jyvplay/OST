import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { safeTransaction } from "@/lib/server/transaction";
import { notes, settings, vfsNodes } from "@/db/schema";
import { BACKUP_VERSION, MAX_BACKUP_BYTES, contentSize, makeBackup, verifyBackup, type BackupPayload } from "@/lib/backup/bundle";
import { bootstrap } from "@/lib/server/bootstrap";
import { RestoreError, restoreBackup } from "@/lib/server/backup-restore";
import { drillBackup } from "@/lib/server/backup-drill";
import { sha256 } from "@/lib/server/vfs";

export const dynamic = "force-dynamic";

/** Config and data exports are separate, consistent snapshots. */
export async function GET(req: NextRequest) {
  await bootstrap();
  const kind = req.nextUrl.searchParams.get("kind") ?? "data";
  if (kind !== "data" && kind !== "config") return NextResponse.json({ ok: false, error: "kind must be data or config" }, { status: 400 });
  try {
    const payload = await safeTransaction(async (tx): Promise<BackupPayload> => {
      const entries: BackupPayload["entries"] = [];
      const exportedNotes: BackupPayload["notes"] = [];
      const exportedSettings: BackupPayload["settings"] = [];
      if (kind === "data") {
        const nodes = await tx.select().from(vfsNodes).where(eq(vfsNodes.trashed, false));
        nodes.sort((a, b) => a.path.localeCompare(b.path));
        for (const node of nodes) {
          if ((node.kind !== "file" && node.kind !== "dir") || (node.encoding !== "utf8" && node.encoding !== "base64")) throw new RestoreError(`Cannot export ${node.path}: unsupported stored kind or encoding.`);
          const digest = sha256(node.content);
          const size = contentSize(node.content, node.encoding);
          if (node.kind === "file" && (node.sha256 !== digest || node.size !== size)) throw new RestoreError(`Cannot export ${node.path}: stored file checksum or size is inconsistent.`);
          entries.push({ path: node.path, kind: node.kind, mime: node.mime, encoding: node.encoding, content: node.content, size,
            tags: node.tags, sha256: digest });
        }
        const rows = await tx.select().from(notes);
        rows.sort((a, b) => a.id - b.id);
        for (const note of rows) exportedNotes.push({ title: note.title, body: note.body, tags: note.tags, pinned: note.pinned,
          createdAt: note.createdAt.toISOString(), updatedAt: note.updatedAt.toISOString() });
      } else {
        const rows = await tx.select().from(settings);
        rows.sort((a, b) => a.key.localeCompare(b.key));
        // Installer/managed locks never travel as user-editable configuration.
        for (const setting of rows) if (!setting.lockReason) exportedSettings.push({ key: setting.key, value: setting.value });
      }
      return { version: BACKUP_VERSION, exportedAt: new Date().toISOString(), kind, entries, notes: exportedNotes, settings: exportedSettings };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_BACKUP_BYTES - 1024) return NextResponse.json({ ok: false, error: "Snapshot exceeds the 64 MiB backup limit. Export individual files from Files or reduce the snapshot size." }, { status: 413 });
    const bundle = await makeBackup(payload);
    const verified = await verifyBackup(bundle);
    if (!verified.ok) return NextResponse.json({ ok: false, error: "Snapshot cannot be safely exported", failures: verified.failures }, { status: 409 });
    return NextResponse.json(bundle, { headers: { "content-disposition": `attachment; filename="fusion-${kind}-${Date.now()}.json"` } });
  } catch (e) {
    if (e instanceof RestoreError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    // Drizzle errors can contain query parameters, including private file contents. Never log them.
    console.error("Backup snapshot failed", (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? "database error");
    return NextResponse.json({ ok: false, error: "Could not build a consistent backup snapshot." }, { status: 500 });
  }
}

async function readBackupRequest(req: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) return NextResponse.json({ ok: false, error: "Backup request exceeds 64 MiB" }, { status: 413 });
  let raw: string;
  try { raw = await req.text(); } catch { return NextResponse.json({ ok: false, error: "Could not read request" }, { status: 400 }); }
  if (Buffer.byteLength(raw, "utf8") > MAX_BACKUP_BYTES) return NextResponse.json({ ok: false, error: "Backup request exceeds 64 MiB" }, { status: 413 });
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch { return NextResponse.json({ ok: false, error: "Expected a JSON object" }, { status: 400 }); }
}

/** Dry-run returns a destination-bound token. Commit rechecks it before any write. */
export async function POST(req: NextRequest) {
  const body = await readBackupRequest(req);
  if (body instanceof Response) return body;
  if (body.drill !== undefined && typeof body.drill !== "boolean") return NextResponse.json({ ok: false, error: "drill must be a boolean" }, { status: 400 });
  const drill = body.drill === true;
  if (drill && (Object.hasOwn(body, "dryRun") || Object.hasOwn(body, "previewToken") || Object.hasOwn(body, "allowLegacy"))) {
    return NextResponse.json({ ok: false, error: "A scratch drill cannot be combined with restore controls." }, { status: 400 });
  }
  const verification = await verifyBackup(Object.hasOwn(body, "bundle") ? body.bundle : body);
  if (!verification.ok) return NextResponse.json({ ok: false, verified: false, failures: verification.failures, restored: 0 }, { status: 409 });
  const dryRun = body.dryRun === true;
  if (verification.legacy && !drill && !dryRun && body.allowLegacy !== true) return NextResponse.json({ ok: false, error: "Legacy backups need explicit confirmation: their settings, notes, names and metadata are not checksummed." }, { status: 409 });
  await bootstrap();
  try {
    if (drill) {
      const result = await drillBackup(verification.payload, verification.digest);
      return NextResponse.json({ ok: true, verified: true, legacy: verification.legacy, warnings: verification.warnings, drill: result });
    }
    const result = await restoreBackup(verification.payload, verification.digest, dryRun, typeof body.previewToken === "string" ? body.previewToken : undefined);
    const s = result.summary;
    return NextResponse.json({ ok: true, verified: true, legacy: verification.legacy, warnings: verification.warnings,
      ...result, wouldRestore: s.filesCreate + s.filesReplace + s.foldersCreate + s.foldersRevive + s.notesAdd + s.settingsChange,
      ...(dryRun ? {} : { restored: s.filesCreate + s.filesReplace + s.foldersCreate + s.foldersRevive + s.notesAdd + s.settingsChange }) });
  } catch (e) {
    if (e instanceof RestoreError) return NextResponse.json({ ok: false, error: e.message, restored: 0 }, { status: e.status });
    // PostgreSQL can abort a serializable transaction if a concurrent writer conflicts.
    const err = e as { code?: string; cause?: { code?: string } };
    if (err.code === "40001" || err.cause?.code === "40001") return NextResponse.json({ ok: false, error: "Concurrent change detected. Preview and restore again.", restored: 0 }, { status: 409 });
    // Do not log database query parameters, and do not assert rollback if the acknowledgement was lost.
    console.error(drill ? "Backup drill could not be confirmed" : "Backup restore could not be confirmed", err.cause?.code ?? err.code ?? "database error");
    if (drill) return NextResponse.json({ ok: false, error: "The scratch drill or its rollback could not be confirmed; no successful drill was recorded." }, { status: 500 });
    return NextResponse.json({ ok: false, error: "Restore could not be confirmed. Check the destination before retrying.", restored: null }, { status: 500 });
  }
}
