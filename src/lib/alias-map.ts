/** TT125 TM-08: session aliases — `alias g=git status` then `g` at the prompt.
 *  Expansion is one pass, at the start of the line, so an alias can never
 *  recurse into itself or rewrite the middle of a command. */
export function parseAlias(line: string): { name: string; cmd: string } | null {
  const m = /^alias\s+([A-Za-z0-9_.-]+)=(.*)$/.exec(line.trim());
  if (!m) return null;
  const cmd = m[2].trim();
  if (!cmd) return null;
  return { name: m[1], cmd };
}
export function expandAlias(line: string, aliases: Readonly<Record<string, string>>): string {
  const m = /^([A-Za-z0-9_.-]+)(\s.*)?$/.exec(line);
  if (!m) return line;
  const cmd = Object.hasOwn(aliases, m[1]) ? aliases[m[1]] : undefined;
  if (!cmd) return line;
  return cmd + (m[2] ?? "");
}
