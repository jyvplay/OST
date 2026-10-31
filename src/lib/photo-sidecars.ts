/** Find visible photos with recipe sidecars, in sidecar order.
 * The caller already deduplicates sidecar paths. The limit bounds recipe reads;
 * stopping once it is reached is equivalent to filtering then slicing. */
export function selectPhotoSidecars(photos: readonly { path: string }[], candidates: Iterable<string>, limit = 2000): string[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("sidecar limit must be a non-negative integer");
  if (limit === 0) return [];
  // Tiny recipe sets are cheaper to scan directly and need no large index.
  const small = candidates instanceof Set && candidates.size <= 4;
  const paths = small ? null : new Set<string>();
  if (paths) for (const photo of photos) paths.add(photo.path);
  const found: string[] = [];
  for (const path of candidates) {
    if (paths ? paths.has(path) : photos.some((photo) => photo.path === path)) {
      found.push(path);
      if (found.length === limit) break;
    }
  }
  return found;
}
