/**
 * A QR encoder that produces real, scannable symbols — byte mode, versions 1–10,
 * all four error-correction levels, with the standard mask chosen by the standard
 * penalty score.
 *
 * Why write it: this app needs to hand a URL, a vCard or a Wi-Fi credential to a
 * phone without a network hop. A QR library is a dependency with an update treadmill;
 * the format is a *specification*, and a fixed 1–10 byte-mode subset is about 400
 * lines of arithmetic.
 *
 * What makes it honest rather than "it renders squares": the matrices this file emits
 * are compared **byte for byte** against Python's independent `qrcode` implementation
 * for a corpus of inputs at every version and level (`scripts/oracle/qr_oracle.py` →
 * `docs/test-fixtures/qr-oracle.json`, asserted by `scripts/tt151-qr.mts`). A wrong
 * Reed–Solomon polynomial, a wrong block split, a wrong format-info bit order or a
 * wrong mask choice shows up immediately as a differing module.
 *
 * Deliberate limits, stated so no caller assumes more: byte mode only (no kanji or
 * numeric/alpha compaction — that changes capacity, not correctness), versions 1–10
 * (≈271 bytes at L, ≈119 at H), SHA-1-free, and no structured-append.
 */

export type Ecc = "L" | "M" | "Q" | "H";

interface BlockSpec {
  /** Data codewords per block, group 1 then group 2. */
  dataPerBlock1: number;
  blocks1: number;
  dataPerBlock2: number;
  blocks2: number;
  ecPerBlock: number;
}

/** Versions 1–10. Total codewords, then the block structure per level. */
const CAPACITY: Record<number, { total: number; blocks: Record<Ecc, BlockSpec> }> = {
  1: { total: 26, blocks: {
    L: { dataPerBlock1: 19, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 7 },
    M: { dataPerBlock1: 16, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 10 },
    Q: { dataPerBlock1: 13, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 13 },
    H: { dataPerBlock1: 9, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 17 } } },
  2: { total: 44, blocks: {
    L: { dataPerBlock1: 34, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 10 },
    M: { dataPerBlock1: 28, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 16 },
    Q: { dataPerBlock1: 22, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 22 },
    H: { dataPerBlock1: 16, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 28 } } },
  3: { total: 70, blocks: {
    L: { dataPerBlock1: 55, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 15 },
    M: { dataPerBlock1: 44, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 26 },
    Q: { dataPerBlock1: 17, blocks1: 2, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 18 },
    H: { dataPerBlock1: 13, blocks1: 2, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 22 } } },
  4: { total: 100, blocks: {
    L: { dataPerBlock1: 80, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 20 },
    M: { dataPerBlock1: 32, blocks1: 2, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 18 },
    Q: { dataPerBlock1: 24, blocks1: 2, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 26 },
    H: { dataPerBlock1: 9, blocks1: 4, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 16 } } },
  5: { total: 134, blocks: {
    L: { dataPerBlock1: 108, blocks1: 1, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 26 },
    M: { dataPerBlock1: 43, blocks1: 2, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 24 },
    Q: { dataPerBlock1: 15, blocks1: 2, dataPerBlock2: 16, blocks2: 2, ecPerBlock: 18 },
    H: { dataPerBlock1: 11, blocks1: 2, dataPerBlock2: 12, blocks2: 2, ecPerBlock: 22 } } },
  6: { total: 172, blocks: {
    L: { dataPerBlock1: 68, blocks1: 2, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 18 },
    M: { dataPerBlock1: 27, blocks1: 4, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 16 },
    Q: { dataPerBlock1: 19, blocks1: 4, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 24 },
    H: { dataPerBlock1: 15, blocks1: 4, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 28 } } },
  7: { total: 196, blocks: {
    L: { dataPerBlock1: 78, blocks1: 2, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 20 },
    M: { dataPerBlock1: 31, blocks1: 4, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 18 },
    Q: { dataPerBlock1: 14, blocks1: 2, dataPerBlock2: 15, blocks2: 4, ecPerBlock: 18 },
    H: { dataPerBlock1: 13, blocks1: 4, dataPerBlock2: 14, blocks2: 1, ecPerBlock: 26 } } },
  8: { total: 242, blocks: {
    L: { dataPerBlock1: 97, blocks1: 2, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 24 },
    M: { dataPerBlock1: 38, blocks1: 2, dataPerBlock2: 39, blocks2: 2, ecPerBlock: 22 },
    Q: { dataPerBlock1: 18, blocks1: 4, dataPerBlock2: 19, blocks2: 2, ecPerBlock: 22 },
    H: { dataPerBlock1: 14, blocks1: 4, dataPerBlock2: 15, blocks2: 2, ecPerBlock: 26 } } },
  9: { total: 292, blocks: {
    L: { dataPerBlock1: 116, blocks1: 2, dataPerBlock2: 0, blocks2: 0, ecPerBlock: 30 },
    M: { dataPerBlock1: 36, blocks1: 3, dataPerBlock2: 37, blocks2: 2, ecPerBlock: 22 },
    Q: { dataPerBlock1: 16, blocks1: 4, dataPerBlock2: 17, blocks2: 4, ecPerBlock: 20 },
    H: { dataPerBlock1: 12, blocks1: 4, dataPerBlock2: 13, blocks2: 4, ecPerBlock: 24 } } },
  10: { total: 346, blocks: {
    L: { dataPerBlock1: 68, blocks1: 2, dataPerBlock2: 69, blocks2: 2, ecPerBlock: 18 },
    M: { dataPerBlock1: 43, blocks1: 4, dataPerBlock2: 44, blocks2: 1, ecPerBlock: 26 },
    Q: { dataPerBlock1: 19, blocks1: 6, dataPerBlock2: 20, blocks2: 2, ecPerBlock: 24 },
    H: { dataPerBlock1: 15, blocks1: 6, dataPerBlock2: 16, blocks2: 2, ecPerBlock: 28 } } },
};

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 10;

