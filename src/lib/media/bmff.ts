/**
 * Lossless MP4 / MOV trimming (ISO/IEC 14496-12 "ISO base media file format"), written from the specification.
 *
 * Reads progressive files (moov + mdat: stts/ctts/stss/stsz/stz2/stsc/stco/co64) and fragmented files (moov/mvex/trex +
 * moof/traf/tfhd/tfdt/trun, as written by MediaRecorder and by `ffmpeg -movflags frag_keyframe`). Existing edit lists
 * (one media edit, optionally after one empty edit — what encoders write for B-frame delay and AAC priming) are honoured.
 *
 * Trim: the compressed samples are copied, never decoded. Each track starts at its last sync sample at or before the
 * cut (the decoder needs it); open-GOP leading pictures that would reference frames before that sync sample are dropped;
 * the end keeps a decode-order prefix that contains every frame shown before the end time. A new edit list makes the
 * presentation start and end at the requested times ("exact" mode, frame-accurate in players that honour edit lists:
 * Chromium, Firefox, Safari/QuickTime, FFmpeg) or at the key frame ("keyframe" mode, for players that ignore them).
 * Output: a fresh progressive file (ftyp, moov, mdat — "fast start"), sample tables rebuilt, codec configuration
 * (stsd) copied byte-for-byte.
 * Refused with a clear error: encrypted tracks (encv/enca/saiz/senc), more than one media edit, damaged box structure.
 */
export type Bytes = Uint8Array;
export class MediaError extends Error {}

interface Box { type: string; start: number; data: number; end: number }
const ascii = (b: Bytes, p: number, n: number) => String.fromCharCode(...b.subarray(p, p + n));

