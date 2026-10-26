/**
 * TT18 — "Remove metadata" for a VFS file (Files context menu, Privacy module). Runs the cleaner IN THE
 * BROWSER, so for /Private files the plaintext never reaches the host: the read is decrypted by the
 * privacy layer, cleaned here, and the write is re-encrypted by the same layer.
 *
 * Default is a cleaned COPY next to the original ("name.clean.ext"). Overwrite mode also drops the file's
 * version history, because the previous version would otherwise keep the very metadata just removed.
 */
import { api, post } from "../api";
import { cleanMetadata, type CleanReport } from "./metaclean";
import { fromB64, toB64 } from "./pcrypt";

export interface CleanFileResult { report: CleanReport; written: string | null; droppedVersions: number }

export const cleanCopyPath = (p: string) => {
  const slash = p.lastIndexOf("/"); const dot = p.lastIndexOf(".");
  return dot > slash + 1 ? `${p.slice(0, dot)}.clean${p.slice(dot)}` : `${p}.clean`;
};

export async function cleanVfsFile(path: string, opts: { overwrite?: boolean } = {}): Promise<CleanFileResult> {
  const r = await api<{ node: { name: string; content: string; encoding: "utf8" | "base64"; mime: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`);
  const n = r.node;
  const bytes = n.encoding === "base64" ? fromB64(n.content) : new TextEncoder().encode(n.content);
  const { data, report } = await cleanMetadata(bytes, n.name);
  if (!report.supported || report.removed.length === 0) return { report, written: null, droppedVersions: 0 };
  const dst = opts.overwrite ? path : cleanCopyPath(path);
  const content = n.encoding === "utf8" ? new TextDecoder().decode(data) : toB64(data);
  await post("/api/fs", { op: "write", path: dst, content, encoding: n.encoding, mime: n.mime, reason: "metadata-clean" });
  let droppedVersions = 0;
  if (opts.overwrite) droppedVersions = (await post<{ dropped: number }>("/api/fs", { op: "dropVersions", path })).dropped ?? 0;
  return { report, written: dst, droppedVersions };
}
