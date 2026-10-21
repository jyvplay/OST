/**
 * TT54 (FF-13) — header-only readers for ISO-BMFF / QuickTime (MP4, M4A, MOV, 3GP) and Matroska / WebM, original
 * code. Unlike the TT53 trimmer these never load sample tables or clusters: they read
 * moov > mvhd / trak (tkhd, mdia > mdhd / hdlr / minf > stbl > stsd) / udta (> meta > ilst iTunes tags, ©xyz)
 * and Segment > Info / Tracks / Tags / Attachments, skipping clusters by their size.
 */
import type { AvInfo, Picture } from "./audio";
import { resolveGenre } from "./audio";

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64be = (b: Uint8Array, o: number) => u32be(b, o) * 2 ** 32 + u32be(b, o + 4);
const ascii = (b: Uint8Array, o: number, n: number) => { let s = ""; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; };
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

interface Bx { type: string; s: number; e: number }
function boxes(b: Uint8Array, s: number, e: number): Bx[] {
  const out: Bx[] = []; let o = s;
  while (o + 8 <= e && out.length < 100000) {
    let size = u32be(b, o); const type = ascii(b, o + 4, 4); let h = 8;
    if (size === 1) { size = u64be(b, o + 8); h = 16; } else if (size === 0) size = e - o;
    if (size < h) break;
    out.push({ type, s: o + h, e: Math.min(o + size, e) }); o += size;
  }
  return out;
}
const child = (b: Uint8Array, x: Bx | undefined, type: string, skip = 0) => x ? boxes(b, x.s + skip, x.e).find((k) => k.type === type) : undefined;

export function sniffBmff(b: Uint8Array): boolean {
  const t = ascii(b, 4, 4);
  if (t === "ftyp") { const brand = ascii(b, 8, 4); return !/^(heic|heix|heim|heis|mif1|msf1|avif|avis)$/.test(brand) || boxes(b, 0, Math.min(b.length, 1 << 16)).some((x) => x.type === "moov"); }
  return t === "moov" || t === "mdat" || t === "wide" || t === "free" && ascii(b, 4 + u32be(b, 0), 4) === "moov";
}

const ILST: Record<string, string> = { "\xa9nam": "title", "\xa9ART": "artist", aART: "albumArtist", "\xa9alb": "album", "\xa9day": "date", "\xa9gen": "genre", "\xa9wrt": "composer", "\xa9cmt": "comment", cprt: "copyright", "\xa9too": "encoder", desc: "description", "\xa9des": "description" };
const STSD_NAME: Record<string, string> = { avc1: "H.264", avc3: "H.264", hvc1: "HEVC", hev1: "HEVC", av01: "AV1", vp09: "VP9", vp08: "VP8", mp4v: "MPEG-4 Visual", mp4a: "AAC", "ac-3": "AC-3", "ec-3": "E-AC-3", Opus: "Opus", fLaC: "FLAC", alac: "ALAC", ".mp3": "MP3", jpeg: "Motion JPEG", apcn: "ProRes", apch: "ProRes", lpcm: "PCM", sowt: "PCM", twos: "PCM", tx3g: "Timed text", text: "Text", encv: "Encrypted video", enca: "Encrypted audio" };

/** "+40.6892-074.0445+010.000/" (ISO 6709) */
export function iso6709(s: string): { lat: number; lon: number; alt?: number } | null {
  const m = s.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/);
  if (!m) return null; const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return m[3] ? { lat, lon, alt: parseFloat(m[3]) } : { lat, lon };
}