class R {
  readonly v: DataView; readonly b: Bytes;
  constructor(b: Bytes) { this.b = b; this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u8(p: number) { this.need(p, 1); return this.b[p]; }
  u16(p: number) { this.need(p, 2); return this.v.getUint16(p); }
  u24(p: number) { this.need(p, 3); return (this.b[p] << 16) | (this.b[p + 1] << 8) | this.b[p + 2]; }
  u32(p: number) { this.need(p, 4); return this.v.getUint32(p); }
  i32(p: number) { this.need(p, 4); return this.v.getInt32(p); }
  u64(p: number) { this.need(p, 8); const hi = this.v.getUint32(p), lo = this.v.getUint32(p + 4); if (hi > 0x1fffff) throw new MediaError("64-bit value too large"); return hi * 2 ** 32 + lo; }
  i64(p: number) { this.need(p, 8); const hi = this.v.getInt32(p), lo = this.v.getUint32(p + 4); return hi * 2 ** 32 + lo; }
  need(p: number, n: number) { if (p < 0 || p + n > this.b.length) throw new MediaError("truncated or damaged file (read past the end)"); }
}

function boxes(r: R, from: number, to: number): Box[] {
  const out: Box[] = []; let p = from;
  while (p + 8 <= to) {
    let size = r.u32(p); const type = ascii(r.b, p + 4, 4); let hdr = 8;
    if (size === 1) { size = r.u64(p + 8); hdr = 16; } else if (size === 0) size = to - p;
    if (type === "uuid") hdr += 16;
    if (size < hdr || p + size > to) {
      if (type === "mdat" && size >= hdr) { out.push({ type, start: p, data: p + hdr, end: to }); break; } // mdat cut short: keep what is there
      throw new MediaError(`damaged box "${type.replace(/[^\x20-\x7e]/g, "?")}" at byte ${p}`);
    }
    out.push({ type, start: p, data: p + hdr, end: p + size }); p += size;
    if (out.length > 1_000_000) throw new MediaError("too many boxes");
  }
  return out;
}
const kid = (r: R, b: Box, type: string, off = 0) => boxes(r, b.data + off, b.end).find((x) => x.type === type);
const kids = (r: R, b: Box, off = 0) => boxes(r, b.data + off, b.end);

export interface Track {
  id: number; handler: string; timescale: number; tkhd: Box; trak: Box; mdhd: Box; stsd: Box;
  /** decode-order samples */
  off: number[]; size: number[]; dts: number[]; cto: number[]; dur: number[]; sync: boolean[]; sdi: number[];
  /** existing edit: media time (in track timescale) shown at `dwell` seconds of the presentation */
  mediaTime: number; dwell: number;
}
export interface Movie { r: R; ftyp: Box | null; moov: Box; mvhd: Box; timescale: number; tracks: Track[]; fragmented: boolean }

function parseEdit(r: R, trak: Box, movieTs: number): { mediaTime: number; dwell: number } {
  const edts = kid(r, trak, "edts"); const elst = edts && kid(r, edts, "elst"); if (!elst) return { mediaTime: 0, dwell: 0 };
  const v = r.u8(elst.data); const n = r.u32(elst.data + 4); let p = elst.data + 8; let dwell = 0; let media: number | null = null;
  for (let i = 0; i < n; i++) {
    const segDur = v === 1 ? r.u64(p) : r.u32(p); const mt = v === 1 ? r.i64(p + 8) : r.i32(p + 4); p += v === 1 ? 20 : 12;
    if (mt === -1) { if (media !== null) throw new MediaError("edit lists with an empty edit after media are not supported"); dwell += segDur / movieTs; continue; }
    if (media !== null) throw new MediaError("edit lists with more than one media edit are not supported");
    media = mt;
  }
  return { mediaTime: media ?? 0, dwell };
}

export function parseMovie(input: Bytes): Movie {
  const r = new R(input); const top = boxes(r, 0, input.length);
  const moov = top.find((b) => b.type === "moov"); if (!moov) throw new MediaError("not an MP4/MOV file (no moov box)");
  const ftyp = top.find((b) => b.type === "ftyp") ?? null;
  const mvhd = kid(r, moov, "mvhd"); if (!mvhd) throw new MediaError("moov without mvhd");
  const mv = r.u8(mvhd.data); const timescale = r.u32(mvhd.data + (mv === 1 ? 20 : 12)); if (!timescale) throw new MediaError("movie timescale is 0");
  const trex = new Map<number, { sdi: number; dur: number; size: number; flags: number }>();
  const mvex = kid(r, moov, "mvex");
  if (mvex) for (const t of kids(r, mvex)) if (t.type === "trex") trex.set(r.u32(t.data + 4), { sdi: r.u32(t.data + 8), dur: r.u32(t.data + 12), size: r.u32(t.data + 16), flags: r.u32(t.data + 20) });
  const tracks: Track[] = [];
  for (const trak of kids(r, moov).filter((b) => b.type === "trak")) {
    const tkhd = kid(r, trak, "tkhd"); const mdia = kid(r, trak, "mdia"); if (!tkhd || !mdia) continue;
    const id = r.u32(tkhd.data + (r.u8(tkhd.data) === 1 ? 20 : 12));
    const mdhd = kid(r, mdia, "mdhd"); const hdlr = kid(r, mdia, "hdlr"); const minf = kid(r, mdia, "minf"); const stbl = minf && kid(r, minf, "stbl");
    if (!mdhd || !hdlr || !stbl) continue;
    const ts = r.u32(mdhd.data + (r.u8(mdhd.data) === 1 ? 20 : 12)); if (!ts) throw new MediaError(`track ${id}: timescale is 0`);
    const stsd = kid(r, stbl, "stsd"); if (!stsd) throw new MediaError(`track ${id}: no sample descriptions`);
    for (const e of boxes(r, stsd.data + 8, stsd.end)) if (e.type === "encv" || e.type === "enca" || e.type === "encs" || e.type === "enct") throw new MediaError("encrypted (DRM/CENC) tracks cannot be trimmed");
    const t: Track = { id, handler: ascii(input, hdlr.data + 8, 4), timescale: ts, tkhd, trak, mdhd, stsd, off: [], size: [], dts: [], cto: [], dur: [], sync: [], sdi: [], ...parseEdit(r, trak, timescale) };
    readSampleTables(r, stbl, t);
    tracks.push(t);
  }
  let fragmented = false;
  for (const moof of top.filter((b) => b.type === "moof")) {
    fragmented = true; let prevEnd = moof.start;
    for (const traf of kids(r, moof).filter((b) => b.type === "traf")) {
      const tfhd = kid(r, traf, "tfhd"); if (!tfhd) continue;
      const fl = r.u24(tfhd.data + 1); const tid = r.u32(tfhd.data + 4); const t = tracks.find((x) => x.id === tid); if (!t) continue;
      if (kid(r, traf, "senc") || kid(r, traf, "saiz")) throw new MediaError("encrypted (DRM/CENC) fragments cannot be trimmed");
      const d = trex.get(tid) ?? { sdi: 1, dur: 0, size: 0, flags: 0 }; let p = tfhd.data + 8;
      let base = fl & 0x20000 ? moof.start : prevEnd; if (fl & 1) { base = r.u64(p); p += 8; }
      let sdi = d.sdi, dDur = d.dur, dSize = d.size, dFlags = d.flags;
      if (fl & 2) { sdi = r.u32(p); p += 4; } if (fl & 8) { dDur = r.u32(p); p += 4; } if (fl & 0x10) { dSize = r.u32(p); p += 4; } if (fl & 0x20) { dFlags = r.u32(p); p += 4; }
      const tfdt = kid(r, traf, "tfdt");
      let dts = tfdt ? (r.u8(tfdt.data) === 1 ? r.u64(tfdt.data + 4) : r.u32(tfdt.data + 4)) : t.dts.length ? t.dts[t.dts.length - 1] + t.dur[t.dur.length - 1] : 0;
      let cursor = base;
      for (const trun of kids(r, traf).filter((b) => b.type === "trun")) {
        const v = r.u8(trun.data); const tf = r.u24(trun.data + 1); const n = r.u32(trun.data + 4); let q = trun.data + 8;
        if (tf & 1) { cursor = base + r.i32(q); q += 4; }
        let first: number | null = null; if (tf & 4) { first = r.u32(q); q += 4; }
        const per = ((tf & 0x100) ? 4 : 0) + ((tf & 0x200) ? 4 : 0) + ((tf & 0x400) ? 4 : 0) + ((tf & 0x800) ? 4 : 0);
        if (q + per * n > trun.end) throw new MediaError("damaged trun box");
        for (let i = 0; i < n; i++) {
          const dur = tf & 0x100 ? r.u32((q += 4) - 4) : dDur; const size = tf & 0x200 ? r.u32((q += 4) - 4) : dSize;
          const flags = tf & 0x400 ? r.u32((q += 4) - 4) : i === 0 && first !== null ? first : dFlags;
          const cto = tf & 0x800 ? (v === 1 ? r.i32((q += 4) - 4) : r.u32((q += 4) - 4)) : 0;
          t.off.push(cursor); t.size.push(size); t.dts.push(dts); t.cto.push(cto | 0); t.dur.push(dur); t.sync.push(!(flags & 0x10000)); t.sdi.push(sdi);
          cursor += size; dts += dur;
        }
      }
      prevEnd = cursor;
    }
  }
  for (const t of tracks) for (let i = 0; i < t.off.length; i++) if (t.off[i] + t.size[i] > input.length) { // samples past a truncated end are dropped
    // with reordering (B-frames), the surviving decode prefix can hold a frame shown after a lost one; the lost samples'
    // times are still known from the tables, so shorten the prefix until no lost frame is shown before its last frame
    const pt = (j: number) => t.dts[j] + t.cto[j]; let k = i;
    let minLost = Infinity; for (let j = i; j < t.off.length; j++) minLost = Math.min(minLost, pt(j));
    while (k > 0) { let mx = -Infinity; for (let j = 0; j < k; j++) mx = Math.max(mx, pt(j)); if (mx < minLost) break; k--; minLost = Math.min(minLost, pt(k)); }
    for (const key of ["off", "size", "dts", "cto", "dur", "sync", "sdi"] as const) (t[key] as unknown[]).length = k; break;
  }
  return { r, ftyp, moov, mvhd, timescale, tracks, fragmented };
}

function readSampleTables(r: R, stbl: Box, t: Track) {
  const g = (ty: string) => kid(r, stbl, ty);
  const stsz = g("stsz"), stz2 = g("stz2"); const sizes: number[] = [];
  if (stsz) { const fixed = r.u32(stsz.data + 4), n = r.u32(stsz.data + 8); if (n > 50_000_000 || (fixed && fixed * n > r.b.length)) throw new MediaError("too many samples for the file size"); if (fixed) for (let i = 0; i < n; i++) sizes.push(fixed); else for (let i = 0; i < n; i++) sizes.push(r.u32(stsz.data + 12 + i * 4)); }
  else if (stz2) { const fs = r.u8(stz2.data + 7), n = r.u32(stz2.data + 8); for (let i = 0; i < n; i++) sizes.push(fs === 4 ? (r.u8(stz2.data + 12 + (i >> 1)) >> (i & 1 ? 0 : 4)) & 15 : fs === 8 ? r.u8(stz2.data + 12 + i) : r.u16(stz2.data + 12 + i * 2)); }
  const n = sizes.length; if (!n) return;
  const stco = g("stco"), co64 = g("co64"); const chunks: number[] = [];
  if (stco) { const c = r.u32(stco.data + 4); for (let i = 0; i < c; i++) chunks.push(r.u32(stco.data + 8 + i * 4)); }
  else if (co64) { const c = r.u32(co64.data + 4); for (let i = 0; i < c; i++) chunks.push(r.u64(co64.data + 8 + i * 8)); }
  else throw new MediaError(`track ${t.id}: no chunk offsets`);
  const stsc = g("stsc"); if (!stsc) throw new MediaError(`track ${t.id}: no sample-to-chunk table`);
  const ents: [number, number, number][] = []; const ec = r.u32(stsc.data + 4); for (let i = 0; i < ec; i++) ents.push([r.u32(stsc.data + 8 + i * 12), r.u32(stsc.data + 12 + i * 12), r.u32(stsc.data + 16 + i * 12)]);
  let s = 0;
  for (let e = 0; e < ents.length && s < n; e++) {
    const last = e + 1 < ents.length ? ents[e + 1][0] - 1 : chunks.length;
    for (let c = ents[e][0]; c <= last && s < n; c++) { let o = chunks[c - 1]; if (o === undefined) throw new MediaError(`track ${t.id}: chunk table too short`); for (let k = 0; k < ents[e][1] && s < n; k++) { t.off.push(o); t.size.push(sizes[s]); t.sdi.push(ents[e][2]); o += sizes[s]; s++; } }
  }
  if (s < n) throw new MediaError(`track ${t.id}: sample-to-chunk table covers ${s} of ${n} samples`);
  const stts = g("stts"); if (!stts) throw new MediaError(`track ${t.id}: no time-to-sample table`);
  let d = 0; const tc = r.u32(stts.data + 4);
  for (let i = 0, k = 0; i < tc && k < n; i++) { const cnt = r.u32(stts.data + 8 + i * 8), du = r.u32(stts.data + 12 + i * 8); for (let j = 0; j < cnt && k < n; j++, k++) { t.dts.push(d); t.dur.push(du); d += du; } }
  while (t.dts.length < n) { t.dts.push(d); t.dur.push(0); }
  const ctts = g("ctts"); for (let i = 0; i < n; i++) t.cto.push(0);
  if (ctts) { const cc = r.u32(ctts.data + 4); for (let i = 0, k = 0; i < cc && k < n; i++) { const cnt = r.u32(ctts.data + 8 + i * 8), off = r.i32(ctts.data + 12 + i * 8); for (let j = 0; j < cnt && k < n; j++, k++) t.cto[k] = off; } }
  const stss = g("stss");
  if (stss) { for (let i = 0; i < n; i++) t.sync.push(false); const sc = r.u32(stss.data + 4); for (let i = 0; i < sc; i++) { const k = r.u32(stss.data + 8 + i * 4) - 1; if (k >= 0 && k < n) t.sync[k] = true; } }
  else for (let i = 0; i < n; i++) t.sync.push(true);
}

/** presentation time (seconds) of sample i */
export const ptOf = (t: Track, i: number) => (t.dts[i] + t.cto[i] - t.mediaTime) / t.timescale + t.dwell;
export function movieDuration(m: Movie): number { let d = 0; for (const t of m.tracks) for (let i = 0; i < t.dts.length; i++) d = Math.max(d, ptOf(t, i) + t.dur[i] / t.timescale); return d; }

/** sample selection for one track; exported for tests */
export function selectSamples(t: Track, from: number, to: number, isRef: boolean): number[] {
  const n = t.dts.length; if (!n) return [];
  const eps = 0.5 / t.timescale; const allSync = t.sync.every(Boolean);
  if (allSync && !isRef) { // audio-like: every sample decodes alone; keep the samples that overlap [from, to)
    const keep: number[] = []; for (let i = 0; i < n; i++) { const p = ptOf(t, i), e = p + t.dur[i] / t.timescale; if (e > from + eps && p < to - eps) keep.push(i); }
    return keep;
  }
  let k = -1; for (let i = 0; i < n; i++) if (t.sync[i] && ptOf(t, i) <= from + eps) k = i;
  if (k < 0) { k = t.sync.indexOf(true); if (k < 0) return []; }
  const pk = ptOf(t, k); let m = -1;
  for (let i = k; i < n; i++) if (ptOf(t, i) < to - eps) m = i;
  if (m < k) return [];
  const keep: number[] = []; for (let i = k; i <= m; i++) if (i === k || ptOf(t, i) >= pk - eps) keep.push(i); // drop open-GOP leading pictures
  return keep;
}

/* ------------------------------------------------------------------------------------------------ writer */
const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
function u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
function u64(n: number) { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, Math.floor(n / 2 ** 32)); v.setUint32(4, n >>> 0); return b; }
function i32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return b; }
function cat(parts: Bytes[]): Bytes { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let q = 0; for (const p of parts) { o.set(p, q); q += p.length; } return o; }
function box(type: string, ...parts: Bytes[]): Bytes { const body = cat(parts); return cat([u32(body.length + 8), enc(type), body]); }
function full(type: string, v: number, flags: number, ...parts: Bytes[]) { return box(type, Uint8Array.of(v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts); }
const raw = (r: R, b: Box) => r.b.subarray(b.start, b.end);
/** a copy of a full box (mvhd/tkhd/mdhd) with its duration field replaced (offsets are from the version byte) */
function withDuration(r: R, b: Box, duration: number, durOffV0: number, durOffV1: number): Bytes {
  const v = r.u8(b.data); const o = r.b.slice(b.data, b.end);
  if (v === 1) o.set(u64(duration), durOffV1);
  else if (duration <= 0xffffffff) o.set(u32(duration), durOffV0);
  else throw new MediaError("the trimmed duration does not fit a version-0 header (over 2^32 ticks)");
  return box(b.type, o);
}

export interface TrimOptions { mode?: "exact" | "keyframe" }
export interface TrimReport { bytes: Bytes; start: number; end: number; keyframe: number; tracks: { id: number; handler: string; samples: number }[]; fragmentedInput: boolean }

export function trimMp4(input: Bytes, from: number, to: number, opts: TrimOptions = {}): TrimReport {
  const m = parseMovie(input); const r = m.r;
  const total = movieDuration(m);
  if (!(to > from)) throw new MediaError("the end must be after the start");
  from = Math.max(0, from); to = Math.min(to, total); if (!(to > from)) throw new MediaError(`the range is outside the file (duration ${total.toFixed(3)} s)`);
  const live = m.tracks.filter((t) => t.dts.length);
  const ref = live.find((t) => t.handler === "vide" && !t.sync.every(Boolean)) ?? live.find((t) => t.handler === "vide") ?? live[0];
  if (!ref) throw new MediaError("the file has no samples");
  const refSel = selectSamples(ref, from, to, true); if (!refSel.length) throw new MediaError("no video frames in that range");
  const keyT = ptOf(ref, refSel[0]);
  const T0 = opts.mode === "keyframe" ? keyT : from; // presentation zero of the output
  const sel = new Map<Track, number[]>(); sel.set(ref, refSel);
  for (const t of live) if (t !== ref) { const s = selectSamples(t, opts.mode === "keyframe" ? keyT : from, to, false); if (s.length) sel.set(t, s); }
  const outDur = to - T0;
  // interleave: chunks of up to ~0.5 s per track in presentation order
  type Chunk = { t: Track; idx: number[]; time: number };
  const chunks: Chunk[] = [];
  for (const [t, s] of sel) { let cur: number[] = []; let t0 = 0; for (const i of s) { const tm = t.dts[i] / t.timescale; if (!cur.length) t0 = tm; else if (tm - t0 >= 0.5) { chunks.push({ t, idx: cur, time: t0 }); cur = []; t0 = tm; } cur.push(i); } if (cur.length) chunks.push({ t, idx: cur, time: t0 }); }
  chunks.sort((a, b) => a.time - b.time || a.t.id - b.t.id);
  let mdatBody = 0; for (const c of chunks) for (const i of c.idx) mdatBody += c.t.size[i];
  const build = (mdatStart: number, wide: boolean): Bytes => {
    const traks: Bytes[] = []; let pos = mdatStart;
    const chunkOff = new Map<Track, number[]>(); const chunkCount = new Map<Track, number[]>();
    for (const c of chunks) { (chunkOff.get(c.t) ?? chunkOff.set(c.t, []).get(c.t)!).push(pos); (chunkCount.get(c.t) ?? chunkCount.set(c.t, []).get(c.t)!).push(c.idx.length); for (const i of c.idx) pos += c.t.size[i]; }
    for (const t of m.tracks) {
      const s = sel.get(t); if (!s) continue;
      const D = t.dts[s[0]];
      // stts / ctts / stss / stsz
      const stts: [number, number][] = []; const ctts: [number, number][] = []; const stss: number[] = []; let mediaDur = 0; let neg = false;
      s.forEach((i, k) => {
        const du = k + 1 < s.length ? t.dts[s[k + 1]] - t.dts[i] : t.dur[i]; mediaDur += du;
        if (stts.length && stts[stts.length - 1][1] === du) stts[stts.length - 1][0]++; else stts.push([1, du]);
        const c = t.cto[i]; if (c < 0) neg = true; if (ctts.length && ctts[ctts.length - 1][1] === c) ctts[ctts.length - 1][0]++; else ctts.push([1, c]);
        if (t.sync[i]) stss.push(k + 1);
      });
      const stbl: Bytes[] = [raw(r, t.stsd)];
      stbl.push(full("stts", 0, 0, u32(stts.length), ...stts.flatMap(([c, d]) => [u32(c), u32(d)])));
      if (ctts.some(([, c]) => c !== 0)) stbl.push(full("ctts", neg ? 1 : 0, 0, u32(ctts.length), ...ctts.flatMap(([c, o]) => [u32(c), i32(o)])));
      if (stss.length < s.length) stbl.push(full("stss", 0, 0, u32(stss.length), ...stss.map(u32)));
      const sdis = new Set(s.map((i) => t.sdi[i]));
      if (sdis.size > 1) throw new MediaError(`track ${t.id}: several sample descriptions in the range are not supported`);
      const sdi = [...sdis][0] || 1;
      const cc = chunkCount.get(t)!; const stsc: [number, number][] = []; cc.forEach((n, k) => { if (!stsc.length || stsc[stsc.length - 1][1] !== n) stsc.push([k + 1, n]); });
      stbl.push(full("stsc", 0, 0, u32(stsc.length), ...stsc.flatMap(([f, n]) => [u32(f), u32(n), u32(sdi)])));
      stbl.push(full("stsz", 0, 0, u32(0), u32(s.length), ...s.map((i) => u32(t.size[i]))));
      const co = chunkOff.get(t)!; stbl.push(wide ? full("co64", 0, 0, u32(co.length), ...co.map(u64)) : full("stco", 0, 0, u32(co.length), ...co.map(u32)));
      // edit list: output presentation 0 ↔ original presentation T0
      const mediaAtT0 = (T0 - t.dwell) * t.timescale + t.mediaTime - D;
      const edits: [number, number][] = []; // [segment duration (movie ts), media time]
      const segTotal = Math.round(outDur * m.timescale);
      if (mediaAtT0 >= 0) edits.push([segTotal, Math.round(mediaAtT0)]);
      else { const dwell = Math.round((-mediaAtT0 / t.timescale) * m.timescale); edits.push([dwell, -1], [Math.max(0, segTotal - dwell), 0]); }
      const ev = edits.some(([d, mt]) => d > 0xffffffff || mt > 0x7fffffff) ? 1 : 0;
      const elst = full("elst", ev, 0, u32(edits.length), ...edits.flatMap(([d, mt]) => ev ? [u64(d), mt < 0 ? Uint8Array.of(255, 255, 255, 255, 255, 255, 255, 255) : u64(mt), u32(0x10000)] : [u32(d), i32(mt), u32(0x10000)]));
      const tkhd = withDuration(r, t.tkhd, segTotal, 20, 28);
      const mdia = boxes(r, t.trak.data, t.trak.end).find((b) => b.type === "mdia")!;
      const mdiaKids: Bytes[] = [];
      for (const b of kids(r, mdia)) {
        if (b.type === "mdhd") mdiaKids.push(withDuration(r, b, mediaDur, 16, 24));
        else if (b.type === "minf") { const mk: Bytes[] = []; for (const x of kids(r, b)) mk.push(x.type === "stbl" ? box("stbl", ...stbl) : raw(r, x)); mdiaKids.push(box("minf", ...mk)); }
        else mdiaKids.push(raw(r, b));
      }
      const trakKids: Bytes[] = [tkhd, box("edts", elst)];
      for (const b of kids(r, t.trak)) if (b.type !== "tkhd" && b.type !== "edts" && b.type !== "mdia") trakKids.push(raw(r, b));
      trakKids.splice(2, 0, box("mdia", ...mdiaKids));
      traks.push(box("trak", ...trakKids));
    }
    const moovKids: Bytes[] = [withDuration(r, m.mvhd, Math.round(outDur * m.timescale), 16, 24), ...traks];
    for (const b of kids(r, m.moov)) if (!["mvhd", "trak", "mvex"].includes(b.type)) moovKids.push(raw(r, b));
    return box("moov", ...moovKids);
  };
  const ftyp = m.ftyp ? raw(r, m.ftyp) : box("ftyp", enc("isom"), u32(512), enc("isomiso2mp41"));
  const bigMdat = mdatBody + 8 > 0xffffffff;
  const mdatHdr = bigMdat ? 16 : 8;
  let moov = build(0, false); let wide = ftyp.length + moov.length + mdatHdr + mdatBody > 0xffffffff;
  moov = build(ftyp.length + moov.length + mdatHdr, wide); // sizes do not depend on the offsets' values, only on their width
  if (!wide && ftyp.length + moov.length + mdatHdr + mdatBody > 0xffffffff) { wide = true; moov = build(0, true); moov = build(ftyp.length + moov.length + mdatHdr, true); }
  const out = new Uint8Array(ftyp.length + moov.length + mdatHdr + mdatBody); let q = 0;
  out.set(ftyp, q); q += ftyp.length; out.set(moov, q); q += moov.length;
  if (bigMdat) { out.set(u32(1), q); out.set(enc("mdat"), q + 4); out.set(u64(mdatBody + 16), q + 8); } else { out.set(u32(mdatBody + 8), q); out.set(enc("mdat"), q + 4); }
  q += mdatHdr;
  for (const c of chunks) for (const i of c.idx) { if (c.t.off[i] + c.t.size[i] > input.length) throw new MediaError(`track ${c.t.id}: sample ${i + 1} lies past the end of the file (truncated download?)`); out.set(input.subarray(c.t.off[i], c.t.off[i] + c.t.size[i]), q); q += c.t.size[i]; }
  return { bytes: out, start: T0, end: to, keyframe: keyT, tracks: [...sel].map(([t, s]) => ({ id: t.id, handler: t.handler, samples: s.length })), fragmentedInput: m.fragmented };
}
