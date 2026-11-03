/** HTML textarea values/offsets normalize CRLF and CR to LF, even when the
 * application retains the untouched source. These linear, constant-space
 * range maps keep selection tools from moving or normalizing source text.
 * Indices are UTF-16 code units, not bytes or grapheme clusters. */
export interface TextRange { start: number; end: number }
function validRange(start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error("Use a valid selection range");
}
export function sourceTextRange(text: string, start: number, end: number): TextRange {
  validRange(start, end);
  if (text.indexOf("\r") < 0) {
    if (end > text.length) throw new Error("Selection exceeds the displayed text");
    return { start, end };
  }
  let raw = 0, displayed = 0, first = start === 0 ? 0 : -1;
  while (displayed < end && raw < text.length) {
    raw += text[raw] === "\r" && text[raw + 1] === "\n" ? 2 : 1; displayed++;
    if (displayed === start) first = raw;
  }
  if (displayed !== end || first < 0) throw new Error("Selection exceeds the displayed text");
  return { start: first, end: raw };
}
export function displayedTextRange(text: string, start: number, end: number): TextRange {
  validRange(start, end);
  if (end > text.length) throw new Error("Selection exceeds the source text");
  if (text.indexOf("\r") < 0) return { start, end };
  let raw = 0, displayed = 0, first = start === 0 ? 0 : -1;
  while (raw < end) {
    const step = text[raw] === "\r" && text[raw + 1] === "\n" ? 2 : 1;
    if (raw + step > end || (raw < start && raw + step > start)) throw new Error("Selection splits a CRLF line ending");
    raw += step; displayed++;
    if (raw === start) first = displayed;
  }
  if (first < 0) throw new Error("Selection exceeds the source text");
  return { start: first, end: displayed };
}
