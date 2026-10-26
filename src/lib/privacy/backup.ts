/**
 * TT20 — one-file encrypted backup / verify / restore of Persistent Storage.
 *
 * Tails pain point (tails.net "back up your Persistent Storage", Redmine #14605, r/tails threads): a backup needs a
 * SECOND Tails USB stick, an administration password and an rsync command; partial failures are reported in a
 * confusing way; restore was undocumented; users are told to "test your backup" with no tool to do so.
 *
 * Here a backup is ONE file the user downloads to any device:
 *   { format: "fusion-private-backup-1", header: <keyslot header, as stored>, manifest: base64(FEN1(JSON)) }
 * The manifest (tree, encrypted names, per-file ciphertext exactly as the host stores it) is itself sealed with the
 * volume content key, so the file reveals neither names, nor tree shape, nor exact sizes (Padmé). Nothing is
 * decrypted to build it: file contents stay in their FEN1 form end to end.
 * verify() opens every entry (AES-GCM tag + SIV name) without writing anything. restore() writes the header and
 * the raw ciphertext back to a host that has no volume (or merges missing entries into the SAME volume).
 * Declared limits: version history and trash are not included; everything is held in memory (cap 256 MiB);
 * host-cleartext "[clear] …" entries are skipped and listed (seal them with the host audit first).
 */
import {
  CLEAR_PREFIX, ENC_MIME, KEYSLOT_FILE, KEYSLOT_PATH, PRIVATE_ROOT, decryptContent, decryptPath, encryptContent, fromB64,
  parseHeader, toB64, unlockVolume, type KeyHeader, type VolumeKeys,
} from "./pcrypt";

export const BACKUP_FORMAT = "fusion-private-backup-1";
export const BACKUP_MAX_BYTES = 256 * 1024 * 1024;
type RawFetch = (url: string, init?: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
interface Entry { p: string; k: "file" | "dir"; c?: string; m?: string }
interface Manifest { format: typeof BACKUP_FORMAT; volumeId: string; created: string; entries: Entry[]; skipped: string[] }
export interface BackupFile { format: typeof BACKUP_FORMAT; header: KeyHeader; manifest: string }

const enc = new TextEncoder(); const dec = new TextDecoder();
async function hostGet(raw: RawFetch, op: string, path: string): Promise<{ status: number; body: Json }> {
  const r = await raw(`/api/fs?op=${op}&path=${encodeURIComponent(path)}`, { cache: "no-store" });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Json };
}
async function hostPost(raw: RawFetch, body: Json): Promise<Json> {
  const r = await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const b = (await r.json().catch(() => ({}))) as Json;
  if (!r.ok || b.ok === false) throw new Error(String(b.error ?? `host refused (${r.status})`));
  return b;
}
const volId = (k: VolumeKeys) => toB64(k.volumeId);

/** Build the backup from what the HOST stores (ciphertext only). */
export async function createBackup(raw: RawFetch, keys: VolumeKeys): Promise<{ file: BackupFile; text: string; files: number; dirs: number; bytes: number; skipped: string[] }> {
  const h = await hostGet(raw, "read", KEYSLOT_PATH);
  if (h.status !== 200 || !(h.body.node as Json | undefined)?.content) throw new Error("no keyslot header on the host");
  const header = parseHeader(String((h.body.node as Json).content));
  if (header.volumeId !== volId(keys)) throw new Error("the unlocked keys belong to a different volume than the host header");
  const entries: Entry[] = []; const skipped: string[] = []; let bytes = 0; let files = 0; let dirs = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 64) throw new Error("directory nesting deeper than 64");
    const l = await hostGet(raw, "list", dir);
    if (l.status >= 400) { if (dir === PRIVATE_ROOT) return; throw new Error(`list ${dir}: ${String(l.body.error ?? l.status)}`); }
    for (const n of (l.body.nodes as Json[]) ?? []) {
      const p = String(n.path); const name = String(n.name);
      if (dir === PRIVATE_ROOT && name === KEYSLOT_FILE) continue;
      if (name.startsWith(CLEAR_PREFIX)) { skipped.push(name.slice(CLEAR_PREFIX.length)); continue; }
      const rel = p.slice(PRIVATE_ROOT.length + 1);
      if (n.kind === "dir") { entries.push({ p: rel, k: "dir" }); dirs += 1; await walk(p, depth + 1); continue; }
      const r = await hostGet(raw, "read", p);
      const node = r.body.node as Json | undefined;
      if (r.status !== 200 || !node) throw new Error(`read failed for an entry (${r.status})`);
      const c = String(node.content ?? "");
      if (node.encoding !== "base64" || !c.startsWith("RkVOMQ")) { skipped.push(`(unsealed entry ${rel.length} chars)`); continue; }
      bytes += c.length; files += 1;
      if (bytes > BACKUP_MAX_BYTES) throw new Error("Persistent Storage is larger than the 256 MiB in-memory backup limit");
      entries.push({ p: rel, k: "file", c, m: String(node.mime ?? ENC_MIME) });
    }
  };
  await walk(PRIVATE_ROOT, 0);
  const manifest: Manifest = { format: BACKUP_FORMAT, volumeId: header.volumeId, created: new Date().toISOString().slice(0, 10), entries, skipped };
  const sealed = await encryptContent(keys, { data: enc.encode(JSON.stringify(manifest)), mime: "application/json", encoding: "utf8" });
  const file: BackupFile = { format: BACKUP_FORMAT, header, manifest: toB64(sealed) };
  return { file, text: JSON.stringify(file), files, dirs, bytes, skipped };
}

