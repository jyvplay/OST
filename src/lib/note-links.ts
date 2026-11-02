/** TT118 NT-02 — hashtags and [[wiki-links]] in notes.
 * A hashtag is # followed by a word character, not preceded by a word character
 * or '/' (so URLs and "a#b" are not tags; a heading "# Title" is not a tag
 * because of the space). A wiki-link is [[Title]] or [[Title|label]]; matching
 * to notes is by case-insensitive title. Backlinks are computed over the whole
 * note set, so they can never disagree with the links they reverse. */
export interface NoteRef { id: number; title: string; body: string }
export function extractTags(text: string): string[] {
  const tags = new Set<string>();
  for (const m of String(text).matchAll(/(?<![\p{L}\p{N}_/])#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu)) tags.add(m[1].toLowerCase());
  return [...tags].sort();
}
export function extractWikiLinks(text: string): { target: string; label: string }[] {
  const out: { target: string; label: string }[] = [];
  for (const m of String(text).matchAll(/\[\[([^\]|]{1,120})(?:\|([^\]]{1,120}))?\]\]/g)) {
    const target = m[1].trim();
    if (target) out.push({ target, label: (m[2] ?? m[1]).trim() });
  }
  return out;
}
export function resolveLinks(notes: NoteRef[], from: NoteRef): { target: string; label: string; noteId: number | null }[] {
  const byTitle = new Map<string, number | null>();
  for (const note of notes) {
    const title = note.title.trim().toLowerCase();
    byTitle.set(title, byTitle.has(title) ? null : note.id);
  }
  return extractWikiLinks(from.body).map((l) => ({ ...l, noteId: byTitle.get(l.target.toLowerCase()) ?? null }));
}
export function backlinks(notes: NoteRef[], target: NoteRef): { id: number; title: string }[] {
  // Incoming edges describe the SAVED graph, identified by row ID. A draft
  // rename must neither lose its saved edges nor borrow another row's edges.
  const saved = notes.find(note => note.id === target.id);
  if (!saved) return [];
  const wanted = saved.title.trim().toLowerCase();
  // Forward navigation refuses an ambiguous title; its reverse relation must
  // not invent a backlink to either of those possible destinations.
  if (notes.filter(note => note.title.trim().toLowerCase() === wanted).length !== 1) return [];
  return notes.filter((n) => n.id !== target.id && extractWikiLinks(n.body).some((l) => l.target.toLowerCase() === wanted))
    .map((n) => ({ id: n.id, title: n.title })).sort((a, b) => a.title.localeCompare(b.title));
}
export function notesByTag(notes: NoteRef[], tag: string): NoteRef[] {
  const t = tag.toLowerCase();
  return notes.filter((n) => extractTags(`${n.title}\n${n.body}`).includes(t));
}
