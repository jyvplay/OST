/** CB-02: clipboard entry kinds, derived from the text itself (entries
 *  store no kind, so classification must be a pure function of content).
 *  A URL or e-mail is only a kind when the WHOLE entry is one — a sentence
 *  containing a link stays text. */
export type ClipKind = "text" | "link" | "email" | "code";
export function clipKindOf(text: string): ClipKind {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t) || /^www\.\S+$/i.test(t)) return "link";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return "email";
  if (/[{};]\s*$|=>|function\s|const\s|import\s|^\s*(def|class|if|for|while)\b/m.test(t) && t.includes("\n")) return "code";
  return "text";
}
export const filterByKind = <T extends { text: string }>(items: T[], kind: ClipKind | "all"): T[] =>
  kind === "all" ? items : items.filter((i) => clipKindOf(i.text) === kind);
