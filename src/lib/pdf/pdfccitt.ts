/**
 * CCITTFaxDecode (ITU-T T.4 Group 3 1-D/2-D and T.6 Group 4), written from the ITU-T recommendations.
 * Output: packed 1-bit rows (MSB first, rows padded to a byte) in PDF sample convention — with BlackIs1 false (the
 * default) a 0 bit is black, as ISO 32000-1 §7.4.6 specifies.
 * Damaged data: decoding stops at the first invalid code; rows already decoded are kept, the rest stay white and the
 * result is flagged `partial` (PDFium/Acrobat show the decoded part too).
 */
type Bytes = Uint8Array;

// [run length, code bits] — T.4 Tables 2 and 3 (terminating + make-up codes) and the extended make-up codes (both colours)
const WHITE: [number, string][] = [
  [0, "00110101"], [1, "000111"], [2, "0111"], [3, "1000"], [4, "1011"], [5, "1100"], [6, "1110"], [7, "1111"], [8, "10011"], [9, "10100"],
  [10, "00111"], [11, "01000"], [12, "001000"], [13, "000011"], [14, "110100"], [15, "110101"], [16, "101010"], [17, "101011"], [18, "0100111"],
  [19, "0001100"], [20, "0001000"], [21, "0010111"], [22, "0000011"], [23, "0000100"], [24, "0101000"], [25, "0101011"], [26, "0010011"],
  [27, "0100100"], [28, "0011000"], [29, "00000010"], [30, "00000011"], [31, "00011010"], [32, "00011011"], [33, "00010010"], [34, "00010011"],
  [35, "00010100"], [36, "00010101"], [37, "00010110"], [38, "00010111"], [39, "00101000"], [40, "00101001"], [41, "00101010"], [42, "00101011"],
  [43, "00101100"], [44, "00101101"], [45, "00000100"], [46, "00000101"], [47, "00001010"], [48, "00001011"], [49, "01010010"], [50, "01010011"],
  [51, "01010100"], [52, "01010101"], [53, "00100100"], [54, "00100101"], [55, "01011000"], [56, "01011001"], [57, "01011010"], [58, "01011011"],
  [59, "01001010"], [60, "01001011"], [61, "00110010"], [62, "00110011"], [63, "00110100"],
  [64, "11011"], [128, "10010"], [192, "010111"], [256, "0110111"], [320, "00110110"], [384, "00110111"], [448, "01100100"], [512, "01100101"],
  [576, "01101000"], [640, "01100111"], [704, "011001100"], [768, "011001101"], [832, "011010010"], [896, "011010011"], [960, "011010100"],
  [1024, "011010101"], [1088, "011010110"], [1152, "011010111"], [1216, "011011000"], [1280, "011011001"], [1344, "011011010"], [1408, "011011011"],
  [1472, "010011000"], [1536, "010011001"], [1600, "010011010"], [1664, "011000"], [1728, "010011011"],
];
const BLACK: [number, string][] = [
  [0, "0000110111"], [1, "010"], [2, "11"], [3, "10"], [4, "011"], [5, "0011"], [6, "0010"], [7, "00011"], [8, "000101"], [9, "000100"],
  [10, "0000100"], [11, "0000101"], [12, "0000111"], [13, "00000100"], [14, "00000111"], [15, "000011000"], [16, "0000010111"], [17, "0000011000"],
  [18, "0000001000"], [19, "00001100111"], [20, "00001101000"], [21, "00001101100"], [22, "00000110111"], [23, "00000101000"], [24, "00000010111"],
  [25, "00000011000"], [26, "000011001010"], [27, "000011001011"], [28, "000011001100"], [29, "000011001101"], [30, "000001101000"],
  [31, "000001101001"], [32, "000001101010"], [33, "000001101011"], [34, "000011010010"], [35, "000011010011"], [36, "000011010100"],
  [37, "000011010101"], [38, "000011010110"], [39, "000011010111"], [40, "000001101100"], [41, "000001101101"], [42, "000011011010"],
  [43, "000011011011"], [44, "000001010100"], [45, "000001010101"], [46, "000001010110"], [47, "000001010111"], [48, "000001100100"],
  [49, "000001100101"], [50, "000001010010"], [51, "000001010011"], [52, "000000100100"], [53, "000000110111"], [54, "000000111000"],
  [55, "000000100111"], [56, "000000101000"], [57, "000001011000"], [58, "000001011001"], [59, "000000101011"], [60, "000000101100"],
  [61, "000001011010"], [62, "000001100110"], [63, "000001100111"],
  [64, "0000001111"], [128, "000011001000"], [192, "000011001001"], [256, "000001011011"], [320, "000000110011"], [384, "000000110100"],
  [448, "000000110101"], [512, "0000001101100"], [576, "0000001101101"], [640, "0000001001010"], [704, "0000001001011"], [768, "0000001001100"],
  [832, "0000001001101"], [896, "0000001110010"], [960, "0000001110011"], [1024, "0000001110100"], [1088, "0000001110101"], [1152, "0000001110110"],
  [1216, "0000001110111"], [1280, "0000001010010"], [1344, "0000001010011"], [1408, "0000001010100"], [1472, "0000001010101"], [1536, "0000001011010"],
  [1600, "0000001011011"], [1664, "0000001100100"], [1728, "0000001100101"],
];
const EXT: [number, string][] = [
  [1792, "00000001000"], [1856, "00000001100"], [1920, "00000001101"], [1984, "000000010010"], [2048, "000000010011"], [2112, "000000010100"],
  [2176, "000000010101"], [2240, "000000010110"], [2304, "000000010111"], [2368, "000000011100"], [2432, "000000011101"], [2496, "000000011110"],
  [2560, "000000011111"],
];
// 2-D mode codes (T.4 Table 4): pass, horizontal, vertical offsets −3…+3
const MODES: [string, string][] = [["P", "0001"], ["H", "001"], ["V0", "1"], ["VR1", "011"], ["VR2", "000011"], ["VR3", "0000011"], ["VL1", "010"], ["VL2", "000010"], ["VL3", "0000010"], ["X", "0000001"]];

