/**
 * TM-03 — `wc`/`du` counting for the Terminal. Byte counts are UTF-8 bytes
 * (what the file occupies), not UTF-16 code units — an emoji counts 4, not 2.
 * A trailing newline ends the last line rather than starting an empty one,
 * matching POSIX wc: "a\n" is 1 line, "a" is 0 lines but 1 word.
 */
export interface WcCount { lines: number; words: number; bytes: number; chars: number }

const encoder = new TextEncoder();

export function wc(text: string): WcCount {
  return {
    lines: (text.match(/\n/g) ?? []).length,
    words: text.split(/\s+/).filter(Boolean).length,
    bytes: encoder.encode(text).length,
    chars: [...text].length,
  };
}

export function formatWc(name: string, c: WcCount): string {
  return `${String(c.lines).padStart(7)} ${String(c.words).padStart(7)} ${String(c.bytes).padStart(8)}  ${name}`;
}