export function parseBackup(text: string): BackupFile {
  let j: Json;
  try { j = JSON.parse(text) as Json; } catch { throw new Error("not a Fusion Persistent Storage backup (not JSON)"); }
  if (j.format !== BACKUP_FORMAT || typeof j.manifest !== "string" || !j.header) throw new Error("not a Fusion Persistent Storage backup");
  return { format: BACKUP_FORMAT, header: parseHeader(JSON.stringify(j.header)), manifest: j.manifest };
}

async function openManifest(file: BackupFile, keys: VolumeKeys): Promise<Manifest> {
  if (file.header.volumeId !== volId(keys)) throw new Error("these keys do not belong to the volume in this backup");
  let plain;
  try { plain = await decryptContent(keys, fromB64(file.manifest)); } catch { throw new Error("backup manifest failed authentication (corrupted or tampered)"); }
  const m = JSON.parse(dec.decode(plain.data)) as Manifest;
  if (m.format !== BACKUP_FORMAT || m.volumeId !== file.header.volumeId || !Array.isArray(m.entries)) throw new Error("backup manifest is malformed");
  return m;
}

/** Keys from the passphrase / recovery key in the backup's OWN header (works on a host with no volume). */
export async function keysForBackup(file: BackupFile, secret: string): Promise<VolumeKeys> {
  return (await unlockVolume(file.header, secret)).keys;
}

/** "Test your backup": authenticate every name and every file without writing anything. */
export async function verifyBackup(file: BackupFile, keys: VolumeKeys) {
  const m = await openManifest(file, keys);
  const report = { files: 0, dirs: 0, plainBytes: 0, failures: [] as string[], skipped: m.skipped, created: m.created };
  for (const e of m.entries) {
    const { path, ok } = await decryptPath(keys, `${PRIVATE_ROOT}/${e.p}`);
    if (!ok) { report.failures.push(`name #${report.files + report.dirs + 1} does not decrypt`); continue; }
    if (e.k === "dir") { report.dirs += 1; continue; }
    try { const p = await decryptContent(keys, fromB64(e.c ?? "")); report.files += 1; report.plainBytes += p.data.length; }
    catch { report.failures.push(`${path}: content failed authentication`); }
  }
  return report;
}

/** Restore to a host with NO volume, or merge missing entries into the SAME volume. Never touches another volume. */
export async function restoreBackup(raw: RawFetch, file: BackupFile, keys: VolumeKeys, opts: { overwrite?: boolean } = {}) {
  const m = await openManifest(file, keys);
  const h = await hostGet(raw, "read", KEYSLOT_PATH);
  const existing = h.status === 200 && (h.body.node as Json | undefined)?.content ? parseHeader(String((h.body.node as Json).content)) : null;
  if (existing && existing.volumeId !== file.header.volumeId) throw new Error("this host already has a DIFFERENT Persistent Storage — delete it first (Privacy ▸ Delete) or restore on another host; nothing was written");
  const report = { headerWritten: false, dirs: 0, written: 0, kept: 0, failures: [] as string[] };
  // verify EVERYTHING before writing anything (an attacker-modified backup must not half-restore)
  const v = await verifyBackup(file, keys);
  if (v.failures.length) throw new Error(`backup failed verification (${v.failures.length} problem(s)) — nothing was written`);
  if (!existing) { await hostPost(raw, { op: "write", path: KEYSLOT_PATH, content: JSON.stringify(file.header, null, 1), mime: "application/json", reason: "privacy-restore" }); report.headerWritten = true; }
  const dirs = m.entries.filter((e) => e.k === "dir").sort((a, b) => a.p.split("/").length - b.p.split("/").length);
  for (const d of dirs) { await hostPost(raw, { op: "mkdir", path: `${PRIVATE_ROOT}/${d.p}` }).catch(() => undefined); report.dirs += 1; }
  for (const e of m.entries.filter((x) => x.k === "file")) {
    const path = `${PRIVATE_ROOT}/${e.p}`;
    if (!opts.overwrite) { const s = await hostGet(raw, "stat", path); if (s.status === 200 && s.body.node) { report.kept += 1; continue; } }
    try { await hostPost(raw, { op: "write", path, content: e.c, encoding: "base64", mime: ENC_MIME, reason: "privacy-restore" }); report.written += 1; }
    catch (err) { report.failures.push(`${e.p.slice(0, 12)}…: ${(err as Error).message}`); }
  }
  return report;
}