/** decoding table: key = (length << 16) | code */
function table<T>(rows: [T, string][]): Map<number, T> { const m = new Map<number, T>(); for (const [v, c] of rows) m.set((c.length << 16) | parseInt(c, 2), v); return m; }
const TW = table([...WHITE, ...EXT]), TB = table([...BLACK, ...EXT]), TM = table(MODES);
/** exported for the test-suite's prefix-code checks */
export const _codes = { WHITE, BLACK, EXT, MODES };

class Bits {
  pos = 0; private d: Bytes; constructor(d: Bytes) { this.d = d; }
  get end() { return this.pos >= this.d.length * 8; }
  bit(): number { const p = this.pos++; if (p >= this.d.length * 8) return 0; return (this.d[p >> 3] >> (7 - (p & 7))) & 1; }
  peek(n: number): number { let v = 0; for (let i = 0; i < n; i++) { const p = this.pos + i; v = (v << 1) | (p >= this.d.length * 8 ? 0 : (this.d[p >> 3] >> (7 - (p & 7))) & 1); } return v; }
  align() { this.pos = (this.pos + 7) & ~7; }
  /** every bit from `from` to the end is zero (padding) */
  restZero(from: number): boolean { for (let p = from; p < this.d.length * 8; p++) if ((this.d[p >> 3] >> (7 - (p & 7))) & 1) return false; return true; }
  /** read one code from a table; null when no code matches within `max` bits */
  code<T>(t: Map<number, T>, max = 13): T | null { let v = 0; for (let n = 1; n <= max; n++) { v = (v << 1) | this.bit(); const r = t.get((n << 16) | v); if (r !== undefined) return r; } return null; }
  /** EOL = ≥11 zero bits (fill) then a 1; consumes it and returns true, otherwise leaves the position unchanged */
  eol(): boolean { const save = this.pos; let z = 0; while (z < 4096 && !this.end && this.peek(1) === 0) { this.pos++; z++; } if (z >= 11 && this.peek(1) === 1) { this.pos++; return true; } this.pos = save; return false; }
}

export interface CcittParams { K?: number; Columns?: number; Rows?: number; EndOfLine?: boolean; EncodedByteAlign?: boolean; EndOfBlock?: boolean; BlackIs1?: boolean }

/** a run of one colour: make-up codes repeat until a terminating code (< 64) ends the run */
function run(b: Bits, white: boolean): number { let total = 0; for (let guard = 0; guard < 64; guard++) { const r = b.code(white ? TW : TB); if (r === null) return -1; total += r; if (r < 64) return total; } return -1; }

