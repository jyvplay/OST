/** ED-05: whole-document line operations for the Editor. The trailing
 *  newline (or its absence) is preserved exactly so a sort never changes
 *  the file's termination; blank lines sort first ascending. */
export interface LineOpOpts { desc?: boolean; dedupe?: boolean; trimTrailing?: boolean }
export function transformLines(text: string, opts: LineOpOpts): string {
  const hadTrailing = text.endsWith("\n");
  let lines = text.split("\n");
  if (hadTrailing) lines = lines.slice(0, -1);
  if (text === "") lines = [];
  if (opts.trimTrailing) lines = lines.map((l) => l.replace(/[ \t]+$/, ""));
  if (opts.dedupe) lines = [...new Set(lines)];
  lines.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  if (opts.desc) lines.reverse();
  return lines.join("\n") + (hadTrailing && lines.length ? "\n" : "");
}
