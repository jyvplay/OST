/** TT125 ST-16: the keyboard map as copyable text, grouped as shown. */
export interface ShortcutLike { keys: string; what: string; }
export function shortcutsText(rows: ReadonlyArray<ShortcutLike>): string {
  if (!rows.length) return "no shortcuts listed";
  return rows.map((r) => `${r.keys}  —  ${r.what}`).join("\n");
}
