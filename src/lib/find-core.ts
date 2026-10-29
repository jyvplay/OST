/** TT117 FN-01 — literal/regex find with positions.
 * A bad regex is an error the caller shows, never a silent fallback to literal.
 * Matches are capped and overlapping matches are not double-counted (the scan
 * advances past each match; a zero-width match advances one character). */
export interface FindOptions { regex: boolean; caseSensitive: boolean; wholeWord: boolean }
export interface FindMatch { index: number; length: number; line: number; column: number; text: string }
export const FIND_CAP = 500;

export function compileFind(query: string, opts: FindOptions): { pattern: RegExp } | { error: string } {
  if (!query) return { error: "type something to find" };
  let src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try { return { pattern: new RegExp(src, opts.caseSensitive ? "gu" : "giu") }; }
  catch (e) { return { error: `invalid pattern: ${(e as Error).message}` }; }
}
export function findInText(text: string, pattern: RegExp): { matches: FindMatch[]; truncated: boolean } {
  const matches: FindMatch[] = [];
  pattern.lastIndex = 0;
  let line = 1, lineStart = 0, scannedTo = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    while (scannedTo < m.index) { if (text[scannedTo] === "\n") { line++; lineStart = scannedTo + 1; } scannedTo++; }
    matches.push({ index: m.index, length: m[0].length, line, column: m.index - lineStart + 1, text: m[0] });
    if (matches.length >= FIND_CAP) return { matches, truncated: true };
    if (m[0].length === 0) pattern.lastIndex++;
  }
  return { matches, truncated: false };
}
