/**
 * TT52 — PDF functions (ISO 32000-2 §7.10: types 0, 2, 3, 4) and colour spaces (§8.6): DeviceGray/RGB/CMYK, CalGray,
 * CalRGB, Lab, ICCBased (by /N with /Alternate; ICC profiles are not interpreted), Indexed, Separation, DeviceN, Pattern.
 * Original code from the specification. CMYK → RGB uses the simple complement formula of §10.4.2 (no ICC conversion).
 */
import { PDict, PName, PStr, isArr, isDict, isName, isNum, isStream, type PObj, type Bytes } from "./pdfobj";
import type { PdfDoc } from "./pdfdoc";

/* ================================================================== functions */
export type PdfFn = (inp: number[]) => number[];
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function loadFunction(doc: PdfDoc, o: PObj | undefined, depth = 0): PdfFn | null {
  if (depth > 8) return null;
  const r = doc.resolve(o);
  if (isArr(r)) { // array of 1-output functions → one n-output function
    const fs = r.map((x) => loadFunction(doc, x, depth + 1)); if (fs.some((f) => !f)) return null;
    return (inp) => fs.map((f) => f!(inp)[0]);
  }
  const d = isStream(r) ? r.dict : isDict(r) ? r : null; if (!d) return null;
  const type = doc.num(d.get("FunctionType"), -1);
  const domain = doc.arr(d.get("Domain")).map((x) => doc.num(x));
  const range = doc.arr(d.get("Range")).map((x) => doc.num(x));
  const clipIn = (inp: number[]) => inp.map((v, i) => (domain.length >= 2 * i + 2 ? clamp(v, domain[2 * i], domain[2 * i + 1]) : v));
  const clipOut = (out: number[]) => (range.length ? out.map((v, i) => (range.length >= 2 * i + 2 ? clamp(v, range[2 * i], range[2 * i + 1]) : v)) : out);
  if (type === 2) {
    const c0 = d.has("C0") ? doc.arr(d.get("C0")).map((x) => doc.num(x)) : [0];
    const c1 = d.has("C1") ? doc.arr(d.get("C1")).map((x) => doc.num(x)) : [1];
    const n = doc.num(d.get("N"), 1);
    return (inp) => { const x = clipIn(inp)[0] ?? 0; const xn = n === 1 ? x : Math.pow(Math.max(0, x), n); return clipOut(c0.map((a, i) => a + xn * ((c1[i] ?? 0) - a))); };
  }
  if (type === 3) {
    const fns = doc.arr(d.get("Functions")).map((x) => loadFunction(doc, x, depth + 1));
    const bounds = doc.arr(d.get("Bounds")).map((x) => doc.num(x)); const enc = doc.arr(d.get("Encode")).map((x) => doc.num(x));
    if (fns.some((f) => !f) || !fns.length) return null;
    return (inp) => {
      const x = clipIn(inp)[0] ?? 0; const d0 = domain[0] ?? 0, d1 = domain[1] ?? 1;
      let k = 0; while (k < bounds.length && x >= bounds[k]) k++;
      const lo = k === 0 ? d0 : bounds[k - 1], hi = k === bounds.length ? d1 : bounds[k];
      const e0 = enc[2 * k] ?? 0, e1 = enc[2 * k + 1] ?? 1;
      const t = hi === lo ? e0 : e0 + ((x - lo) * (e1 - e0)) / (hi - lo);
      return clipOut(fns[Math.min(k, fns.length - 1)]!([t]));
    };
  }
  if (type === 0 && isStream(r)) {
    const size = doc.arr(d.get("Size")).map((x) => doc.num(x)); const bps = doc.num(d.get("BitsPerSample"), 8);
    const m = size.length; const nOut = range.length / 2; if (!m || !nOut || m > 8) return null;
    const enc = d.has("Encode") ? doc.arr(d.get("Encode")).map((x) => doc.num(x)) : size.flatMap((s) => [0, s - 1]);
    const dec = d.has("Decode") ? doc.arr(d.get("Decode")).map((x) => doc.num(x)) : range;
    const data = doc.decode(r).data; const maxv = Math.pow(2, bps) - 1;
    const sample = (idx: number, j: number) => {
      const bit = (idx * nOut + j) * bps;
      if (bps === 8) return data[bit >> 3] ?? 0; if (bps === 16) return ((data[bit >> 3] << 8) | data[(bit >> 3) + 1]) || 0;
      let v = 0; for (let b = 0; b < bps; b++) { const bb = bit + b; v = v * 2 + (((data[bb >> 3] ?? 0) >> (7 - (bb & 7))) & 1); } return v;
    };
    return (inp) => {
      const x = clipIn(inp);
      // multilinear interpolation over the m-dimensional sample grid
      const e = x.map((v, i) => { const d0 = domain[2 * i] ?? 0, d1 = domain[2 * i + 1] ?? 1; const t = d1 === d0 ? enc[2 * i] : enc[2 * i] + ((v - d0) * (enc[2 * i + 1] - enc[2 * i])) / (d1 - d0); return clamp(t, 0, size[i] - 1); });
      const out = new Array(nOut).fill(0);
      const corners = 1 << m;
      for (let c = 0; c < corners; c++) {
        let w = 1, idx = 0, mul = 1;
        for (let i = 0; i < m; i++) {
          const f = Math.floor(e[i]), fr = e[i] - f; const hi = (c >> i) & 1;
          const k = Math.min(size[i] - 1, f + hi); w *= hi ? fr : 1 - fr; idx += k * mul; mul *= size[i];
        }
        if (w === 0) continue;
        for (let j = 0; j < nOut; j++) out[j] += w * sample(idx, j);
      }
      return clipOut(out.map((v, j) => dec[2 * j] + (v * (dec[2 * j + 1] - dec[2 * j])) / maxv));
    };
  }
  if (type === 4 && isStream(r)) {
    const prog = compilePS(new TextDecoder("latin1").decode(doc.decode(r).data)); if (!prog) return null;
    return (inp) => { const st = clipIn(inp).slice(); runPS(prog, st, 0); return clipOut(st.slice(Math.max(0, st.length - range.length / 2))); };
  }
  return null;
}
type PSOp = number | string | { ifp: PSOp[]; elsep?: PSOp[] };
function compilePS(src: string): PSOp[] | null {
  const toks = src.match(/[{}]|[^\s{}]+/g) ?? []; let i = 0;
  const block = (): PSOp[] => {
    const out: PSOp[] = [];
    while (i < toks.length) {
      const t = toks[i++];
      if (t === "{") { const b = block(); const nx = toks[i];
        if (nx === "{") { i++; const e = block(); if (toks[i] === "ifelse") { i++; out.push({ ifp: b, elsep: e }); } }
        else if (nx === "if") { i++; out.push({ ifp: b }); } else out.push(...b); }
      else if (t === "}") return out;
      else if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) out.push(parseFloat(t));
      else out.push(t);
    }
    return out;
  };
  if (toks[i] === "{") i++;
  try { return block(); } catch { return null; }
}
function runPS(prog: PSOp[], st: number[], depth: number) {
  if (depth > 32) return;
  const pop = () => st.pop() ?? 0;
  for (const op of prog) {
    if (st.length > 1000) return;
    if (typeof op === "number") { st.push(op); continue; }
    if (typeof op === "object") { const c = pop(); if (c) runPS(op.ifp, st, depth + 1); else if (op.elsep) runPS(op.elsep, st, depth + 1); continue; }
    let a: number, b: number;
    switch (op) {
      case "add": b = pop(); a = pop(); st.push(a + b); break; case "sub": b = pop(); a = pop(); st.push(a - b); break;
      case "mul": b = pop(); a = pop(); st.push(a * b); break; case "div": b = pop(); a = pop(); st.push(b ? a / b : 0); break;
      case "idiv": b = pop(); a = pop(); st.push(b ? Math.trunc(a / b) : 0); break; case "mod": b = pop(); a = pop(); st.push(b ? a % b : 0); break;
      case "neg": st.push(-pop()); break; case "abs": st.push(Math.abs(pop())); break;
      case "ceiling": st.push(Math.ceil(pop())); break; case "floor": st.push(Math.floor(pop())); break;
      case "round": st.push(Math.round(pop())); break; case "truncate": st.push(Math.trunc(pop())); break;
      case "sqrt": st.push(Math.sqrt(Math.max(0, pop()))); break;
      case "sin": st.push(Math.sin((pop() * Math.PI) / 180)); break; case "cos": st.push(Math.cos((pop() * Math.PI) / 180)); break;
      case "atan": { b = pop(); a = pop(); let d = (Math.atan2(a, b) * 180) / Math.PI; if (d < 0) d += 360; st.push(d); break; }
      case "exp": b = pop(); a = pop(); st.push(Math.pow(a, b)); break;
      case "ln": st.push(Math.log(pop())); break; case "log": st.push(Math.log10(pop())); break;
      case "cvi": st.push(Math.trunc(pop())); break; case "cvr": break;
      case "eq": b = pop(); a = pop(); st.push(a === b ? 1 : 0); break; case "ne": b = pop(); a = pop(); st.push(a !== b ? 1 : 0); break;
      case "gt": b = pop(); a = pop(); st.push(a > b ? 1 : 0); break; case "ge": b = pop(); a = pop(); st.push(a >= b ? 1 : 0); break;
      case "lt": b = pop(); a = pop(); st.push(a < b ? 1 : 0); break; case "le": b = pop(); a = pop(); st.push(a <= b ? 1 : 0); break;
      case "and": b = pop(); a = pop(); st.push(a & b); break; case "or": b = pop(); a = pop(); st.push(a | b); break;
      case "xor": b = pop(); a = pop(); st.push(a ^ b); break; case "not": a = pop(); st.push(a === 0 ? 1 : a === 1 ? 0 : ~a); break;
      case "bitshift": b = pop(); a = pop(); st.push(b >= 0 ? a << b : a >> -b); break;
      case "true": st.push(1); break; case "false": st.push(0); break;
      case "pop": pop(); break; case "dup": st.push(st[st.length - 1] ?? 0); break;
      case "exch": b = pop(); a = pop(); st.push(b, a); break;
      case "copy": { const n = pop(); if (n > 0 && n <= st.length) st.push(...st.slice(st.length - n)); break; }
      case "index": { const n = pop(); st.push(st[st.length - 1 - n] ?? 0); break; }
      case "roll": { const j = pop(), n = pop(); if (n > 0 && n <= st.length) { const part = st.splice(st.length - n, n); const s = ((j % n) + n) % n; st.push(...part.slice(n - s), ...part.slice(0, n - s)); } break; }
      default: break;
    }
  }
}

