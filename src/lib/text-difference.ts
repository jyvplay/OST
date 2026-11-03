/** Linear prefix/suffix line comparison: one exact changed region, not a
 * minimal/LCS diff. Every source line is classified; the UI bounds rendering. */
export interface TextDifference { before: string[]; removed: string[]; added: string[]; after: string[]; equal: boolean }
export function textDifference(original: string, edited: string): TextDifference {
  if (original.length > 1_048_576 || edited.length > 1_048_576) throw new Error("Comparison is limited to 1,048,576 UTF-16 code units per side");
  const a = original.split("\n"), b = edited.split("\n");
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0; while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  return { before: a.slice(0, start), removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end), after: end ? a.slice(a.length - end) : [], equal: original === edited };
}
