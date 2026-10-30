/** TM-05: the terminal `sort` / `uniq` commands as one pure transform.
 *  Numeric mode compares leading numbers (non-numeric lines count as 0,
 *  like POSIX sort -n); uniq removes ADJACENT duplicates unless asked for
 *  global dedupe — the distinction is the point of the exercise. */
export interface SortOpts { desc?: boolean; numeric?: boolean; unique?: boolean }
export function sortText(text: string, opts: SortOpts): string {
  const hadTrailing = text.endsWith("\n");
  let lines = text === "" ? [] : text.split("\n");
  if (hadTrailing) lines = lines.slice(0, -1);
  const num = (l: string) => { const m = /^\s*[+-]?[0-9]*\.?[0-9]+/.exec(l); return m ? parseFloat(m[0]) : 0; };
  lines.sort((a, b) => (opts.numeric ? num(a) - num(b) : a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })));
  if (opts.desc) lines.reverse();
  if (opts.unique) lines = lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
  return lines.join("\n") + (hadTrailing && lines.length ? "\n" : "");
}
export function uniqText(text: string, global = false): string {
  const hadTrailing = text.endsWith("\n");
  let lines = text === "" ? [] : text.split("\n");
  if (hadTrailing) lines = lines.slice(0, -1);
  lines = global ? [...new Set(lines)] : lines.filter((l, i) => i === 0 || l !== lines[i - 1]);
  return lines.join("\n") + (hadTrailing && lines.length ? "\n" : "");
}