export function readBmff(b: Uint8Array): AvInfo {
  const info: AvInfo = { format: "mp4", mime: "video/mp4", kind: "audio", codecs: [], tags: {}, pictures: [], warnings: [] };
  const top = boxes(b, 0, b.length);
  const ftyp = top.find((x) => x.type === "ftyp"); const brand = ftyp ? ascii(b, ftyp.s, 4) : "";
  const moov = top.find((x) => x.type === "moov");
  if (!moov) { info.warnings.push(top.some((x) => x.type === "mdat") && !top.some((x) => x.type === "moov") ? "mp4: no moov box (truncated download, or moov at the end beyond what was read)" : "mp4: no moov box"); return info; }
  const mk = boxes(b, moov.s, moov.e);
  const mvhd = mk.find((x) => x.type === "mvhd");
  let movieDur = 0;
  if (mvhd) { const v = b[mvhd.s]; const ts = v ? u32be(b, mvhd.s + 20) : u32be(b, mvhd.s + 12); const d = v ? u64be(b, mvhd.s + 24) : u32be(b, mvhd.s + 16); if (ts && d !== 0xffffffff && d < 2 ** 52) movieDur = d / ts; }
  let audioDur = 0, video = false; const scales = new Map<number, number>(); let audioId = 0, videoId = 0;
  for (const trak of mk.filter((x) => x.type === "trak")) {
    const tkhd = child(b, trak, "tkhd"); const mdia = child(b, trak, "mdia");
    const tid = tkhd ? u32be(b, tkhd.s + (b[tkhd.s] ? 20 : 12)) : 0;
    const hdlr = child(b, mdia, "hdlr"); const handler = hdlr ? ascii(b, hdlr.s + 8, 4) : "";
    const mdhd = child(b, mdia, "mdhd");
    let dur = 0; if (mdhd) { const v = b[mdhd.s]; const ts = v ? u32be(b, mdhd.s + 20) : u32be(b, mdhd.s + 12); const d = v ? u64be(b, mdhd.s + 24) : u32be(b, mdhd.s + 16); if (ts) scales.set(tid, ts); if (ts && d !== 0xffffffff) dur = d / ts; }
    if (handler === "vide" && !videoId) videoId = tid; if (handler === "soun" && !audioId) audioId = tid;
    const stsd = child(b, child(b, child(b, mdia, "minf"), "stbl"), "stsd");
    const entry = stsd ? boxes(b, stsd.s + 8, stsd.e)[0] : undefined;
    const fourcc = entry?.type ?? "";
    if (fourcc) { const nm = STSD_NAME[fourcc] ?? fourcc.trim(); if (!info.codecs.includes(nm)) info.codecs.push(nm); }
    if (handler === "vide" && tkhd) {
      // width / height (16.16 fixed) are the last 8 bytes of tkhd in both versions
      const w = u32be(b, tkhd.e - 8) / 65536, h = u32be(b, tkhd.e - 4) / 65536;
      if (w && h && !(info.width && info.height)) { info.width = Math.round(w); info.height = Math.round(h); }
      video = true;
    } else if (handler === "soun") {
      if (!audioDur) audioDur = dur;
      if (entry && info.sampleRate === undefined) { const e = entry.s; info.channels = u16be(b, e + 16); info.bitsPerSample = u16be(b, e + 18); info.sampleRate = u32be(b, e + 24) / 65536; }
    }
  }
  info.kind = video ? "video" : "audio";
  info.duration = video ? movieDur || audioDur : audioDur || movieDur;
  const mvex = mk.find((x) => x.type === "mvex");
  if (!info.duration && mvex) info.duration = fragmentedDuration(b, top, mvex, mvhd, scales, video ? videoId : audioId) || undefined;
  info.format = video ? (brand === "qt  " ? "mov" : "mp4") : "m4a";
  info.mime = video ? (brand === "qt  " ? "video/quicktime" : "video/mp4") : "audio/mp4";
  if (info.duration) info.bitrate = Math.round(b.length * 8 / info.duration);
  const udta = mk.find((x) => x.type === "udta");
  if (udta) {
    for (const u of boxes(b, udta.s, udta.e)) {
      if (u.type === "\xa9xyz") { const n = u16be(b, u.s); const g = iso6709(ascii(b, u.s + 4, n)); if (g) info.gps = g; }
      else if (u.type === "meta") {
        // ISO meta is a FullBox; QuickTime's is a plain container — tell them apart by what follows
        const skip = ascii(b, u.s + 4, 4) === "hdlr" ? 0 : 4;
        const ilst = child(b, u, "ilst", skip); if (ilst) ilstTags(b, ilst, info);
      } else if (u.type[0] === "\xa9" && ILST[u.type] && !info.tags[ILST[u.type]]) {
        // QuickTime international text atom: u16 size, u16 language, text
        const n = u16be(b, u.s); if (n && u.s + 4 + n <= u.e) info.tags[ILST[u.type]] = utf8(b.subarray(u.s + 4, u.s + 4 + n));
      }
    }
  }
  const meta = mk.find((x) => x.type === "meta");
  if (meta) {
    const skip = ascii(b, meta.s + 4, 4) === "hdlr" ? 0 : 4; const mb = boxes(b, meta.s + skip, meta.e);
    const keys = mb.find((x) => x.type === "keys"); const ilst = mb.find((x) => x.type === "ilst");
    if (keys && ilst) {
      // QuickTime metadata (iPhone): keys box names items by index; com.apple.quicktime.location.ISO6709 = GPS
      const names: string[] = []; let p = keys.s + 8; const n = u32be(b, keys.s + 4);
      for (let i = 0; i < n && p + 8 <= keys.e; i++) { const sz = u32be(b, p); names.push(ascii(b, p + 8, sz - 8)); p += sz; }
      for (const it of boxes(b, ilst.s, ilst.e)) {
        const idx = u32be(b, it.s - 4) - 1; const key = names[idx]; const data = child(b, it, "data"); if (!key || !data) continue;
        const val = utf8(b.subarray(data.s + 8, data.e));
        if (key === "com.apple.quicktime.location.ISO6709") { const g = iso6709(val); if (g) info.gps = g; }
        else if (key === "com.apple.quicktime.make") info.tags.make = val;
        else if (key === "com.apple.quicktime.model") info.tags.model = val;
        else if (key === "com.apple.quicktime.creationdate") info.tags.date = val;
        else if (key === "com.apple.quicktime.title" && !info.tags.title) info.tags.title = val;
      }
    }
  }
  return info;
}

