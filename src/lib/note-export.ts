/**
 * NT-04 — export a note as a Markdown file. The filename comes from the
 * title with path separators and control characters removed (a title is
 * user data; "../x" must never become a path, and leading dots are
 * stripped so the export is never a hidden file). The body gets a small
 * front-matter block with the export date and the note's tags so the
 * file stands on its own outside Fusion.
 */
export function noteFilename(title: string): string {
  const clean = title
    .replace(/[\\/:*?"<>|-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "")
    .trim()
    .slice(0, 80)
    .trim();
  return `${clean || "untitled"}.md`;
}

export function noteToMarkdown(note: { title: string; body: string; tags?: string }, exportedAt = new Date()): string {
  const tags = (note.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const fm = ["---", `title: ${note.title}`, `exported: ${exportedAt.toISOString()}`, ...(tags.length ? [`tags: ${tags.join(", ")}`] : []), "---", ""].join("\n");
  return fm + note.body + (note.body.endsWith("\n") ? "" : "\n");
}
