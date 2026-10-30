/** PK-02: a hex head for binary files — offset, hex bytes, printable
 *  ASCII gutter, 16 bytes per line. Reads only the first bytes the UI
 *  passes in; nothing is decoded as text or executed. */
export const HEX_HEAD_BYTES = 64;
export function hexHead(bytes: Uint8Array, max = HEX_HEAD_BYTES): string {
  const n = Math.min(bytes.length, max);
  const lines: string[] = [];
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(n, off + 16));
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${off.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  |${ascii}|`);
  }
  if (bytes.length > n) lines.push(`… ${bytes.length - n} more bytes not shown`);
  return lines.join("\n");
}