/** fragmented MP4: mehd fragment_duration, else the end of the last fragment of the main track (tfdt + trun durations) */
function fragmentedDuration(b: Uint8Array, top: Bx[], mvex: Bx, mvhd: Bx | undefined, scales: Map<number, number>, mainId: number): number {
  const kids = boxes(b, mvex.s, mvex.e);
  const mehd = kids.find((x) => x.type === "mehd");
  if (mehd && mvhd) { const ts = b[mvhd.s] ? u32be(b, mvhd.s + 20) : u32be(b, mvhd.s + 12); const d = b[mehd.s] ? u64be(b, mehd.s + 4) : u32be(b, mehd.s + 4); if (ts && d) return d / ts; }
  const trexDur = new Map<number, number>();
  for (const t of kids.filter((x) => x.type === "trex")) trexDur.set(u32be(b, t.s + 4), u32be(b, t.s + 12));
  const end = new Map<number, number>(); const run = new Map<number, number>();
  for (const moof of top.filter((x) => x.type === "moof")) {
    for (const traf of boxes(b, moof.s, moof.e).filter((x) => x.type === "traf")) {
      const tk = boxes(b, traf.s, traf.e); const tfhd = tk.find((x) => x.type === "tfhd"); if (!tfhd) continue;
      const fl = u24(b, tfhd.s + 1); const id = u32be(b, tfhd.s + 4); let p = tfhd.s + 8;
      if (fl & 1) p += 8; if (fl & 2) p += 4; let defDur = trexDur.get(id) ?? 0; if (fl & 8) defDur = u32be(b, p);
      const tfdt = tk.find((x) => x.type === "tfdt");
      let t = tfdt ? (b[tfdt.s] ? u64be(b, tfdt.s + 4) : u32be(b, tfdt.s + 4)) : run.get(id) ?? 0;
      for (const trun of tk.filter((x) => x.type === "trun")) {
        const tf = u24(b, trun.s + 1), n = u32be(b, trun.s + 4); let q = trun.s + 8; if (tf & 1) q += 4; if (tf & 4) q += 4;
        const per = (tf & 0x100 ? 4 : 0) + (tf & 0x200 ? 4 : 0) + (tf & 0x400 ? 4 : 0) + (tf & 0x800 ? 4 : 0);
        if (tf & 0x100) { for (let i = 0; i < n && q + 4 <= trun.e; i++, q += per) t += u32be(b, q); } else t += n * defDur;
      }
      run.set(id, t); end.set(id, Math.max(end.get(id) ?? 0, t));
    }
  }
  const id = end.has(mainId) ? mainId : [...end.keys()][0]; const ts = scales.get(id);
  return id !== undefined && ts ? (end.get(id) ?? 0) / ts : 0;
}
const u24 = (b: Uint8Array, o: number) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