export function ccittDecode(data: Bytes, p: CcittParams): { data: Bytes; rows: number; partial: boolean; consumed: number } {
  const K = p.K ?? 0, cols = Math.max(1, Math.min(1 << 16, p.Columns ?? 1728)), maxRows = Math.min(p.Rows && p.Rows > 0 ? p.Rows : 1 << 20, Math.floor((1 << 28) / cols));
  const eob = p.EndOfBlock !== false, align = !!p.EncodedByteAlign, black1 = !!p.BlackIs1;
  const rowBytes = (cols + 7) >> 3; const out: Bytes[] = []; const b = new Bits(data);
  let ref: number[] = [cols, cols]; let partial = false;
  const emit = (ch: number[]) => {
    const row = new Uint8Array(rowBytes).fill(black1 ? 0 : 255); // white
    for (let i = 0; i + 1 < ch.length; i += 2) { const s = Math.max(0, ch[i]), e = Math.min(cols, ch[i + 1]); for (let x = s; x < e; x++) { if (black1) row[x >> 3] |= 0x80 >> (x & 7); else row[x >> 3] &= ~(0x80 >> (x & 7)); } }
    if (ch.length & 1) { const s = Math.max(0, ch[ch.length - 1]); for (let x = s; x < cols; x++) { if (black1) row[x >> 3] |= 0x80 >> (x & 7); else row[x >> 3] &= ~(0x80 >> (x & 7)); } }
    out.push(row);
  };
  /** 1-D (Modified Huffman) row: alternating runs starting with white */
  const row1D = (): number[] | null => { const ch: number[] = []; let a = 0, white = true; while (a < cols) { const r = run(b, white); if (r < 0) return null; a += r; if (a > cols) a = cols; ch.push(a); white = !white; } if (!white && ch[ch.length - 1] >= cols) ch.pop(); if (white && ch.length && ch[ch.length - 1] >= cols) ch.pop(); return ch; };
  /** 2-D (READ) row against the reference row's changing elements */
  const row2D = (): number[] | null => {
    const ch: number[] = []; let a0 = -1, white = true; let i = 0;
    const b1At = () => { // first changing element on ref right of a0 with the colour opposite to a0's (even index = white→black)
      while (i > 0 && ref[i - 1] > a0) i--;
      while (i < ref.length && (ref[i] <= a0 || (i & 1) !== (white ? 0 : 1))) i++;
      return i;
    };
    for (let guard = 0; a0 < cols && guard < cols * 4 + 16; guard++) {
      const m = b.code(TM, 7); if (m === null || m === "X") return null;
      const k = b1At(); const b1 = k < ref.length ? ref[k] : cols, b2 = k + 1 < ref.length ? ref[k + 1] : cols;
      if (m === "P") { a0 = b2; continue; }
      if (m === "H") { const r1 = run(b, white), r2 = r1 < 0 ? -1 : run(b, !white); if (r1 < 0 || r2 < 0) return null; const s = Math.max(0, a0); const a1 = Math.min(cols, s + r1), a2 = Math.min(cols, a1 + r2); ch.push(a1, a2); a0 = a2; continue; }
      const off = m === "V0" ? 0 : (m[1] === "R" ? 1 : -1) * Number(m[2]); const a1 = Math.max(0, Math.min(cols, b1 + off));
      if (a1 < a0 && a0 >= 0) return null; // vertical code pointing behind a0: corrupt
      ch.push(a1); a0 = a1; white = !white;
    }
    while (ch.length && ch[ch.length - 1] >= cols) ch.pop();
    return ch;
  };
  for (let y = 0; y < maxRows; y++) {
    if (b.end) break;
    if (align && (K < 0 || !p.EndOfLine)) b.align();
    if (K >= 0) { // Group 3: optional EOL before each row; a block of EOLs (RTC) ends the data
      if (b.eol()) { let n = 1; while (n < 6) { const save = b.pos; if (K > 0) b.bit(); /* EOL+tag bit */ if (b.eol()) n++; else { b.pos = save; break; } } if (n >= 2 && eob) break; }
    } else if (eob && b.peek(24) === 0x001001) break; // EOFB
    let ch: number[] | null; const start = b.pos;
    if (K > 0) { const tag = b.bit(); ch = tag ? row1D() : row2D(); }
    else if (K === 0) ch = row1D();
    else ch = row2D();
    if (!ch) { if (!(out.length && b.restZero(start))) partial = true; break; } // trailing zero padding is not damage
    emit(ch); ref = [...ch, cols, cols];
  }
  if (p.Rows && p.Rows > 0 && out.length < maxRows) { partial = true; while (out.length < maxRows) out.push(new Uint8Array(rowBytes).fill(black1 ? 0 : 255)); } // pad to the (capped) row count
  const res = new Uint8Array(out.length * rowBytes); out.forEach((r, k) => res.set(r, k * rowBytes));
  // TT77: JBIG2 MMR regions (T.88 6.2.6) sit back to back in one segment, so the caller needs the bytes consumed,
  // including an EOFB that follows the last row
  if (K < 0 && b.peek(24) === 0x001001) b.pos += 24;
  return { data: res, rows: out.length, partial, consumed: Math.min(data.length, (b.pos + 7) >> 3) };
}
