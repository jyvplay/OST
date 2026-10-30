/**
 * TM-04 — `head`/`tail` for the Terminal. N is a count of lines, parsed
 * from `-n N` or `-N`; a request for more lines than the file has returns
 * the whole file rather than padding or erroring. A trailing newline does
 * not create a phantom empty final line.
 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function headLines(text: string, n: number): string[] {
  return splitLines(text).slice(0, Math.max(0, n));
}

export function tailLines(text: string, n: number): string[] {
  const lines = splitLines(text);
  return lines.slice(Math.max(0, lines.length - Math.max(0, n)));
}

/** Parse `head [-n 5 | -5] file` args → { n, file } with default 10. */
export function parseCountArg(args: string[], fallbackFile = ""): { n: number; file: string } {
  let n = 10, file = fallbackFile;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-n" && args[i + 1]) { n = Number(args[++i]); }
    else if (/^-\d+$/.test(a)) { n = Number(a.slice(1)); }
    else if (!a.startsWith("-")) file = a;
  }
  return { n: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10, file };
}
