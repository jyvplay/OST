/** TT125 VA-03: find vault entries that store the SAME secret, comparing only
 *  caller-supplied digests — the plaintext never leaves the vault client and
 *  never reaches this function. */
export interface DigestEntry { id: number; label: string; digest: string; }
export interface ReuseGroup { digest: string; labels: string[]; }
export function reuseGroups(entries: ReadonlyArray<DigestEntry>): ReuseGroup[] {
  const by = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.digest) continue;
    const arr = by.get(e.digest) ?? [];
    arr.push(e.label);
    by.set(e.digest, arr);
  }
  return [...by.entries()]
    .filter(([, labels]) => labels.length > 1)
    .map(([digest, labels]) => ({ digest, labels: [...labels].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => b.labels.length - a.labels.length);
}
export function reuseReportText(groups: ReadonlyArray<ReuseGroup>): string {
  if (!groups.length) return "no secret is stored twice";
  return groups.map((g) => `${g.labels.length}× shared: ${g.labels.join(", ")}`).join("\n");
}