/* ================================================================== colour spaces */
export interface ColorSpace {
  name: string; n: number;
  /** components (in the space's ranges) → sRGB 0..255 */
  rgb(c: number[]): [number, number, number];
  initial(): number[];
  /** Decode default for images */
  defaultDecode(bpc: number): number[];
  base?: ColorSpace; pattern?: boolean;
}
const to8 = (v: number) => Math.round(clamp(v, 0, 1) * 255);
export const DeviceGray: ColorSpace = { name: "DeviceGray", n: 1, rgb: (c) => { const g = to8(c[0] ?? 0); return [g, g, g]; }, initial: () => [0], defaultDecode: () => [0, 1] };
export const DeviceRGB: ColorSpace = { name: "DeviceRGB", n: 3, rgb: (c) => [to8(c[0] ?? 0), to8(c[1] ?? 0), to8(c[2] ?? 0)], initial: () => [0, 0, 0], defaultDecode: () => [0, 1, 0, 1, 0, 1] };
export function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  return [to8((1 - c) * (1 - k)), to8((1 - m) * (1 - k)), to8((1 - y) * (1 - k))];
}
export const DeviceCMYK: ColorSpace = { name: "DeviceCMYK", n: 4, rgb: (c) => cmykToRgb(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1), initial: () => [0, 0, 0, 1], defaultDecode: () => [0, 1, 0, 1, 0, 1, 0, 1] };
function labSpace(doc: PdfDoc, d: PDict | null): ColorSpace {
  const wp = d ? doc.arr(d.get("WhitePoint")).map((x) => doc.num(x)) : []; const [Xw, Yw, Zw] = wp.length === 3 ? wp : [0.9505, 1, 1.089];
  const rg = d ? doc.arr(d.get("Range")).map((x) => doc.num(x)) : []; const range = rg.length === 4 ? rg : [-100, 100, -100, 100];
  const g = (x: number) => (x >= 6 / 29 ? x * x * x : (108 / 841) * (x - 4 / 29));
  const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  return {
    name: "Lab", n: 3, initial: () => [0, clamp(0, range[0], range[1]), clamp(0, range[2], range[3])],
    defaultDecode: () => [0, 100, range[0], range[1], range[2], range[3]],
    rgb: (c) => {
      const L = c[0] ?? 0, a = clamp(c[1] ?? 0, range[0], range[1]), b = clamp(c[2] ?? 0, range[2], range[3]);
      const M = (L + 16) / 116; const X = Xw * g(M + a / 500), Y = Yw * g(M), Z = Zw * g(M - b / 200);
      // XYZ (D65-ish white) → linear sRGB (IEC 61966-2-1 matrix), Bradford adaptation omitted
      const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, bl = 0.0557 * X - 0.204 * Y + 1.057 * Z;
      return [to8(srgb(r)), to8(srgb(gg)), to8(srgb(bl))];
    },
  };
}
export function loadColorSpace(doc: PdfDoc, o: PObj | undefined, resources: PDict | null, depth = 0): ColorSpace {
  if (depth > 8) return DeviceGray;
  let r = doc.resolve(o);
  if (isName(r)) {
    switch (r.n) {
      case "DeviceGray": case "G": case "CalGray": return DeviceGray;
      case "DeviceRGB": case "RGB": case "CalRGB": return DeviceRGB;
      case "DeviceCMYK": case "CMYK": return DeviceCMYK;
      case "Pattern": return { name: "Pattern", n: 1, pattern: true, rgb: () => [0, 0, 0], initial: () => [0], defaultDecode: () => [0, 1] };
      case "Indexed": case "I": return DeviceGray;
    }
    const csd = resources ? doc.dict(resources.get("ColorSpace")) : null;
    const named = csd ? doc.resolve(csd.get(r.n)) : undefined;
    if (named !== undefined && named !== null) return loadColorSpace(doc, named, resources, depth + 1);
    return DeviceGray;
  }
  if (!isArr(r) || !r.length) return DeviceGray;
  const fam = doc.resolve(r[0]); const fn = isName(fam) ? fam.n : "";
  switch (fn) {
    case "CalGray": return DeviceGray;
    case "CalRGB": return DeviceRGB;
    case "Lab": return labSpace(doc, doc.dict(r[1]));
    case "ICCBased": {
      const s = doc.resolve(r[1]); const d = isStream(s) ? s.dict : null;
      const n = d ? doc.num(d.get("N"), 0) : 0; const alt = d?.get("Alternate");
      if (alt) { const a = loadColorSpace(doc, alt, resources, depth + 1); if (a.n === n || !n) return a; }
      return n === 1 ? DeviceGray : n === 4 ? DeviceCMYK : DeviceRGB;
    }
    case "Indexed": case "I": {
      const base = loadColorSpace(doc, r[1], resources, depth + 1); const hival = clamp(Math.floor(doc.num(r[2], 0)), 0, 255);
      const lk = doc.resolve(r[3]); let table: Bytes = lk instanceof PStr ? lk.b : isStream(lk) ? doc.decode(lk).data : new Uint8Array(0);
      const pal: [number, number, number][] = [];
      const bd = base.defaultDecode(8);
      for (let i = 0; i <= hival; i++) { const comps: number[] = []; for (let j = 0; j < base.n; j++) { const v = table[i * base.n + j] ?? 0; comps.push(bd[2 * j] + (v / 255) * (bd[2 * j + 1] - bd[2 * j])); } pal.push(base.rgb(comps)); }
      return { name: "Indexed", n: 1, base, initial: () => [0], defaultDecode: (bpc) => [0, Math.pow(2, bpc) - 1], rgb: (c) => pal[clamp(Math.round(c[0] ?? 0), 0, hival)] ?? [0, 0, 0] };
    }
    case "Separation": case "DeviceN": {
      const names = fn === "Separation" ? [doc.resolve(r[1])] : doc.arr(r[1]); const n = Math.max(1, names.length);
      const alt = loadColorSpace(doc, r[2], resources, depth + 1); const f = loadFunction(doc, r[3]);
      const isNone = names.every((x) => isName(x, "None"));
      const isAll = fn === "Separation" && isName(names[0], "All");
      const cache = new Map<string, [number, number, number]>();
      return {
        name: fn, n, base: alt, initial: () => new Array(n).fill(1), defaultDecode: () => new Array(n).fill(0).flatMap(() => [0, 1]),
        rgb: (c) => {
          if (isNone) return [255, 255, 255];
          if (isAll) { const v = to8(1 - (c[0] ?? 0)); return [v, v, v]; }
          const k = c.map((v) => v.toFixed(3)).join(","); const hit = cache.get(k); if (hit) return hit;
          const out = f ? alt.rgb(f(c)) : DeviceGray.rgb([1 - (c[0] ?? 0)]);
          if (cache.size < 4096) cache.set(k, out); return out;
        },
      };
    }
    case "Pattern": {
      const under = r.length > 1 ? loadColorSpace(doc, r[1], resources, depth + 1) : undefined;
      return { name: "Pattern", n: under ? under.n : 1, pattern: true, base: under, rgb: (c) => (under ? under.rgb(c) : [0, 0, 0]), initial: () => [0], defaultDecode: () => [0, 1] };
    }
    case "DeviceGray": case "G": return DeviceGray;
    case "DeviceRGB": case "RGB": return DeviceRGB;
    case "DeviceCMYK": case "CMYK": return DeviceCMYK;
  }
  return DeviceGray;
}
export { PName };
