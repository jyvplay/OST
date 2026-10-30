/**
 * PH-04 — prev/next navigation in the Photos editor, over the currently
 * shown (filtered, sorted) list — navigation follows what the user is
 * looking at, not the raw library. No wrap here: hitting the first/last
 * photo reports the boundary instead of silently looping (the slideshow
 * wraps; deliberate navigation does not).
 */
export function neighbor<T extends { path: string }>(shown: T[], currentPath: string, dir: 1 | -1): { item: T; index: number; total: number } | null {
  const i = shown.findIndex((x) => x.path === currentPath);
  if (i < 0) return null;
  const j = i + dir;
  if (j < 0 || j >= shown.length) return null;
  return { item: shown[j], index: j, total: shown.length };
}

export function positionLabel(shown: { path: string }[], currentPath: string): string {
  const i = shown.findIndex((x) => x.path === currentPath);
  return i < 0 ? "" : `${i + 1} of ${shown.length}`;
}
