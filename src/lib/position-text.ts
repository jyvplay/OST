/** TT125 BK-13: the reading position as one copyable line. The reader may
 *  know a fraction, a chapter, both or neither — each absence is stated. */
export function bookPositionText(title: string, fraction: number | null, chapter: string | null): string {
  const parts: string[] = [title];
  if (fraction != null && Number.isFinite(fraction)) parts.push(`${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`);
  if (chapter) parts.push(chapter);
  if (parts.length === 1) return `${title} — position not reported by this book`;
  return parts.join(" — ");
}