function ilstTags(b: Uint8Array, ilst: Bx, info: AvInfo) {
  for (const it of boxes(b, ilst.s, ilst.e)) {
    const data = boxes(b, it.s, it.e).find((k) => k.type === "data"); if (!data) continue;
    const type = u32be(b, data.s) & 0xffffff; const payload = b.subarray(data.s + 8, data.e);
    if (it.type === "covr") {
      for (const d of boxes(b, it.s, it.e).filter((k) => k.type === "data")) {
        const t = u32be(b, d.s) & 0xffffff; const pd = b.subarray(d.s + 8, d.e);
        const mime = t === 14 || (pd[0] === 0x89 && pd[1] === 0x50) ? "image/png" : t === 27 ? "image/bmp" : "image/jpeg";
        info.pictures.push({ mime, data: pd, type: 3, description: "" } as Picture);
      }
    } else if (it.type === "trkn" || it.type === "disk") {
      if (payload.length >= 6) { const n = u16be(payload, 2), tot = u16be(payload, 4); info.tags[it.type === "trkn" ? "track" : "disc"] = tot ? `${n}/${tot}` : String(n); }
    } else if (it.type === "gnre") { if (payload.length >= 2 && !info.tags.genre) info.tags.genre = resolveGenre(String(u16be(payload, 0) - 1)); }
    else if (it.type === "----") {
      const name = boxes(b, it.s, it.e).find((k) => k.type === "name");
      const nm = name ? utf8(b.subarray(name.s + 4, name.e)) : "";
      if (nm && type === 1) info.tags[`itunes:${nm}`] = utf8(payload);
    } else {
      const k = ILST[it.type]; if (!k || info.tags[k]) continue;
      if (type === 1 || type === 0) info.tags[k] = utf8(payload).replace(/\0+$/, "");
    }
  }
}

/* ------------------------------------------------------------- Matroska ------ */

function vint(b: Uint8Array, o: number, keepMarker: boolean): [number, number] | null {
  const f = b[o]; if (f === undefined || f === 0) return null;
  let len = 1; while (!(f & (0x80 >> (len - 1)))) len++;
  if (len > 8 || o + len > b.length) return null;
  let v = keepMarker ? f : f & (0xff >> len); let ones = (f & (0xff >> len)) === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 0xff) ones = false; }
  return [ones && !keepMarker ? -1 : v, len];
}
interface Ebml { id: number; s: number; e: number; unknown: boolean }
function els(b: Uint8Array, s: number, e: number, stopAt?: number): Ebml[] {
  const out: Ebml[] = []; let o = s;
  while (o < e && out.length < 200000) {
    const id = vint(b, o, true); if (!id) break; const sz = vint(b, o + id[1], false); if (!sz) break;
    const ds = o + id[1] + sz[1]; const unknown = sz[0] < 0; const de = unknown ? e : Math.min(e, ds + sz[0]);
    out.push({ id: id[0], s: ds, e: de, unknown });
    if (stopAt !== undefined && id[0] === stopAt && unknown) break;
    o = de;
  }
  return out;
}
const uint = (b: Uint8Array, x: Ebml) => { let v = 0; for (let i = x.s; i < x.e; i++) v = v * 256 + b[i]; return v; };
const flt = (b: Uint8Array, x: Ebml) => { const dv = new DataView(b.buffer, b.byteOffset + x.s, x.e - x.s); return x.e - x.s === 4 ? dv.getFloat32(0) : x.e - x.s === 8 ? dv.getFloat64(0) : 0; };
const str = (b: Uint8Array, x: Ebml) => utf8(b.subarray(x.s, x.e)).replace(/\0+$/, "");

const MK_CODEC: Record<string, string> = { V_VP8: "VP8", V_VP9: "VP9", V_AV1: "AV1", "V_MPEG4/ISO/AVC": "H.264", "V_MPEGH/ISO/HEVC": "HEVC", A_OPUS: "Opus", A_VORBIS: "Vorbis", A_AAC: "AAC", A_FLAC: "FLAC", A_MPEG_L3: "MP3", A_AC3: "AC-3", "A_PCM/INT/LIT": "PCM", S_TEXT_UTF8: "SRT", S_TEXT_WEBVTT: "WebVTT", S_TEXT_ASS: "ASS" };

export function sniffMatroska(b: Uint8Array): boolean { return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3; }

