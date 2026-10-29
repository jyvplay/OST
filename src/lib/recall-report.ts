/** TT117 RC-40/41/42 — Recall archive reporting over receipts.
 * A memory here is the receipt's own fields (path, sha256, bytes, mime, method,
 * capturedAt) — the same source RC-27 filters on, so a report can never disagree
 * with the provenance it summarises. The manifest is deterministic (sorted by
 * path, fixed key order) so two exports of the same archive are byte-identical
 * and a diff means the archive changed, not the exporter. Verification compares
 * a manifest against a live receipt list and reports missing / extra / changed
 * separately; it does not re-hash media bytes (that is RC-19's job). */
export interface MemoryRef { path: string; sha256: string; bytes: number; mime: string; method: string; capturedAt: string | null; folder: string }
export const MANIFEST_KIND = "fusion.recall-manifest.v1";

function sorted(memories: MemoryRef[]): MemoryRef[] {
  return [...memories].sort((a, b) => a.path.localeCompare(b.path)).map((m) => ({
    path: m.path, sha256: m.sha256, bytes: m.bytes, mime: m.mime, method: m.method, capturedAt: m.capturedAt, folder: m.folder,
  }));
}
export function buildManifest(memories: MemoryRef[], generatedAt = new Date().toISOString()): string {
  const rows = sorted(memories);
  return JSON.stringify({ kind: MANIFEST_KIND, generatedAt, count: rows.length, memories: rows }, null, 2);
}
export function parseManifest(json: string): MemoryRef[] {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { throw new Error("manifest is not valid JSON"); }
  const d = doc as { kind?: string; memories?: unknown };
  if (!d || d.kind !== MANIFEST_KIND || !Array.isArray(d.memories)) throw new Error("not a Fusion Recall manifest");
  return d.memories.map((raw, i) => {
    const m = raw as Partial<MemoryRef>;
    if (typeof m.path !== "string" || !m.path.startsWith("/") || typeof m.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.sha256)
      || typeof m.bytes !== "number" || !Number.isSafeInteger(m.bytes) || m.bytes < 0) throw new Error(`manifest memory ${i + 1} is invalid`);
    return { path: m.path, sha256: m.sha256, bytes: m.bytes, mime: String(m.mime ?? ""), method: String(m.method ?? ""), capturedAt: m.capturedAt ?? null, folder: String(m.folder ?? "") };
  });
}
export interface ManifestDiff { ok: boolean; missing: string[]; extra: string[]; changed: { path: string; field: string; manifest: string; live: string }[] }
export function verifyManifest(json: string, live: MemoryRef[]): ManifestDiff {
  const wanted = new Map(parseManifest(json).map((m) => [m.path, m]));
  const have = new Map(sorted(live).map((m) => [m.path, m]));
  const missing = [...wanted.keys()].filter((p) => !have.has(p));
  const extra = [...have.keys()].filter((p) => !wanted.has(p));
  const changed: ManifestDiff["changed"] = [];
  for (const [path, w] of wanted) {
    const h = have.get(path); if (!h) continue;
    for (const field of ["sha256", "bytes", "mime", "method"] as const) {
      if (String(w[field]) !== String(h[field])) changed.push({ path, field, manifest: String(w[field]), live: String(h[field]) });
    }
  }
  return { ok: !missing.length && !extra.length && !changed.length, missing, extra, changed };
}
/** RC-41: totals by folder / method / capture day. Undated receipts are counted, not dropped. */
export function archiveStats(memories: MemoryRef[]) {
  const byFolder = new Map<string, { count: number; bytes: number }>();
  const byMethod = new Map<string, { count: number; bytes: number }>();
  const byDay = new Map<string, { count: number; bytes: number }>();
  let undated = 0;
  const bump = (map: Map<string, { count: number; bytes: number }>, key: string, bytes: number) => {
    const row = map.get(key) ?? { count: 0, bytes: 0 }; row.count++; row.bytes += bytes; map.set(key, row);
  };
  for (const m of memories) {
    bump(byFolder, m.folder || "(root)", m.bytes);
    bump(byMethod, m.method || "(unknown)", m.bytes);
    if (m.capturedAt && !isNaN(Date.parse(m.capturedAt))) bump(byDay, m.capturedAt.slice(0, 10), m.bytes); else undated++;
  }
  const rows = (map: Map<string, { count: number; bytes: number }>) => [...map.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
  return { total: memories.length, totalBytes: memories.reduce((s, m) => s + m.bytes, 0), undated, byFolder: rows(byFolder), byMethod: rows(byMethod), byDay: rows(byDay) };
}
/** RC-42: identical bytes held under more than one path, across all folders. */
export function duplicateGroups(memories: MemoryRef[]): { sha256: string; bytes: number; paths: string[]; wastedBytes: number }[] {
  const byHash = new Map<string, MemoryRef[]>();
  for (const m of memories) { const g = byHash.get(m.sha256) ?? []; g.push(m); byHash.set(m.sha256, g); }
  return [...byHash.entries()].filter(([, g]) => g.length > 1)
    .map(([sha256, g]) => ({ sha256, bytes: g[0].bytes, paths: g.map((m) => m.path).sort(), wastedBytes: g[0].bytes * (g.length - 1) }))
    .sort((a, b) => b.wastedBytes - a.wastedBytes);
}