/** Alignment-pattern centres for versions 2–10 (version 1 has none). */
const ALIGNMENT: Record<number, number[]> = {
  2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const ECC_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

export function dataCodewords(version: number, ecc: Ecc): number {
  const spec = CAPACITY[version];
  if (!spec) throw new Error(`version ${version} is outside 1–${QR_MAX_VERSION}`);
  const b = spec.blocks[ecc];
  return b.dataPerBlock1 * b.blocks1 + b.dataPerBlock2 * b.blocks2;
}

export function ecCodewords(version: number, ecc: Ecc): number {
  const b = CAPACITY[version].blocks[ecc];
  return b.ecPerBlock * (b.blocks1 + b.blocks2);
}

/** Bytes of payload that fit in `version`/`ecc` in byte mode. */
export function byteCapacity(version: number, ecc: Ecc): number {
  const bits = dataCodewords(version, ecc) * 8;
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((bits - 4 - countBits) / 8);
}

export function smallestVersion(bytes: number, ecc: Ecc): number | null {
  for (let v = QR_MIN_VERSION; v <= QR_MAX_VERSION; v++) if (byteCapacity(v, ecc) >= bytes) return v;
  return null;
}

// ── Reed–Solomon over GF(256), primitive polynomial 0x11d ───────────────────

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >> 7) * 0x11d);
    z ^= ((y >> i) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial coefficients for `degree` EC codewords, highest power first. */
export function rsGenerator(degree: number): number[] {
  let poly = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
    root = gfMul(root, 2);
  }
  return poly;
}

export function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ── Bit stream ─────────────────────────────────────────────────────────────

