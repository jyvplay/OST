"use client";
import { api } from "@/lib/api";
import { copyName } from "@/lib/files/model";
import { toB64 } from "@/lib/privacy/pcrypt";
import { privacy } from "@/lib/privacy/session";

/** The server VFS stores files in a Postgres text column; this is a byte limit, not a RAM-use claim. */
export const MAX_BROWSER_SAVE_BYTES = 8 * 1024 * 1024;

export function downloadMime(header: string): string {
  const mime = header.split(";")[0].trim().toLowerCase();
  return mime.length <= 200 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

/** Derive a safe virtual filename from the URL, never from a directory or query. */
export function saveName(url: string, type: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return "page.html"; }
  const segment = u.pathname.split("/").filter(Boolean).pop() ?? "";
  let decoded: string;
  try { decoded = decodeURIComponent(segment); } catch { decoded = segment; }
  let name = (decoded || u.hostname).replace(/[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "_").replace(/^\.+/, "").trim().slice(0, 120) || "page";
  if (downloadMime(type) === "text/html" && !/\.x?html?$/i.test(name)) name += ".html";
  return name;
}

/** Read the actual decoded bytes, not an untrusted Content-Length alone. Cancel on overflow/error. */
export async function readBrowserSave(response: Response, signal: AbortSignal, onBytes?: (n: number) => void): Promise<Uint8Array> {
  if (signal.aborted) throw new DOMException("Download cancelled", "AbortError");
  if (!response.ok || response.status === 206) { void response.body?.cancel().catch(() => undefined); throw new Error(response.status === 206 ? "A partial response cannot be saved as a complete file" : `Remote download failed (HTTP ${response.status})`); }
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BROWSER_SAVE_BYTES) {
    void response.body?.cancel().catch(() => undefined); throw new Error("This file exceeds the 8 MiB Fusion Files limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (signal.aborted) throw new DOMException("Download cancelled", "AbortError");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BROWSER_SAVE_BYTES) throw new Error("This file exceeds the 8 MiB Fusion Files limit");
      chunks.push(next.value); onBytes?.(size);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (err) {
    void reader.cancel().catch(() => undefined); throw err;
  } finally {
    signal.removeEventListener("abort", abort); reader.releaseLock();
  }
}

/** Save a fresh file; server-side conditional create resolves races without overwriting existing content. */
export async function saveBrowserDownload(url: string, type: string, bytes: Uint8Array): Promise<{ name: string; path: string }> {
  if (!privacy.status().installed || privacy.status().amnesic) throw new Error("Saving downloads to the server is unavailable in an amnesic session");
  if (bytes.byteLength > MAX_BROWSER_SAVE_BYTES) throw new Error("This file exceeds the 8 MiB Fusion Files limit");
  const requested = saveName(url, type), mime = downloadMime(type), content = toB64(bytes);
  // No offline queue: the current action must not unexpectedly replay later.
  await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "mkdir", path: "/Downloads" }) });
  const list = await api<{ nodes: { name: string }[] }>("/api/fs?op=list&path=%2FDownloads");
  const used = new Set(list.nodes.map((node) => node.name));
  for (let i = 0; i < 100; i++) {
    const name = copyName(requested, used, false, "number"), path = `/Downloads/${name}`;
    try {
      await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "writeIfUnchanged", path, content, encoding: "base64", mime, expected: null }) });
      return { name, path };
    } catch (e) {
      if ((e as { status?: number }).status !== 409) throw e;
      used.add(name);
    }
  }
  throw new Error("Could not find an available name in /Downloads");
}
