/** TT118 BK-06 — compare two backup manifests.
 * A manifest entry is (path, bytes, sha256). The comparison is set arithmetic
 * over paths with a digest comparison inside each shared path — the same
 * three-bucket discipline as the Recall manifest (missing / extra / changed),
 * written separately because a backup bundle and a Recall archive are
 * different formats that happen to share a shape. */
export interface BackupEntry { path: string; bytes: number; sha256: string }
export interface BackupDiff { added: string[]; removed: string[]; changed: { path: string; before: BackupEntry; after: BackupEntry }[]; unchanged: number; bytesDelta: number }
export function parseBackupManifest(json: string): BackupEntry[] {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { throw new Error("manifest is not valid JSON"); }
  const d = doc as { entries?: unknown; files?: unknown };
  const list = (d.entries ?? d.files) as unknown;
  if (!Array.isArray(list)) throw new Error("manifest has no entries list");
  return list.map((raw, i) => {
    const e = raw as Partial<BackupEntry> & { size?: unknown };
    const bytes = typeof e.bytes === "number" ? e.bytes : e.size; // Backup bundle entries call it `size`
    if (typeof e.path !== "string" || !e.path.startsWith("/") || typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(e.sha256) || typeof bytes !== "number" || bytes < 0) {
      throw new Error(`manifest entry ${i + 1} is invalid`);
    }
    return { path: e.path, bytes, sha256: e.sha256.toLowerCase() };
  });
}
export function compareManifests(before: BackupEntry[], after: BackupEntry[]): BackupDiff {
  const bMap = new Map(before.map((e) => [e.path, e]));
  const aMap = new Map(after.map((e) => [e.path, e]));
  const added = [...aMap.keys()].filter((p) => !bMap.has(p)).sort();
  const removed = [...bMap.keys()].filter((p) => !aMap.has(p)).sort();
  const changed: BackupDiff["changed"] = [];
  let unchanged = 0;
  for (const [path, b] of bMap) {
    const a = aMap.get(path);
    if (!a) continue;
    if (a.sha256 !== b.sha256 || a.bytes !== b.bytes) changed.push({ path, before: b, after: a }); else unchanged++;
  }
  changed.sort((x, y) => x.path.localeCompare(y.path));
  const sum = (l: BackupEntry[]) => l.reduce((s, e) => s + e.bytes, 0);
  return { added, removed, changed, unchanged, bytesDelta: sum(after) - sum(before) };
}
