/** FM-19: selected file names as a list. Names only (not paths) — the
 *  use is pasting an inventory into a document; order follows the
 *  on-screen sort so the list reads as the user sees it. */
export function namesList(items: { name: string }[]): string {
  return items.map((i) => i.name).join("\n");
}
