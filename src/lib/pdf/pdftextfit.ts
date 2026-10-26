/** TT52 — text fitting for generated appearances: WinAnsi encoding, standard-14 advance widths, line wrapping. */
import { nameToUnicode, std14Width } from "./pdffont";
import { ENC_WINANSI, STD14 } from "./fontdata";
import type { Bytes } from "./pdfobj";
/* ------------------------------------------------------------------ WinAnsi text + standard-14 metrics for appearances */
let WIN_REV: Map<string, number> | null = null; let WIN_NAMES: string[] | null = null;
export function winAnsiBytes(s: string): Bytes {
  if (!WIN_REV) { WIN_NAMES = ENC_WINANSI.split(" "); WIN_REV = new Map(); WIN_NAMES.forEach((n, c) => { if (n && n !== ".") { const u = nameToUnicode(n); if (u && !WIN_REV!.has(u)) WIN_REV!.set(u, c); } }); for (let c = 32; c < 127; c++) if (!WIN_REV.has(String.fromCharCode(c))) WIN_REV.set(String.fromCharCode(c), c); }
  const out: number[] = []; for (const ch of s) { const c = WIN_REV.get(ch); out.push(c ?? 63); } return Uint8Array.from(out);
}
/** advance width of `s` in a standard-14 font at `size` (WinAnsi), used to lay out generated appearances */
export function helvWidth(s: string, size: number, font = "Helvetica"): number {
  if (!STD14[font]) font = "Helvetica"; const b = winAnsiBytes(s); let w = 0;
  for (const c of b) { const n = WIN_NAMES![c]; w += (n && std14Width(font, n)) || 500; }
  return (w / 1000) * size;
}
export function pdfLiteral(b: Bytes): string { let s = ""; for (const c of b) { if (c === 0x28 || c === 0x29 || c === 0x5c) s += "\\" + String.fromCharCode(c); else if (c < 32 || c > 126) s += "\\" + c.toString(8).padStart(3, "0"); else s += String.fromCharCode(c); } return s; }
export function wrap(text: string, width: number, size: number, font = "Helvetica"): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r\n|\r|\n/)) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue; const cand = line + word;
      if (helvWidth(cand.trimEnd(), size, font) <= width || !line.trim()) line = cand;
      else { out.push(line.trimEnd()); line = word.trimStart(); }
      while (helvWidth(line, size, font) > width && line.length > 1) { let k = line.length - 1; while (k > 1 && helvWidth(line.slice(0, k), size, font) > width) k--; out.push(line.slice(0, k)); line = line.slice(k); }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** a PDF literal string body for text in WinAnsiEncoding */
export const pdfLiteralWinAnsi = (s: string) => pdfLiteral(winAnsiBytes(s));
