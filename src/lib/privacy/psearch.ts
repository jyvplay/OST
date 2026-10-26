/**
 * TT19 — search inside Persistent Storage without telling the host.
 *
 * The host index never holds /Private (TT18 choke point), so encrypted files were unsearchable. This index is
 * built IN THE TAB after unlock from decrypted reads, kept only in memory, updated incrementally by the privacy
 * layer on every /Private write/move/trash, and dropped on lock, key change and emergency wipe.
 * Queries scoped to /Private never leave the browser; unscoped queries still ask the host for host files (the
 * host already holds those in clear) and the two result lists are merged.
 */
import { isTextual } from "../mime";
import { fromB64 } from "./pcrypt";

export interface PDoc { path: string; name: string; body: string; lower: string }
export interface PHit { source: "file"; ref: string; title: string; snippet: string; rank: number; how: "private-local" | "amnesic-ram" }

export const PSEARCH_LIMITS = { files: 5000, bytesPerFile: 2 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, bodyChars: 200_000 };
const dec = new TextDecoder();

export function docBody(content: string, encoding: string, mime: string): string {
  if (!isTextual(mime)) return "";
  if (encoding === "utf8") return content.slice(0, PSEARCH_LIMITS.bodyChars);
  try { return dec.decode(fromB64(content)).slice(0, PSEARCH_LIMITS.bodyChars); } catch { return ""; }
}

export class PrivateIndex {
  docs = new Map<string, PDoc>();
  bytes = 0;
  truncated = false;
  builtAt = 0;
  buildMs = 0;
  readonly fingerprint: string;
  constructor(fingerprint: string) { this.fingerprint = fingerprint; }

  put(path: string, name: string, body: string) {
    this.drop(path);
    if (this.docs.size >= PSEARCH_LIMITS.files || this.bytes + body.length > PSEARCH_LIMITS.totalBytes) { this.truncated = true; body = ""; }
    this.docs.set(path, { path, name, body, lower: `${name}\n${body}`.toLowerCase() });
    this.bytes += body.length;
  }
  drop(path: string) { const d = this.docs.get(path); if (d) { this.bytes -= d.body.length; this.docs.delete(path); } }
  dropPrefix(prefix: string) { for (const p of [...this.docs.keys()]) if (p === prefix || p.startsWith(`${prefix}/`)) this.drop(p); }
  movePrefix(from: string, to: string) {
    for (const d of [...this.docs.values()]) {
      if (d.path !== from && !d.path.startsWith(`${from}/`)) continue;
      const np = to + d.path.slice(from.length);
      this.drop(d.path); this.put(np, np.split("/").pop() ?? np, d.body);
    }
  }
  clear() { this.docs.clear(); this.bytes = 0; }

  search(q: string, scope = "", limit = 40, how: PHit["how"] = "private-local"): PHit[] {
    return searchDocs(this.docs.values(), q, scope, limit, how);
  }
}

/** AND of whitespace tokens (like websearch_to_tsquery's default), case-insensitive substring matching. */
export function searchDocs(docs: Iterable<PDoc>, q: string, scope: string, limit: number, how: PHit["how"]): PHit[] {
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 16);
  if (!toks.length) return [];
  const out: PHit[] = [];
  for (const d of docs) {
    if (scope && d.path !== scope && !d.path.startsWith(scope.endsWith("/") ? scope : `${scope}/`)) continue;
    if (!toks.every((t) => d.lower.includes(t))) continue;
    const nameL = d.name.toLowerCase();
    const inTitle = toks.filter((t) => nameL.includes(t)).length / toks.length;
    let occ = 0; for (const t of toks) { let i = d.lower.indexOf(t); while (i >= 0 && occ < 50) { occ++; i = d.lower.indexOf(t, i + t.length); } }
    const first = d.body.toLowerCase().indexOf(toks[0]);
    const snippet = first >= 0 ? d.body.slice(Math.max(0, first - 60), first + 120).replace(/\s+/g, " ") : d.body.slice(0, 180).replace(/\s+/g, " ");
    out.push({ source: "file", ref: d.path, title: d.name, snippet, rank: Math.min(1, 0.1 + 0.4 * inTitle + 0.02 * occ), how });
  }
  return out.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title)).slice(0, limit);
}
