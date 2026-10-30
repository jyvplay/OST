/**
 * ED-04 — Editor go-to-line + document statistics. Line numbers are 1-based
 * at the boundary (what the user types) and clamped inside (typing line
 * 9999 in a 3-line file lands on line 3, never past the end). Statistics
 * reuse the same counting rules as Terminal `wc` (wc-core) so the Editor
 * and the shell can never disagree about a document.
 */
import { wc } from "./wc-core";

export function clampLine(line: number, text: string): number {
  const total = text === "" ? 1 : text.split("\n").length;
  if (!Number.isFinite(line) || line < 1) return 1;
  return Math.min(Math.floor(line), total);
}

/** Character offset of the start of a 1-based line. */
export function offsetAtLine(text: string, line: number): number {
  const target = clampLine(line, text);
  let seen = 1, i = 0;
  while (seen < target && i < text.length) {
    if (text[i] === "\n") seen++;
    i++;
  }
  return i;
}

export function totalLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

export interface DocStats { lines: number; words: number; chars: number; bytes: number; readingMinutes: number }

export function docStats(text: string): DocStats {
  const c = wc(text);
  return {
    // wc's rule (newline count, +1 for a final unterminated line) — the
    // Editor and `wc` in Terminal report the same number for the same file.
    lines: c.lines + (text === "" || text.endsWith("\n") ? 0 : 1),
    words: c.words,
    chars: c.chars,
    bytes: c.bytes,
    // 200 wpm is a reading estimate, labelled as one — never presented as exact.
    readingMinutes: c.words === 0 ? 0 : Math.max(1, Math.round(c.words / 200)),
  };
}
