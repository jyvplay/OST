/** Test-only ISO-BMFF box-tree rewriter used to build hostile/unusual MP4 shapes for the TT53 suite. */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "udta"]);
export type Visit = (path: string, type: string, body: Uint8Array) => Uint8Array | null | undefined; // undefined = keep, null = drop

function u32(n: number) { return Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
function cat(parts: Uint8Array[]) { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let q = 0; for (const p of parts) { o.set(p, q); q += p.length; } return o; }
export function box(type: string, body: Uint8Array) { return cat([u32(body.length + 8), Uint8Array.from(type, (c) => c.charCodeAt(0)), body]); }
export interface RawBox { type: string; start: number; hdr: number; end: number }
export function list(b: Uint8Array, start: number, end: number): RawBox[] {
  const out: RawBox[] = []; let p = start; const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (p + 8 <= end) {
    let size = v.getUint32(p); const type = String.fromCharCode(...b.subarray(p + 4, p + 8)); let hdr = 8;
    if (size === 1) { size = v.getUint32(p + 8) * 2 ** 32 + v.getUint32(p + 12); hdr = 16; } else if (size === 0) size = end - p;
    out.push({ type, start: p, hdr, end: p + size }); p += size;
  }
  return out;
}
function walk(b: Uint8Array, bx: RawBox, path: string, fn: Visit): Uint8Array | null {
  const body = b.subarray(bx.start + bx.hdr, bx.end); const here = path ? `${path}/${bx.type}` : bx.type;
  let nb: Uint8Array;
  if (CONTAINERS.has(bx.type)) { const kids = list(b, bx.start + bx.hdr, bx.end).map((k) => walk(b, k, here, fn)).filter((x): x is Uint8Array => x !== null); nb = cat(kids); }
  else nb = body;
  const r = fn(here, bx.type, nb);
  if (r === null) return null;
  return box(bx.type, r ?? nb);
}
/** rewrite the moov tree; top-level boxes other than moov are copied verbatim (so only safe for size changes when mdat precedes moov) */
export function rewrite(b: Uint8Array, fn: Visit): Uint8Array {
  return cat(list(b, 0, b.length).map((t) => (t.type === "moov" ? walk(b, t, "", fn) ?? new Uint8Array(0) : b.subarray(t.start, t.end))));
}
export const be32 = u32;
