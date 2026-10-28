"use client";
import { api } from "@/lib/api";
import { digestText } from "@/lib/backup/bundle";
import { toB64 } from "@/lib/crypto";
import { badName, copyName } from "@/lib/files/model";
import { ENCRYPTED_MIME } from "@/lib/mime";

/** Sync is deliberately limited to direct-child, strictly decodable UTF-8 text of at most 1 MiB. */
const MAX_TEXT = 1024 * 1024;
const MAX_ENTRIES = 5000;
const TEXT_NAME = /\.(md|txt|csv|json|ya?ml|log|ini|html|css|js|ts|svg)$/i;
export type Directory = FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
interface VfsNode {
  id: number; name: string; path: string; kind: string; encoding: string; mime: string;
  size: number; sha256: string; version: number; content?: string; trashed?: boolean;
}
export interface SyncConflict { name: string; localSha: string; vfsSha: string; id: number; version: number }
export interface SyncSkipped { name: string; reason: string }
export interface SyncReport { pushed: number; pulled: number; same: number; conflicts: SyncConflict[]; skipped: SyncSkipped[] }

export function syncTarget(name: string): string {
  if (badName(name)) throw new Error("This folder name cannot be represented in the Fusion filesystem.");
  return `/Sync/${name}`;
}
const textName = (name: string) => !badName(name) && TEXT_NAME.test(name);
const vfsText = (v: VfsNode) => v.kind === "file" && v.encoding === "utf8" && v.mime !== ENCRYPTED_MIME && v.size <= MAX_TEXT && textName(v.name);
const request = <T,>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
const expected = (v: VfsNode) => ({ id: v.id, version: v.version, sha256: v.sha256 });
const pathOf = (target: string, name: string) => `${target}/${name}`;

async function readLocal(h: FileSystemFileHandle) {
  const file = await h.getFile();
  if (file.size > MAX_TEXT) throw new Error("Local file exceeds 1 MiB");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error("Local file is not valid UTF-8"); }
  if (text.includes("\0")) throw new Error("Local file contains NUL bytes");
  return { text, sha256: await digestText(text), size: file.size, modified: file.lastModified };
}
async function readVfs(path: string): Promise<VfsNode> {
  const result = await api<{ node: VfsNode }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
  return result.node;
}
const unchangedVfs = (a: VfsNode, b: VfsNode) => a.id === b.id && a.version === b.version && a.sha256 === b.sha256
  && a.kind === b.kind && a.encoding === b.encoding && a.size === b.size && !b.trashed;

async function nameExists(h: Directory, name: string): Promise<boolean> {
  try { await h.getFileHandle(name); return true; }
  catch (e) {
    const type = (e as Error).name;
    if (type === "TypeMismatchError") return true; // a directory occupies the name
    if (type !== "NotFoundError") throw e;
  }
  try { await h.getDirectoryHandle(name); return true; }
  catch (e) { if ((e as Error).name === "NotFoundError") return false; if ((e as Error).name === "TypeMismatchError") return true; throw e; }
}

/**
 * Browser handles have no create-if-absent primitive. Recheck immediately and abort if the new handle is not empty;
 * this reduces races but cannot exclude a concurrent native writer. Never describe it as a cross-process lock.
 */
async function createLocalCopy(h: Directory, name: string, content: string) {
  if (await nameExists(h, name)) throw new Error("Local name appeared during sync; no replacement attempted");
  const fh = await h.getFileHandle(name, { create: true });
  const before = await fh.getFile();
  if (before.size !== 0) throw new Error("Local file appeared during sync; no replacement attempted");
  const writer = await fh.createWritable({ mode: "exclusive" } as FileSystemCreateWritableOptions);
  try {
    await writer.write(content);
    const current = await fh.getFile();
    if (current.size !== before.size || current.lastModified !== before.lastModified) throw new Error("Local file changed during sync; copy cancelled");
    await writer.close();
  } catch (e) { await writer.abort().catch(() => undefined); throw e; }
}

