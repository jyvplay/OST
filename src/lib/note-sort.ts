/** NT-05: note list ordering. Pinned notes always lead (existing server
 *  flag); within each group the chosen key applies. Title sort is
 *  case-insensitive; updated is the stored ISO timestamp. */
export interface NoteLike { title: string; updatedAt: string; pinned?: boolean }
export type NoteSort = "updated" | "title" | "created";
export function sortNotes<T extends NoteLike & { id: number }>(notes: T[], sort: NoteSort): T[] {
  const key = (n: T): string | number => sort === "title" ? n.title.toLowerCase() : sort === "created" ? n.id : n.updatedAt;
  return [...notes].sort((a, b) => {
    const pin = Number(b.pinned ?? false) - Number(a.pinned ?? false);
    if (pin) return pin;
    const ka = key(a), kb = key(b);
    const cmp = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
    return sort === "title" ? cmp : -cmp;
  });
}