export function readMatroska(b: Uint8Array): AvInfo {
  const info: AvInfo = { format: "mkv", mime: "video/x-matroska", kind: "audio", codecs: [], tags: {}, pictures: [], warnings: [] };
  const top = els(b, 0, b.length, 0x18538067);
  const head = top.find((x) => x.id === 0x1a45dfa3);
  if (head) { const dt = els(b, head.s, head.e).find((x) => x.id === 0x4282); if (dt && str(b, dt) === "webm") { info.format = "webm"; info.mime = "video/webm"; } }
  const seg = top.find((x) => x.id === 0x18538067); if (!seg) { info.warnings.push("matroska: no Segment"); return info; }
  let scale = 1_000_000, dur = 0, video = false;
  for (const x of els(b, seg.s, seg.e, 0x1f43b675)) {
    if (x.id === 0x1549a966) {
      for (const k of els(b, x.s, x.e)) {
        if (k.id === 0x2ad7b1) scale = uint(b, k) || scale;
        else if (k.id === 0x4489) dur = flt(b, k);
        else if (k.id === 0x7ba9) info.tags.title = str(b, k);
        else if (k.id === 0x4d80) info.tags.encoder = str(b, k);
        else if (k.id === 0x4461 && k.e - k.s === 8) { const ns = new DataView(b.buffer, b.byteOffset + k.s, 8).getBigInt64(0); info.tags.date = new Date(Date.UTC(2001, 0, 1) + Number(ns / BigInt(1000000))).toISOString(); }
      }
    } else if (x.id === 0x1654ae6b) {
      for (const te of els(b, x.s, x.e)) {
        if (te.id !== 0xae) continue; let type = 0, codec = "";
        for (const k of els(b, te.s, te.e)) {
          if (k.id === 0x83) type = uint(b, k); else if (k.id === 0x86) codec = str(b, k);
          else if (k.id === 0xe0) { for (const v of els(b, k.s, k.e)) { if (v.id === 0xb0 && !info.width) info.width = uint(b, v); else if (v.id === 0xba && !info.height) info.height = uint(b, v); } }
          else if (k.id === 0xe1) { for (const a of els(b, k.s, k.e)) { if (a.id === 0xb5 && !info.sampleRate) info.sampleRate = flt(b, a); else if (a.id === 0x9f && !info.channels) info.channels = uint(b, a); else if (a.id === 0x6264 && !info.bitsPerSample) info.bitsPerSample = uint(b, a); } }
        }
        if (type === 1) video = true;
        const nm = MK_CODEC[codec] ?? codec; if (nm && !info.codecs.includes(nm)) info.codecs.push(nm);
      }
    } else if (x.id === 0x1254c367) {
      for (const tag of els(b, x.s, x.e)) {
        if (tag.id !== 0x7373) continue;
        for (const st of els(b, tag.s, tag.e)) {
          if (st.id !== 0x67c8) continue; let n = "", v = "";
          for (const k of els(b, st.s, st.e)) { if (k.id === 0x45a3) n = str(b, k).toUpperCase(); else if (k.id === 0x4487) v = str(b, k); }
          const key = ({ TITLE: "title", ARTIST: "artist", ALBUM: "album", DATE_RELEASED: "date", DATE_RECORDED: "date", GENRE: "genre", COMMENT: "comment", ENCODER: "encoder", COMPOSER: "composer", PART_NUMBER: "track" } as Record<string, string>)[n];
          if (key && v && !info.tags[key]) info.tags[key] = v;
        }
      }
    } else if (x.id === 0x1941a469) {
      for (const af of els(b, x.s, x.e)) {
        if (af.id !== 0x61a7) continue; let mime = "", data: Uint8Array | null = null, fname = "";
        for (const k of els(b, af.s, af.e)) { if (k.id === 0x4660) mime = str(b, k); else if (k.id === 0x465c) data = b.subarray(k.s, k.e); else if (k.id === 0x466e) fname = str(b, k); }
        if (data && mime.startsWith("image/")) info.pictures.push({ mime, data, type: /cover/i.test(fname) ? 3 : 0, description: fname });
      }
    } else if (x.id === 0x1f43b675 && x.unknown) break;
  }
  info.kind = video ? "video" : "audio";
  if (!video) { info.mime = info.format === "webm" ? "audio/webm" : "audio/x-matroska"; if (info.format === "mkv") info.format = "mka"; }
  if (dur) { info.duration = dur * scale / 1e9; info.bitrate = Math.round(b.length * 8 / info.duration); }
  return info;
}
