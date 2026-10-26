/**
 * TT48 — MS-CFB (compound file) writer, original code from the [MS-CFB] specification.
 * Version 3 (512-byte sectors), 64-byte mini sectors below the 4096-byte cutoff, FAT + DIFAT (any size), directory
 * siblings stored as a balanced binary search tree in [MS-CFB] 2.6.4 order (all nodes black, which every reader
 * accepts; Microsoft's own reader does not require the red-black colouring to be re-derived).
 */
type Bytes = Uint8Array;
export interface CfbNode { name: string; data?: Bytes; children?: CfbNode[] }

const SS = 512, MSS = 64, CUTOFF = 4096;
const FREE = 0xffffffff, END = 0xfffffffe, FATSECT = 0xfffffffd, DIFSECT = 0xfffffffc, NOSTREAM = 0xffffffff;

/** [MS-CFB] 2.6.4: shorter names sort first; equal lengths compare code points after simple upper-casing. */
export function cfbCompare(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const A = a.toUpperCase(), B = b.toUpperCase();
  for (let i = 0; i < A.length; i++) { const d = A.charCodeAt(i) - B.charCodeAt(i); if (d) return d; }
  return 0;
}

interface Entry { name: string; type: 1 | 2 | 5; data?: Bytes; left: number; right: number; child: number; start: number; size: number }