export async function syncLocalFolder(handle: Directory, target: string): Promise<SyncReport> {
  if (target !== syncTarget(handle.name)) throw new Error("The selected folder does not match the sync target");
  // Use api() directly, not the generic offline write queue: a delayed sync must not replay unexpectedly.
  const syncRoot = await api<{ node: VfsNode | null }>("/api/fs?op=stat&path=%2FSync");
  if (syncRoot.node && (syncRoot.node.kind !== "dir" || syncRoot.node.trashed)) throw new Error("/Sync is not an available folder");
  const destination = await api<{ node: VfsNode | null }>(`/api/fs?op=stat&path=${encodeURIComponent(target)}`);
  if (destination.node && (destination.node.kind !== "dir" || destination.node.trashed)) throw new Error("The Fusion sync target is not an available folder");
  await request("/api/fs", { op: "mkdir", path: target });
  const listed = await api<{ nodes: VfsNode[] }>(`/api/fs?op=list&path=${encodeURIComponent(target)}`);
  if (listed.nodes.length > MAX_ENTRIES) throw new Error("Fusion folder has more than 5,000 entries; no file copies were started");
  const local = new Map<string, FileSystemHandle>();
  for await (const [name, entry] of handle.entries()) {
    local.set(name, entry); // retain *every* name, including directories, large and binary files
    if (local.size > MAX_ENTRIES) throw new Error("Local folder has more than 5,000 entries; no file copies were started");
  }
  const vmap = new Map(listed.nodes.map((node) => [node.name, node]));
  const report: SyncReport = { pushed: 0, pulled: 0, same: 0, conflicts: [], skipped: [] };
  const skip = (name: string, reason: string) => report.skipped.push({ name, reason });
  for (const [name, item] of local) {
    if (item.kind !== "file") { skip(name, "Local subfolders are not synced"); continue; }
    if (!textName(name)) { skip(name, "Not a supported text filename"); continue; }
    let snapshot: Awaited<ReturnType<typeof readLocal>>;
    try { snapshot = await readLocal(item as FileSystemFileHandle); }
    catch (e) { skip(name, String((e as Error).message)); continue; }
    const existing = vmap.get(name);
    if (existing && !vfsText(existing)) { skip(name, "Fusion name belongs to a folder, binary, encrypted or oversized file"); continue; }
    if (!existing) {
      try {
        const current = await readLocal(item as FileSystemFileHandle);
        if (current.sha256 !== snapshot.sha256 || current.size !== snapshot.size) { skip(name, "Local file changed while syncing"); continue; }
        await request("/api/fs", { op: "writeIfUnchanged", path: pathOf(target, name), content: snapshot.text, expected: null });
        report.pushed += 1;
      } catch (e) {
        if ((e as { status?: number }).status === 409) { skip(name, "Fusion name appeared during sync"); continue; }
        throw e;
      }
    } else if (existing.sha256 === snapshot.sha256) report.same += 1;
    else report.conflicts.push({ name, localSha: snapshot.sha256, vfsSha: existing.sha256, id: existing.id, version: existing.version });
  }
  for (const [name, entry] of vmap) {
    if (local.has(name)) continue; // skipped local entries still occupy their names
    if (!vfsText(entry)) { skip(name, "Fusion item is not a supported UTF-8 text file ≤ 1 MiB"); continue; }
    try {
      const current = await readVfs(pathOf(target, name));
      if (!unchangedVfs(entry, current) || typeof current.content !== "string" || await digestText(current.content) !== current.sha256) {
        skip(name, "Fusion file changed while syncing"); continue;
      }
      await createLocalCopy(handle, name, current.content);
      report.pulled += 1;
    } catch (e) {
      if ((e as Error).name === "NotFoundError" || /Local (name|file)/.test(String((e as Error).message))) { skip(name, String((e as Error).message)); continue; }
      throw e;
    }
  }
  return report;
}

export async function resolveLocalConflict(handle: Directory, target: string, conflict: SyncConflict, keep: "local" | "vfs") {
  if (target !== syncTarget(handle.name) || !textName(conflict.name)) throw new Error("Invalid folder or conflict name");
  const fh = await handle.getFileHandle(conflict.name);
  const local = await readLocal(fh);
  const remote = await readVfs(pathOf(target, conflict.name));
  if (local.sha256 !== conflict.localSha || !vfsText(remote) || remote.id !== conflict.id || remote.version !== conflict.version || remote.sha256 !== conflict.vfsSha
    || typeof remote.content !== "string" || await digestText(remote.content) !== remote.sha256) throw new Error("One copy changed since this conflict was listed. Sync again before choosing.");
  if (keep === "local") {
    await request("/api/fs", { op: "writeIfUnchanged", path: pathOf(target, conflict.name), content: local.text, expected: expected(remote) });
    return;
  }
  const writer = await fh.createWritable({ mode: "exclusive" } as FileSystemCreateWritableOptions);
  try {
    await writer.write(remote.content);
    const current = await readLocal(fh);
    const remoteNow = await readVfs(pathOf(target, conflict.name));
    if (current.sha256 !== local.sha256 || !unchangedVfs(remote, remoteNow)) throw new Error("One copy changed while resolving. Sync again before choosing.");
    await writer.close();
  } catch (e) { await writer.abort().catch(() => undefined); throw e; }
}

/** Import any local file without silently replacing a same-named Fusion document. */
export async function importLocalFile(handle: Directory, name: string) {
  if (badName(name)) throw new Error("Invalid file name");
  const file = await (await handle.getFileHandle(name)).getFile();
  if (file.size > 8 * 1024 * 1024) throw new Error("File exceeds the 8 MiB Fusion limit");
  const content = toB64(new Uint8Array(await file.arrayBuffer()));
  const list = await api<{ nodes: { name: string }[] }>("/api/fs?op=list&path=%2FDocuments");
  const used = new Set(list.nodes.map((n) => n.name));
  for (let i = 0; i < 100; i++) {
    const candidate = copyName(name, used, false, "number");
    try {
      await request("/api/fs", { op: "writeIfUnchanged", path: `/Documents/${candidate}`, content, encoding: "base64", mime: file.type || undefined, expected: null });
      return candidate;
    } catch (e) {
      if ((e as { status?: number }).status !== 409) throw e;
      used.add(candidate);
    }
  }
  throw new Error("Could not find an available name in /Documents");
}