class BitBuffer {
  bits: number[] = [];
  push(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
}

function encodeData(payload: Uint8Array, version: number, ecc: Ecc): number[] {
  const capacity = dataCodewords(version, ecc);
  const bb = new BitBuffer();
  bb.push(0b0100, 4); // byte mode
  bb.push(payload.length, version < 10 ? 8 : 16);
  for (const b of payload) bb.push(b, 8);
  const capBits = capacity * 8;
  if (bb.length > capBits) throw new Error(`payload does not fit ${version}-${ecc}`);
  bb.push(0, Math.min(4, capBits - bb.length)); // terminator
  while (bb.length % 8 !== 0) bb.push(0, 1);
  const out: number[] = [];
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
    out.push(byte);
  }
  // Alternate pad bytes, exactly as the spec says — not zeros.
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Split into blocks, append EC, then interleave data and EC codewords. */
export function buildCodewords(payload: Uint8Array, version: number, ecc: Ecc): { data: number[]; ec: number[]; interleaved: number[] } {
  const spec = CAPACITY[version].blocks[ecc];
  const data = encodeData(payload, version, ecc);
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let pos = 0;
  for (let i = 0; i < spec.blocks1; i++) {
    const block = data.slice(pos, pos + spec.dataPerBlock1);
    pos += spec.dataPerBlock1;
    blocks.push(block);
    ecBlocks.push(rsRemainder(block, spec.ecPerBlock));
  }
  for (let i = 0; i < spec.blocks2; i++) {
    const block = data.slice(pos, pos + spec.dataPerBlock2);
    pos += spec.dataPerBlock2;
    blocks.push(block);
    ecBlocks.push(rsRemainder(block, spec.ecPerBlock));
  }
  if (pos !== data.length) throw new Error("block split consumed the wrong number of codewords");
  const interleaved: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) interleaved.push(b[i]);
  for (let i = 0; i < spec.ecPerBlock; i++) for (const b of ecBlocks) interleaved.push(b[i]);
  return { data, ec: ecBlocks.flat(), interleaved };
}

// ── Matrix ─────────────────────────────────────────────────────────────────

export interface QrSymbol {
  version: number;
  ecc: Ecc;
  size: number;
  mask: number;
  /** modules[y][x] === true means dark. */
  modules: boolean[][];
  text: string;
}

type Cell = boolean | null;

function emptyMatrix(size: number): Cell[][] {
  return Array.from({ length: size }, () => new Array<Cell>(size).fill(null));
}

function placeFinder(m: Cell[][], cx: number, cy: number) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || y >= m.length || x >= m.length) continue;
      const inRing = (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6) && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
      const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      m[y][x] = inRing || inCore;
    }
  }
}

function placeAlignment(m: Cell[][], version: number) {
  const centres = ALIGNMENT[version] ?? [];
  const last = centres.length - 1;
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      // Skip the three that would collide with finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cx = centres[i], cy = centres[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          m[cy + dy][cx + dx] = ring !== 1;
        }
      }
    }
  }
}

function placeTiming(m: Cell[][]) {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0;
    if (m[6][i] === null) m[6][i] = bit;
    if (m[i][6] === null) m[i][6] = bit;
  }
}

function reservedForFormat(m: Cell[][], size: number) {
  // Mark the format-info cells as reserved so data placement skips them.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) { if (m[8][i] === null) m[8][i] = false; if (m[i][8] === null) m[i][8] = false; }
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
  }
  if (m[8][8] === null) m[8][8] = false;
  if (m[8][6] === null) m[8][6] = false;
  if (m[6][8] === null) m[6][8] = false;
  // Version info (7×3 and 3×7 blocks) exists from version 7 up.
  return m;
}