export function writeCfb(rootChildren: CfbNode[]): Bytes {
  // ---- directory (index 0 = root)
  const entries: Entry[] = [{ name: "Root Entry", type: 5, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, start: END, size: 0 }];
  const addLevel = (nodes: CfbNode[]): number => {
    for (const n of nodes) {
      if (!n.name || n.name.length > 31 || /[\/\\:!]/.test(n.name)) throw new Error(`cfb: invalid entry name ${JSON.stringify(n.name)}`);
    }
    const sorted = [...nodes].sort((x, y) => cfbCompare(x.name, y.name));
    for (let i = 1; i < sorted.length; i++) if (cfbCompare(sorted[i - 1].name, sorted[i].name) === 0) throw new Error(`cfb: duplicate name ${sorted[i].name}`);
    const ids = sorted.map((n) => {
      const id = entries.length;
      entries.push({ name: n.name, type: n.children ? 1 : 2, data: n.data, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, start: n.children ? 0 : END, size: n.children ? 0 : (n.data?.length ?? 0) });
      return id;
    });
    sorted.forEach((n, i) => { if (n.children) entries[ids[i]].child = addLevel(n.children); });
    const build = (lo: number, hi: number): number => {
      if (lo > hi) return NOSTREAM;
      const mid = (lo + hi) >> 1; const e = entries[ids[mid]];
      e.left = build(lo, mid - 1); e.right = build(mid + 1, hi);
      return ids[mid];
    };
    return build(0, sorted.length - 1);
  };
  entries[0].child = addLevel(rootChildren);

  // ---- mini stream (streams below the cutoff) and regular streams
  const small = entries.filter((e) => e.type === 2 && e.size > 0 && e.size < CUTOFF);
  const big = entries.filter((e) => e.type === 2 && e.size >= CUTOFF);
  let miniSecs = 0; const miniFat: number[] = [];
  for (const e of small) {
    const n = Math.ceil(e.size / MSS); e.start = miniSecs;
    for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? END : miniSecs + i + 1);
    miniSecs += n;
  }
  for (const e of entries) if (e.type === 2 && e.size === 0) e.start = END;
  const miniStreamSize = miniSecs * MSS;
  const nMiniStream = Math.ceil(miniStreamSize / SS), nMiniFat = Math.ceil((miniFat.length * 4) / SS);
  const nDir = Math.ceil((entries.length * 128) / SS);
  const nBig = big.reduce((s, e) => s + Math.ceil(e.size / SS), 0);
  const data = nDir + nMiniFat + nMiniStream + nBig;
  let nFat = 1, nDifat = 0;
  for (;;) {
    const difat = nFat > 109 ? Math.ceil((nFat - 109) / (SS / 4 - 1)) : 0;
    const fat = Math.ceil((data + nFat + difat) / (SS / 4));
    if (fat === nFat && difat === nDifat) break;
    nFat = fat; nDifat = difat;
  }
  const total = nFat + nDifat + data;
  const fat = new Uint32Array(nFat * (SS / 4)).fill(FREE);
  let next = 0;
  const alloc = (n: number, mark?: number): number => {
    const start = next;
    for (let i = 0; i < n; i++) fat[next + i] = mark ?? (i === n - 1 ? END : next + i + 1);
    next += n; return n ? start : END;
  };
  const fatStart = alloc(nFat, FATSECT), difatStart = alloc(nDifat, DIFSECT);
  const dirStart = alloc(nDir), miniFatStart = alloc(nMiniFat), miniStart = alloc(nMiniStream);
  for (const e of big) e.start = alloc(Math.ceil(e.size / SS));
  if (next !== total) throw new Error("cfb: allocation mismatch");
  entries[0].start = nMiniStream ? miniStart : END; entries[0].size = miniStreamSize;

  // ---- bytes
  const out = new Uint8Array((total + 1) * SS); const dv = new DataView(out.buffer);
  const sec = (s: number) => (s + 1) * SS;
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  dv.setUint16(24, 0x3e, true); dv.setUint16(26, 3, true); dv.setUint16(28, 0xfffe, true); dv.setUint16(30, 9, true); dv.setUint16(32, 6, true);
  dv.setUint32(44, nFat, true); dv.setUint32(48, dirStart, true); dv.setUint32(56, CUTOFF, true);
  dv.setUint32(60, nMiniFat ? miniFatStart : END, true); dv.setUint32(64, nMiniFat, true);
  dv.setUint32(68, nDifat ? difatStart : END, true); dv.setUint32(72, nDifat, true);
  for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i < nFat ? fatStart + i : FREE, true);
  for (let d = 0; d < nDifat; d++) {
    const o = sec(difatStart + d); const per = SS / 4 - 1;
    for (let i = 0; i < per; i++) { const k = 109 + d * per + i; dv.setUint32(o + i * 4, k < nFat ? fatStart + k : FREE, true); }
    dv.setUint32(o + SS - 4, d === nDifat - 1 ? END : difatStart + d + 1, true);
  }
  for (let i = 0; i < fat.length; i++) dv.setUint32(sec(fatStart) + i * 4, fat[i], true); // FAT sectors are contiguous
  entries.forEach((e, i) => {
    const o = sec(dirStart) + i * 128;
    for (let k = 0; k < e.name.length; k++) dv.setUint16(o + k * 2, e.name.charCodeAt(k), true);
    dv.setUint16(o + 64, (e.name.length + 1) * 2, true);
    out[o + 66] = e.type; out[o + 67] = 1; // black
    dv.setUint32(o + 68, e.left, true); dv.setUint32(o + 72, e.right, true); dv.setUint32(o + 76, e.child, true);
    dv.setUint32(o + 116, e.start, true); dv.setUint32(o + 120, e.size >>> 0, true); dv.setUint32(o + 124, 0, true);
  });
  for (let i = entries.length; i < nDir * 4; i++) { const o = sec(dirStart) + i * 128; dv.setUint32(o + 68, NOSTREAM, true); dv.setUint32(o + 72, NOSTREAM, true); dv.setUint32(o + 76, NOSTREAM, true); }
  for (let i = 0; i < nMiniFat * (SS / 4); i++) dv.setUint32(sec(miniFatStart) + i * 4, i < miniFat.length ? miniFat[i] : FREE, true);
  for (const e of small) out.set(e.data!, sec(miniStart) + e.start * MSS); // mini stream sectors are contiguous
  for (const e of big) out.set(e.data!, sec(e.start));
  return out;
}
