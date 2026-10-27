"use client";
import { api } from "@/lib/api";
import { badName, copyName } from "@/lib/files/model";
import { privacy } from "@/lib/privacy/session";

export const MAX_LAUNCH_FILES = 8;
export const MAX_LAUNCH_FILE_BYTES = 1024 * 1024;
const MIMES: Record<string, string> = { txt: "text/plain", log: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json" };

/** Read a selected UTF-8 file strictly. Return text only; caller must obtain consent before invoking this. */
export async function decodeLaunchFile(file: File): Promise<{ name: string; text: string; mime: string }> {
  const name = file.name;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (badName(name) || name.length > 240 || /[\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name) || !Object.hasOwn(MIMES, ext) || !name.includes(".")) {
    throw new Error("The filename is invalid or is not a supported text type");
  }
  if (file.size > MAX_LAUNCH_FILE_BYTES) throw new Error("The file exceeds the 1 MiB launch-import limit");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error("The file is not valid UTF-8"); }
  if (text.includes("\0")) throw new Error("The file contains NUL bytes");
  return { name, text, mime: MIMES[ext] };
}

/** Copy into /Documents without overwriting an existing or concurrently created Fusion file. */
export async function importLaunchFile(file: File): Promise<{ name: string; path: string }> {
  if (!privacy.status().installed || privacy.status().amnesic) throw new Error("File launch import is unavailable in an amnesic session");
  const decoded = await decodeLaunchFile(file);
  // Do not queue this operation offline: explicit consent applies to this immediate launch only.
  const list = await api<{ nodes: { name: string }[] }>("/api/fs?op=list&path=%2FDocuments");
  const used = new Set(list.nodes.map((n) => n.name));
  for (let i = 0; i < 100; i++) {
    const name = copyName(decoded.name, used, false, "number");
    const path = `/Documents/${name}`;
    try {
      await api("/api/fs", { method: "POST", body: JSON.stringify({ op: "writeIfUnchanged", path, content: decoded.text, encoding: "utf8", mime: decoded.mime, expected: null }) });
      return { name, path };
    } catch (e) {
      if ((e as { status?: number }).status !== 409) throw e;
      used.add(name);
    }
  }
  throw new Error("Could not find an available name in /Documents");
}