function placeData(m: Cell[][], codewords: number[]) {
  const size = m.length;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const bitAt = (i: number) => (i < totalBits ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0);
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is not part of the data region
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (let c = 0; c < 2; c++) {
        const x = right - c;
        if (m[y][x] !== null) continue;
        m[y][x] = bitAt(bitIndex) === 1;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

const MASKS: ((y: number, x: number) => boolean)[] = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_y, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

function formatBits(ecc: Ecc, mask: number): number[] {
  const data = (ECC_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  // The placement order below is least-significant bit first (ISO 18004 §8.9), which is
  // why this returns LSB-first: bit 0 sits at (8,0), not bit 14. Getting this backwards
  // produces a symbol a scanner reads as the wrong mask — every module still "looks right".
  return Array.from({ length: 15 }, (_, i) => (bits >> i) & 1);
}

function placeFormat(m: Cell[][], ecc: Ecc, mask: number) {
  const size = m.length;
  const bits = formatBits(ecc, mask);
  // Copy 1: around the top-left finder.
  const coords1: [number, number][] = [];
  for (let i = 0; i <= 5; i++) coords1.push([8, i]);
  coords1.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) coords1.push([14 - i, 8]);
  coords1.forEach(([x, y], i) => { m[y][x] = bits[i] === 1; });
  // Copy 2: split between top-right and bottom-left.
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bits[i] === 1;
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bits[i] === 1;
  m[size - 8][8] = true; // the always-dark module
}

function versionBits(version: number): number[] {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  return Array.from({ length: 18 }, (_, i) => (bits >> i) & 1);
}

function placeVersion(m: Cell[][], version: number) {
  if (version < 7) return;
  const size = m.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = bits[i] === 1;
    const a = Math.floor(i / 3);
    const b = i % 3;
    m[size - 11 + b][a] = bit;
    m[a][size - 11 + b] = bit;
  }
}

function applyMask(m: Cell[][], mask: number, reserved: boolean[][]): boolean[][] {
  const fn = MASKS[mask];
  return m.map((row, y) => row.map((cell, x) => {
    const dark = cell === true;
    return reserved[y][x] ? dark : dark !== fn(y, x);
  }));
}

/**
 * Which cells are function patterns (and therefore never masked).
 *
 * This is computed by running the *same* placement primitives into a scratch matrix
 * rather than by a second, hand-written geometry pass. The first version of this file
 * did have a hand-written pass, and it reserved one column too many beside the top-right
 * finder — a bug invisible in the render and fatal to a scanner. The oracle caught it
 * as exactly eight differing modules along row 12 and column 12.
 */
function functionMap(version: number): boolean[][] {
  const size = version * 4 + 17;
  const cells = emptyMatrix(size);
  placeFinder(cells, 0, 0);
  placeFinder(cells, size - 7, 0);
  placeFinder(cells, 0, size - 7);
  placeAlignment(cells, version);
  placeTiming(cells);
  reservedForFormat(cells, size);
  placeVersion(cells, version);
  return cells.map((row) => row.map((c) => c !== null));
}

export interface PenaltyBreakdown { rule1: number; rule2: number; rule3: number; rule4: number; total: number }

/** The standard penalty score (rules 1–4), used to pick the mask. */
export function penaltyScore(m: boolean[][]): number {
  return penaltyBreakdown(m).total;
}

/** The four rules separately — the mask choice depends on their sum, and a test that
 *  can only see the sum cannot say *which* rule is over-firing. */
export function penaltyBreakdown(m: boolean[][]): PenaltyBreakdown {
  const size = m.length;
  let rule1 = 0, rule2 = 0, rule3 = 0, rule4 = 0;
  const at = (y: number, x: number) => (y >= 0 && x >= 0 && y < size && x < size ? m[y][x] : false);
  // Rule 1: runs of five or more same-coloured modules.
  for (const horizontal of [true, false]) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const cur = horizontal ? at(a, b) : at(b, a);
        const prev = horizontal ? at(a, b - 1) : at(b - 1, a);
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) rule1 += run - 2;
          run = 1;
        }
      }
      if (run >= 5) rule1 += run - 2;
    }
  }
  // Rule 2: 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = at(y, x);
      if (v === at(y, x + 1) && v === at(y + 1, x) && v === at(y + 1, x + 1)) rule2 += 3;
    }
  }
  // Rule 3: the 1:1:3:1:1 finder-like pattern with four light modules on one side.
  const pattern = [true, false, true, true, true, false, true];
  const matches = (y: number, x: number, dy: number, dx: number) => {
    for (let i = 0; i < 7; i++) if (at(y + dy * i, x + dx * i) !== pattern[i]) return false;
    return true;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [dy, dx] of [[0, 1], [1, 0]] as const) {
        if (!matches(y, x, dy, dx)) continue;
        const before = [1, 2, 3, 4].every((k) => !at(y - dy * k, x - dx * k));
        const after = [7, 8, 9, 10].every((k) => !at(y + dy * k, x + dx * k));
        if (before) rule3 += 40;
        if (after) rule3 += 40;
      }
    }
  }
  // Rule 4: deviation from 50% dark.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (at(y, x)) dark++;
  const total = size * size;
  const percent = (dark * 100) / total;
  rule4 += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return { rule1, rule2, rule3, rule4, total: rule1 + rule2 + rule3 + rule4 };
}

export interface EncodeOptions {
  ecc?: Ecc;
  /** Force a version; by default the smallest that fits is chosen. */
  version?: number;
  /** Force a mask 0–7; by default every mask is scored and the lowest penalty wins. */
  mask?: number;
}

export type EncodeResult = { ok: true; symbol: QrSymbol } | { ok: false; error: string };

export function encodeQr(input: string | Uint8Array, opts: EncodeOptions = {}): EncodeResult {
  const ecc = opts.ecc ?? "M";
  const payload = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (payload.length === 0) return { ok: false, error: "nothing to encode" };
  const version = opts.version ?? smallestVersion(payload.length, ecc);
  if (version === null) return { ok: false, error: `${payload.length} bytes exceed version ${QR_MAX_VERSION}-${ecc}` };
  if (version < QR_MIN_VERSION || version > QR_MAX_VERSION) return { ok: false, error: `version ${version} is outside 1–${QR_MAX_VERSION}` };
  if (byteCapacity(version, ecc) < payload.length) {
    return { ok: false, error: `${payload.length} bytes do not fit version ${version}-${ecc} (max ${byteCapacity(version, ecc)})` };
  }
  const size = version * 4 + 17;
  const reserved = functionMap(version);
  const build = (mask: number) => {
    const m = emptyMatrix(size);
    placeFinder(m, 0, 0);
    placeFinder(m, size - 7, 0);
    placeFinder(m, 0, size - 7);
    placeAlignment(m, version);
    placeTiming(m);
    reservedForFormat(m, size);
    placeVersion(m, version);
    const { interleaved } = buildCodewords(payload, version, ecc);
    placeData(m, interleaved);
    placeFormat(m, ecc, mask);
    return applyMask(m, mask, reserved);
  };
  let mask = opts.mask;
  let modules = build(mask ?? 0);
  if (mask === undefined) {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      const candidateModules = build(candidate);
      const score = penaltyScore(candidateModules);
      if (score < best) { best = score; mask = candidate; modules = candidateModules; }
    }
  }
  const text = modules.map((row) => row.map((d) => (d ? "#" : ".")).join("")).join("\n");
  return { ok: true, symbol: { version, ecc, size, mask: mask!, modules, text } };
}

/**
 * SVG with a four-module quiet zone — the margin the spec requires and the first
 * thing hand-rolled generators forget, which is why a phone camera refuses them.
 */
export function qrToSvg(symbol: QrSymbol, opts: { moduleSize?: number; quietZone?: number; dark?: string; light?: string } = {}): string {
  const ms = opts.moduleSize ?? 4;
  const qz = opts.quietZone ?? 4;
  const dim = (symbol.size + qz * 2) * ms;
  const dark = opts.dark ?? "#000";
  const light = opts.light ?? "#fff";
  let path = "";
  for (let y = 0; y < symbol.size; y++) {
    for (let x = 0; x < symbol.size; x++) {
      if (!symbol.modules[y][x]) continue;
      path += `M${(x + qz) * ms} ${(y + qz) * ms}h${ms}v${ms}h-${ms}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code, version ${symbol.version}, ${symbol.ecc} error correction"><rect width="${dim}" height="${dim}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
